'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { inspectProject, applyAutoFixes, gatherProjectContextForAI, validateHostingOutput, validateAppHostingProject } = require('../doctor');

function fixture(t, files) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'firebase-doctor-test-'));
  const root = path.join(base, 'repo');
  fs.mkdirSync(root);
  const oldLocal = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join(base, 'local-data');
  for (const [relative, content] of Object.entries(files)) {
    const dest = path.join(root, relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, typeof content === 'string' ? content : JSON.stringify(content));
  }
  t.after(() => {
    if (oldLocal === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = oldLocal;
    const resolved = path.resolve(base);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('firebase-doctor-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return root;
}

test('non-web repositories are blocked and never replaced by a fake application', t => {
  const root = fixture(t, { 'CMakeLists.txt': 'project(DesktopApp)', 'src/main.cpp': 'int main() {}' });
  const result = applyAutoFixes(root, 'example-app');
  assert.equal(result.updatedInspection.blocked, true);
  assert.ok(result.updatedInspection.issues.some(issue => issue.id === 'NO_HTML_FOUND'));
  assert.equal(fs.existsSync(path.join(root, 'index.html')), false);
  assert.equal(fs.existsSync(path.join(root, 'firebase.json')), false);
});

test('the previously generated success placeholder is recognized as nonfunctional', t => {
  const root = fixture(t, { 'index.html': '<p>Project is successfully deployed via Firebase Direct Studio.</p>' });
  assert.ok(inspectProject(root).issues.some(issue => issue.id === 'GENERATED_PLACEHOLDER'));
  assert.throws(() => validateHostingOutput(inspectProject(root)), /starter page/);
});

test('Next server applications are blocked without rewriting their configuration', t => {
  const config = 'export default { experimental: { serverActions: {} } };';
  const root = fixture(t, {
    'package.json': { scripts: { build: 'next build' }, dependencies: { next: '16' } },
    'next.config.mjs': config,
    'app/api/orders/route.ts': 'export async function POST() { return Response.json({}); }'
  });
  const result = applyAutoFixes(root);
  assert.equal(result.updatedInspection.framework, 'nextjs');
  assert.equal(result.updatedInspection.blocked, true);
  assert.ok(result.updatedInspection.issues.some(issue => issue.id === 'NEXTJS_SERVER_RUNTIME'));
  assert.equal(fs.readFileSync(path.join(root, 'next.config.mjs'), 'utf8'), config);
});

test('an explicitly static Next export can be configured and validated', t => {
  const root = fixture(t, {
    'package.json': { scripts: { build: 'next build' }, dependencies: { next: '16' } },
    'next.config.mjs': "export default { output: 'export' };",
    'app/page.tsx': 'export default function Page() { return <main>Hello</main>; }',
    'out/index.html': '<main>Hello</main>'
  });
  const result = applyAutoFixes(root, 'example-app');
  assert.equal(result.updatedInspection.blocked, false);
  assert.equal(result.updatedInspection.expectedPublicDir, 'out');
  assert.equal(validateHostingOutput(result.updatedInspection).fileCount, 1);
});

test('auto-fixes preserve custom Firebase services, targets, headers, and rewrites with backups', t => {
  const original = {
    firestore: { rules: 'firestore.rules' },
    hosting: { public: 'public', headers: [{ source: '**', headers: [{ key: 'X-Test', value: 'yes' }] }], rewrites: [{ source: '/help/**', destination: '/help.html' }], ignore: ['custom/**'] }
  };
  const root = fixture(t, {
    'package.json': { scripts: { build: 'vite build' }, devDependencies: { vite: '7' } },
    'firebase.json': original,
    '.firebaserc': { projects: { default: 'old-site', production: 'prod-site' }, targets: { 'old-site': { hosting: {} } } },
    'dist/index.html': '<main>Real app</main>'
  });
  const result = applyAutoFixes(root, 'example-app');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'firebase.json')));
  const rc = JSON.parse(fs.readFileSync(path.join(root, '.firebaserc')));
  assert.deepEqual(config.firestore, original.firestore);
  assert.deepEqual(config.hosting.rewrites, original.hosting.rewrites);
  assert.deepEqual(config.hosting.headers, original.hosting.headers);
  assert.equal(config.hosting.public, 'dist');
  assert.equal(rc.projects.production, 'prod-site');
  assert.deepEqual(rc.targets, { 'old-site': { hosting: {} } });
  assert.ok(config.hosting.ignore.includes('custom/**'));
  assert.ok(result.backupDir && !result.backupDir.startsWith(root));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.backupDir, 'firebase.json'))), original);
  const second = applyAutoFixes(root, 'example-app');
  assert.equal(second.backupDir, '');
});

