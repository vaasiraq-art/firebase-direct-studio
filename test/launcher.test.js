'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

const windows = process.platform === 'win32';
const launcher = path.join(__dirname, '..', 'Start-Firebase-Direct.ps1');

async function availablePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function makeFixture(fail) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fds-launcher-test-'));
  const appDir = path.join(root, 'app with spaces');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(appDir);
  fs.copyFileSync(launcher, path.join(appDir, 'Start-Firebase-Direct.ps1'));
  const deps = { express: 'file:fixtures/express', 'firebase-tools': 'file:fixtures/firebase-tools' };
  const packageJson = { name: 'fds-launcher-fixture', version: '1.0.0', private: true, dependencies: deps };
  if (fail) packageJson.scripts = { preinstall: 'node -e "process.exit(7)"' };
  const packages = { '': { ...packageJson, hasInstallScript: !!fail } };
  for (const name of Object.keys(deps)) {
    const relative = `fixtures/${name}`;
    fs.mkdirSync(path.join(appDir, relative), { recursive: true });
    fs.writeFileSync(path.join(appDir, relative, 'package.json'), JSON.stringify({ name, version: '0.0.0', private: true }));
    packages[relative] = { name, version: '0.0.0' };
    packages[`node_modules/${name}`] = { resolved: relative, link: true };
  }
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(packageJson));
  fs.writeFileSync(path.join(appDir, 'package-lock.json'), JSON.stringify({ name: packageJson.name, version: packageJson.version, lockfileVersion: 3, requires: true, packages }));
  fs.writeFileSync(path.join(appDir, 'server.js'), `
    const http = require('node:http');
    const fs = require('node:fs');
    const path = require('node:path');
    fs.writeFileSync(path.join(__dirname, 'server.pid'), String(process.pid));
    const server = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({app: 'firebase-direct-studio', fixture: true}));
    });
    server.listen(Number(process.env.PORT), '127.0.0.1');
    setTimeout(() => server.close(), 30000).unref();
  `);
  return { root, appDir, dataDir };
}

function runLauncher(fixture, port) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(fixture.appDir, 'Start-Firebase-Direct.ps1'), '-NoBrowser', '-Port', String(port)], {
      cwd: fixture.appDir, windowsHide: true,
      env: { ...process.env, FDS_DATA_DIR: fixture.dataDir, npm_config_offline: 'true', npm_config_update_notifier: 'false' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    const timer = setTimeout(() => { child.kill(); reject(new Error('Fixture launcher timed out.')); }, 45000);
    // A background server can inherit a Windows pipe handle even when its own
    // output is redirected. Observe the launcher process exit, then stop the
    // fixture server in cleanup rather than waiting for every descendant pipe.
    child.on('exit', code => { clearTimeout(timer); setTimeout(() => resolve({ code, stdout, stderr }), 20); });
  });
}

function health(port) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/api/health`, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    req.on('error', reject);
  });
}

async function cleanup(fixture) {
  const pidFile = path.join(fixture.appDir, 'server.pid');
  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  fs.rmSync(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

test('Windows first launch accepts successful offline npm ci and starts its server', { skip: !windows, timeout: 60000 }, async () => {
  const fixture = makeFixture(false);
  try {
    const port = await availablePort();
    const result = await runLauncher(fixture, port);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Firebase Direct Studio is ready/);
    assert.deepEqual(await health(port), { app: 'firebase-direct-studio', fixture: true });
    for (const name of ['express', 'firebase-tools']) assert.ok(fs.existsSync(path.join(fixture.appDir, 'node_modules', name, 'package.json')));
    assert.match(fs.readFileSync(path.join(fixture.dataDir, 'logs', 'install.log'), 'utf8'), /added/);
  } finally { await cleanup(fixture); }
});

test('Windows first launch reports a real npm ci failure without starting the server', { skip: !windows, timeout: 60000 }, async () => {
  const fixture = makeFixture(true);
  try {
    const result = await runLauncher(fixture, await availablePort());
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Dependency\s+setup failed/);
    assert.equal(fs.existsSync(path.join(fixture.appDir, 'server.pid')), false);
    assert.match(fs.readFileSync(path.join(fixture.dataDir, 'logs', 'install.error.log'), 'utf8'), /code 7|exit\(7\)/);
  } finally { await cleanup(fixture); }
});
