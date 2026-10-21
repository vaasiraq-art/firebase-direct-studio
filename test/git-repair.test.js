'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { run: realRun } = require('../lib/process');
const realGithub = require('../lib/github');
const { createGitRepair } = require('../lib/git-repair');

async function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fds-git-repair-test-'));
  const hooks = path.join(root, 'empty-hooks');
  fs.mkdirSync(hooks);
  const env = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  async function git(args) {
    const result = await realRun('git', ['-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgSign=false', ...args], { cwd: root, env });
    assert.equal(result.code, 0, `Fixture git ${args[0]} failed.`);
    return result.stdout;
  }
  await git(['init', '-b', 'main']);
  fs.writeFileSync(path.join(root, 'firebase.json'), '{"hosting":{"public":"public"}}\n');
  fs.writeFileSync(path.join(root, 'README.md'), 'Original documentation\n');
  await git(['add', 'firebase.json', 'README.md']);
  await git(['commit', '--no-gpg-sign', '-m', 'Initial fixture']);
  await git(['remote', 'add', 'origin', 'https://github.com/example/repair-app.git']);
  const initialHead = (await git(['rev-parse', 'HEAD'])).trim();
  const calls = [], apiCalls = [];
  const auth = { token: 'fixture-auth-token-do-not-log', source: 'fixture' };
  const control = { pushFails: false, prFails: false, commitFails: false, remoteHead: initialHead, ...overrides };
  const github = {
    normalizeRepo: realGithub.normalizeRepo,
    validateBranch: realGithub.validateBranch,
    gitEnv: realGithub.gitEnv,
    credential: async () => control.noCredential ? { token: '', source: 'none' } : auth,
    request: async (route, passedAuth, options) => {
      assert.equal(passedAuth.token, auth.token);
      apiCalls.push({ route, options });
      if (route === '/repos/example/repair-app') return { default_branch: 'main', permissions: { push: !control.noWrite } };
      if (options?.method === 'POST' && route.endsWith('/pulls')) {
        if (control.prFails) throw new Error('Mock PR creation denied.');
        return { html_url: control.prUrl || 'https://github.com/example/repair-app/pull/3' };
      }
      if (route.includes('/pulls?')) return [];
      throw new Error('Unexpected GitHub route in fixture.');
    }
  };
  const service = createGitRepair({
    github,
    getSecretValues: () => ['known-configured-credential'],
    run: async (name, args, options) => {
      assert.equal(name, 'git');
      let index = 0;
      while (args[index] === '-c') index += 2;
      const verb = args[index];
      calls.push({ verb, args, options });
      assert.ok(!args.join(' ').includes(auth.token));
      if (verb === 'fetch') {
        fs.writeFileSync(path.join(root, '.git', 'FETCH_HEAD'), control.remoteHead + '\n');
        if (control.changeDuringFetch) fs.writeFileSync(path.join(root, 'firebase.json'), '{"changed":"externally"}\n');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (verb === 'push') return { code: control.pushFails ? 1 : 0, stdout: '', stderr: '' };
      if (verb === 'commit' && control.commitFails) return { code: 1, stdout: '', stderr: '' };
      return realRun(name, args, options);
    }
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return { root, git, service, initialHead, calls, apiCalls, control };
}

const change = root => fs.writeFileSync(path.join(root, 'firebase.json'), '{"hosting":{"public":"dist","ignore":["**/.*"]}}\n');

test('publishes only app files on a repair branch and preserves unrelated local edits', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.root, 'README.md'), 'User edits must stay local\n');
  const baseline = await f.service.captureRepairBaseline(f.root);
  change(f.root);
  fs.writeFileSync(path.join(f.root, 'apphosting.yaml'), 'runConfig:\n  minInstances: 0\n');
  const logs = [];
  const hashes = new Map(['firebase.json', 'apphosting.yaml'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(f.root, file))).digest('hex')]));
  const result = await f.service.publishRepair({ projectPath: f.root, baseline, files: ['firebase.json', 'apphosting.yaml'], expectedHashes: hashes, onLog: message => logs.push(message) });
  assert.match(result.branch, /^firebase-direct\/repair-\d{14}-[0-9a-f]{8}$/);
  assert.equal(result.baseBranch, 'main');
  assert.equal(result.pullRequestUrl, 'https://github.com/example/repair-app/pull/3');
  assert.deepEqual(result.fixedFiles, ['firebase.json', 'apphosting.yaml']);
  assert.equal((await f.git(['rev-parse', 'main'])).trim(), f.initialHead);
  assert.equal((await f.git(['branch', '--show-current'])).trim(), result.branch);
  const committed = (await f.git(['show', '--pretty=format:', '--name-only', result.commit])).trim().split(/\r?\n/).sort();
  assert.deepEqual(committed, ['apphosting.yaml', 'firebase.json']);
  assert.match(await f.git(['status', '--porcelain']), /README\.md/);
  assert.equal((await f.git(['log', '-1', '--format=%an <%ae>'])).trim(), 'Firebase Direct Studio <firebase-direct-studio@users.noreply.github.com>');
  assert.ok(!JSON.stringify(logs).includes('fixture-auth-token'));
  const push = f.calls.find(call => call.verb === 'push');
  assert.ok(push.args.includes(`HEAD:refs/heads/${result.branch}`));
  assert.ok(!push.args.some(arg => arg === '--force' || arg === '-f'));
  assert.ok(push.options.env.GIT_CONFIG_VALUE_0.startsWith('AUTHORIZATION: basic '));
  const pull = JSON.parse(f.apiCalls.find(call => call.options?.method === 'POST').options.body);
  assert.equal(pull.head, result.branch);
  assert.equal(pull.base, 'main');
  assert.equal((await f.git(['remote', 'get-url', 'origin'])).trim(), 'https://github.com/example/repair-app.git');
});