test('missing production output stops deployment even if a build command succeeds', t => {
  const root = fixture(t, { 'package.json': { scripts: { build: 'exit 0' }, devDependencies: { vite: '7' } } });
  const result = applyAutoFixes(root);
  assert.equal(result.updatedInspection.blocked, false);
  assert.equal(result.updatedInspection.outputReady, false);
  assert.throws(() => validateHostingOutput(result.updatedInspection), /does not exist|did not produce/);
});

test('nested app selection is explicit for multiple apps and traversal is rejected', t => {
  const root = fixture(t, { 'apps/one/index.html': '<h1>One</h1>', 'apps/two/index.html': '<h1>Two</h1>' });
  const report = inspectProject(root);
  assert.equal(report.blocked, true);
  assert.equal(report.appRoots.length, 2);
  const selected = inspectProject(root, '', { appSubdir: 'apps/two' });
  assert.equal(selected.blocked, false);
  assert.equal(selected.relativeSubdir, 'apps/two');
  assert.throws(() => inspectProject(root, '', { appSubdir: '../' }), /leaves/);
});

test('single nested frontend is detected without selecting dependency folders', t => {
  const root = fixture(t, { 'store/package.json': { scripts: { build: 'vite build' }, dependencies: { vite: '7' } }, 'node_modules/package/index.html': 'bad' });
  assert.equal(inspectProject(root).relativeSubdir, 'store');
});

test('malformed or multiple-site Hosting is preserved and blocks automatic deployment', t => {
  const root = fixture(t, { 'index.html': 'site', 'firebase.json': '{invalid json' });
  assert.equal(applyAutoFixes(root).updatedInspection.blocked, true);
  assert.equal(fs.readFileSync(path.join(root, 'firebase.json'), 'utf8'), '{invalid json');
  const multi = JSON.stringify({ hosting: [{ public: '.' }, { public: 'other' }] });
  fs.writeFileSync(path.join(root, 'firebase.json'), multi);
  assert.ok(applyAutoFixes(root).updatedInspection.issues.some(issue => issue.id === 'MULTISITE_HOSTING'));
  assert.equal(fs.readFileSync(path.join(root, 'firebase.json'), 'utf8'), multi);
});

test('backend Hosting rewrites are blocked early and never modified', t => {
  const original = JSON.stringify({ hosting: { public: '.', rewrites: [{ source: '/api/**', function: 'api' }, { source: '/service/**', run: { serviceId: 'service' } }] } });
  const root = fixture(t, { 'index.html': 'site', 'firebase.json': original });
  const report = applyAutoFixes(root).updatedInspection;
  assert.equal(report.blocked, true);
  assert.ok(report.issues.some(issue => issue.id === 'HOSTING_SERVER_REWRITES'));
  assert.equal(fs.readFileSync(path.join(root, 'firebase.json'), 'utf8'), original);
});

test('explicit Hosting site and target settings are blocked early and preserved', t => {
  const root = fixture(t, { 'index.html': 'site' });
  for (const key of ['site', 'target']) {
    const original = JSON.stringify({ hosting: { public: '.', [key]: 'custom-site' } });
    fs.writeFileSync(path.join(root, 'firebase.json'), original);
    const report = applyAutoFixes(root).updatedInspection;
    assert.equal(report.blocked, true);
    assert.ok(report.issues.some(issue => issue.id === 'HOSTING_EXPLICIT_TARGET'));
    assert.equal(fs.readFileSync(path.join(root, 'firebase.json'), 'utf8'), original);
  }
});

