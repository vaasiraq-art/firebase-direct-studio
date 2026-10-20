'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fds-github-test-'));
process.env.FDS_DATA_DIR = temp;
const config = require('../lib/config');
const processes = require('../lib/process');
const actualRun = processes.run;
let runMock = async () => { throw new Error('Unexpected external command in test.'); };
processes.run = (...args) => runMock(...args);
const github = require('../lib/github');
after(() => fs.rmSync(temp, { recursive: true, force: true }));

test('repository normalization accepts clean GitHub URLs and rejects unsafe destinations', () => {
  const expected = { owner: 'example', name: 'my-app', fullName: 'example/my-app', url: 'https://github.com/example/my-app.git' };
  assert.deepEqual(github.normalizeRepo('example/my-app'), expected);
  assert.deepEqual(github.normalizeRepo('https://github.com/example/my-app.git'), expected);
  for (const raw of ['https://evil.test/example/app', 'https://github.com.evil.test/example/app', 'http://github.com/example/app', 'file:///C:/secret', 'git@github.com:example/app', 'https://user:private-token@github.com/example/app', 'https://github.com:444/example/app', 'https://github.com/example/app/tree/main', 'example/app && whoami', 'example/app";cmd', 'https://github.com/example/app?token=secret', 'https://github.com/example/app#branch']) {
    assert.throws(() => github.normalizeRepo(raw));
  }
});

test('branch validation rejects options, ref traversal, whitespace, and malformed paths', () => {
  assert.equal(github.validateBranch('feature/private-repo'), 'feature/private-repo');
  for (const branch of ['--upload-pack=evil', 'main\ncmd', 'main branch', '../main', 'refs//main', '.hidden', 'main.lock', 'branch@{1}', 'main\\evil', 'trailing/', 'trailing.']) assert.throws(() => github.validateBranch(branch));
});

test('authenticated repository listing includes private organization repos and paginates', async t => {
  config.saveConfig({ githubDisconnected: false, githubUsername: '' });
  config.readSecrets().githubToken = 'test-github-private-token';
  const routes = [];
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    routes.push(url);
    assert.equal(request.headers.Authorization, 'Bearer test-github-private-token');
    assert.equal(request.redirect, 'error');
    assert.ok(!url.includes('test-github-private-token'));
    if (url.endsWith('/user')) return Response.json({ login: 'actual-user' });
    assert.ok(url.includes('affiliation=owner,collaborator,organization_member'));
    if (new URL(url).searchParams.get('page') === '1') return Response.json(Array.from({ length: 100 }, (_, index) => ({ id: index, name: `app-${index}`, full_name: `other-owner/app-${index}`, owner: { login: 'other-owner' }, private: index === 0, default_branch: 'main' })));
    return Response.json([{ id: 101, name: 'private-app', full_name: 'private-org/private-app', private: true, default_branch: 'release' }]);
  });
  const result = await github.repos();
  assert.equal(result.connected, true);
  assert.equal(result.username, 'actual-user');
  assert.equal(result.repos.length, 101);
  assert.equal(result.repos[100].private, true);
  assert.equal(result.repos[100].fullName, 'private-org/private-app');
  assert.equal(routes.length, 3);
    assert.ok(!JSON.stringify(result).includes('test-github-private-token'));
});

test('GitHub errors hide response bodies and disconnect bypasses credential helpers', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ message: 'sensitive response' }, { status: 404 }));
  await assert.rejects(github.request('/repos/example/private', { token: 'test-token' }), error => /cannot read/.test(error.message) && !error.message.includes('sensitive response'));
  await assert.rejects(github.request('//evil.test/', { token: 'test-token' }), /Invalid GitHub API route/);
  config.saveConfig({ githubDisconnected: true });
  runMock = async () => { throw new Error('Credential helper should not be invoked after disconnect.'); };
  assert.deepEqual(await github.credential(), { token: '', source: 'none' });
});

test('GitHub sync preserves dirty working trees and fails when pull fails', async () => {
  config.saveConfig({ githubDisconnected: false });
  let dirty = true;
  const calls = [];
  runMock = async (name, args) => {
    calls.push({ name, args });
    if (args[0] === 'remote') return { code: 0, stdout: 'https://github.com/example/app.git\n', stderr: '' };
    if (args[0] === 'status') return { code: 0, stdout: dirty ? ' M source.js\n' : '', stderr: '' };
    if (args[0] === 'pull') return { code: 1, stdout: '', stderr: 'remote failed' };
    throw new Error('Unexpected command');
  };
  await assert.rejects(github.sync(temp, 'main'), /Local changes exist/);
  assert.equal(calls.some(call => call.args[0] === 'pull'), false);
  dirty = false;
  await assert.rejects(github.sync(temp, 'main'), /GitHub sync failed/);
  assert.ok(calls.some(call => call.args.join(' ') === 'pull --ff-only origin main'));
});

test('legacy token-bearing origins are scrubbed before use', async () => {
  const calls = [];
  runMock = async (name, args) => {
    calls.push(args);
    return { code: 0, stdout: args[1] === 'get-url' ? 'https://x-access-token:legacy-secret@github.com/example/app.git\n' : '', stderr: '' };
  };
  const result = await github.scrubRemote(temp);
  assert.equal(result.url, 'https://github.com/example/app.git');
  assert.deepEqual(calls[1], ['remote', 'set-url', 'origin', 'https://github.com/example/app.git']);
});

test('child processes receive arguments literally and sensitive inherited variables are removed', async () => {
  const sentinel = 'literal & ; $() ` < > | value';
  const result = await actualRun(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', sentinel], { cwd: temp });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, sentinel);
  const previous = process.env.FDS_TEST_API_KEY;
  try {
    process.env.FDS_TEST_API_KEY = 'not-for-builds';
    const envResult = await actualRun(process.execPath, ['-e', 'process.stdout.write(String(!!process.env.FDS_TEST_API_KEY))'], { cwd: temp });
    assert.equal(envResult.stdout, 'false');
  } finally {
    if (previous === undefined) delete process.env.FDS_TEST_API_KEY;
    else process.env.FDS_TEST_API_KEY = previous;
  }
});
