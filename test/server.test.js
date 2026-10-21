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
const firebaseClient = require('../lib/firebase');
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

test('Firebase status returns verified account metadata through its bounded API client', async t => {
  t.mock.method(firebaseClient, 'status', async () => ({ isLoggedIn: true, email: 'test@example.invalid', projects: [{ projectId: 'test-site-2026', displayName: 'Test site' }], connectionStatus: 'connected', cliAvailable: true, message: '' }));
  runMock = async () => { throw new Error('Status must not launch the hanging Firebase CLI.'); };
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

function runtimeProject(name, configText = 'export default {};') {
  const root = path.join(temp, name), app = path.join(root, 'web');
  fs.mkdirSync(path.join(app, 'app', 'api', 'health'), { recursive: true });
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'runtime-fixture', scripts: { build: 'next build', start: 'next start' }, dependencies: { next: '16.0.0', react: '19.0.0' } }));
  fs.writeFileSync(path.join(app, 'next.config.mjs'), configText);
  fs.writeFileSync(path.join(app, 'app', 'api', 'health', 'route.js'), 'export function GET() { return Response.json({ok:true}); }');
  fs.writeFileSync(path.join(app, '.env.local'), 'DO_NOT_UPLOAD=synthetic-private-value');
  const cfg = config.loadConfig();
  config.saveConfig({ activeProjectPath: root, appSubdir: 'web', deploymentMode: 'auto', recentProjects: [...cfg.recentProjects, { name, path: root, sourceType: 'local' }] });
  return { root, app };
}
const runtimeBackend = { id: 'test-backend', name: 'projects/test-project/locations/us-east4/backends/test-backend', location: 'us-east4', uri: 'https://test-backend--test-project.us-east4.hosted.app' };

test('Next.js server apps automatically select App Hosting and preserve API files', async () => {
  const { root, app } = runtimeProject('runtime-selection');
  const selected = await post('/api/project/select', { projectPath: root, deploymentMode: 'auto', appSubdir: 'web' });
  assert.equal(selected.status, 200);
  assert.equal(selected.json.inspection.deploymentMode, 'apphosting');
  assert.equal(selected.json.inspection.blocked, false);
  const fixed = await post('/api/project/autofix', { projectPath: root, deploymentMode: 'auto', appSubdir: 'web' });
  assert.equal(fixed.status, 200);
  assert.deepEqual(fixed.json.changedFiles, []);
  assert.equal(fs.existsSync(path.join(app, 'app', 'api', 'health', 'route.js')), true);
  assert.equal(fs.existsSync(path.join(app, 'firebase.json')), false);
  assert.equal(fs.existsSync(path.join(app, '.firebaserc')), false);
});

test('App Hosting deploy stages protected source and reports a verified runtime URL', async t => {
  const { root, app } = runtimeProject('runtime-deployment', "export default { output: 'export', poweredByHeader: false };");
  t.mock.method(firebaseClient, 'billing', async () => true);
  t.mock.method(firebaseClient, 'appHostingStatus', async () => ({ billingEnabled: true, backends: [runtimeBackend] }));
  t.mock.method(firebaseClient, 'getBackend', async () => ({ name: runtimeBackend.name, uri: runtimeBackend.uri }));
  const baseline = [];
  t.mock.method(firebaseClient, 'assertNoActiveDeployment', async () => {});
  t.mock.method(firebaseClient, 'listRollouts', async () => baseline);
  t.mock.method(firebaseClient, 'verifyRollout', async (project, name, previous) => { assert.equal(project, 'test-project'); assert.equal(name, runtimeBackend.name); assert.equal(previous, baseline); return { rolloutName: runtimeBackend.name + '/rollouts/new-release', buildName: runtimeBackend.name + '/builds/new-build' }; });
  let inspected = false;
  runMock = async (name, args, options) => {
    assert.equal(name, 'firebase'); assert.equal(args[0], 'deploy');
    assert.equal(args[args.indexOf('--only') + 1], 'apphosting:test-backend');
    assert.ok(args.includes('--non-interactive'));
    const staging = JSON.parse(fs.readFileSync(args[args.indexOf('--config') + 1], 'utf8'));
    assert.deepEqual(Object.keys(staging), ['apphosting']);
    assert.equal(staging.apphosting[0].rootDir, 'web');
    assert.equal(staging.apphosting[0].alwaysDeployFromSource, true);
    assert.equal(options.timeout, 65 * 60 * 1000);
    assert.ok(options.sourceModesPath.endsWith('.modes.json'));
    assert.equal(fs.existsSync(path.join(options.cwd, 'web', '.env.local')), false);
    assert.equal(fs.existsSync(path.join(options.cwd, 'web', 'app', 'api', 'health', 'route.js')), true);
    assert.ok(!fs.readFileSync(path.join(options.cwd, 'web', 'next.config.mjs'), 'utf8').includes("output: 'export'"));
    inspected = true; return { code: 0, stdout: JSON.stringify({ status: 'success', result: {} }), stderr: '' };
  };
  const response = await post('/api/project/deploy', { projectPath: root, appSubdir: 'web', firebaseProject: 'test-project', deploymentMode: 'apphosting', backendId: 'test-backend' });
  assert.equal(response.status, 200);
  const job = await completedJob(response.json.jobId);
  assert.equal(job.status, 'completed', job.errorLog);
  assert.equal(inspected, true);
  assert.equal(job.liveUrl, runtimeBackend.uri);
  assert.equal(job.rolloutName, runtimeBackend.name + '/rollouts/new-release');
  assert.equal(fs.existsSync(path.join(app, '.env.local')), true);
  assert.equal(fs.existsSync(path.join(app, 'firebase.json')), false);
});

