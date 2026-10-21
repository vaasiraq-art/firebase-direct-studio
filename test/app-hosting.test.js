'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { stageSource, sensitiveName, secretContent, trackedExecutableFiles } = require('../lib/app-hosting');

function fixture(t, files) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fds-apphosting-test-'));
  const source = path.join(base, 'source');
  const destination = path.join(base, 'staging', 'deployment');
  fs.mkdirSync(source);
  for (const [relative, value] of Object.entries(files)) {
    const full = path.join(source, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
  }
  t.after(() => {
    const resolved = path.resolve(base);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('fds-apphosting-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { base, source, destination };
}
function stage(f, effectiveRoot = f.source, options = {}) { return stageSource({ projectRoot: f.source, effectiveRoot, destination: f.destination, backend: 'test-backend', ...options }); }
function sourceSnapshot(root) {
  const files = {};
  function visit(directory, relative = '') {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const rel = relative ? relative + '/' + item.name : item.name;
      const full = path.join(directory, item.name);
      if (item.isSymbolicLink()) files[rel] = 'SYMLINK:' + fs.readlinkSync(full);
      else if (item.isDirectory()) { files[rel + '/'] = 'DIR'; visit(full, rel); }
      else files[rel] = fs.readFileSync(full).toString('base64');
    }
  }
  visit(root);
  return files;
}

test('nested Next.js staging preserves server source and npm metadata while excluding private local data', t => {
  const f = fixture(t, {
    '.gitignore': 'ignored.txt\nstore/.local-data/\n',
    'ignored.txt': 'local data must stay local',
    '.git/config': 'private local remote metadata',
    '.aws/credentials': 'private local credentials',
    '.ssh/id_rsa': 'private key',
    'store/package.json': { scripts: { build: 'next build' }, dependencies: { next: '15', pg: '8' } },
    'store/package-lock.json': { lockfileVersion: 3, packages: {} },
    'store/next.config.ts': "export default {serverExternalPackages:['pg']};",
    'store/app/api/orders/route.ts': 'export async function POST(){return Response.json({ok:true})}',
    'store/app/actions.ts': "'use server'; export async function save(){return process.env.DATABASE_URL}",
    'store/db/schema.ts': 'export const schema = {};',
    'store/.env': 'DATABASE_URL=private-value',
    'store/.env.production.local': 'ADMIN_PASSWORD=private-value',
    'store/credentials.json': { password: 'private-value' },
    'store/secrets.txt': 'private untracked secret',
    'store/local-private.key': 'private key',
    'store/.local-data/orders.json': 'local customer data',
    'store/node_modules/package/index.js': 'dependency source',
    'store/.next/server/app.js': 'generated build',
    'store/public/favicon.png': Buffer.from([137, 80, 78, 71, 0, 1, 2, 3])
  });
  const before = sourceSnapshot(f.source);
  const result = stage(f, path.join(f.source, 'store'));
  assert.equal(result.directory, f.destination);
  assert.equal(result.appSubdir, 'store');
  for (const file of ['store/package.json', 'store/package-lock.json', 'store/next.config.ts', 'store/app/api/orders/route.ts', 'store/app/actions.ts', 'store/db/schema.ts', 'store/public/favicon.png']) {
    assert.deepEqual(fs.readFileSync(path.join(f.destination, file)), fs.readFileSync(path.join(f.source, file)));
  }
  for (const file of ['ignored.txt', '.git', '.aws', '.ssh', 'store/.env', 'store/.env.production.local', 'store/credentials.json', 'store/secrets.txt', 'store/local-private.key', 'store/.local-data', 'store/node_modules', 'store/.next']) assert.equal(fs.existsSync(path.join(f.destination, file)), false, file);
  const config = JSON.parse(fs.readFileSync(result.configPath));
  assert.equal(config.apphosting[0].rootDir, 'store');
  assert.equal(config.apphosting[0].backendId, 'test-backend');
  assert.equal(config.apphosting[0].alwaysDeployFromSource, true);
  assert.equal(config.hosting, undefined);
  assert.match(fs.readFileSync(path.join(f.destination, 'store/apphosting.yaml'), 'utf8'), /maxInstances: 1/);
  assert.deepEqual(sourceSnapshot(f.source), before);
});

test('staging replaces source Firebase hooks with a minimal App Hosting config without changing source', t => {
  const original = JSON.stringify({ hosting: { public: 'out', predeploy: ['echo must-never-run'], postdeploy: ['echo must-never-run'] }, functions: { source: 'functions', predeploy: ['echo must-never-run'] }, apphosting: [{ backendId: 'other-backend', predeploy: ['echo must-never-run'] }] });
  const f = fixture(t, { 'package.json': { scripts: { build: 'next build' }, dependencies: { next: '15' } }, 'firebase.json': original });
  const result = stage(f);
  const config = JSON.parse(fs.readFileSync(result.configPath));
  assert.deepEqual(Object.keys(config), ['apphosting']);
  assert.equal(JSON.stringify(config).includes('predeploy'), false);
  assert.equal(JSON.stringify(config).includes('postdeploy'), false);
  assert.equal(config.apphosting[0].rootDir, '.');
  assert.equal(config.apphosting[0].backendId, 'test-backend');
  assert.equal(fs.readFileSync(path.join(f.source, 'firebase.json'), 'utf8'), original);
  assert.equal(fs.existsSync(path.join(f.source, 'apphosting.yaml')), false);
});

test('existing App Hosting YAML secret references and limits are preserved byte for byte', t => {
  const yaml = 'runConfig:\n  minInstances: 0\n  maxInstances: 2\nenv:\n  - variable: DATABASE_URL\n    secret: database-url\n';
  const f = fixture(t, { 'package.json': { dependencies: { next: '15' } }, 'apphosting.yaml': yaml });
  stage(f);
  assert.equal(fs.readFileSync(path.join(f.destination, 'apphosting.yaml'), 'utf8'), yaml);
  assert.equal(fs.readFileSync(path.join(f.source, 'apphosting.yaml'), 'utf8'), yaml);
});

test('source staging respects nested Git ignore rules and negated source exceptions', t => {
  const f = fixture(t, {
    '.gitignore': '*.cache\n',
    'store/.gitignore': 'private/\n*.generated.ts\n!keep.generated.ts\n',
    'store/package.json': { dependencies: { next: '15' } },
    'store/root.cache': 'ignored cache',
    'store/private/local.json': 'ignored private data',
    'store/remove.generated.ts': 'ignored generated source',
    'store/keep.generated.ts': 'export const keep = true;',
    'store/app/page.tsx': 'export default function Page(){return null}'
  });
  stage(f, path.join(f.source, 'store'));
  assert.equal(fs.existsSync(path.join(f.destination, 'store/root.cache')), false);
  assert.equal(fs.existsSync(path.join(f.destination, 'store/private')), false);
  assert.equal(fs.existsSync(path.join(f.destination, 'store/remove.generated.ts')), false);
  assert.equal(fs.existsSync(path.join(f.destination, 'store/keep.generated.ts')), true);
  assert.equal(fs.existsSync(path.join(f.destination, 'store/app/page.tsx')), true);
});

test('source staging rejects embedded credentials before creating an upload directory', t => {
  for (const content of [
    'const key = "' + 'sk-' + 'proj-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";',
    'const key = "' + 'ghp' + '_abcdefghijklmnopqrstuvwxyz1234567890";',
    '-----BEGIN ' + 'PRIVATE KEY-----\nsynthetic-key-material',
    'const settings = {password:"synthetic-long-private-password"};',
    'const key = "known-synthetic-sensitive-value";'
  ]) {
    const f = fixture(t, { 'package.json': { dependencies: { next: '15' } }, 'app/page.tsx': content });
    const before = sourceSnapshot(f.source);
    assert.throws(() => stage(f, f.source, { secretValues: ['known-synthetic-sensitive-value'] }), /Potential hardcoded credential/);
    assert.equal(fs.existsSync(f.destination), false);
    assert.deepEqual(sourceSnapshot(f.source), before);
  }
});

test('source symlinks and junctions cannot upload files outside the repository', t => {
  const f = fixture(t, { 'package.json': { dependencies: { next: '15' } } });
  const outside = path.join(f.base, 'private'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'private.txt'), 'private data');
  fs.symlinkSync(outside, path.join(f.source, 'linked'), 'junction');
  const before = sourceSnapshot(f.source);
  assert.throws(() => stage(f), /symbolic link|junction/);
  assert.equal(fs.existsSync(f.destination), false);
  assert.deepEqual(sourceSnapshot(f.source), before);
});

test('the effective app must be inside the repository and staging must be disjoint from source', t => {
  const f = fixture(t, { 'package.json': { dependencies: { next: '15' } } });
  const outside = path.join(f.base, 'outside'); fs.mkdirSync(outside);
  assert.throws(() => stage(f, outside), /outside the source|separate/);
  assert.throws(() => stage(f, f.source, { destination: path.join(f.source, 'upload') }), /outside the source|separate/);
  assert.throws(() => stage(f, f.source, { destination: f.base }), /outside the source|separate/);
  assert.equal(fs.existsSync(path.join(f.source, 'upload')), false);
});

test('staging cannot traverse an existing junction back into the source repository', t => {
  const f = fixture(t, { 'package.json': { dependencies: { next: '15' } }, 'app/page.tsx': 'export default function Page(){return null}' });
  const junction = path.join(f.base, 'staging-alias');
  fs.symlinkSync(f.source, junction, 'junction');
  const before = sourceSnapshot(f.source);
  assert.throws(() => stage(f, f.source, { destination: path.join(junction, 'upload') }), /staging|junction|symbolic|outside|separate/);
  assert.deepEqual(sourceSnapshot(f.source), before);
});

test('source staging does not overwrite existing staging directories', t => {
  const f = fixture(t, { 'package.json': { dependencies: { next: '15' } } });
  fs.mkdirSync(f.destination, { recursive: true });
  fs.writeFileSync(path.join(f.destination, 'preserve.txt'), 'existing deployment');
  assert.throws(() => stage(f), /already exists/);
  assert.equal(fs.readFileSync(path.join(f.destination, 'preserve.txt'), 'utf8'), 'existing deployment');
});

test('excluded npm app metadata fails before writing staging files', t => {
  const f = fixture(t, { '.gitignore': 'store/package.json\n', 'store/package.json': { dependencies: { next: '15' } } });
  assert.throws(() => stage(f, path.join(f.source, 'store')), /package.json is excluded/);
  assert.equal(fs.existsSync(f.destination), false);
});

test('large individual source files are rejected before reading or copying them', t => {
  const f = fixture(t, { 'package.json': { dependencies: { next: '15' } }, 'large.bin': '' });
  fs.truncateSync(path.join(f.source, 'large.bin'), 50 * 1024 * 1024 + 1);
  assert.throws(() => stage(f), /too large/);
  assert.equal(fs.existsSync(f.destination), false);
});

test('sensitive file naming excludes local credentials while allowing environment references', () => {
  for (const name of ['.env', '.env.production', '.npmrc', '.netrc', 'secrets.json', 'credentials.txt', 'service-account.json', 'private.pem', 'local.sqlite', 'desktop.lnk']) assert.equal(sensitiveName(name), true, name);
  assert.equal(sensitiveName('package.json'), false);
  assert.equal(sensitiveName('apphosting.yaml'), false);
  assert.equal(secretContent('export const token = process.env.API_KEY;', []), false);
  assert.equal(secretContent('apiKey: "YOUR_EXAMPLE_API_KEY_PLACEHOLDER"', []), false);
  assert.equal(secretContent('actual-value-known-only-to-test', ['actual-value-known-only-to-test']), true);
});

function testChildEnvironment(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_|^GCM_|TOKEN|API_KEY|SECRET|PASSWORD|CREDENTIAL|^NODE_OPTIONS$/i.test(key)) delete env[key];
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0', ...extra };
}
function gitForFixture(directory, args) {
  const out = spawnSync('git', ['--no-pager', '--no-optional-locks', '-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), '-c', 'core.fsmonitor=false', ...args], { cwd: directory, env: testChildEnvironment(), encoding: 'utf8', shell: false, windowsHide: true, timeout: 15000 });
  assert.equal(out.error, undefined);
  assert.equal(out.status, 0, 'Local fixture Git operation failed.');
  return out.stdout;
}
function executableFixture(t) {
  const f = fixture(t, {
    'package.json': { scripts: { build: './scripts/build.sh' }, dependencies: { next: '15' } },
    'scripts/build.sh': '#!/bin/sh\nexec node build.js\n',
    'scripts/ordinary.js': 'console.log("ordinary source");'
  });
  gitForFixture(f.source, ['-c', 'init.templateDir=', 'init', '--quiet']);
  gitForFixture(f.source, ['add', '--', 'package.json', 'scripts/ordinary.js']);
  gitForFixture(f.source, ['add', '--chmod=+x', '--', 'scripts/build.sh']);
  if (process.platform !== 'win32') {
    fs.chmodSync(path.join(f.source, 'scripts/build.sh'), 0o4751);
    fs.chmodSync(path.join(f.source, 'scripts/ordinary.js'), 0o600);
  }
  return f;
}
function zipEntryModes(file) {
  const bytes = fs.readFileSync(file);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0, 'ZIP end-of-directory record must exist.');
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const modes = {};
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    modes[name] = (bytes.readUInt32LE(offset + 38) >>> 16) & 0o7777;
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return modes;
}

test('staging recovers Git-index 100755 modes on Windows and records only safe executable source paths', t => {
  const f = executableFixture(t);
  assert.deepEqual([...trackedExecutableFiles(f.source)], ['scripts/build.sh']);
  const before = sourceSnapshot(f.source);
  const result = stage(f);
  assert.deepEqual(result.executableFiles, ['scripts/build.sh']);
  assert.equal(result.modesPath, f.destination + '.modes.json');
  assert.equal(fs.existsSync(path.join(f.destination, '.modes.json')), false);
  const manifest = JSON.parse(fs.readFileSync(result.modesPath));
  assert.deepEqual(manifest, { root: f.destination, executableFiles: ['scripts/build.sh'] });
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(f.destination, 'scripts/build.sh')).mode & 0o7777, 0o755);
    assert.equal(fs.statSync(path.join(f.destination, 'scripts/ordinary.js')).mode & 0o7777, 0o644);
  }
  assert.deepEqual(sourceSnapshot(f.source), before);
});

