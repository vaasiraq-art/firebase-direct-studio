'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Project configuration is data to inspect, never code to execute.
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.next-dev', '.firebase', 'dist', 'build', 'out', 'coverage', '.turbo', '.cache', 'vendor']);
const REQUIRED_IGNORES = [
  'firebase.json', '**/.*', '**/node_modules/**', '**/.git/**',
  '**/.env*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx',
  '**/*service-account*.json', '**/*serviceAccount*.json', '**/*credentials*.json',
  '**/config.json', '**/*.sqlite', '**/*.sqlite3', '**/*.db', '**/*.bak', '**/*.log',
  '**/package.json', '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml',
  '**/README.md', '**/Dockerfile', '**/*.ps1', '**/*.bat', '**/*.cmd', '**/*.sh',
  '**/*.exe', '**/*.dll', '**/*.cpp', '**/*.h', '**/*.py', '**/server.js',
  '**/next.config.*', '**/vite.config.*', '**/tsconfig.json'
];

function fileExists(file) {
  try { return !fs.lstatSync(file).isSymbolicLink() && fs.statSync(file).isFile(); } catch { return false; }
}

function dirExists(dir) {
  try { return !fs.lstatSync(dir).isSymbolicLink() && fs.statSync(dir).isDirectory(); } catch { return false; }
}

function entryExists(file) {
  try { fs.lstatSync(file); return true; } catch { return false; }
}

function safeReadText(file, maxLen = 40000) {
  try {
    if (!fileExists(file)) return '';
    const fd = fs.openSync(file, 'r');
    try {
      const bytes = Buffer.alloc(Math.min(fs.fstatSync(fd).size, maxLen));
      return bytes.subarray(0, fs.readSync(fd, bytes, 0, bytes.length, 0)).toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

function safeReadJson(file) {
  try {
    if (!fileExists(file) || fs.statSync(file).size > 1024 * 1024) return null;
    const value = JSON.parse(safeReadText(file, 1024 * 1024));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

function safeResolve(root, relative = '.', allowMissing = true) {
  if (typeof relative !== 'string' || !relative || /\0/.test(relative) || path.isAbsolute(relative) || /^[a-z]:/i.test(relative) || relative.startsWith('\\')) throw new Error('Use a relative path inside the selected project.');
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  if (!inside(base, target)) throw new Error('Path leaves the selected project.');
  let current = base;
  const parts = path.relative(base, target).split(path.sep).filter(Boolean);
  for (const part of ['', ...parts]) {
    if (part) current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (allowMissing && error.code === 'ENOENT') continue;
      throw new Error('Project path does not exist.');
    }
    // existsSync follows links and returns false for dangling links. lstat must come first.
    if (stat.isSymbolicLink() || !inside(fs.realpathSync(base), fs.realpathSync(current))) throw new Error('Symbolic links and junctions are not allowed in project paths.');
  }
  return target;
}

function walkSources(root, maxFiles = 1800) {
  const files = [];
  let scanned = 0;
  function visit(dir, depth) {
    if (depth > 9 || scanned >= 6000 || files.length >= maxFiles) return;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++scanned > 6000 || files.length >= maxFiles) break;
      if (item.isSymbolicLink() || item.name.startsWith('.') || SKIP_DIRS.has(item.name)) continue;
      const absolute = path.join(dir, item.name);
      if (item.isDirectory()) visit(absolute, depth + 1);
      else if (item.isFile()) files.push(path.relative(root, absolute).replace(/\\/g, '/'));
    }
  }
  visit(root, 0);
  return files;
}

function discoverAppRoots(repoRoot) {
  const roots = [];
  let scanned = 0;
  function visit(dir, depth) {
    if (++scanned > 300 || depth > 3) return;
    if (fileExists(path.join(dir, 'package.json')) || fileExists(path.join(dir, 'index.html'))) {
      const relative = path.relative(repoRoot, dir).replace(/\\/g, '/') || '.';
      roots.push({ path: relative, label: relative === '.' ? 'Repository root' : relative });
    }
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!item.isDirectory() || item.isSymbolicLink() || item.name.startsWith('.') || SKIP_DIRS.has(item.name)) continue;
      visit(path.join(dir, item.name), depth + 1);
    }
  }
  visit(repoRoot, 0);
  return roots;
}

function findEffectiveRoot(repoRoot, options = {}) {
  const root = safeResolve(path.resolve(repoRoot), '.', false);
  if (!dirExists(root)) throw new Error('Selected project must be a real directory.');
  const appRoots = discoverAppRoots(root);
  if (options.appSubdir !== undefined && options.appSubdir !== '') {
    const effectiveRoot = safeResolve(root, options.appSubdir, false);
    if (!dirExists(effectiveRoot)) throw new Error('App subfolder must be a directory.');
    return { effectiveRoot, relativeSubdir: path.relative(root, effectiveRoot).replace(/\\/g, '/'), appRoots, ambiguous: false };
  }
  const rootCandidate = appRoots.find(item => item.path === '.');
  const packageCandidates = appRoots.filter(item => fileExists(path.join(root, item.path, 'package.json')));
  const nextCandidates = options.deploymentMode === 'apphosting' ? packageCandidates.filter(item => {
    const pkg = safeReadJson(path.join(root, item.path, 'package.json'));
    return Boolean(pkg?.dependencies?.next || pkg?.devDependencies?.next);
  }) : [];
  const selected = options.deploymentMode === 'apphosting' && nextCandidates.length
    ? (nextCandidates.find(item => item.path === '.') || (nextCandidates.length === 1 ? nextCandidates[0] : null))
    : rootCandidate || (packageCandidates.length === 1 ? packageCandidates[0] : (appRoots.length === 1 ? appRoots[0] : null));
  return {
    effectiveRoot: selected ? safeResolve(root, selected.path, false) : root,
    relativeSubdir: selected && selected.path !== '.' ? selected.path : '',
    appRoots,
    ambiguous: !selected && appRoots.length > 1
  };
}