test('unsafe Vite output paths are blocked without writing Hosting configuration', t => {
  const root = fixture(t, { 'package.json': { scripts: { build: 'vite build' }, dependencies: { vite: '7' } }, 'vite.config.js': "export default {build:{outDir:'../outside'}}" });
  const report = applyAutoFixes(root).updatedInspection;
  assert.ok(report.issues.some(issue => issue.id === 'UNSAFE_OUTPUT_PATH'));
  assert.equal(fs.existsSync(path.join(root, 'firebase.json')), false);
});

test('Hosting validation excludes credentials, dependency trees, and local build scripts', t => {
  const root = fixture(t, {
    'index.html': '<h1>Site</h1>', 'assets/main.js': 'console.log(1)', '.env': 'PASSWORD=secret',
    'config.json': { githubToken: 'secret' }, 'secrets/private.key': 'secret',
    'node_modules/dependency/index.js': 'private dependency', 'Start.bat': 'echo private',
    'credentials.json': { secret: true }
  });
  const report = applyAutoFixes(root).updatedInspection;
  assert.equal(validateHostingOutput(report).fileCount, 2);
  fs.writeFileSync(path.join(root, 'ID_RSA'), 'secret');
  assert.throws(() => validateHostingOutput(report), /private data/);
});

test('Hosting refuses junctions leading outside the output directory', t => {
  const root = fixture(t, { 'index.html': 'site' });
  const outside = path.join(path.dirname(root), 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  const report = applyAutoFixes(root).updatedInspection;
  fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
  assert.throws(() => validateHostingOutput(report), /symbolic link/);
  assert.throws(() => inspectProject(root, '', { appSubdir: 'linked' }), /links|junctions/);
});

test('dangling output junctions cannot redirect later writes outside the app', t => {
  const root = fixture(t, {
    'package.json': { scripts: { build: 'vite build' }, dependencies: { vite: '7' } }
  });
  const outside = path.join(path.dirname(root), 'not-yet-created');
  fs.symlinkSync(outside, path.join(root, 'dist'), 'junction');
  const report = applyAutoFixes(root).updatedInspection;
  assert.equal(report.blocked, true);
  assert.ok(report.issues.some(issue => issue.id === 'UNSAFE_OUTPUT_PATH'));
  assert.equal(fs.existsSync(path.join(root, 'firebase.json')), false);
  assert.equal(fs.existsSync(outside), false);
});

test('invalid Firebase project IDs cause no partial configuration changes', t => {
  const root = fixture(t, { 'index.html': 'site' });
  assert.throws(() => applyAutoFixes(root, 'bad;command'), /Invalid Firebase/);
  assert.equal(fs.existsSync(path.join(root, 'firebase.json')), false);
});

test('AI context rejects traversal, hidden files, secrets, and linked directories', t => {
  const root = fixture(t, {
    'index.html': 'real app', 'package.json': { name: 'safe' },
    'src/App.tsx': 'export default function App() {return null;}',
    '.env.js': 'PASSWORD=secret', 'config.json': { githubToken: 'secret' },
    'src/credentials.ts': 'const data = {"access_token":"private"}',
    'src/key.ts': 'const key = "github_pat_abcdefghijklmnopqrstuvwxyz1234567890";'
  });
  const outside = path.join(path.dirname(root), 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.js'), 'outside secret');
  fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
  const context = gatherProjectContextForAI(root, '../outside/secret.js linked/secret.js .env.js src/credentials.ts src/key.ts src/App.tsx');
  assert.ok(context.some(file => file.filePath === 'src/App.tsx'));
  assert.ok(context.some(file => file.filePath === 'package.json'));
  assert.equal(context.some(file => /secret|credentials|\.env|key\.ts/.test(file.filePath)), false);
  assert.ok(context.length <= 12 && context.reduce((size, file) => size + file.content.length, 0) <= 100000);
});

test('modern Angular application builders select browser output', t => {
  const root = fixture(t, {
    'package.json': { scripts: { build: 'ng build' }, dependencies: { '@angular/core': '20' } },
    'angular.json': { projects: { client: { architect: { build: { builder: '@angular/build:application', options: { outputPath: 'dist/client' } } } } } }
  });
  assert.equal(inspectProject(root).expectedPublicDir, 'dist/client/browser');
});

test('AI discovers framework source files while excluding embedded provider keys and passwords', t => {
  const root = fixture(t, {
    'package.json': { scripts: { build: 'next build' }, dependencies: { next: '16' } },
    'next.config.mjs': "export default { output: 'export' };",
    'app/page.tsx': 'export default function Page() {return <main>Home</main>}',
    'app/widgets/controls.tsx': 'export function Controls() {return <button>Go</button>}',
    'lib/openai.ts': 'const clientKey = "' + 'sk-' + 'proj-' + 'abcdefghijklmnopqrstuvwxyz1234567890";',
    'lib/anthropic.ts': 'const clientKey = "' + 'sk-' + 'ant-api03-' + 'abcdefghijklmnopqrstuvwxyz1234567890";',
    'lib/stripe.ts': 'const clientKey = "' + 'sk_' + 'live_' + 'abcdefghijklmnopqrstuvwxyz1234";',
    'lib/settings.ts': 'export const API_KEY = "private-data";',
    'lib/database.ts': 'const options = { password: "private-password" };',
    'lib/aws.ts': 'const clientKey = "' + 'AKIA' + 'ABCDEFGHIJKLMNOP";',
    'lib/runtime.ts': 'export const key = process.env.API_KEY;'
  });
  const files = gatherProjectContextForAI(root).map(file => file.filePath);
  assert.ok(files.includes('app/page.tsx'));
  assert.ok(files.includes('app/widgets/controls.tsx'));
  assert.ok(files.includes('lib/runtime.ts'));
  for (const name of ['openai', 'anthropic', 'stripe', 'settings', 'database', 'aws']) assert.equal(files.includes(`lib/${name}.ts`), false);
});

test('App Hosting detects a nested Next server app and preserves its APIs, actions, and database', t => {
  const root = fixture(t, {
    'package.json': { private: true, workspaces: ['store'] },
    'store/package.json': { scripts: { build: 'next build' }, dependencies: { next: '15', pg: '8' } },
    'store/next.config.ts': "import type {NextConfig} from 'next'; const config:NextConfig={serverExternalPackages:['pg'],experimental:{serverActions:{bodySizeLimit:'6mb'}}}; export default config;",
    'store/app/api/orders/route.ts': "export async function POST(){ return Response.json({ok:true}); }",
    'store/app/actions.ts': "'use server'; export async function save(){ return process.env.DATABASE_URL; }",
    'store/middleware.ts': 'export function middleware() {}',
    'store/.env': 'DATABASE_URL=secret://private-data'
  });
  const report = inspectProject(root, '', { deploymentMode: 'apphosting' });
  assert.equal(report.relativeSubdir, 'store');
  assert.equal(report.framework, 'nextjs');
  assert.equal(report.deploymentMode, 'apphosting');
  assert.equal(report.recommendedDeploymentMode, 'apphosting');
  assert.equal(report.blocked, false);
  assert.equal(report.expectedPublicDir, '');
  assert.equal(report.outputReady, false);
  assert.equal(report.capabilities.serverActions, true);
  assert.equal(report.capabilities.apiRoutes, true);
  assert.equal(report.capabilities.database, true);
  assert.equal(report.capabilities.appHosting, true);
  assert.equal(report.capabilities.staticHosting, false);
  assert.ok(report.environmentVariables.includes('DATABASE_URL'));
  assert.ok(!report.issues.some(issue => ['NEXTJS_STATIC_EXPORT', 'NEXTJS_SERVER_RUNTIME', 'BUILD_OUTPUT_PENDING', 'MISSING_FIREBASE_JSON'].includes(issue.id)));
  const validated = validateAppHostingProject(report);
  assert.equal(validated.sourceDir, path.join(root, 'store'));
  assert.equal(validated.packageManager, 'npm');
  assert.throws(() => validateHostingOutput(report), /cannot be used/);
  const context = gatherProjectContextForAI(report.effectiveRoot);
  assert.equal(context.some(file => file.filePath.startsWith('.env') || file.content.includes('secret://private-data')), false);
});

test('App Hosting safe fixes are a no-op for runtime Next.js configuration and static config is preserved', t => {
  const next = "export default {serverExternalPackages:['pg'],poweredByHeader:false};";
  const root = fixture(t, {
    'package.json': { scripts: { build: 'next build' }, dependencies: { next: '15', pg: '8' } },
    'next.config.mjs': next,
    'firebase.json': '{old static config preserved even when not parseable',
    '.firebaserc': '{old aliases preserved',
    'app/api/route.ts': 'export function GET() { return Response.json({}) }'
  });
  const result = applyAutoFixes(root, 'example-app', { deploymentMode: 'apphosting' });
  assert.equal(result.updatedInspection.blocked, false);
  assert.deepEqual(result.changedFiles, []);
  assert.equal(result.backupDir, '');
  assert.equal(fs.readFileSync(path.join(root, 'next.config.mjs'), 'utf8'), next);
  assert.equal(fs.readFileSync(path.join(root, 'firebase.json'), 'utf8'), '{old static config preserved even when not parseable');
  assert.equal(fs.readFileSync(path.join(root, '.firebaserc'), 'utf8'), '{old aliases preserved');
  validateAppHostingProject(result.updatedInspection);
});

test('App Hosting does not confuse comments, strings, or nested plugin output with Next static export', t => {
  const originals = [
    "// Before switching we had output: 'export'\nexport default {poweredByHeader:false};",
    "export default {env:{DOCUMENTATION:\"output: 'export'\"},poweredByHeader:false};",
    "export default {experimental:{plugin:{output:'export'}},poweredByHeader:false};"
  ];
  const root = fixture(t, { 'package.json': { scripts: { build: 'next build' }, dependencies: { next: '15' } } });
  for (const source of originals) {
    fs.writeFileSync(path.join(root, 'next.config.mjs'), source);
    const result = applyAutoFixes(root, '', { deploymentMode: 'apphosting' });
    assert.equal(result.updatedInspection.hasStaticExport, false);
    assert.equal(result.updatedInspection.blocked, false);
    assert.deepEqual(result.changedFiles, []);
    assert.equal(fs.readFileSync(path.join(root, 'next.config.mjs'), 'utf8'), source);
    validateAppHostingProject(result.updatedInspection);
  }
});

test('App Hosting removes only an explicit literal static export and backs up its original config', t => {
  const originals = [
    "export default {output:'export',poweredByHeader:false};",
    "export default {poweredByHeader:false, output:'export'};",
    "module.exports={output:'export'};",
    "import type {NextConfig} from 'next'; const nextConfig:NextConfig={images:{unoptimized:true}, /* preserve */ output:'export',serverExternalPackages:['pg']}; export default nextConfig;",
    "const config={ 'output' /* comment */ : \"export\", experimental:{serverActions:{bodySizeLimit:'6mb'}} }; module.exports=config;"
  ];
  const root = fixture(t, {
    'package.json': { scripts: { build: 'next build' }, dependencies: { next: '15', pg: '8' } },
    'app/api/route.ts': 'export function POST() {}'
  });
  for (const original of originals) {
    fs.writeFileSync(path.join(root, 'next.config.ts'), original);
    const before = inspectProject(root, '', { deploymentMode: 'apphosting' });
    assert.ok(before.issues.some(issue => issue.id === 'APPHOSTING_STATIC_EXPORT' && issue.autoFixable));
    assert.throws(() => validateAppHostingProject(before), /Auto-Fix can remove/);
    const result = applyAutoFixes(root, '', { deploymentMode: 'apphosting' });
    assert.deepEqual(result.changedFiles, ['next.config.ts']);
    assert.ok(result.backupDir && !result.backupDir.startsWith(root));
    assert.equal(fs.readFileSync(path.join(result.backupDir, 'next.config.ts'), 'utf8'), original);
    const after = fs.readFileSync(path.join(root, 'next.config.ts'), 'utf8');
    assert.equal(/output[^:]*:\s*['"]export/.test(after), false);
    assert.equal(result.updatedInspection.hasStaticExport, false);
    assert.equal(fs.existsSync(path.join(root, 'firebase.json')), false);
    assert.equal(fs.existsSync(path.join(root, '.firebaserc')), false);
    assert.equal(fs.readFileSync(path.join(root, 'app/api/route.ts'), 'utf8'), 'export function POST() {}');
    validateAppHostingProject(result.updatedInspection);
  }
});

test('dynamic, wrapped, spread, and mutated static-export Next.js configs require manual edits', t => {
  const originals = [
    "export default plugin({output:'export'});",
    "export default {...base,output:'export'};",
    "const config={output:'export'}; config.images={unoptimized:true}; export default config;",
    "const config={output:'export',output:'export'}; export default config;"
  ];
  const root = fixture(t, { 'package.json': { scripts: { build: 'next build' }, dependencies: { next: '15' } } });
  for (const original of originals) {
    fs.writeFileSync(path.join(root, 'next.config.mjs'), original);
    const result = applyAutoFixes(root, '', { deploymentMode: 'apphosting' });
    assert.equal(result.updatedInspection.blocked, true);
    assert.deepEqual(result.changedFiles, []);
    assert.equal(fs.readFileSync(path.join(root, 'next.config.mjs'), 'utf8'), original);
    assert.throws(() => validateAppHostingProject(result.updatedInspection), /manually/);
  }
});

test('App Hosting validates Next dependency, build script, npm package manager, and current source', t => {
  const root = fixture(t, { 'package.json': { scripts: { build: 'next build' }, dependencies: { next: '15' }, packageManager: 'pnpm@9' } });
  assert.ok(inspectProject(root, '', { deploymentMode: 'apphosting' }).issues.some(issue => issue.id === 'APPHOSTING_PACKAGE_MANAGER'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { build: 'next build' }, dependencies: { next: '15' } }));
  const report = inspectProject(root, '', { deploymentMode: 'apphosting' });
  validateAppHostingProject(report);
  fs.writeFileSync(path.join(root, 'next.config.mjs'), "export default {output:'export'}");
  assert.throws(() => validateAppHostingProject(report), /static export|Auto-Fix/);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { next: '15' } }));
  assert.ok(inspectProject(root, '', { deploymentMode: 'apphosting' }).issues.some(issue => issue.id === 'MISSING_BUILD_SCRIPT'));
  assert.throws(() => inspectProject(root, '', { deploymentMode: 'invalid' }), /Deployment mode/);
});

test('App Hosting refuses native and static-only projects without generating Firebase config', t => {
  const root = fixture(t, { 'index.html': 'static website', 'CMakeLists.txt': 'project(DesktopApp)' });
  const result = applyAutoFixes(root, '', { deploymentMode: 'apphosting' });
  assert.equal(result.updatedInspection.blocked, true);
  assert.ok(result.updatedInspection.issues.some(issue => issue.id === 'APPHOSTING_FRAMEWORK_UNSUPPORTED'));
  assert.deepEqual(result.changedFiles, []);
  assert.equal(fs.existsSync(path.join(root, 'firebase.json')), false);
});

test('static Hosting reports the exact changed files and keeps App Hosting opt-in', t => {
  const root = fixture(t, { 'index.html': 'site' });
  const result = applyAutoFixes(root, 'example-app');
  assert.deepEqual(result.changedFiles, ['firebase.json', '.firebaserc']);
  assert.equal(result.updatedInspection.deploymentMode, 'hosting');
  assert.equal(result.updatedInspection.recommendedDeploymentMode, 'hosting');
  assert.deepEqual(applyAutoFixes(root, 'example-app').changedFiles, []);
  assert.throws(() => validateAppHostingProject(result.updatedInspection), /Select App Hosting/);
});
