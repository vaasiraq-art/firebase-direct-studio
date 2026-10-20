'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fds-config-test-'));
process.env.FDS_DATA_DIR = path.join(temp, 'data');
const config = require('../lib/config');
after(() => fs.rmSync(temp, { recursive: true, force: true }));

test('atomic writes never follow an attacker-controlled predictable temporary link', t => {
  const source = path.join(temp, 'source.js'), external = path.join(temp, 'unrelated.js');
  fs.writeFileSync(source, 'old content'); fs.writeFileSync(external, 'preserved content');
  let linkCreated = false;
  try { fs.symlinkSync(external, source + '.tmp', 'file'); linkCreated = true; }
  catch (e) { if (e.code !== 'EPERM') throw e; fs.writeFileSync(source + '.tmp', 'preserved old temporary file'); }
  config.atomicWrite(source, 'reviewed update');
  assert.equal(fs.readFileSync(source, 'utf8'), 'reviewed update');
  assert.equal(fs.readFileSync(external, 'utf8'), 'preserved content');
  assert.equal(fs.readFileSync(source + '.tmp', 'utf8'), linkCreated ? 'preserved content' : 'preserved old temporary file');
  assert.equal(fs.readdirSync(temp).filter(name => /^source\.js\.[a-f0-9-]+\.tmp$/.test(name)).length, 0);
});

test('Windows credentials are encrypted on disk and public settings contain flags only', { skip: process.platform !== 'win32' }, () => {
  const secret = 'synthetic-encryption-test-value';
  config.writeSecrets({ githubToken: secret, aiKeys: { openai: secret } });
  const ciphertext = fs.readFileSync(path.join(config.DATA_DIR, 'credentials.enc'), 'utf8');
  assert.ok(!ciphertext.includes(secret));
  assert.equal(config.readSecrets().aiKeys.openai, secret);
  const visible = config.publicConfig();
  assert.equal(visible.hasGithubToken, true); assert.equal(visible.hasAiKey, true);
  assert.ok(!JSON.stringify(visible).includes(secret));
  assert.equal(visible.githubToken, undefined); assert.equal(visible.aiKeys, undefined);
});