function detectAngularOutputDir(root) {
  const config = safeReadJson(path.join(root, 'angular.json'));
  const project = Object.values(config?.projects || {})[0];
  const build = project?.architect?.build || project?.targets?.build;
  const output = build?.options?.outputPath;
  const applicationBuilder = /:application$/.test(build?.builder || '');
  if (typeof output === 'string') return applicationBuilder ? `${output}/browser` : output;
  if (output && typeof output.base === 'string') return output.browser === '' ? output.base : `${output.base}/${output.browser || 'browser'}`;
  return project ? `dist/${Object.keys(config.projects)[0]}${applicationBuilder ? '/browser' : ''}` : 'dist';
}

// Small, conservative lexer for one safe edit. It never evaluates the Next.js
// configuration. Wrapped, computed, mutated, or spread configs require manual edits.
function configTokens(source) {
  const tokens = [];
  for (let index = 0; index < source.length;) {
    if (/\s/.test(source[index])) { index++; continue; }
    if (source.startsWith('//', index)) { const end = source.indexOf('\n', index); index = end < 0 ? source.length : end + 1; continue; }
    if (source.startsWith('/*', index)) { const end = source.indexOf('*/', index + 2); if (end < 0) return null; index = end + 2; continue; }
    const start = index;
    const quote = source[index];
    if (quote === '"' || quote === "'") {
      index++;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\') index++;
        index++;
      }
      if (index >= source.length) return null;
      tokens.push({ type: 'string', value: source.slice(start + 1, index), start, end: ++index });
      continue;
    }
    // Regex and template literals require a JavaScript parser; do not guess at them.
    if (quote === '`' || quote === '/') return null;
    if (/[a-zA-Z_$]/.test(source[index])) {
      while (index < source.length && /[a-zA-Z0-9_$]/.test(source[index])) index++;
      tokens.push({ type: 'identifier', value: source.slice(start, index), start, end: index });
      continue;
    }
    if (source.startsWith('...', index)) { tokens.push({ type: 'symbol', value: '...', start, end: index + 3 }); index += 3; continue; }
    tokens.push({ type: 'symbol', value: source[index], start, end: ++index });
  }
  return tokens;
}

function staticExportRemovalPlan(source) {
  const tokens = configTokens(source);
  const fallback = tokens
    ? tokens.some((token, index) => token.value === 'output' && [':', '='].includes(tokens[index + 1]?.value) && tokens[index + 2]?.type === 'string' && tokens[index + 2].value === 'export')
    : /\boutput\b["']?\s*[:=]\s*["']export["']/.test(source);
  const unsafe = { hasStaticExport: fallback, content: null };
  if (!tokens) return unsafe;
  const exports = [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].value === 'export' && tokens[index + 1]?.value === 'default') exports.push(index + 2);
    if (tokens[index].value === 'module' && tokens[index + 1]?.value === '.' && tokens[index + 2]?.value === 'exports' && tokens[index + 3]?.value === '=') exports.push(index + 4);
  }
  if (exports.length !== 1) return unsafe;
  let opening = exports[0];
  if (tokens[opening]?.value !== '{') {
    const name = tokens[opening];
    if (name?.type !== 'identifier' || (tokens[opening + 1] && tokens[opening + 1].value !== ';')) return unsafe;
    if (tokens.filter(token => token.type === 'identifier' && token.value === name.value).length !== 2) return unsafe;
    const declarations = [];
    for (let index = 0; index < opening; index++) {
      if (!['const', 'let', 'var'].includes(tokens[index].value) || tokens[index + 1]?.value !== name.value) continue;
      let equals = index + 2;
      while (equals < opening && !['=', ';'].includes(tokens[equals].value)) equals++;
      if (tokens[equals]?.value === '=' && tokens[equals + 1]?.value === '{') declarations.push(equals + 1);
    }
    if (declarations.length !== 1) return unsafe;
    opening = declarations[0];
  }
  let depth = 0;
  let closing = -1;
  let previousComma = -1;
  const properties = [];
  for (let index = opening + 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (depth === 0 && token.value === '}') { closing = index; break; }
    if (depth === 0 && (token.value === '...' || (token.value === '[' && (index === opening + 1 || tokens[index - 1]?.value === ',')))) return unsafe;
    if (depth === 0 && token.value === ',') previousComma = index;
    if (depth === 0 && ['string', 'identifier'].includes(token.type) && token.value === 'output' && tokens[index + 1]?.value === ':') {
      if (tokens[index + 2]?.type !== 'string' || tokens[index + 2]?.value !== 'export' || ![',', '}'].includes(tokens[index + 3]?.value)) return unsafe;
      properties.push({ key: index, value: index + 2, following: index + 3, previousComma });
    }
    if (['{', '[', '('].includes(token.value)) depth++;
    if (['}', ']', ')'].includes(token.value)) depth--;
    if (depth < 0) return unsafe;
  }
  if (closing < 0) return unsafe;
  if (properties.length !== 1) return { hasStaticExport: properties.length > 0, content: null };
  const property = properties[0];
  const start = tokens[property.following].value === ',' || property.previousComma < 0 ? tokens[property.key].start : tokens[property.previousComma].start;
  const end = tokens[property.following].value === ',' ? tokens[property.following].end : tokens[property.value].end;
  return { hasStaticExport: true, content: source.slice(0, start) + source.slice(end) };
}

