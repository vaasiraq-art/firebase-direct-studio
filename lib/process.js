'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

function executableScript(name) {
  const local = path.join(__dirname, '..', 'node_modules', name === 'firebase' ? 'firebase-tools/lib/bin/firebase.js' : 'npm/bin/npm-cli.js');
  if (fs.existsSync(local)) return local;
  const candidates = [path.join(path.dirname(process.execPath), 'node_modules'), path.join(process.env.APPDATA || '', 'npm/node_modules')];
  if (process.platform === 'win32') {
    const found = spawnSync('where.exe', [name + '.cmd'], { encoding: 'utf8', windowsHide: true });
    for (const file of (found.stdout || '').trim().split(/\r?\n/)) if (file) candidates.push(path.join(path.dirname(file), 'node_modules'));
  }
  for (const dir of candidates) {
    const file = path.join(dir, name === 'firebase' ? 'firebase-tools/lib/bin/firebase.js' : 'npm/bin/npm-cli.js');
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function cleanEnvironment() {
  const env = { ...process.env, FORCE_COLOR: '0', CI: 'true', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  for (const key of Object.keys(env)) if (/(?:TOKEN|API_KEY|SECRET|PASSWORD|CREDENTIAL|FD_GITHUB|GIT_CONFIG_|GIT_ASKPASS)/i.test(key)) delete env[key];
  return env;
}

function command(name, args) {
  if (name === 'npm' || name === 'firebase') {
    const script = executableScript(name);
    if (script) return { file: process.execPath, args: [script, ...args] };
    if (process.platform === 'win32') throw new Error(`${name} is not installed. Install ${name === 'firebase' ? 'Firebase CLI (npm install -g firebase-tools)' : 'Node.js with npm'}, then restart the app.`);
  }
  return { file: name, args };
}

function run(name, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    let spec;
    try { spec = command(name, args); } catch (error) { reject(error); return; }
    const child = spawn(spec.file, spec.args, { cwd: options.cwd || path.join(__dirname, '..'), shell: false, windowsHide: true, env: { ...cleanEnvironment(), ...options.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGTERM');
    }, options.timeout || 120000);
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-2e6); options.onLog?.(String(data), 'stdout'); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-2e6); options.onLog?.(String(data), 'stderr'); });
    child.on('error', error => { clearTimeout(timer); reject(new Error(`${name} could not start: ${error.code || 'unavailable'}`)); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: timedOut ? 124 : (code ?? 1), stdout, stderr: timedOut ? stderr + '\nCommand timed out.' : stderr }); });
    child.stdin.end(options.input || '');
  });
}
module.exports = { run, command, executableScript, cleanEnvironment };