test('interrupted App Hosting rollout stays unknown, blocks duplicate uploads, and can be checked safely', async t => {
  const { root } = runtimeProject('runtime-interrupted');
  t.mock.method(firebaseClient, 'billing', async () => true);
  t.mock.method(firebaseClient, 'appHostingStatus', async () => ({ billingEnabled: true, backends: [runtimeBackend] }));
  t.mock.method(firebaseClient, 'getBackend', async () => ({ name: runtimeBackend.name, uri: runtimeBackend.uri }));
  t.mock.method(firebaseClient, 'listRollouts', async () => []);
  t.mock.method(firebaseClient, 'assertNoActiveDeployment', async () => {});
  let ready = false, uploads = 0;
  t.mock.method(firebaseClient, 'verifyRollout', async () => { if (!ready) { const error = new Error('The new rollout is still building.'); error.state = 'pending'; throw error; } return { rolloutName: runtimeBackend.name + '/rollouts/recovered', buildName: runtimeBackend.name + '/builds/recovered' }; });
  runMock = async () => { uploads++; return { code: 124, stdout: '', stderr: 'Command timed out.' }; };
  const payload = { projectPath: root, appSubdir: 'web', firebaseProject: 'test-project', deploymentMode: 'apphosting', backendId: 'test-backend' };
  const started = await post('/api/project/deploy', payload), job = await completedJob(started.json.jobId);
  assert.equal(job.status, 'unknown'); assert.equal(job.liveUrl, ''); assert.match(job.message, /may still be running/); assert.match(job.consoleUrl, /^https:\/\/console\.firebase\.google\.com\//);
  const duplicate = await post('/api/project/deploy', payload);
  assert.equal(duplicate.status, 409); assert.equal(uploads, 1);
  const pending = await post(`/api/jobs/${job.id}/check`, {}); assert.equal(pending.json.status, 'unknown');
  ready = true;
  const recovered = await post(`/api/jobs/${job.id}/check`, {});
  assert.equal(recovered.json.status, 'completed'); assert.equal(recovered.json.liveUrl, runtimeBackend.uri); assert.equal(recovered.json.errorLog, ''); assert.equal(uploads, 1);
});

test('App Hosting never accepts CLI success without a newly verified rollout', async t => {
  const { root } = runtimeProject('runtime-false-success');
  t.mock.method(firebaseClient, 'billing', async () => true);
  t.mock.method(firebaseClient, 'appHostingStatus', async () => ({ billingEnabled: true, backends: [runtimeBackend] }));
  t.mock.method(firebaseClient, 'listRollouts', async () => []);
  let active = false;
  t.mock.method(firebaseClient, 'assertNoActiveDeployment', async () => { if (active) throw new Error('A cloud build is still active.'); });
  t.mock.method(firebaseClient, 'verifyRollout', async () => { const error = new Error('No new rollout was created.'); error.state = 'unknown'; throw error; });
  let backendReads = 0;
  t.mock.method(firebaseClient, 'getBackend', async () => { backendReads++; return { uri: runtimeBackend.uri }; });
  runMock = async () => ({ code: 0, stdout: JSON.stringify({ status: 'success' }), stderr: '' });
  const started = await post('/api/project/deploy', { projectPath: root, appSubdir: 'web', firebaseProject: 'other-project', deploymentMode: 'apphosting', backendId: 'test-backend' });
  const job = await completedJob(started.json.jobId);
  assert.equal(job.status, 'unknown'); assert.equal(job.liveUrl, ''); assert.equal(backendReads, 0);
  const missingAck = await post(`/api/jobs/${job.id}/acknowledge`, {}); assert.equal(missingAck.status, 400);
  active = true;
  const busyAck = await post(`/api/jobs/${job.id}/acknowledge`, { checkedFirebase: true }); assert.equal(busyAck.status, 400);
  assert.equal((await request(`/api/jobs/${job.id}`)).json.status, 'unknown');
  active = false;
  const released = await post(`/api/jobs/${job.id}/acknowledge`, { checkedFirebase: true });
  assert.equal(released.json.status, 'failed'); assert.equal(released.json.retryAllowed, true); assert.equal(released.json.liveUrl, '');
});

test('an already active App Hosting rollout stops before source upload', async t => {
  const { root } = runtimeProject('runtime-existing-rollout');
  t.mock.method(firebaseClient, 'billing', async () => true);
  t.mock.method(firebaseClient, 'appHostingStatus', async () => ({ billingEnabled: true, backends: [runtimeBackend] }));
  t.mock.method(firebaseClient, 'listRollouts', async () => [{ state: 'BUILDING', reconciling: true }]);
  let uploads = 0; runMock = async () => { uploads++; throw new Error('Must not upload while an existing rollout is active.'); };
  const started = await post('/api/project/deploy', { projectPath: root, appSubdir: 'web', firebaseProject: 'test-project', deploymentMode: 'apphosting', backendId: 'test-backend' });
  const job = await completedJob(started.json.jobId);
  assert.equal(job.status, 'failed'); assert.match(job.errorLog, /active cloud rollout/); assert.equal(uploads, 0);
});

test('App Hosting billing or missing backend blocks cloud deployment without creating resources', async t => {
  const { root } = runtimeProject('runtime-billing');
  let called = false;
  runMock = async () => { called = true; throw new Error('Unexpected cloud mutation.'); };
  t.mock.method(firebaseClient, 'billing', async () => false);
  const response = await post('/api/project/deploy', { projectPath: root, appSubdir: 'web', firebaseProject: 'test-project', deploymentMode: 'apphosting', backendId: 'test-backend' });
  assert.equal(response.status, 200);
  const job = await completedJob(response.json.jobId);
  assert.equal(job.status, 'failed'); assert.match(job.errorLog, /Blaze/); assert.equal(job.liveUrl, ''); assert.equal(called, false);
  const setup = await post('/api/apphosting/setup', { projectPath: root, appSubdir: 'web', firebaseProject: 'test-project', backendId: 'test-backend', location: 'us-east4' });
  assert.equal(setup.status, 400); assert.match(setup.json.error, /does not upgrade|will not upgrade/); assert.equal(called, false);
});

test('backend setup uses explicit validated creation and verifies the resulting backend', async t => {
  const { root } = runtimeProject('runtime-setup');
  t.mock.method(firebaseClient, 'billing', async () => true);
  let checks = 0;
  t.mock.method(firebaseClient, 'appHostingStatus', async () => ({ billingEnabled: true, locations: [{ id: 'us-east4' }], backends: checks++ ? [runtimeBackend] : [] }));
  runMock = async (name, args) => {
    assert.equal(name, 'firebase'); assert.equal(args[0], 'apphosting:backends:create'); assert.ok(args.includes('--non-interactive'));
    assert.equal(args[args.indexOf('--backend') + 1], 'test-backend'); assert.equal(args[args.indexOf('--primary-region') + 1], 'us-east4');
    return { code: 0, stdout: JSON.stringify({ status: 'success' }), stderr: '' };
  };
  const response = await post('/api/apphosting/setup', { projectPath: root, appSubdir: 'web', firebaseProject: 'test-project', backendId: 'test-backend', location: 'us-east4' });
  assert.equal(response.status, 200); assert.equal(response.json.backendId, 'test-backend'); assert.equal(config.loadConfig().appHostingBackendId, 'test-backend');
});

test('GitHub repair publishes only app-generated changes through a captured baseline', async t => {
  const root = staticProject('github-auto-repair'); fs.mkdirSync(path.join(root, '.git'));
  const repair = require('../lib/git-repair'), github = require('../lib/github');
  let baselineCount = 0, published;
  t.mock.method(repair, 'captureRepairBaseline', async () => ({ dirtyFiles: [], stagedFiles: [], captured: ++baselineCount }));
  t.mock.method(github, 'sync', async () => {});
  t.mock.method(repair, 'publishRepair', async args => { published = args; return { branch: 'firebase-direct/repair-fixture', pullRequestUrl: 'https://github.com/example/app/pull/1', fixedFiles: args.files, commit: 'fixture-sha' }; });
  const response = await post('/api/project/fix-github', { projectPath: root, firebaseProject: 'test-project', deploymentMode: 'hosting', appSubdir: '' });
  assert.equal(response.status, 200);
  const job = await completedJob(response.json.jobId);
  assert.equal(job.status, 'completed', job.errorLog); assert.equal(job.type, 'github-repair'); assert.equal(job.pullRequestUrl, 'https://github.com/example/app/pull/1');
  assert.ok(published.files.includes('firebase.json')); assert.ok(published.files.includes('.firebaserc'));
  assert.ok(published.files.every(file => file in published.expectedHashes)); assert.ok(published.baseline.captured);
  assert.equal(config.loadConfig().recentProjects.find(p => p.path === root).branch, 'firebase-direct/repair-fixture');
});