function inspectProject(repoRoot, targetFirebaseProject = '', options = {}) {
  const deploymentMode = options.deploymentMode || 'hosting';
  if (!['hosting', 'apphosting'].includes(deploymentMode)) throw new Error('Deployment mode must be hosting or apphosting.');
  const root = path.resolve(repoRoot);
  const { effectiveRoot, relativeSubdir, appRoots, ambiguous } = findEffectiveRoot(root, options);
  const pkgPath = path.join(effectiveRoot, 'package.json');
  const pkg = safeReadJson(pkgPath);
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const scripts = pkg?.scripts || {};
  const issues = [];
  const issue = (id, severity, title, description, autoFixable = false, meta) => issues.push({ id, severity, title, description, autoFixable, ...(meta ? { meta } : {}) });
  let framework = 'static';
  let frameworkLabel = 'Static website';
  let expectedPublicDir = '.';
  let needsBuild = false;
  let isSPA = false;
  let nextConfigPath = '';
  let nextConfigText = '';
  let hasStaticExport = false;
  let exportRemoval = null;
  const runtimeFeatures = [];
  const environmentVariables = new Set();
  const configFile = names => names.map(name => path.join(effectiveRoot, name)).find(fileExists);

  if (ambiguous) issue('MULTIPLE_APP_ROOTS', 'error', 'Choose the app subfolder', 'This repository contains several apps. Choose the folder that you want to build and deploy.');
  if (entryExists(pkgPath) && !pkg) issue('INVALID_PACKAGE_JSON', 'error', 'Cannot read package.json', 'Repair invalid JSON or remove the symbolic link before building.');
  if (deps.next || configFile(['next.config.js', 'next.config.mjs', 'next.config.ts'])) {
    framework = 'nextjs'; frameworkLabel = 'Next.js'; expectedPublicDir = 'out';
  } else if (deps['@sveltejs/kit']) {
    framework = 'sveltekit'; frameworkLabel = 'SvelteKit'; expectedPublicDir = 'build'; isSPA = false;
  } else if (deps.vite || configFile(['vite.config.js', 'vite.config.ts', 'vite.config.mjs'])) {
    framework = 'vite'; frameworkLabel = deps.react ? 'React + Vite' : (deps.vue ? 'Vue + Vite' : 'Vite'); expectedPublicDir = 'dist'; isSPA = true;
    const viteConfig = configFile(['vite.config.js', 'vite.config.ts', 'vite.config.mjs']);
    const viteText = viteConfig ? safeReadText(viteConfig) : '';
    const output = viteText.match(/\boutDir\s*:\s*['"]([^'"]+)['"]/);
    if (output) expectedPublicDir = output[1];
    const base = viteText.match(/\bbase\s*:\s*['"]([^'"]*)['"]/);
    if (base && !['', '/', './'].includes(base[1])) issue('VITE_BASE_PATH', 'warning', 'Assets use a custom base path', `Vite base is "${base[1]}". Hosting at the domain root usually needs "/".`, true, { viteCfgPath: viteConfig });
  } else if (deps['react-scripts']) {
    framework = 'cra'; frameworkLabel = 'Create React App'; expectedPublicDir = 'build'; isSPA = true;
  } else if (deps['@angular/core'] || fileExists(path.join(effectiveRoot, 'angular.json'))) {
    framework = 'angular'; frameworkLabel = 'Angular'; expectedPublicDir = detectAngularOutputDir(effectiveRoot); isSPA = true;
  } else if (deps['@vue/cli-service']) {
    framework = 'vue'; frameworkLabel = 'Vue CLI'; expectedPublicDir = 'dist'; isSPA = true;
  } else if (deps.astro) {
    framework = 'astro'; frameworkLabel = 'Astro'; expectedPublicDir = 'dist';
    const astro = configFile(['astro.config.mjs', 'astro.config.js', 'astro.config.ts']);
    if (astro && /\boutput\s*:\s*['"](?:server|hybrid)['"]/.test(safeReadText(astro))) issue('ASTRO_SERVER_RUNTIME', 'error', 'Astro requires a server', 'This app uses server rendering. Use a server hosting service, or explicitly convert it to a static website.');
  } else if (scripts.build) {
    framework = 'custom-node'; frameworkLabel = 'Custom JavaScript build'; expectedPublicDir = fileExists(path.join(effectiveRoot, 'build', 'index.html')) ? 'build' : 'dist';
  }

  needsBuild = framework !== 'static' && typeof scripts.build === 'string' && scripts.build.trim().length > 0;
  if (framework !== 'static' && !needsBuild) issue('MISSING_BUILD_SCRIPT', 'error', 'Production build script is missing', 'Add a build script to package.json so the production website can be generated.');

  if (framework === 'static') {
    const candidate = ['.', 'public', 'dist', 'build', 'out', 'docs'].find(dir => fileExists(path.join(effectiveRoot, dir, 'index.html')));
    if (candidate) expectedPublicDir = candidate;
    else issue('NO_HTML_FOUND', 'error', 'No deployable website found', 'Choose a frontend app folder containing index.html or a supported production build. Desktop apps and backend servers cannot run on static Firebase Hosting.');
    if (pkg && !candidate && (scripts.start || deps.express || deps.fastify)) frameworkLabel = 'Backend / Node.js project';
  }

  if (framework === 'nextjs') {
    if (['next.config.js', 'next.config.mjs', 'next.config.ts'].some(name => entryExists(path.join(effectiveRoot, name)) && !fileExists(path.join(effectiveRoot, name)))) issue('INVALID_NEXT_CONFIG', 'error', 'Next.js configuration must be a regular local file', 'Remove symbolic links and junctions from the Next.js config path before deployment.');
    nextConfigPath = configFile(['next.config.js', 'next.config.mjs', 'next.config.ts']) || '';
    nextConfigText = nextConfigPath ? safeReadText(nextConfigPath, 250000) : '';
    exportRemoval = staticExportRemovalPlan(nextConfigText);
    hasStaticExport = exportRemoval.hasStaticExport;
    if (deploymentMode === 'hosting' && !hasStaticExport) issue('NEXTJS_STATIC_EXPORT', 'error', 'Next.js needs an explicit static export', 'Static Hosting serves exported files only. This app is not configured with output: "export". Choose Firebase App Hosting to run the full Next.js app, including server features. Auto-Fix will not rewrite it into a static app.');
    const sourceFiles = walkSources(effectiveRoot);
    const runtimeFiles = sourceFiles.filter(file => /(^|\/)(?:middleware|proxy)\.[cm]?[jt]s$/.test(file) || /(^|\/)(?:src\/)?pages\/api\//.test(file) || /(^|\/)app\/(?:.*\/)?route\.[jt]s$/.test(file));
    if (sourceFiles.some(file => /(^|\/)(?:src\/)?pages\/api\/|(^|\/)app\/(?:.*\/)?route\.[jt]s$/.test(file))) runtimeFeatures.push('api-routes');
    if (sourceFiles.some(file => /(^|\/)(?:middleware|proxy)\.[cm]?[jt]s$/.test(file))) runtimeFeatures.push('middleware');
    if (['pg', 'mysql2', 'better-sqlite3', '@prisma/client', 'drizzle-orm', '@aws-sdk/client-rds-data', '@electric-sql/pglite'].some(name => deps[name])) runtimeFeatures.push('database');
    for (const file of sourceFiles) {
      if (!/\.[cm]?[jt]sx?$/.test(file) || /(^|\/)(?:next|eslint|postcss|tailwind)\.config\./.test(file)) continue;
      const source = safeReadText(path.join(effectiveRoot, file), 60000);
      if (/['"]use server['"]/.test(source) && !runtimeFeatures.includes('server-actions')) runtimeFeatures.push('server-actions');
      if (/\bgetServerSideProps\b|\b(?:dynamic|fetchCache)\s*=\s*['"](?:force-dynamic|force-no-store)['"]|from\s*['"]next\/headers['"]/.test(source) && !runtimeFeatures.includes('request-runtime')) runtimeFeatures.push('request-runtime');
      if (/require\(\s*['"](?:pg|mysql2|better-sqlite3)['"]|from\s*['"](?:pg|mysql2|better-sqlite3|@prisma\/client)['"]/.test(source) && !runtimeFeatures.includes('database')) runtimeFeatures.push('database');
      for (const match of source.matchAll(/\bprocess\.env(?:\.([A-Z][A-Z0-9_]*)|\[['"]([A-Z][A-Z0-9_]*)['"]\])/g)) {
        const name = match[1] || match[2];
        if (!['NODE_ENV', 'PORT', 'HOSTNAME', 'CI', 'NEXT_RUNTIME', 'NEXT_PHASE', 'VERCEL'].includes(name) && environmentVariables.size < 80) environmentVariables.add(name);
      }
      if (/['"]use server['"]|\bgetServerSideProps\b|\b(?:dynamic|fetchCache)\s*=\s*['"](?:force-dynamic|force-no-store)['"]|from\s*['"]next\/headers['"]|require\(\s*['"](?:pg|mysql2|better-sqlite3)['"]|from\s*['"](?:pg|mysql2|better-sqlite3|@prisma\/client)['"]/.test(source)) runtimeFiles.push(file);
    }
    if (/\bserverActions\s*:/.test(nextConfigText) && !runtimeFeatures.includes('server-actions')) runtimeFeatures.push('server-actions');
    if (deploymentMode === 'hosting' && (runtimeFeatures.length || runtimeFiles.length)) issue('NEXTJS_SERVER_RUNTIME', 'error', 'This Next.js app uses server features', `Static Hosting cannot run API routes, server actions, request cookies, middleware, or database code. ${runtimeFiles.length ? `Detected: ${[...new Set(runtimeFiles)].slice(0, 5).join(', ')}.` : 'Server features are configured.'} Choose Firebase App Hosting to preserve the full app.`);
    if (deploymentMode === 'apphosting' && hasStaticExport) issue('APPHOSTING_STATIC_EXPORT', 'error', 'Remove static export for the Next.js server runtime', exportRemoval.content !== null ? 'Auto-Fix can remove the explicit output: "export" property while preserving server routes, actions, and all other configuration. The original config is backed up.' : 'This dynamic or wrapped Next.js config enables static export. Remove output: "export" from the exported config manually so App Hosting can build the server runtime. No config was changed.', exportRemoval.content !== null, { nextConfigPath });
  }

  if (framework === 'sveltekit') {
    const svelteConfig = configFile(['svelte.config.js', 'svelte.config.mjs', 'svelte.config.ts']);
    if (!deps['@sveltejs/adapter-static'] || !svelteConfig || !/adapter-static/.test(safeReadText(svelteConfig))) issue('SVELTEKIT_STATIC_ADAPTER', 'error', 'SvelteKit needs a static adapter', 'Use @sveltejs/adapter-static and prerender the app before deploying to static Hosting.');
    if (walkSources(effectiveRoot).some(file => /\+(?:server|page\.server|layout\.server)\.[jt]s$/.test(file))) issue('SVELTEKIT_SERVER_RUNTIME', 'error', 'SvelteKit has server routes', 'Server routes require a runtime and cannot be deployed by this static Hosting flow.');
  }

  if (relativeSubdir) issue('SUBFOLDER_DETECTED', 'info', `App folder: ${relativeSubdir}`, 'Builds and Hosting configuration use this folder.');
  if (framework === 'cra' && typeof pkg.homepage === 'string' && !['', '.', '/'].includes(pkg.homepage)) issue('GITHUB_PAGES_HOMEPAGE', 'warning', 'Asset homepage points to another location', 'Remove the custom Create React App homepage to load assets from the Firebase site root.', true);
  if (needsBuild && !dirExists(path.join(effectiveRoot, 'node_modules'))) issue('MISSING_NODE_MODULES', 'info', 'Dependencies are not installed', 'Deploy installs the dependencies before building.');

  let publicAbsolutePath = '';
  try { publicAbsolutePath = safeResolve(effectiveRoot, expectedPublicDir); }
  catch { issue('UNSAFE_OUTPUT_PATH', 'error', 'Build output leaves the selected app', 'Set a relative output directory inside the app folder and remove output symlinks.'); }
  const outputReady = Boolean(publicAbsolutePath && fileExists(path.join(publicAbsolutePath, 'index.html')));
  if (needsBuild && !outputReady) issue('BUILD_OUTPUT_PENDING', 'info', 'Production output is not built yet', `Deploy must produce ${expectedPublicDir}/index.html before publishing.`);
  if (outputReady) {
    const entry = safeReadText(path.join(publicAbsolutePath, 'index.html'), 16000);
    if (/Firebase Hosting Setup Complete/.test(entry)) issue('FIREBASE_PLACEHOLDER', 'error', 'Only the Firebase starter page is present', 'Replace the starter page with the real frontend build before deployment.');
    if (/successfully deployed via Firebase Direct Studio/.test(entry)) issue('GENERATED_PLACEHOLDER', 'error', 'A generated placeholder is not your application', 'An earlier version generated this starter page. Select the actual web app folder; this page does not run the repository application.');
  }

  const hostingConfigPath = path.join(effectiveRoot, 'firebase.json');
  const firebase = safeReadJson(hostingConfigPath);
  let hosting = null;
  if (entryExists(hostingConfigPath) && !firebase) issue('INVALID_FIREBASE_JSON', 'error', 'Cannot read firebase.json', 'Repair its JSON or remove the symbolic link. Auto-Fix preserves unreadable files.');
  else if (Array.isArray(firebase?.hosting)) issue('MULTISITE_HOSTING', 'error', 'Multiple Hosting sites need an explicit target', 'This project has multiple Hosting configurations. Choose and configure a single Hosting target before using this deployment flow.');
  else if (firebase?.hosting && (typeof firebase.hosting !== 'object' || firebase.hosting.source || firebase.hosting.frameworksBackend)) issue('FRAMEWORK_HOSTING', 'error', 'This configuration uses framework Hosting', 'This flow publishes static files. Existing framework/server Hosting configuration is preserved.');
  else {
    hosting = firebase?.hosting || null;
    if (!hosting) issue('MISSING_FIREBASE_JSON', 'warning', 'Hosting configuration is missing', `Auto-Fix can add static Hosting for "${expectedPublicDir}" without changing other Firebase services.`, true);
    else {
      if (hosting.rewrites !== undefined && !Array.isArray(hosting.rewrites)) issue('INVALID_HOSTING_ROUTES', 'error', 'Hosting rewrites must be an array', 'Repair the existing custom routing configuration before deployment.');
      if (Array.isArray(hosting.rewrites) && hosting.rewrites.some(rule => rule?.function || rule?.run)) issue('HOSTING_SERVER_REWRITES', 'error', 'Hosting routes depend on a backend runtime', 'This app forwards requests to Cloud Functions or Cloud Run. This static deployment flow cannot provision or validate that backend; use a runtime deployment workflow. Existing routes are preserved.');
      if (hosting.site || hosting.target) issue('HOSTING_EXPLICIT_TARGET', 'error', 'This app uses an explicit Hosting site or target', 'Choose a site-aware deployment workflow for this Firebase configuration. This flow deploys to the selected project default site and preserves your existing site and target settings.');
      try { safeResolve(effectiveRoot, hosting.public || 'public'); }
      catch { issue('UNSAFE_HOSTING_PATH', 'error', 'Hosting points outside the app or through a link', 'Choose a local output folder inside the selected app before deployment.'); }
      if (hosting.public !== expectedPublicDir) issue('WRONG_PUBLIC_DIR', 'warning', 'Hosting output folder does not match the app', `Hosting uses "${hosting.public || '(unset)'}"; the detected output is "${expectedPublicDir}".`, true);
      if (!Array.isArray(hosting.ignore) || REQUIRED_IGNORES.some(pattern => !hosting.ignore.includes(pattern))) issue('HOSTING_SECRET_IGNORES', 'warning', 'Hosting exclusions need protection', 'Auto-Fix excludes hidden files, credentials, dependencies, databases, build configuration, and local scripts.', true);
      if (isSPA && hosting.rewrites === undefined) issue('SPA_ROUTING', 'warning', 'Page refresh needs frontend routing', 'Auto-Fix can add an index.html fallback for this single page app.', true);
      else if (isSPA && Array.isArray(hosting.rewrites) && !hosting.rewrites.some(rule => rule?.source === '**' && rule?.destination === '/index.html')) issue('CUSTOM_ROUTING', 'warning', 'Custom Hosting routes are preserved', 'Review your existing rewrites if frontend page refreshes fail. Auto-Fix will not overwrite custom routes.');
    }
  }

  const rcPath = path.join(effectiveRoot, '.firebaserc');
  const rc = safeReadJson(rcPath);
  const currentBoundProject = rc?.projects?.default || '';
  if (entryExists(rcPath) && !rc) issue('INVALID_FIREBASERC', 'error', 'Cannot read .firebaserc', 'Repair its JSON or remove the symbolic link before linking a Firebase project.');
  else if (targetFirebaseProject && currentBoundProject !== targetFirebaseProject) issue('MISMATCH_FIREBASERC', 'info', `Link to ${targetFirebaseProject}`, 'Auto-Fix updates the default project while preserving other aliases and targets.', true);
  const staticCompatible = framework === 'nextjs' ? hasStaticExport && runtimeFeatures.length === 0 : !issues.some(item => ['NO_HTML_FOUND', 'ASTRO_SERVER_RUNTIME', 'SVELTEKIT_STATIC_ADAPTER', 'SVELTEKIT_SERVER_RUNTIME'].includes(item.id));
  const appHostingCompatible = framework === 'nextjs' && Boolean(deps.next);
  if (deploymentMode === 'apphosting') {
    // App Hosting builds and runs the source app. Static output and Firebase Hosting
    // configuration do not apply, and must never be generated or rewritten here.
    const staticIssueIds = new Set(['NO_HTML_FOUND', 'BUILD_OUTPUT_PENDING', 'UNSAFE_OUTPUT_PATH', 'FIREBASE_PLACEHOLDER', 'GENERATED_PLACEHOLDER', 'MISSING_FIREBASE_JSON', 'INVALID_FIREBASE_JSON', 'MULTISITE_HOSTING', 'FRAMEWORK_HOSTING', 'INVALID_HOSTING_ROUTES', 'HOSTING_SERVER_REWRITES', 'HOSTING_EXPLICIT_TARGET', 'UNSAFE_HOSTING_PATH', 'WRONG_PUBLIC_DIR', 'HOSTING_SECRET_IGNORES', 'SPA_ROUTING', 'CUSTOM_ROUTING', 'INVALID_FIREBASERC', 'MISMATCH_FIREBASERC', 'VITE_BASE_PATH', 'GITHUB_PAGES_HOMEPAGE']);
    for (let index = issues.length - 1; index >= 0; index--) if (staticIssueIds.has(issues[index].id)) issues.splice(index, 1);
    if (!appHostingCompatible) issue('APPHOSTING_FRAMEWORK_UNSUPPORTED', 'error', 'Choose a Next.js app for App Hosting', 'This deployment mode currently supports Next.js projects with a next dependency and production build script. Choose the Next.js app subfolder, or use static Hosting for a static website.');
    if (!pkg) issue('APPHOSTING_PACKAGE_REQUIRED', 'error', 'App Hosting needs package.json', 'Choose the Next.js source folder containing a valid package.json.');
    if (pkg && ((typeof pkg.packageManager === 'string' && !/^npm@/.test(pkg.packageManager)) || (!fileExists(path.join(effectiveRoot, 'package-lock.json')) && !fileExists(path.join(effectiveRoot, 'npm-shrinkwrap.json')) && ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'].some(file => entryExists(path.join(effectiveRoot, file)))))) issue('APPHOSTING_PACKAGE_MANAGER', 'error', 'This local deployment flow currently uses npm', 'Use an npm package-lock.json for this app, or deploy with the package manager supported by your own App Hosting workflow. No lockfiles were changed.');
    else if (pkg && !fileExists(path.join(effectiveRoot, 'package-lock.json')) && !fileExists(path.join(effectiveRoot, 'npm-shrinkwrap.json'))) issue('APPHOSTING_LOCKFILE', 'warning', 'Commit an npm lockfile for repeatable builds', 'App Hosting installs the app dependencies in the cloud. A package-lock.json or npm-shrinkwrap.json keeps dependency versions repeatable.');
    if (runtimeFeatures.includes('database')) issue('APPHOSTING_DATABASE', 'info', 'Backend database connections are preserved', 'Configure the database and storage connection settings for the cloud runtime. Deploying the Next.js server does not create or migrate an external database.');
    if (environmentVariables.size) issue('APPHOSTING_ENVIRONMENT', 'info', 'Configure the app environment for cloud builds and runtime', `The source references these variable names: ${[...environmentVariables].sort().join(', ')}. Add the values or Secret Manager references in App Hosting; local .env contents are not shared with the AI.`);
    expectedPublicDir = '';
    publicAbsolutePath = '';
  }
  const recommendedDeploymentMode = framework === 'nextjs' && (!hasStaticExport || runtimeFeatures.length) ? 'apphosting' : 'hosting';
  const blockReasons = issues.filter(item => item.severity === 'error' && !item.autoFixable).map(item => item.description);
  return {
    repoRoot: root, effectiveRoot, relativeSubdir, appRoots, framework, frameworkLabel,
    needsBuild, buildScript: needsBuild ? 'build' : '', expectedPublicDir, publicAbsolutePath,
    hostingConfigPath, isSPA, currentBoundProject, hasPackageJson: Boolean(pkg),
    packageName: pkg?.name || path.basename(effectiveRoot), issues,
    blocked: blockReasons.length > 0, blockReasons, outputReady: deploymentMode === 'hosting' ? outputReady : false,
    deploymentMode, recommendedDeploymentMode,
    deploymentModes: [
      { id: 'hosting', label: 'Static Hosting', supported: staticCompatible, reason: staticCompatible ? 'Publish production website files.' : 'This app needs a server runtime or a valid static frontend.' },
      { id: 'apphosting', label: 'Next.js App Hosting', supported: appHostingCompatible, reason: appHostingCompatible ? 'Build and run the full Next.js server app.' : 'Choose a Next.js app with a next dependency.' }
    ],
    capabilities: { staticHosting: staticCompatible, appHosting: appHostingCompatible, serverRendering: framework === 'nextjs', apiRoutes: runtimeFeatures.includes('api-routes'), serverActions: runtimeFeatures.includes('server-actions'), database: runtimeFeatures.includes('database'), runtime: framework === 'nextjs' ? 'nodejs' : null },
    runtimeFeatures, environmentVariables: [...environmentVariables].sort(), nextConfigPath, hasStaticExport
  };
}

function applyAutoFixes(repoRoot, targetFirebaseProject = '', options = {}) {
  if (targetFirebaseProject && !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(targetFirebaseProject)) throw new Error('Invalid Firebase project ID.');
  const report = inspectProject(repoRoot, targetFirebaseProject, options);
  const { effectiveRoot, expectedPublicDir, isSPA, issues } = report;
  const fixedLogs = [];
  const changedFiles = [];
  let backupDir = '';
  let backupBase = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'FirebaseDirectStudio', 'backups');
  if (inside(effectiveRoot, backupBase)) backupBase = path.join(os.tmpdir(), 'FirebaseDirectStudio', 'backups');
  if (inside(effectiveRoot, backupBase)) throw new Error('Choose a dedicated app folder rather than a system or temporary folder.');
  const write = (relative, text) => {
    const dest = safeResolve(effectiveRoot, relative);
    const before = fileExists(dest) ? fs.readFileSync(dest, 'utf8') : null;
    if (before === text) return;
    if (before !== null) {
      if (!backupDir) {
        fs.mkdirSync(backupBase, { recursive: true });
        backupDir = fs.mkdtempSync(path.join(backupBase, 'doctor-'));
        fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify({ projectRoot: effectiveRoot, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
      }
      const backupPath = path.join(backupDir, relative);
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.writeFileSync(backupPath, before, { mode: 0o600 });
    }
    fs.writeFileSync(dest, text, { mode: 0o600 });
    changedFiles.push(relative.replace(/\\/g, '/'));
  };
  if (report.blocked) return { fixedLogs: ['Resolve the blocking issues before applying automatic changes.'], backupDir, changedFiles, updatedInspection: report };
  if (report.deploymentMode === 'apphosting') {
    if (report.hasStaticExport) {
      const source = safeReadText(report.nextConfigPath, 250000);
      const plan = staticExportRemovalPlan(source);
      if (plan.content === null) return { fixedLogs: ['Remove static export manually from the dynamic Next.js configuration.'], backupDir, changedFiles, updatedInspection: report };
      write(path.relative(effectiveRoot, report.nextConfigPath), plan.content);
      fixedLogs.push('Removed the explicit static export setting; server routes, actions, and the remaining Next.js configuration were preserved.');
    } else fixedLogs.push('Next.js server configuration is ready for App Hosting; no source changes were needed.');
    return { fixedLogs, backupDir, changedFiles, updatedInspection: inspectProject(repoRoot, targetFirebaseProject, options) };
  }
  for (const item of issues) {
    if (item.id === 'GITHUB_PAGES_HOMEPAGE') {
      const pkg = safeReadJson(path.join(effectiveRoot, 'package.json'));
      delete pkg.homepage;
      write('package.json', JSON.stringify(pkg, null, 2) + '\n');
      fixedLogs.push('Removed the custom Create React App homepage.');
    }
    if (item.id === 'VITE_BASE_PATH') {
      const relative = path.relative(effectiveRoot, item.meta.viteCfgPath);
      const content = safeReadText(item.meta.viteCfgPath, 1024 * 1024);
      write(relative, content.replace(/\bbase\s*:\s*['"][^'"]*['"]/, "base: '/'"));
      fixedLogs.push('Set the Vite asset base to the domain root.');
    }
  }
  const config = safeReadJson(path.join(effectiveRoot, 'firebase.json')) || {};
  const hosting = { ...(config.hosting || {}) };
  hosting.public = expectedPublicDir;
  hosting.ignore = [...new Set([...(Array.isArray(hosting.ignore) ? hosting.ignore : []), ...REQUIRED_IGNORES])];
  if (hosting.cleanUrls === undefined) hosting.cleanUrls = true;
  if (isSPA && hosting.rewrites === undefined) hosting.rewrites = [{ source: '**', destination: '/index.html' }];
  config.hosting = hosting;
  write('firebase.json', JSON.stringify(config, null, 2) + '\n');
  fixedLogs.push(`Configured static Hosting for ${expectedPublicDir}; existing services and routes were preserved.`);
  if (targetFirebaseProject) {
    const rc = safeReadJson(path.join(effectiveRoot, '.firebaserc')) || {};
    rc.projects = { ...(rc.projects || {}), default: targetFirebaseProject };
    write('.firebaserc', JSON.stringify(rc, null, 2) + '\n');
    fixedLogs.push(`Linked the default Firebase project to ${targetFirebaseProject}.`);
  }
  return { fixedLogs, backupDir, changedFiles, updatedInspection: inspectProject(repoRoot, targetFirebaseProject, options) };
}

function globMatches(relative, pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = escaped.replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0001/g, '(?:.*/)?').replace(/\u0002/g, '.*');
  return new RegExp('^' + regex + '$').test(relative);
}

function validateHostingOutput(report) {
  if (report?.deploymentMode && report.deploymentMode !== 'hosting') throw new Error('Static Hosting validation cannot be used for an App Hosting project.');
  if (!report || report.blocked) throw new Error(report?.blockReasons?.join('\n') || 'Project inspection is required before deployment.');
  const output = safeResolve(report.effectiveRoot, report.expectedPublicDir, false);
  if (!dirExists(output) || !fileExists(path.join(output, 'index.html'))) throw new Error(`Build did not produce ${report.expectedPublicDir}/index.html. Nothing was deployed.`);
  const firebase = safeReadJson(report.hostingConfigPath);
  const hosting = firebase?.hosting;
  if (!hosting || Array.isArray(hosting) || hosting.public !== report.expectedPublicDir || !Array.isArray(hosting.ignore)) throw new Error('Run Auto-Fix to configure the detected Hosting output before deploying.');
  if (REQUIRED_IGNORES.some(pattern => !hosting.ignore.includes(pattern))) throw new Error('Hosting protection rules are missing. Run Auto-Fix before deploying.');
  let scanned = 0;
  let fileCount = 0;
  function visit(dir, relative = '') {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++scanned > 100000) throw new Error('Hosting output has too many files to validate. Use a dedicated production output folder.');
      const rel = relative ? `${relative}/${item.name}` : item.name;
      if (hosting.ignore.some(pattern => globMatches(rel, pattern) || (item.isDirectory() && globMatches(rel + '/__file__', pattern)))) continue;
      if (item.isSymbolicLink()) throw new Error(`Hosting output contains a symbolic link: ${rel}. Remove it before deployment.`);
      const full = safeResolve(output, rel, false);
      if (item.isDirectory()) visit(full, rel);
      else if (item.isFile()) {
        fileCount++;
        if (/(?:^|\/)(?:\.env[^/]*|\.npmrc|id_rsa|id_ed25519|[^/]*credentials[^/]*|[^/]*service[-_]?account[^/]*)$|\.(?:pem|key|pfx|p12|sqlite3?|db|bak)$/i.test(rel)) throw new Error(`Potential credential or private data file in Hosting output: ${rel}. Exclude it before deploying.`);
      }
    }
  }
  visit(output);
  return { outputDir: output, fileCount };
}

function validateAppHostingProject(report) {
  if (!report || report.deploymentMode !== 'apphosting') throw new Error('Select App Hosting mode before deploying the Next.js runtime.');
  // Inspect again so a stale browser report cannot bypass a changed config or path.
  const current = inspectProject(report.repoRoot, '', { deploymentMode: 'apphosting', appSubdir: report.relativeSubdir || '.' });
  const errors = current.issues.filter(issue => issue.severity === 'error');
  if (errors.length) throw new Error(errors.map(issue => issue.description).join('\n'));
  if (current.framework !== 'nextjs' || !current.needsBuild) throw new Error('App Hosting requires a Next.js dependency and a production build script.');
  const packagePath = safeResolve(current.effectiveRoot, 'package.json', false);
  const pkg = safeReadJson(packagePath);
  if (!pkg?.dependencies?.next && !pkg?.devDependencies?.next) throw new Error('The selected package.json does not include Next.js.');
  for (const name of ['package-lock.json', 'npm-shrinkwrap.json', 'next.config.js', 'next.config.mjs', 'next.config.ts', 'apphosting.yaml']) {
    if (entryExists(path.join(current.effectiveRoot, name))) safeResolve(current.effectiveRoot, name, false);
  }
  return { sourceDir: current.effectiveRoot, packagePath, framework: 'nextjs', packageManager: 'npm', buildScript: 'build', runtimeFeatures: current.runtimeFeatures, environmentVariables: current.environmentVariables };
}

function gatherProjectContextForAI(effectiveRoot, errorLog = '') {
  const root = safeResolve(effectiveRoot, '.', false);
  const candidates = ['package.json', 'firebase.json', 'vite.config.js', 'vite.config.ts', 'next.config.js', 'next.config.mjs', 'next.config.ts', 'tsconfig.json', 'index.html', 'public/index.html', 'src/main.jsx', 'src/main.tsx', 'src/index.js', 'src/index.tsx', 'src/App.jsx', 'src/App.tsx', 'src/App.js', 'src/App.vue', 'src/App.svelte', 'app/page.tsx', 'app/layout.tsx', 'src/app/page.tsx', 'src/app/layout.tsx', 'pages/index.tsx', 'pages/index.js', 'src/routes/+page.svelte', 'src/pages/index.astro'];
  const mentions = String(errorLog).slice(-20000).matchAll(/([a-zA-Z0-9_./\\-]+\.(?:jsx?|tsx?|html|css|vue|svelte|mjs|cjs))/g);
  for (const match of mentions) {
    let relative = match[1].replace(/\\/g, '/');
    const normalizedRoot = root.replace(/\\/g, '/');
    if (relative.startsWith(normalizedRoot + '/')) relative = relative.slice(normalizedRoot.length + 1);
    if (!candidates.includes(relative)) candidates.unshift(relative);
  }
  // Include actual source files when a framework uses another entry point. Source and
  // error-log paths still pass the same no-link, no-secret, project containment checks.
  for (const relative of walkSources(root, 800)) {
    if (/\.(?:jsx?|tsx?|html|css|vue|svelte|astro|mjs|cjs)$/.test(relative) && !candidates.includes(relative)) candidates.push(relative);
  }
  const result = [];
  let total = 0;
  for (const relative of candidates) {
    if (result.length >= 12 || total >= 100000) break;
    if (relative.split(/[\\/]/).some(part => part.startsWith('.') || SKIP_DIRS.has(part)) || /(?:^|\/)(?:secrets?|credentials?|service[-_]?account)(?:[./_-]|$)|(?:^|\/)config[^/]*\.json$|\.(?:env|pem|key)$/i.test(relative)) continue;
    if (relative.endsWith('.json') && !['package.json', 'firebase.json', 'tsconfig.json'].includes(relative)) continue;
    try {
      const full = safeResolve(root, relative, false);
      if (!fileExists(full) || fs.statSync(full).size > 250000) continue;
      const content = safeReadText(full, Math.min(12000, 100000 - total));
      if (hasEmbeddedSecret(content)) continue;
      total += content.length;
      result.push({ filePath: relative.replace(/\\/g, '/'), content });
    } catch { /* Invalid and linked paths are intentionally excluded. */ }
  }
  return result;
}

function hasEmbeddedSecret(content) {
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{30,}|\bsk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{20,}|\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}|\bAKIA[0-9A-Z]{16}\b|\bxox[bpars]-[A-Za-z0-9-]{15,}|\b(?:api[_-]?key|password|passwd|secret|token|client[_-]?secret|access[_-]?token|refresh[_-]?token|private[_-]?key)["']?\s*(?:=|:)\s*["'`][^"'`\r\n]+["'`]/i.test(content);
}

module.exports = { inspectProject, applyAutoFixes, gatherProjectContextForAI, findEffectiveRoot, validateHostingOutput, validateAppHostingProject };