test('rejects staged user changes without altering the index or creating a branch', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.root, 'README.md'), 'Staged user edits\n');
  await f.git(['add', 'README.md']);
  const baseline = await f.service.captureRepairBaseline(f.root);
  change(f.root);
  await assert.rejects(f.service.publishRepair({ projectPath: f.root, baseline, files: ['firebase.json'] }), /Existing staged changes/);
  assert.equal((await f.git(['diff', '--cached', '--name-only'])).trim(), 'README.md');
  assert.equal((await f.git(['branch', '--show-current'])).trim(), 'main');
  assert.equal(f.apiCalls.length, 0);
});

test('rejects candidate files that already contained user edits before the scan', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.root, 'firebase.json'), '{"user":"local edit"}\n');
  const baseline = await f.service.captureRepairBaseline(f.root);
  change(f.root);
  await assert.rejects(f.service.publishRepair({ projectPath: f.root, baseline, files: ['firebase.json'] }), /already contained local edits/);
  assert.equal((await f.git(['rev-parse', 'HEAD'])).trim(), f.initialHead);
  assert.equal(f.apiCalls.length, 0);
});

test('requires an authentic baseline and refuses changed branches or a diverged default branch', async t => {
  const f = await fixture(t);
  const baseline = await f.service.captureRepairBaseline(f.root);
  change(f.root);
  await assert.rejects(f.service.publishRepair({ projectPath: f.root, baseline: { ...baseline }, files: ['firebase.json'] }), /snapshot is missing/);
  f.control.remoteHead = '1234567890123456789012345678901234567890';
  await assert.rejects(f.service.publishRepair({ projectPath: f.root, baseline, files: ['firebase.json'] }), /differs from GitHub/);
  assert.equal(f.calls.some(call => call.verb === 'push'), false);
  await f.git(['switch', '-c', 'user-feature']);
  await assert.rejects(f.service.publishRepair({ projectPath: f.root, baseline, files: ['firebase.json'] }), /branch or commit changed/);
});

