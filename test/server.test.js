'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fds-server-test-'));
const project = path.join(temp, 'website');
fs.mkdirSync(project);
fs.writeFileSync(path.join(project, 'index.html'), '<!doctype html><title>Test website</title>');
process.env.FDS_DATA_DIR = path.join(temp, 'data');
process.env.PORT = '14565';
const config = require('../lib/config');
// Importing the test server must never migrate the real project's legacy config.
config.migrateLegacyConfig = () => {};
const processes = require('../lib/process');
let runMock = async () => { throw new Error('Unexpected external command in server test.'); };
processes.run = (...args) => runMock(...args);
processes.command = (name, args) => ({ file: name, args });
const { app, safePatchFile, firebaseId } = require('../server');
let server;
let port;
let csrfToken;

function request(route, { method = 'GET', data, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const body = data === undefined ? undefined : JSON.stringify(data);
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: { Host: 'localhost:14565', ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}), ...headers } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let json; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
const post = (route, data, headers = {}) => request(route, { method: 'POST', data, headers: { 'X-CSRF-Token': csrfToken, ...headers } });

before(async () => {
  config.saveConfig({ activeProjectPath: project, recentProjects: [{ name: 'website', path: project }], githubDisconnected: true });
  config.readSecrets().githubToken = 'test-private-github-secret';
  config.readSecrets().aiKeys = { openai: 'test-private-ai-secret' };
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  port = server.address().port;
  csrfToken = (await request('/api/session')).json.csrfToken;
});
after(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
});

