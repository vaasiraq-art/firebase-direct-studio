'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ignore = require('ignore');
const { backendId } = require('./firebase');

const EXCLUDED_DIRS = new Set(['.git', '.next', '.next-dev', '.firebase', '.cache', '.turbo', '.local', '.aws', '.ssh', '.config', 'node_modules', 'coverage', 'test-results', 'playwright-report']);
function sensitiveName(name) { return /^\.env(?:[._-]|$)/i.test(name) || /^(?:\.npmrc|\.netrc|\.DS_Store|credentials(?:[._-].*)?|secrets?(?:[._-].*)?|.*service[-_]?account.*\.json|firebase-adminsdk.*|id_(?:rsa|dsa|ecdsa|ed25519))$/i.test(name) || /\.(?:pem|key|p12|pfx|sqlite3?|db|bak|log|lnk|enc)$/i.test(name); }
function secretContent(text, secrets) { return secrets.some(v => typeof v === 'string' && v.length > 7 && text.includes(v)) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{30,}|AIza[A-Za-z0-9_-]{30,}|sk-(?:proj-|ant-|or-v1-)?[A-Za-z0-9_-]{25,}|[sr]k_live_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/.test(text) || /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)["']?\s*[:=]\s*["'](?!\$\{|process\.env\.|YOUR_|REPLACE_|EXAMPLE_|placeholder)[^"'\r\n]{12,}["']/i.test(text); }
function inside(root, target) { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); }

function trackedExecutableFiles(source) {
  // Windows does not expose Unix execute bits. Read only the index; no hooks,
  // filters, credential helpers, or shell commands are needed to recover 100755.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_|^GCM_|TOKEN|API_KEY|SECRET|PASSWORD|CREDENTIAL/i.test(key)) delete env[key];
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' });
  const result = spawnSync('git', ['--no-pager', '--no-optional-locks', '-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), '-c', 'core.fsmonitor=false', 'ls-files', '--stage', '-z', '--', '.'], { cwd: source, encoding: 'utf8', env, shell: false, windowsHide: true, timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) return new Set();
  const executable = new Set();
  for (const entry of result.stdout.split('\0')) {
    const match = entry.match(/^100755 [a-f0-9]+ 0\t(.+)$/s);
    if (!match) continue;
    const relative = match[1];
    if (relative.includes('\\') || path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) continue;
    if (inside(source, path.resolve(source, relative))) executable.add(relative);
  }
  return executable;
}

function stageSource({ projectRoot, effectiveRoot, destination, backend, secretValues = [] }) {
  backendId(backend);
  const source = fs.realpathSync(projectRoot), app = fs.realpathSync(effectiveRoot), dest = path.resolve(destination);
  const modesPath = dest + '.modes.json';
  let ancestor = dest;
  while (true) {
    try { if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('App Hosting staging paths cannot contain symbolic links or junctions.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
  }
  if (!inside(source, app) || inside(source, dest) || inside(dest, source)) throw new Error('Use a separate App Hosting staging folder outside the source repository.');
  if (fs.existsSync(dest)) throw new Error('This deployment staging folder already exists. Start a new deployment.');
  try { fs.lstatSync(modesPath); throw new Error('This deployment permission manifest already exists. Start a new deployment.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const trackedExecutables = process.platform === 'win32' ? trackedExecutableFiles(source) : new Set();
  const files = []; let totalBytes = 0;
  function visit(directory, relative = '', inherited = []) {
    const rules = [...inherited], ignoreFile = path.join(directory, '.gitignore');
    if (fs.existsSync(ignoreFile)) { const stat = fs.lstatSync(ignoreFile); if (stat.isSymbolicLink() || stat.size > 65536) throw new Error('The project contains an unsafe .gitignore file.'); rules.push({ directory, matcher: ignore().add(fs.readFileSync(ignoreFile, 'utf8')) }); }
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (EXCLUDED_DIRS.has(item.name) || sensitiveName(item.name) || /^firebase-debug/.test(item.name)) continue;
      const absolute = path.join(directory, item.name), rel = relative ? relative + '/' + item.name : item.name;
      let ignored = false;
      for (let i = rules.length - 1; i >= 0; i--) { const match = rules[i].matcher.test(path.relative(rules[i].directory, absolute).replace(/\\/g, '/') + (item.isDirectory() ? '/' : '')); if (match.ignored || match.unignored) { ignored = match.ignored; break; } }
      if (ignored) continue;
      if (item.isSymbolicLink()) throw new Error(`Source contains a symbolic link or junction: ${rel}. Remove it before uploading source.`);
      if (!inside(source, fs.realpathSync(absolute))) throw new Error('A source file leaves the project directory.');
      if (item.isDirectory()) { visit(absolute, rel, rules); continue; }
      if (!item.isFile()) throw new Error('Source contains a special file that cannot be uploaded.');
      const stat = fs.statSync(absolute); totalBytes += stat.size;
      if (stat.size > 50 * 1024 * 1024 || totalBytes > 250 * 1024 * 1024 || files.length >= 20000) throw new Error('Source upload is too large. Use a clean app repository without generated assets or local data.');
      const bytes = fs.readFileSync(absolute);
      if (!bytes.includes(0) && secretContent(bytes.toString('utf8'), secretValues)) throw new Error(`Potential hardcoded credential in ${rel}. Move it to Firebase Secret Manager before deploying.`);
      files.push({ relative: rel, bytes, mode: (stat.mode & 0o111) || trackedExecutables.has(rel) ? 0o755 : 0o644 });
    }
  }
  visit(source);
  const appSubdir = path.relative(source, app).replace(/\\/g, '/') || '.';
  const packageFile = (appSubdir === '.' ? '' : appSubdir + '/') + 'package.json';
  if (!files.some(file => file.relative === packageFile)) throw new Error('The app package.json is excluded from deployment. Check .gitignore and your app folder.');
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  // Cloud Build's non-root buildpack user must be able to read archived source.
  // The staging directory itself stays private to the local account.
  for (const file of files) { const target = path.join(dest, file.relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, file.bytes, { mode: file.mode, flag: 'wx' }); fs.chmodSync(target, file.mode); }
  const config = { apphosting: [{ backendId: backend, rootDir: appSubdir, alwaysDeployFromSource: true, ignore: ['node_modules', '.git', '**/.env*', '**/*.pem', '**/*.key', 'firebase-debug.log', 'firebase-debug.*.log'] }] };
  fs.writeFileSync(path.join(dest, 'firebase.json'), JSON.stringify(config, null, 2));
  const yamlPath = path.join(dest, appSubdir === '.' ? '' : appSubdir, 'apphosting.yaml');
  if (!fs.existsSync(yamlPath)) fs.writeFileSync(yamlPath, '# Runtime limits for this App Hosting deployment.\nrunConfig:\n  minInstances: 0\n  maxInstances: 1\n');
  const executableFiles = files.filter(file => file.mode === 0o755).map(file => file.relative).sort();
  fs.writeFileSync(modesPath, JSON.stringify({ root: dest, executableFiles }), { mode: 0o600, flag: 'wx' });
  return { directory: dest, configPath: path.join(dest, 'firebase.json'), modesPath, executableFiles, appSubdir, fileCount: files.length, totalBytes };
}
module.exports = { stageSource, sensitiveName, secretContent, trackedExecutableFiles };
