'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const DATA_DIR = process.env.FDS_DATA_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'FirebaseDirectStudio');
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const settingsPath = path.join(DATA_DIR, 'settings.json');
const secretsPath = path.join(DATA_DIR, 'credentials.enc');
const defaults = { githubUsername: '', githubDisconnected: false, aiProvider: 'openai', aiModel: '', defaultFirebaseProject: '', activeProjectPath: '', appSubdir: '', recentProjects: [] };
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw new Error('Saved settings could not be read. Check local app data.'); } }
function atomicWrite(file, data) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, data, { mode: 0o600 }); fs.renameSync(tmp, file); }
function dpapi(value, decrypt) {
  const operation = decrypt ? "[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))" : "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))";
  const script = `Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); ${operation}`;
  const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: value, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (out.status !== 0) throw new Error('Windows credential encryption failed. No credentials were saved.');
  return out.stdout.trim();
}
let cachedSecrets;
function readSecrets() {
  if (cachedSecrets) return cachedSecrets;
  if (!fs.existsSync(secretsPath)) return (cachedSecrets = { aiKeys: {} });
  if (process.platform !== 'win32') throw new Error('Persistent credentials currently require Windows.');
  try { cachedSecrets = JSON.parse(dpapi(fs.readFileSync(secretsPath, 'utf8'), true)); return cachedSecrets; }
  catch { throw new Error('Cannot unlock credentials for this Windows account. Reconnect using the account that saved them.'); }
}
function writeSecrets(patch) {
  if (process.platform !== 'win32') throw new Error('Persistent credentials currently require Windows.');
  const value = { ...readSecrets(), ...patch };
  atomicWrite(secretsPath, dpapi(JSON.stringify(value), false)); cachedSecrets = value;
}
function loadConfig() { return { ...defaults, ...readJson(settingsPath, {}) }; }
function saveConfig(patch) { const cfg = { ...loadConfig(), ...patch }; atomicWrite(settingsPath, JSON.stringify(cfg, null, 2)); return cfg; }
function publicConfig() { const cfg = loadConfig(), secrets = readSecrets(); return { ...cfg, hasGithubToken: !!secrets.githubToken, hasGeminiKey: !!secrets.aiKeys?.gemini, hasAiKey: !!secrets.aiKeys?.[cfg.aiProvider], aiKeyStatus: Object.fromEntries(Object.keys(secrets.aiKeys || {}).map(key => [key, !!secrets.aiKeys[key]])) }; }
function migrateLegacyConfig() {
  const legacyPath = path.join(__dirname, '..', 'config.json');
  if (!fs.existsSync(legacyPath)) return;
  const legacy = readJson(legacyPath, {});
  if (!legacy.githubToken && !legacy.geminiApiKey && !legacy.activeProjectPath && !legacy.githubUsername) return;
  const secrets = readSecrets();
  if (legacy.githubToken || legacy.geminiApiKey) writeSecrets({ githubToken: secrets.githubToken || legacy.githubToken || '', aiKeys: { ...secrets.aiKeys, ...(legacy.geminiApiKey && !secrets.aiKeys?.gemini ? { gemini: legacy.geminiApiKey } : {}) } });
  if (!fs.existsSync(settingsPath)) saveConfig(Object.fromEntries(Object.keys(defaults).filter(k => k in legacy).map(k => [k, legacy[k]])));
  atomicWrite(legacyPath, JSON.stringify({ migrated: true, message: 'Settings and encrypted credentials are stored in local application data. This file is not needed.' }, null, 2));
}
function recentProject(entry) { const cfg = loadConfig(); const previous = cfg.recentProjects.find(p => p.path === entry.path) || {}; const item = { ...previous, ...entry, updatedAt: new Date().toISOString() }; saveConfig({ activeProjectPath: item.path, recentProjects: [item, ...cfg.recentProjects.filter(p => p.path !== item.path)].slice(0, 20) }); return item; }
function redact(text) {
  let result = String(text || '').replace(/https:\/\/[^\s/@]+:[^\s/@]+@github\.com/gi, 'https://github.com').replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|AIza[A-Za-z0-9_-]{20,})\b/g, '[redacted]');
  for (const value of [readSecrets().githubToken, ...Object.values(readSecrets().aiKeys || {})]) if (value) result = result.split(value).join('[redacted]');
  return result;
}
module.exports = { DATA_DIR, loadConfig, saveConfig, readSecrets, writeSecrets, publicConfig, migrateLegacyConfig, recentProject, redact, atomicWrite };