test('local health has security headers and browser writes require the session token', async () => {
  const health = await request('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.app, 'firebase-direct-studio');
  assert.equal(health.headers['x-content-type-options'], 'nosniff');
  assert.equal(health.headers['x-frame-options'], 'DENY');
  assert.ok(health.headers['content-security-policy'].includes("script-src 'self'"));
  assert.equal(health.headers['access-control-allow-origin'], undefined);
  const missing = await request('/api/config', { method: 'POST', data: { githubUsername: 'attacker' } });
  assert.equal(missing.status, 403);
  const wrong = await post('/api/config', { githubUsername: 'attacker' }, { 'X-CSRF-Token': 'wrong-token' });
  assert.equal(wrong.status, 403);
  const valid = await post('/api/config', { githubUsername: 'example-user' });
  assert.equal(valid.status, 200);
});

test('foreign hosts, origins, and cross-site fetches cannot read or mutate local state', async () => {
  for (const headers of [{ Host: 'evil.test:14565' }, { Origin: 'https://evil.test' }, { Origin: 'http://localhost:14565.evil.test' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await request('/api/session', { headers })).status, 403);
    assert.equal((await post('/api/config', { githubUsername: 'attacker' }, headers)).status, 403);
  }
  assert.equal((await request('/api/health', { headers: { Host: '127.0.0.1:14565' } })).status, 200);
});

test('public configuration never contains saved credentials and cannot register arbitrary folders', async () => {
  const response = await request('/api/config');
  assert.equal(response.json.hasGithubToken, true);
  assert.equal(response.json.hasAiKey, true);
  assert.equal(response.json.githubToken, undefined);
  assert.equal(response.json.geminiApiKey, undefined);
  assert.equal(response.json.aiKeys, undefined);
  assert.ok(!response.text.includes('test-private-github-secret'));
  assert.ok(!response.text.includes('test-private-ai-secret'));
  const before = config.loadConfig();
  const arbitrary = await post('/api/config', { activeProjectPath: path.parse(project).root, recentProjects: [{ path: path.parse(project).root }] });
  assert.equal(arbitrary.status, 200);
  assert.equal(config.loadConfig().activeProjectPath, before.activeProjectPath);
  assert.deepEqual(config.loadConfig().recentProjects, before.recentProjects);
  const selected = await post('/api/project/select', { projectPath: path.parse(project).root });
  assert.equal(selected.status, 403);
});

test('project selection confines app folders and rejects invalid Firebase identifiers', async () => {
  assert.equal((await post('/api/project/select', { projectPath: project })).status, 200);
  assert.equal((await post('/api/project/select', { projectPath: project, appSubdir: '..' })).status, 400);
  assert.equal((await post('/api/project/select', { projectPath: project, firebaseProject: 'app; whoami' })).status, 400);
  for (const id of ['app & calc', '--project', '../secret', 'short', '1invalid', 'a'.repeat(31)]) assert.throws(() => firebaseId(id));
  assert.equal(firebaseId('valid-site-2026'), 'valid-site-2026');
});

test('AI patch paths reject traversal, secrets, lockfiles, and symbolic-link escapes', t => {
  assert.equal(safePatchFile(project, 'src/app.js'), path.join(project, 'src', 'app.js'));
  for (const file of ['../outside.js', '/absolute.js', 'C:/outside.js', 'src\\escape.js', '.env', '.git/config', 'node_modules/dep/index.js', 'credentials.json', 'config.json', 'package-lock.json', 'nested/.secret.json', 'x//file.js', 'x/./file.js', 'binary.exe']) assert.throws(() => safePatchFile(project, file), `Expected rejection for ${file}`);
  const outside = path.join(temp, 'outside');
  fs.mkdirSync(outside);
  const junction = path.join(project, 'linked');
  try { fs.symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { t.diagnostic(`Symlink check unavailable: ${error.code}`); return; }
  assert.throws(() => safePatchFile(project, 'linked/source.js'), /symbolic links/);
});

test('Firebase status returns only identity and project metadata, never CLI tokens', async () => {
  runMock = async (name, args) => {
    assert.equal(name, 'firebase');
    if (args[0] === 'login:list') return { code: 0, stdout: JSON.stringify({ status: 'success', result: [{ user: { email: 'test@example.invalid' }, tokens: { refresh_token: 'firebase-refresh-secret', access_token: 'firebase-access-secret' } }] }), stderr: '' };
    if (args[0] === 'projects:list') return { code: 0, stdout: JSON.stringify({ status: 'success', result: [{ projectId: 'test-site-2026', displayName: 'Test site', internal: 'ignored' }] }), stderr: '' };
    throw new Error('Unexpected command');
  };
  const response = await request('/api/firebase/status');
  assert.equal(response.status, 200);
  assert.equal(response.json.isLoggedIn, true);
  assert.equal(response.json.email, 'test@example.invalid');
  assert.deepEqual(response.json.projects, [{ projectId: 'test-site-2026', displayName: 'Test site' }]);
  assert.ok(!response.text.includes('firebase-refresh-secret'));
  assert.ok(!response.text.includes('firebase-access-secret'));
  assert.equal(response.json.rawOutput, undefined);
});

test('unsafe repository URLs and arbitrary AI patch submissions cannot run commands or write files', async () => {
  runMock = async () => { throw new Error('Unsafe request reached an external command.'); };
  for (const repoUrl of ['https://evil.test/owner/repo', 'https://github.com/owner/repo" & calc', 'owner/repo;whoami']) {
    const result = await post('/api/project/import-github', { repoUrl });
    assert.equal(result.status, 400);
    assert.ok(!result.text.includes('reached an external command'));
  }
  assert.equal((await post('/api/project/apply-ai-patches', { projectPath: project, patches: [{ filePath: '../outside.js', updatedContent: 'unsafe' }] })).status, 404);
  assert.equal((await post('/api/project/ai-apply', { proposalId: 'invented-proposal' })).status, 400);
  assert.equal(fs.existsSync(path.join(temp, 'outside.js')), false);
});

function staticProject(name, extra = {}) {
  const root = path.join(temp, name);
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Deployment fixture</title>');
  for (const [file, value] of Object.entries(extra)) fs.writeFileSync(path.join(root, file), value);
  const cfg = config.loadConfig();
  config.saveConfig({ activeProjectPath: root, appSubdir: '', recentProjects: [...cfg.recentProjects, { name, path: root, branch: 'main' }] });
  return root;
}

async function completedJob(id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await request(`/api/jobs/${id}`);
    if (result.json?.status !== 'running') return result.json;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Mock deployment did not finish.');
}

test('static deployment configures Hosting, strips hooks, and reports the actual site only after success', async () => {
  const root = staticProject('deploy-success', {
    'firebase.json': JSON.stringify({ hosting: { public: '.', predeploy: ['never-run-this-hook'], postdeploy: ['never-run-that-hook'] }, functions: { source: 'backend', predeploy: ['never-run-functions'] } })
  });
  const calls = [];
  let releaseDeploy;
  const deploymentGate = new Promise(resolve => { releaseDeploy = resolve; });
  let startedResolve;
  const deploymentStarted = new Promise(resolve => { startedResolve = resolve; });
  let staged;
  runMock = async (name, args, options) => {
    calls.push({ name, args, cwd: options.cwd });
    assert.equal(name, 'firebase');
    if (args[0] === 'hosting:sites:list') return { code: 0, stdout: JSON.stringify({ status: 'success', result: { sites: [{ name: 'projects/test-project/sites/actual-live-site' }] } }), stderr: '' };
    assert.equal(args[0], 'deploy');
    staged = JSON.parse(fs.readFileSync(args[args.indexOf('--config') + 1], 'utf8'));
    startedResolve();
    await deploymentGate;
    return { code: 0, stdout: JSON.stringify({ status: 'success', result: { hosting: 'sites/actual-live-site/versions/test-v1' } }), stderr: '' };
  };
  const response = await post('/api/project/deploy', { projectPath: root, firebaseProject: 'test-project', autoFixFirst: true });
  assert.equal(response.status, 200);
  try {
    await deploymentStarted;
    const running = (await request(`/api/jobs/${response.json.jobId}`)).json;
    assert.equal(running.status, 'running');
    assert.equal(running.liveUrl, '');
    assert.deepEqual(Object.keys(staged), ['hosting']);
    assert.equal(staged.hosting.public, root);
    assert.equal(staged.hosting.predeploy, undefined);
    assert.equal(staged.hosting.postdeploy, undefined);
    assert.ok(staged.hosting.ignore.includes('**/.*'));
    assert.ok(calls.every(call => call.cwd.startsWith(process.env.FDS_DATA_DIR)));
    assert.ok(calls.every(call => !call.args.includes('never-run-this-hook')));
  } finally {
    releaseDeploy();
  }
  const job = await completedJob(response.json.jobId);
  assert.equal(job.status, 'completed');
  assert.equal(job.liveUrl, 'https://actual-live-site.web.app');
  assert.equal(job.secondaryUrl, 'https://actual-live-site.firebaseapp.com');
  assert.equal(fs.existsSync(path.join(root, '.firebaserc')), true);
  const original = JSON.parse(fs.readFileSync(path.join(root, 'firebase.json'), 'utf8'));
  assert.deepEqual(original.hosting.predeploy, ['never-run-this-hook']);
  assert.equal(calls.some(call => call.name === 'npm'), false);
});

test('a missing Hosting site is created and failed Firebase deploy never exposes a live URL', async () => {
  const root = staticProject('deploy-failure');
  const calls = [];
  runMock = async (name, args) => {
    assert.equal(name, 'firebase');
    calls.push(args[0]);
    if (args[0] === 'hosting:sites:list') return { code: 0, stdout: JSON.stringify({ status: 'success', result: { sites: [] } }), stderr: '' };
    if (args[0] === 'hosting:sites:create') return { code: 0, stdout: JSON.stringify({ status: 'success' }), stderr: '' };
    if (args[0] === 'deploy') return { code: 1, stdout: '', stderr: 'Permission denied for test-private-ai-secret' };
    throw new Error('Unexpected deployment command');
  };
  const response = await post('/api/project/deploy', { projectPath: root, firebaseProject: 'test-project' });
  assert.equal(response.status, 200);
  const job = await completedJob(response.json.jobId);
  assert.equal(job.status, 'failed');
  assert.equal(job.liveUrl, '');
  assert.equal(job.secondaryUrl, undefined);
  assert.deepEqual(calls, ['hosting:sites:list', 'hosting:sites:create', 'deploy']);
  assert.ok(!JSON.stringify(job).includes('test-private-ai-secret'));
});

test('failed GitHub sync stops deployment before configuration, installation, or publishing', async t => {
  const root = staticProject('deploy-sync-failure');
  fs.mkdirSync(path.join(root, '.git'));
  const github = require('../lib/github');
  t.mock.method(github, 'sync', async () => { throw new Error('GitHub sync failed. Local changes preserved.'); });
  let commandCalled = false;
  runMock = async () => { commandCalled = true; throw new Error('The pipeline continued after sync failed.'); };
  const response = await post('/api/project/deploy', { projectPath: root, firebaseProject: 'test-project', syncGithubFirst: true });
  assert.equal(response.status, 200);
  const job = await completedJob(response.json.jobId);
  assert.equal(job.status, 'failed');
  assert.equal(job.stepIndex, 1);
  assert.equal(job.liveUrl, '');
  assert.equal(commandCalled, false);
  assert.equal(fs.existsSync(path.join(root, 'firebase.json')), false);
});
