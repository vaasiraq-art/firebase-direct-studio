'use strict';
// Scan exactly the files Git will publish, including staged blobs.
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function git(args, encoding = 'utf8') { return execFileSync('git', args, { cwd: root, encoding, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }); }
const files = git(['ls-files', '-z']).split('\0').filter(Boolean);
if (!files.length) throw new Error('No release files are staged.');
const problems = [];
for (const file of files) {
  if (/(?:^|\/)(?:node_modules|workspaces|release|\.local)(?:\/|$)|(?:^|\/)(?:config\.json|settings\.json|credentials[^/]*|\.env(?:\..*)?)$|\.(?:lnk|enc|log|bak)$/i.test(file)) { problems.push(`${file}: local data must not be published`); continue; }
  const bytes = git(['show', ':' + file], 'buffer');
  if (bytes.includes(0)) continue;
  const text = bytes.toString('utf8');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{50,}|AIza[A-Za-z0-9_-]{30,}|sk-(?:proj-|ant-)[A-Za-z0-9_-]{30,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|AKIA[A-Z0-9]{16})\b/.test(text)) problems.push(`${file}: credential-like value`);
  if (/[A-Z]:[\\/]+Users[\\/]+(?!Public\b|Default\b)[a-z0-9_.-]+/i.test(text)) problems.push(`${file}: personal Windows home path`);
  if (/https:\/\/[^\s/@]+:[^\s/@]+@github\.com/i.test(text) && !file.startsWith('test/')) problems.push(`${file}: credential in Git URL`);
}
if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; }
else console.log(`Release scan passed: ${files.length} tracked files; no local data or credential patterns detected.`);
