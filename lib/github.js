'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { run } = require('./process');
const { loadConfig, readSecrets, saveConfig } = require('./config');
function normalizeRepo(input) {
  if (typeof input !== 'string' || input.length > 500) throw new Error('Use a GitHub HTTPS URL or owner/repository.');
  let value = input.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) value = 'https://github.com/' + value;
  let url; try { url = new URL(value); } catch { throw new Error('Use a GitHub HTTPS URL or owner/repository.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) throw new Error('Only github.com HTTPS repository URLs are supported.');
  const match = url.pathname.match(/^\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (!match || ['.', '..'].includes(match[2])) throw new Error('Use a repository URL without /tree or /blob. Select its branch separately.');
  return { owner: match[1], name: match[2], fullName: `${match[1]}/${match[2]}`, url: `https://github.com/${match[1]}/${match[2]}.git` };
}
function validateBranch(branch) { if (typeof branch !== 'string' || !branch || branch.length > 200 || branch.startsWith('-') || /[\x00-\x20~^:?*\[\\]/.test(branch) || branch.includes('..') || branch.includes('@{') || branch.endsWith('/') || branch.endsWith('.') || branch.includes('//') || branch.split('/').some(x => x.startsWith('.') || x.endsWith('.lock'))) throw new Error('Select a valid Git branch.'); return branch; }
async function credential() {
  if (loadConfig().githubDisconnected) return { token: '', source: 'none' };
  if (readSecrets().githubToken) return { token: readSecrets().githubToken, source: 'saved-token' };
  try { const out = await run('gh', ['auth', 'token', '--hostname', 'github.com'], { timeout: 8000 }); if (out.code === 0 && out.stdout.trim()) return { token: out.stdout.trim(), source: 'github-cli' }; } catch {}
  try { const out = await run('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', timeout: 15000 }); const token = out.stdout.match(/^password=(.+)$/m)?.[1]?.trim(); if (out.code === 0 && token) return { token, source: 'windows-credential-manager' }; } catch {}
  return { token: '', source: 'none' };
}
async function request(route, auth, options = {}) {
  if (!route.startsWith('/') || route.startsWith('//')) throw new Error('Invalid GitHub API route.');
  const response = await fetch('https://api.github.com' + route, { ...options, redirect: 'error', signal: AbortSignal.timeout(25000), headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Firebase-Direct-Studio', ...(auth?.token ? { Authorization: `Bearer ${auth.token}` } : {}), ...options.headers } });
  if (!response.ok) { const hints = { 401: 'GitHub sign-in expired. Reconnect your account.', 403: 'GitHub denied access or its rate limit was reached. Check repository permissions and organization SSO.', 404: 'Repository not found or your GitHub account cannot read it. Grant this repository access to your token and organization SSO if required.' }; throw new Error(hints[response.status] || `GitHub request failed (${response.status}).`); }
  return response.json();
}
async function status(auth) { auth ||= await credential(); if (!auth.token) return { connected: false, username: loadConfig().githubUsername, authSource: 'none', privateAccess: false, message: 'Connect your GitHub account to read private repositories.' }; const user = await request('/user', auth); saveConfig({ githubUsername: user.login }); return { connected: true, username: user.login, authSource: auth.source, privateAccess: true, message: 'Connected. Repositories are limited to the permissions granted to this credential.' }; }
async function repos() {
  const auth = await credential(), cfg = loadConfig();
  if (!auth.token && !/^[A-Za-z0-9-]{1,39}$/.test(cfg.githubUsername)) return { connected: false, repos: [] };
  const connection = auth.token ? await status(auth) : { connected: false, username: cfg.githubUsername, privateAccess: false, authSource: 'public' };
  const all = [];
  for (let page = 1; page <= 100; page++) {
    const route = auth.token ? `/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member&page=${page}` : `/users/${encodeURIComponent(cfg.githubUsername)}/repos?per_page=100&sort=updated&page=${page}`;
    const list = await request(route, auth); if (!Array.isArray(list)) throw new Error('GitHub returned an unexpected repository list.'); all.push(...list); if (list.length < 100) break;
  }
  return { ...connection, repos: all.map(r => ({ id: r.id, name: r.name, fullName: r.full_name, private: r.private, htmlUrl: r.html_url, cloneUrl: r.clone_url, defaultBranch: r.default_branch, description: r.description || '', language: r.language || '', updatedAt: r.updated_at })) };
}
function gitEnv(auth) { return auth?.token ? { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + auth.token).toString('base64'), GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '' } : {}; }
async function scrubRemote(dir) { const out = await run('git', ['remote', 'get-url', 'origin'], { cwd: dir }); let raw = out.stdout.trim(); if (out.code !== 0) throw new Error('Git origin is missing.'); try { const parsed = new URL(raw); if (parsed.hostname === 'github.com' && (parsed.username || parsed.password)) { parsed.username = ''; parsed.password = ''; raw = parsed.href; await run('git', ['remote', 'set-url', 'origin', raw], { cwd: dir }); } } catch {} return normalizeRepo(raw); }
async function sync(dir, branch, onLog) { const repo = await scrubRemote(dir); const auth = await credential(); const dirty = await run('git', ['status', '--porcelain'], { cwd: dir }); if (dirty.code !== 0 || dirty.stdout.trim()) throw new Error('Local changes exist. Turn off “Sync latest from GitHub” to deploy these fixes, or commit them before syncing.'); const args = ['pull', '--ff-only', 'origin']; if (branch) args.push(validateBranch(branch)); const result = await run('git', args, { cwd: dir, env: gitEnv(auth), onLog }); if (result.code !== 0) throw new Error('GitHub sync failed. Check repository access, branch, and local changes.'); return repo; }
module.exports = { normalizeRepo, validateBranch, credential, request, status, repos, gitEnv, scrubRemote, sync };
