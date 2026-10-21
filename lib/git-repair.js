'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const defaultRun = require('./process').run;
const defaultGithub = require('./github');

function failure(message, code = 'GITHUB_REPAIR_UNSAFE', details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function parseStatus(output) {
  const dirty = new Set(), staged = new Set();
  const rows = output.split('\0');
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!row) continue;
    const xy = row.slice(0, 2), file = row.slice(3);
    dirty.add(file);
    if (xy[0] !== ' ' && xy[0] !== '?' && xy[0] !== '!') staged.add(file);
    if (/[RC]/.test(xy)) {
      const previous = rows[++index];
      if (previous) { dirty.add(previous); if (xy[0] !== ' ') staged.add(previous); }
    }
  }
  return { dirtyFiles: [...dirty], stagedFiles: [...staged] };
}

function containsSecret(text, secretValues) {
  if (secretValues.some(secret => typeof secret === 'string' && secret.length >= 8 && text.includes(secret))) return true;
  if (/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/.test(text)) return true;
  if (/\b(?:gh[pousr]_[A-Za-z0-9_]{15,}|github_pat_[A-Za-z0-9_]{15,}|AIza[A-Za-z0-9_-]{20,}|sk-(?:proj-|ant-|or-v1-)?[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16}|ya29\.[A-Za-z0-9_-]{15,})\b/.test(text)) return true;
  const assignments = text.matchAll(/(?:api[_-]?key|secret|token|password|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*["']([^"'\r\n]{8,})["']/gi);
  for (const match of assignments) {
    if (!/^(?:\$\{|<|\{\{|process\.env\.|YOUR[_ -]|REPLACE[_ -]|EXAMPLE[_ -]|CHANGEME|placeholder|not[-_ ]?set)/i.test(match[1])) return true;
  }
  return false;
}

function checkedFile(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.length > 300 || /[\\:\x00-\x1f]/.test(relative) || path.isAbsolute(relative)) throw failure('The repair contains an unsafe file path.');
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /^(?:\.git|\.firebase|node_modules|workspaces)$/i.test(part))) throw failure('The repair contains an unsafe file path.');
  if (parts.some(part => /^\.env(?:[._-]|$)/i.test(part) || /^(?:(?:credentials?|secrets?)(?:[._-].*)?|service[-_]?account.*|firebase-adminsdk.*|id_(?:rsa|dsa|ecdsa|ed25519))$/i.test(part))) throw failure('Credential files cannot be published by automatic repair.');
  const allowedHidden = relative === '.firebaserc' || relative === '.gitignore' || /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(relative);
  if (parts.some(part => part.startsWith('.')) && !allowedHidden) throw failure('Hidden configuration files cannot be published by automatic repair.');
  if (!allowedHidden && !/\.(?:[cm]?[jt]sx?|json|ya?ml|html|css|scss|md|vue|svelte|astro|txt)$/i.test(relative)) throw failure('Automatic repair can publish ordinary source and deployment configuration files only.');
  if (/(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|credentials[^/]*|secrets[^/]*)$/i.test(relative)) throw failure('Lockfiles and credential files require a separate reviewed change.');
  const full = path.resolve(root, ...parts);
  if (!full.startsWith(root + path.sep)) throw failure('The repair file escapes the repository.');
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw failure('Automatic repair cannot publish symbolic links.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (fs.existsSync(full) && !fs.statSync(full).isFile()) throw failure('The repair must list individual files, not directories.');
  return full;
}

function configuredSecrets() {
  const { readSecrets } = require('./config');
  const saved = readSecrets();
  return [saved.githubToken, ...Object.values(saved.aiKeys || {})];
}

function createGitRepair({ run = defaultRun, github = defaultGithub, getSecretValues = configuredSecrets } = {}) {
  const snapshots = new WeakSet();
  // A unique nonexistent hooks directory disables repository hooks for every
  // command, including fetch reference updates. Disable executable fsmonitors.
  const disabledHooksPath = path.join(os.tmpdir(), 'fds-repair-disabled-hooks-' + crypto.randomUUID());

  async function git(root, args, options = {}) {
    const result = await run('git', ['-c', `core.hooksPath=${disabledHooksPath}`, '-c', 'core.fsmonitor=false', ...args], { cwd: root, timeout: 120000, ...options });
    if (result.code !== 0) throw failure('Git could not complete the repair operation. Your source files have been preserved.', 'GIT_REPAIR_FAILED');
    return result.stdout;
  }

  async function state(root) {
    const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
    const branch = (await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
    if (!branch) throw failure('Check out the repository default branch before publishing a repair.');
    const rawStatus = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (rawStatus.length >= 1900000) throw failure('The repository has too many local changes for automatic repair. Review and clean up its generated files first.');
    const status = parseStatus(rawStatus);
    return { head, branch, ...status };
  }

  async function captureRepairBaseline(projectPath) {
    const root = fs.realpathSync(projectPath);
    const top = fs.realpathSync((await git(root, ['rev-parse', '--show-toplevel'])).trim());
    if (top !== root) throw failure('Select the Git repository root before enabling GitHub repair.');
    const before = await state(root);
    const baseline = Object.freeze({ root, ...before, dirtyFiles: Object.freeze(before.dirtyFiles), stagedFiles: Object.freeze(before.stagedFiles), createdAt: Date.now() });
    snapshots.add(baseline);
    return baseline;
  }

  async function publishRepair({ projectPath, files, baseline, expectedHashes, title = 'Fix deployment configuration', body = 'Deployment configuration fixes prepared and reviewed in Firebase Direct Studio.', onLog = () => {}, secretValues = [] } = {}) {
    if (!baseline || !snapshots.has(baseline) || Date.now() - baseline.createdAt > 3600000) throw failure('Run the repair scan again before publishing. Its original Git snapshot is missing or expired.');
    const root = fs.realpathSync(projectPath);
    if (root !== baseline.root) throw failure('The selected repository changed after the repair scan. Scan it again.');
    if (!Array.isArray(files) || !files.length || files.length > 30 || files.some(file => typeof file !== 'string')) throw failure('There are no safe app-generated file changes to publish.');
    if (typeof title !== 'string' || !title.trim() || title.length > 120 || /[\r\n\x00]/.test(title) || typeof body !== 'string' || body.length > 12000) throw failure('The pull request title or description is invalid.');
    const secrets = [...getSecretValues(), ...(Array.isArray(secretValues) ? secretValues : [])];
    if (containsSecret(title + '\n' + body, secrets)) throw failure('The pull request text may contain a credential. Remove it before publishing.');
    const paths = [...new Set(files)];
    for (const file of paths) checkedFile(root, file);
    const current = await state(root);
    if (baseline.stagedFiles.length || current.stagedFiles.length) throw failure('Existing staged changes were found. Commit or unstage them yourself before running a new repair scan.');
    if (current.head !== baseline.head || current.branch !== baseline.branch) throw failure('The Git branch or commit changed after the repair scan. Scan again.');
    if (paths.some(file => baseline.dirtyFiles.includes(file))) throw failure('A repair file already contained local edits before the scan. Keep those edits separate and run a new scan from a clean version of that file.');
    const changed = paths.filter(file => current.dirtyFiles.includes(file));
    if (!changed.length) throw failure('There are no changed app-generated files to publish.');
    let totalBytes = 0;
    const fingerprints = new Map();
    for (const file of changed) {
      const full = checkedFile(root, file);
      const exists = fs.existsSync(full), content = exists ? fs.readFileSync(full) : Buffer.alloc(0);
      const fingerprint = exists ? crypto.createHash('sha256').update(content).digest('hex') : null;
      if (expectedHashes) {
        const supplied = expectedHashes instanceof Map ? expectedHashes.has(file) : Object.hasOwn(expectedHashes, file);
        const expected = expectedHashes instanceof Map ? expectedHashes.get(file) : expectedHashes[file];
        if (!supplied || expected !== fingerprint) throw failure('A repair file changed after the app prepared its fixes. Review the changes and run the repair again.');
      }
      totalBytes += content.byteLength;
      if (content.byteLength > 500000 || totalBytes > 2000000 || content.includes(0)) throw failure('The repair contains binary or oversized files. Review those changes manually.');
      if (containsSecret(content.toString('utf8'), secrets)) throw failure('A repair file may contain a credential. No changes were published.');
      fingerprints.set(file, fingerprint);
    }
    const diff = await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--', ...changed]);
    if (diff.length >= 1900000 || containsSecret(diff, secrets)) throw failure('The repair diff is oversized or may contain credentials. Review it manually.');
    const rawOrigin = (await git(root, ['remote', 'get-url', 'origin'])).trim();
    let repo; try { repo = github.normalizeRepo(rawOrigin); } catch { throw failure('Use a clean github.com HTTPS origin without credentials before publishing repairs.'); }
    const auth = await github.credential();
    if (!auth.token) throw failure('Connect GitHub with repository Contents and Pull requests write access before publishing a repair.', 'GITHUB_WRITE_REQUIRED');
    const metadata = await github.request(`/repos/${repo.fullName}`, auth);
    if (metadata.permissions?.push === false) throw failure('This GitHub account cannot push to the repository. Grant Contents and Pull requests write access.', 'GITHUB_WRITE_REQUIRED');
    const base = github.validateBranch(metadata.default_branch);
    if (current.branch !== base) throw failure('Switch to the repository default branch and run a new repair scan. Automatic repair does not combine another branch’s changes.');
    onLog('Checking the current GitHub default branch.', 'info');
    await git(root, ['fetch', '--no-tags', 'origin', base], { env: github.gitEnv(auth) });
    const remoteHead = (await git(root, ['rev-parse', 'FETCH_HEAD'])).trim();
    if (remoteHead !== baseline.head) throw failure('The local default branch differs from GitHub. Sync it first, preserve your local fixes, then run a new repair scan.');
    const afterNetwork = await state(root);
    if (afterNetwork.head !== baseline.head || afterNetwork.branch !== baseline.branch || afterNetwork.stagedFiles.length) throw failure('Git state changed while preparing the repair. No commit was made.');
    for (const file of changed) {
      const full = checkedFile(root, file), content = fs.existsSync(full) ? fs.readFileSync(full) : null;
      if ((content ? crypto.createHash('sha256').update(content).digest('hex') : null) !== fingerprints.get(file)) throw failure('A repair file changed during the GitHub check. Review it and scan again.');
    }

    const branch = `firebase-direct/repair-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}-${crypto.randomBytes(4).toString('hex')}`;
    const hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fds-repair-hooks-'));
    const gitOptions = ['-c', `core.hooksPath=${hooksDir}`];
    let staged = false, committed = false, pushed = false, commit = '';
    snapshots.delete(baseline);
    try {
      onLog('Creating a repair branch; the default branch will not be pushed.', 'info');
      await git(root, [...gitOptions, 'switch', '-c', branch]);
      await git(root, [...gitOptions, 'add', '--', ...changed]);
      staged = true;
      const stagedFiles = (await git(root, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean);
      if (stagedFiles.length !== changed.length || stagedFiles.some(file => !changed.includes(file))) throw failure('The Git index changed unexpectedly. No repair commit was made.');
      const stagedDiff = await git(root, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--', ...changed]);
      if (stagedDiff.length >= 1900000 || containsSecret(stagedDiff, secrets)) throw failure('The staged repair may contain credentials. No commit was made.');
      await git(root, [...gitOptions, '-c', 'commit.gpgSign=false', 'commit', '--no-gpg-sign', '-m', title.trim()], {
        env: { GIT_AUTHOR_NAME: 'Firebase Direct Studio', GIT_AUTHOR_EMAIL: 'firebase-direct-studio@users.noreply.github.com', GIT_COMMITTER_NAME: 'Firebase Direct Studio', GIT_COMMITTER_EMAIL: 'firebase-direct-studio@users.noreply.github.com' }
      });
      committed = true;
      commit = (await git(root, ['rev-parse', 'HEAD'])).trim();
      onLog('Pushing the repair branch to GitHub.', 'info');
      try { await git(root, [...gitOptions, 'push', '--set-upstream', 'origin', `HEAD:refs/heads/${branch}`], { env: github.gitEnv(auth) }); }
      catch { throw failure('The repair commit is saved locally, but GitHub rejected the push. Check repository Contents write access. No default branch was changed.', 'GITHUB_WRITE_REQUIRED'); }
      pushed = true;
      onLog('Opening a pull request for review.', 'info');
      let pull;
      try { pull = await github.request(`/repos/${repo.fullName}/pulls`, auth, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: title.trim(), body, head: branch, base, maintainer_can_modify: true }) }); }
      catch {
        try { const existing = await github.request(`/repos/${repo.fullName}/pulls?state=open&head=${encodeURIComponent(repo.owner + ':' + branch)}`, auth); pull = Array.isArray(existing) ? existing[0] : null; } catch {}
        if (!pull) throw failure('The repair branch was pushed, but creating its pull request failed. Check Pull requests write access and open a pull request from that branch.', 'GITHUB_PR_FAILED');
      }
      const expected = new RegExp(`^https://github\\.com/${repo.owner}/${repo.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/pull/[1-9][0-9]*$`, 'i');
      if (typeof pull.html_url !== 'string' || !expected.test(pull.html_url)) throw failure('GitHub did not return a valid pull request link. The repair branch is preserved.', 'GITHUB_PR_FAILED');
      return { branch, baseBranch: base, pullRequestUrl: pull.html_url, commit, fixedFiles: changed };
    } catch (error) {
      if (staged && !committed) { try { await git(root, [...gitOptions, 'restore', '--staged', '--', ...changed]); } catch {} }
      if (!committed) { try { await git(root, [...gitOptions, 'switch', baseline.branch]); } catch {} }
      error.details = { ...(error.details || {}), branch, commit, pushed, fixedFiles: changed, compareUrl: pushed ? `https://github.com/${repo.fullName}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}` : '' };
      throw error;
    } finally {
      fs.rmSync(hooksDir, { recursive: true, force: true });
    }
  }

  return { captureRepairBaseline, publishRepair };
}

const service = createGitRepair();
module.exports = { ...service, createGitRepair };