test('the pinned Firebase App Hosting ZIP records executable0755 and ordinary0644 with the controlled preload', t => {
  const f = executableFixture(t);
  const result = stage(f);
  const before = sourceSnapshot(f.source);
  const preload = path.resolve(__dirname, '../lib/firebase-source-modes.js');
  const code = 'globalThis.fetch=()=>Promise.reject(new Error("Network is forbidden in archive test")); require(process.argv[2]).createSourceDeployArchive({backendId:"test-backend",ignore:[".git","node_modules"]},process.argv[1],"").then(file=>process.stdout.write(JSON.stringify({file}))).catch(error=>{process.stderr.write(error.message);process.exitCode=1;});';
  const child = spawnSync(process.execPath, ['--require', preload, '-e', code, result.directory, require.resolve('firebase-tools/lib/deploy/apphosting/util')], { cwd: f.base, env: testChildEnvironment({ FDS_SOURCE_MODES_PATH: result.modesPath }), encoding: 'utf8', shell: false, windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  const archive = JSON.parse(child.stdout).file;
  assert.ok(path.resolve(archive).startsWith(path.resolve(os.tmpdir()) + path.sep));
  assert.ok(path.basename(archive).startsWith('test-backend-') && archive.endsWith('.zip'));
  t.after(() => fs.unlinkSync(archive));
  const modes = zipEntryModes(archive);
  assert.equal(modes['scripts/build.sh'], 0o755);
  assert.equal(modes['scripts/ordinary.js'], 0o644);
  assert.equal(modes['package.json'], 0o644);
  assert.equal(modes['firebase.json'], 0o644);
  assert.equal(Object.keys(modes).some(name => name.endsWith('.modes.json')), false);
  assert.deepEqual(sourceSnapshot(f.source), before);
});

test('the source mode preload rejects executable traversal and symlink metadata before loading Firebase', t => {
  const f = fixture(t, { 'package.json': { dependencies: { next: '15' } } });
  const result = stage(f);
  const preload = path.resolve(__dirname, '../lib/firebase-source-modes.js');
  const runPreload = manifest => spawnSync(process.execPath, ['--require', preload, '-e', 'process.stdout.write("loaded")'], { cwd: f.base, env: testChildEnvironment({ FDS_SOURCE_MODES_PATH: manifest }), encoding: 'utf8', shell: false, windowsHide: true, timeout: 15000 });
  for (const executableFiles of [['../outside.js'], ['C:/outside.js'], ['scripts\\outside.js'], ['missing.js']]) {
    fs.writeFileSync(result.modesPath, JSON.stringify({ root: result.directory, executableFiles }));
    const out = runPreload(result.modesPath);
    assert.notEqual(out.status, 0);
    assert.equal(out.stdout.includes('loaded'), false);
  }
  const linkedManifest = path.join(f.base, 'metadata-alias');
  fs.mkdirSync(linkedManifest);
  fs.writeFileSync(path.join(linkedManifest, 'outside.modes.json'), '{}');
  fs.symlinkSync(linkedManifest, path.join(f.base, 'metadata-link'), 'junction');
  const linked = runPreload(path.join(f.base, 'metadata-link/outside.modes.json'));
  assert.notEqual(linked.status, 0);
  assert.match(linked.stderr, /symbolic links|junctions/);
});