test('blocks credential paths, traversal, symbolic links, and embedded credentials before GitHub access', async t => {
  const f = await fixture(t);
  const baseline = await f.service.captureRepairBaseline(f.root);
  for (const file of ['../outside.js', '.env', '.env.production', 'credentials.json', 'serviceAccountKey.json', '.git/config', 'node_modules/package/source.js', 'folder\\source.js', 'package-lock.json']) {
    await assert.rejects(f.service.publishRepair({ projectPath: f.root, baseline, files: [file] }), `Expected unsafe path rejection for ${file}`);
  }
  const linked = path.join(f.root, 'linked');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fds-git-repair-target-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  try {
    fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.service.publishRepair({ projectPath: f.root, baseline, files: ['linked/source.js'] }), /symbolic links/);
  } catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; t.diagnostic('Symlink creation unavailable on this runner.'); }
  finally { fs.rmSync(linked, { recursive: true, force: true }); }
  fs.writeFileSync(path.join(f.root, 'source.js'), 'const key = "known-configured-credential";\n');
  await assert.rejects(f.service.publishRepair({ projectPath: f.root, baseline, files: ['source.js'] }), /may contain a credential/);
  fs.writeFileSync(path.join(f.root, 'source.js'), 'const key = "' + 'ghp' + '_abcdefghijklmnopqrstuvwxyz";\n');
  await assert.rejects(f.service.publishRepair({ projectPath: f.root, baseline, files: ['source.js'] }), /may contain a credential/);
  fs.writeFileSync(path.join(f.root, 'source.js'), 'const password = "a-hardcoded-password";\n');
  await assert.rejects(f.service.publishRepair({ projectPath: f.root, baseline, files: ['source.js'] }), /may contain a credential/);
  assert.equal(f.apiCalls.length, 0);
  assert.equal((await f.git(['rev-parse', 'HEAD'])).trim(), f.initialHead);
});

test('refuses missing write permission and concurrent changes without committing source', async t => {
  const f = await fixture(t, { noWrite: true });
  const baseline = await f.service.captureRepairBaseline(f.root);
  change(f.root);
  await assert.rejects(f.service.publishRepair({ projectPath: f.root, baseline, files: ['firebase.json'] }), /cannot push/);
  f.control.noWrite = false;
  f.control.changeDuringFetch = true;
  await assert.rejects(f.service.publishRepair({ projectPath: f.root, baseline, files: ['firebase.json'] }), /changed during/);
  assert.equal((await f.git(['rev-parse', 'HEAD'])).trim(), f.initialHead);
  assert.equal((await f.git(['branch', '--show-current'])).trim(), 'main');
});

test('rejects source edits made after the app recorded its repair hashes', async t => {
  const f = await fixture(t);
  const baseline = await f.service.captureRepairBaseline(f.root);
  change(f.root);
  const hashes = new Map([['firebase.json', crypto.createHash('sha256').update(fs.readFileSync(path.join(f.root, 'firebase.json'))).digest('hex')]]);
  fs.writeFileSync(path.join(f.root, 'firebase.json'), '{"user":"edited after repair"}\n');
  await assert.rejects(f.service.publishRepair({ projectPath: f.root, baseline, files: ['firebase.json'], expectedHashes: hashes }), /changed after the app prepared/);
  assert.equal(f.apiCalls.length, 0);
  assert.equal((await f.git(['rev-parse', 'HEAD'])).trim(), f.initialHead);
});

test('failed commits unstage only repair files and preserve their working copies', async t => {
  const f = await fixture(t, { commitFails: true });
  const baseline = await f.service.captureRepairBaseline(f.root);
  change(f.root);
  await assert.rejects(f.service.publishRepair({ projectPath: f.root, baseline, files: ['firebase.json'] }), /Git could not complete/);
  assert.equal((await f.git(['diff', '--cached', '--name-only'])).trim(), '');
  assert.equal((await f.git(['branch', '--show-current'])).trim(), 'main');
  assert.match(fs.readFileSync(path.join(f.root, 'firebase.json'), 'utf8'), /dist/);
  assert.equal(f.calls.some(call => call.verb === 'push'), false);
});

test('push and PR failures preserve repair commits and never claim a completed pull request', async t => {
  const f = await fixture(t, { pushFails: true });
  let baseline = await f.service.captureRepairBaseline(f.root);
  change(f.root);
  await assert.rejects(f.service.publishRepair({ projectPath: f.root, baseline, files: ['firebase.json'] }), error => {
    assert.equal(error.code, 'GITHUB_WRITE_REQUIRED');
    assert.match(error.details.commit, /^[a-f0-9]{40}$/);
    assert.equal(error.details.pushed, false);
    return true;
  });
  assert.equal(f.apiCalls.some(call => call.options?.method === 'POST'), false);
  const second = await fixture(t, { prFails: true });
  baseline = await second.service.captureRepairBaseline(second.root);
  change(second.root);
  await assert.rejects(second.service.publishRepair({ projectPath: second.root, baseline, files: ['firebase.json'] }), error => {
    assert.equal(error.code, 'GITHUB_PR_FAILED');
    assert.equal(error.details.pushed, true);
    assert.match(error.details.compareUrl, /^https:\/\/github\.com\/example\/repair-app\/compare\//);
    return true;
  });
});
