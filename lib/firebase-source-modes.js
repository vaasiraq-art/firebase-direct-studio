'use strict';

// Loaded only in the dedicated Firebase CLI process. Windows cannot represent
// Unix execute bits on disk, so provide verified staging modes to its ZIP writer.
const fs = require('node:fs');
const path = require('node:path');

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function rejectLinks(target) {
  let current = path.resolve(target);
  while (true) {
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Source permission metadata cannot use symbolic links or junctions.');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function installSourceModes(manifestPath) {
  if (typeof manifestPath !== 'string' || !path.isAbsolute(manifestPath)) throw new Error('Invalid source permission metadata path.');
  rejectLinks(manifestPath);
  const stat = fs.statSync(manifestPath);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('Invalid source permission metadata file.');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { throw new Error('Cannot read source permission metadata.'); }
  if (!manifest || typeof manifest.root !== 'string' || !path.isAbsolute(manifest.root) || path.resolve(manifestPath) !== path.resolve(manifest.root) + '.modes.json' || !Array.isArray(manifest.executableFiles) || manifest.executableFiles.length > 20000) throw new Error('Invalid source permission metadata.');
  const root = path.resolve(manifest.root);
  rejectLinks(root);
  if (!fs.statSync(root).isDirectory() || fs.realpathSync(root) !== root) throw new Error('Invalid source permission staging folder.');
  const executableFiles = new Set();
  for (const relative of manifest.executableFiles) {
    if (typeof relative !== 'string' || relative.length > 2048 || /[\\:\x00-\x1f]/.test(relative) || path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid executable source path.');
    const absolute = path.resolve(root, relative);
    if (!inside(root, absolute)) throw new Error('Executable source path leaves staging.');
    rejectLinks(absolute);
    if (!fs.statSync(absolute).isFile() || !inside(root, fs.realpathSync(absolute))) throw new Error('Invalid executable source file.');
    executableFiles.add(relative);
  }
  const reader = require('firebase-tools/lib/fsAsync');
  const original = reader.readdirRecursive;
  reader.readdirRecursive = async function (...args) {
    const files = await original.apply(this, args);
    return files.map(file => {
      const absolute = path.resolve(file.name);
      if (!inside(root, absolute)) return file;
      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      const mode = executableFiles.has(relative) ? 0o755 : 0o644;
      return { ...file, mode: (file.mode & ~0o7777) | mode };
    });
  };
}

if (process.env.FDS_SOURCE_MODES_PATH) {
  const manifestPath = process.env.FDS_SOURCE_MODES_PATH;
  delete process.env.FDS_SOURCE_MODES_PATH;
  installSourceModes(manifestPath);
}

module.exports = { installSourceModes };
