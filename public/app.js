'use strict';
const state = { config: {}, csrfToken: '', github: {}, githubRepos: [], firebase: {}, activeInspection: null, importing: false, deploying: false, activeJobId: null, activeJobType: 'deploy', unknownJob: null, proposalId: null, lastDeployErrorLog: '', pollTimer: null, pollFailures: 0, refreshRunning: false, loginTimer: null, loginChecks: 0, appHosting: null, appHostingLoading: false, appHostingRequest: 0 };
const el = id => document.getElementById(id);
function node(tag, className, text) { const result = document.createElement(tag); if (className) result.className = className; if (text !== undefined) result.textContent = text; return result; }
function show(id, visible = true) { el(id).classList.toggle('hidden', !visible); }
function message(id, text, type = '') { const target = el(id); target.textContent = text || ''; target.className = (id === 'pageMessage' ? 'notice' : 'status-message') + (type ? ' ' + type : ''); if (id === 'pageMessage') target.classList.toggle('hidden', !text); }
function badge(id, text, type = '') { const target = el(id); target.textContent = text; target.className = 'badge' + (type ? ' ' + type : ''); }
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
async function api(url, method = 'GET', body) {
  if (method !== 'GET' && !state.csrfToken) { const sessionResponse = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' }); if (!sessionResponse.ok) throw new Error('Unable to establish a local session. Refresh this page.'); state.csrfToken = (await sessionResponse.json()).csrfToken; }
  const options = { method, credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } };
  if (method !== 'GET') { options.headers['Content-Type'] = 'application/json'; options.headers['X-CSRF-Token'] = state.csrfToken; if (body !== undefined) options.body = JSON.stringify(body); }
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { if (response.status === 403 && /session|csrf/i.test(data.error || '')) state.csrfToken = ''; const error = new Error(data.error || `Request failed (${response.status}).`); error.status = response.status; throw error; }
  return data;
}
async function busy(id, label, operation) { const button = el(id); if (button.disabled) return; const previous = button.textContent; button.disabled = true; button.textContent = label; try { return await operation(); } finally { button.disabled = false; button.textContent = previous; } }
function projectPath() { const i = state.activeInspection; return i?.repoRoot || i?.rootDir || state.config.activeProjectPath || ''; }
function projectBody() { return { projectPath: projectPath(), firebaseProject: el('firebaseProjectSelect').value || state.config.defaultFirebaseProject || '', appSubdir: el('appSubdirInput').value.trim(), deploymentMode: el('deploymentModeSelect').value || state.activeInspection?.deploymentMode || 'auto' }; }
function validWebsite(raw) { try { const url = new URL(raw); if (url.protocol === 'https:' && !url.username && !url.password && (url.hostname.endsWith('.web.app') || url.hostname.endsWith('.firebaseapp.com') || url.hostname.endsWith('.hosted.app') || url.hostname.endsWith('.run.app'))) return url.href; } catch {} return ''; }
function validPullRequest(raw) { try { const url = new URL(raw); if (url.protocol === 'https:' && url.hostname === 'github.com' && /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+\/?$/.test(url.pathname) && !url.username && !url.password) return url.href; } catch {} return ''; }
function validGithubCompare(raw) { try { const url = new URL(raw); if (url.protocol === 'https:' && url.hostname === 'github.com' && /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/compare\/.+/.test(url.pathname) && !url.username && !url.password && !url.search && !url.hash) return url.href; } catch {} return ''; }
function validFirebaseConsole(raw) { try { const url = new URL(raw); if (url.protocol === 'https:' && ['console.firebase.google.com', 'console.cloud.google.com'].includes(url.hostname) && !url.username && !url.password && !url.port) return url.href; } catch {} return ''; }
function friendlyDate(raw) { const date = new Date(raw); return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
function setEmpty(container, text) { container.replaceChildren(node('div', 'empty-state', text)); }

window.addEventListener('DOMContentLoaded', () => { bindEvents(); loadAllData(); });
function bindEvents() {
  const actions = {
    refreshAllBtn: loadAllData,
    btnConnectGithub: () => connectGithub(false),
    btnConnectToken: () => connectGithub(true),
    btnDisconnectGithub: disconnectGithub,
    btnRefreshFirebase: checkFirebaseStatus,
    btnLoginFirebase: triggerFirebaseLogin,
    btnSaveConnections: saveAiSettings,
    btnRemoveAiKey: removeAiKey,
    btnImportGithubUrl: () => importGithubRepo(el('githubRepoUrlInput').value.trim(), el('branchSelect').value),
    btnBrowseLocalFolder: browseLocalFolder,
    btnReloadRepos: loadGithubRepos,
    btnLoadBranches: loadBranches,
    btnRescanProject: () => selectProject(projectPath()),
    btnSetAppFolder: () => selectProject(projectPath(), true),
    btnAutoFixAll: runAutoFixAll,
    btnFixGithub: startGithubRepair,
    btnUseRecommendedMode: () => changeDeploymentMode('auto'),
    btnRefreshAppHosting: () => loadAppHostingStatus(true),
    btnCreateAppHostingBackend: createAppHostingBackend,
    btnRunAiDoctor: () => runAiDoctor(false),
    btnApplyAiPatches: applyAiPatches,
    btnDeployNow: startDeployPipeline,
    checkDeploymentStatus: checkDeploymentStatus,
    acknowledgeDeployment: acknowledgeDeployment,
    btnFixDeployErrorWithAi: () => { el('aiDetails').open = true; el('aiDetails').scrollIntoView({ behavior: 'smooth', block: 'center' }); return runAiDoctor(true); },
    btnToggleNewFbProject: () => show('newFbProjectDrawer', el('newFbProjectDrawer').classList.contains('hidden')),
    btnCancelFbProject: () => show('newFbProjectDrawer', false),
    btnCreateFbProject: createNewFirebaseProject,
    btnCopyLiveUrl: () => copyText(el('livePrimaryUrl').textContent, 'btnCopyLiveUrl', 'Copied'),
    btnCopyLogs: () => copyText(el('deployTerminalBody').textContent, 'btnCopyLogs', 'Copied')
  };
  for (const [id, action] of Object.entries(actions)) el(id).addEventListener('click', () => Promise.resolve().then(action).catch(error => message('pageMessage', errorMessage(error), 'error')));
  el('githubRepoUrlInput').addEventListener('keydown', event => { if (event.key === 'Enter') el('btnImportGithubUrl').click(); });
  el('githubRepoUrlInput').addEventListener('input', () => { el('branchSelect').replaceChildren(new Option('Default branch', '')); });
  el('repoSearchInput').addEventListener('input', renderGithubRepos);
  el('repoVisibility').addEventListener('change', renderGithubRepos);
  el('firebaseProjectSelect').addEventListener('change', () => changeFirebaseProject().catch(error => message('pageMessage', errorMessage(error), 'error')));
  el('deploymentModeSelect').addEventListener('change', () => changeDeploymentMode().catch(error => message('pageMessage', errorMessage(error), 'error')));
  el('appHostingBackendSelect').addEventListener('change', () => changeAppHostingBackend().catch(error => message('appHostingStatusMessage', errorMessage(error), 'error')));
  el('aiProviderSelect').addEventListener('change', () => { el('aiApiKeyInput').value = ''; const provider = el('aiProviderSelect').value; el('aiModelInput').value = provider === state.config.aiProvider ? state.config.aiModel || '' : ''; updateAiStatus(provider); });
  for (const link of document.querySelectorAll('.tab')) link.addEventListener('click', () => { document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active')); link.classList.add('active'); });
}
async function loadAllData() {
  if (state.refreshRunning) return; state.refreshRunning = true; el('refreshAllBtn').disabled = true;
  try {
    const session = await api('/api/session'); state.csrfToken = session.csrfToken;
    await loadConfig();
    const localProject = state.config.activeProjectPath ? selectProject(state.config.activeProjectPath).catch(error => message('pageMessage', errorMessage(error), 'error')) : Promise.resolve();
    await Promise.allSettled([checkFirebaseStatus(), loadGithubConnection(), localProject.then(restoreUnknownDeployment)]);
  } catch (error) { message('pageMessage', 'Cannot connect to Firebase Direct Studio. ' + errorMessage(error), 'error'); }
  finally { state.refreshRunning = false; el('refreshAllBtn').disabled = false; updateReadiness(); }
}
async function loadConfig() {
  state.config = await api('/api/config');
  el('aiProviderSelect').value = state.config.aiProvider || 'openai';
  el('aiModelInput').value = state.config.aiModel || '';
  updateAiStatus(); renderRecentProjects(); updateTarget();
}
function updateAiStatus(provider = el('aiProviderSelect').value) {
  const saved = Boolean(state.config.aiKeyStatus?.[provider] || (provider === state.config.aiProvider && state.config.hasAiKey) || (provider === 'gemini' && state.config.hasGeminiKey));
  badge('aiStatusPill', saved ? 'Key saved' : 'Optional', saved ? 'success' : '');
  el('aiStatusText').textContent = saved ? 'A key is saved for this provider. Leave the key field blank to keep it.' : 'Add your own provider key to use AI analysis. Deployment works without AI.';
  el('aiApiKeyInput').placeholder = saved ? 'Saved key — paste to replace' : 'Paste a new key to save';
  show('btnRemoveAiKey', saved);
  const defaultModel = state.config.aiProviders?.find(item => item.id === provider)?.defaultModel;
  el('aiModelInput').placeholder = defaultModel ? `Default: ${defaultModel}` : 'Enter a model available to your account';
}
async function saveAiSettings() {
  await busy('btnSaveConnections', 'Saving…', async () => {
    message('saveConfigStatus', 'Saving AI settings…', 'loading');
    try { const body = { aiProvider: el('aiProviderSelect').value, aiModel: el('aiModelInput').value.trim() }; const key = el('aiApiKeyInput').value.trim(); if (key) body.aiApiKey = key; state.config = { ...state.config, ...await api('/api/config', 'POST', body) }; el('aiApiKeyInput').value = ''; updateAiStatus(); message('saveConfigStatus', 'AI settings saved.', 'success'); }
    catch (error) { message('saveConfigStatus', errorMessage(error), 'error'); }
  });
}
async function removeAiKey() {
  await busy('btnRemoveAiKey', 'Removing…', async () => {
    const provider = el('aiProviderSelect').value;
    state.config = { ...state.config, ...await api('/api/config', 'POST', { aiProvider: provider, clearAiKey: true }) };
    el('aiApiKeyInput').value = ''; updateAiStatus(provider); message('saveConfigStatus', 'Saved API key removed from this app.', 'success');
  });
}

async function loadGithubConnection() {
  try { state.github = await api('/api/github/status'); renderGithubConnection(); if (state.github.connected) await loadGithubRepos(); else { state.githubRepos = []; renderGithubRepos(); } }
  catch (error) { badge('ghStatusPill', 'Unavailable', 'warning'); el('ghStatusText').textContent = errorMessage(error); }
}
function renderGithubConnection() {
  const connected = Boolean(state.github.connected);
  badge('ghStatusPill', connected ? 'Connected' : 'Not connected', connected ? 'success' : '');
  el('ghStatusText').textContent = connected ? `Signed in as ${state.github.username || 'GitHub user'}. ${state.github.privateAccess === false ? 'Private repository access has not been verified.' : 'Repositories available to your account will appear below.'}` : (state.github.message || 'Connect with your existing GitHub sign-in, or use a personal access token.');
  el('btnConnectGithub').textContent = connected ? 'Check GitHub connection' : 'Connect GitHub'; show('btnDisconnectGithub', connected); updateReadiness();
}
async function connectGithub(useToken) {
  const id = useToken ? 'btnConnectToken' : 'btnConnectGithub';
  const token = useToken ? el('githubTokenInput').value.trim() : '';
  if (useToken && !token) { message('githubConnectionMessage', 'Paste a GitHub token first.', 'error'); return; }
  await busy(id, 'Connecting…', async () => {
    message('githubConnectionMessage', 'Checking GitHub authentication…', 'loading');
    try {
      const data = await api('/api/github/connect', 'POST', token ? { token } : {});
      el('githubTokenInput').value = '';
      if (data.connected === false) { state.github = data; renderGithubConnection(); message('githubConnectionMessage', data.message || 'Complete GitHub sign-in, then check the connection.', ''); return; }
      await loadGithubConnection(); message('githubConnectionMessage', state.github.connected ? `Connected as ${state.github.username || 'GitHub user'}.` : data.message || 'Check your GitHub sign-in.', state.github.connected ? 'success' : '');
    } catch (error) { message('githubConnectionMessage', errorMessage(error), 'error'); }
  });
}
async function disconnectGithub() {
  await busy('btnDisconnectGithub', 'Disconnecting…', async () => { await api('/api/github/disconnect', 'POST', {}); state.github = {}; state.githubRepos = []; renderGithubConnection(); renderGithubRepos(); message('githubConnectionMessage', 'Disconnected from this app.', ''); });
}
async function loadGithubRepos() {
  const button = el('btnReloadRepos'); button.disabled = true;
  setEmpty(el('githubReposList'), 'Loading repositories…');
  try { const data = await api('/api/github/repos'); state.githubRepos = data.repos || []; if (data.connected !== undefined) state.github = { ...state.github, connected: data.connected, username: data.username || state.github.username }; renderGithubConnection(); renderGithubRepos(); if (data.message) message('githubConnectionMessage', data.message); }
  catch (error) { state.githubRepos = []; setEmpty(el('githubReposList'), 'Could not load repositories. ' + errorMessage(error)); message('githubConnectionMessage', errorMessage(error), 'error'); }
  finally { button.disabled = false; }
}
function renderGithubRepos() {
  const query = el('repoSearchInput').value.toLowerCase().trim(); const visibility = el('repoVisibility').value;
  const filtered = state.githubRepos.filter(repo => `${repo.fullName || repo.name} ${repo.description || ''}`.toLowerCase().includes(query) && (visibility === 'all' || repo.private === (visibility === 'private')));
  el('repoCount').textContent = String(state.githubRepos.length);
  const list = el('githubReposList'); list.replaceChildren();
  if (!filtered.length) { setEmpty(list, state.github.connected ? 'No matching repositories. Check your filter or the repository permissions on your GitHub token.' : 'Connect GitHub to see your public and private repositories. You can also import a public repository by URL.'); return; }
  for (const repo of filtered) {
    const row = node('div', 'repo-item'); const meta = node('div', 'repo-meta');
    const title = node('div', 'repo-name'); title.append(node('span', 'repo-symbol', '⑂'), node('span', '', repo.fullName || repo.name), node('span', 'badge', repo.private ? 'Private' : 'Public')); meta.append(title);
    if (repo.description) meta.append(node('p', 'repo-description', repo.description));
    const details = node('div', 'repo-details'); if (repo.language) { const language = node('span', '', repo.language); language.prepend(node('span', 'language-dot')); details.append(language); } if (repo.updatedAt) details.append(node('span', '', 'Updated ' + friendlyDate(repo.updatedAt))); meta.append(details);
    const button = node('button', 'btn btn-small repo-import', 'Import'); button.type = 'button'; button.disabled = state.importing || state.deploying || state.appHostingSetupRunning; button.addEventListener('click', () => { el('githubRepoUrlInput').value = repo.fullName || repo.cloneUrl; el('branchSelect').replaceChildren(new Option(repo.defaultBranch || 'Default branch', repo.defaultBranch || '')); importGithubRepo(repo.cloneUrl || repo.fullName, repo.defaultBranch || ''); }); row.append(meta, button); list.append(row);
  }
}
function renderRecentProjects() {
  const list = el('recentProjectsList'); list.replaceChildren(); const recent = state.config.recentProjects || [];
  if (!recent.length) { setEmpty(list, 'No imported projects yet.'); return; }
  for (const project of recent.slice(0, 8)) {
    const row = node('div', 'repo-item'); const meta = node('div', 'repo-meta'); const name = node('div', 'repo-name', project.name || 'Project');
    if (project.path === state.config.activeProjectPath) name.append(node('span', 'badge success', 'Selected'));
    meta.append(name, node('div', 'repo-details', project.frameworkLabel || project.sourceType || 'Local project'));
    const button = node('button', 'btn btn-small', 'Open'); button.type = 'button'; button.disabled = state.importing || state.deploying || state.appHostingSetupRunning; button.addEventListener('click', () => selectProject(project.path, false).then(() => el('project').scrollIntoView({ behavior: 'smooth' })).catch(error => message('pageMessage', errorMessage(error), 'error'))); row.append(meta, button); list.append(row);
  }
}
async function loadBranches() {
  await busy('btnLoadBranches', 'Loading…', async () => {
    const repo = el('githubRepoUrlInput').value.trim(); if (!repo) { message('importStatusMsg', 'Enter a repository first.', 'error'); return; }
    try { const data = await api('/api/github/branches?repo=' + encodeURIComponent(repo)); const select = el('branchSelect'); select.replaceChildren(new Option('Default branch', '')); for (const branch of data.branches || []) select.add(new Option(branch.name || branch, branch.name || branch)); message('importStatusMsg', `${(data.branches || []).length} branches loaded. Choose a branch, then import.`, 'success'); }
    catch (error) { message('importStatusMsg', errorMessage(error), 'error'); }
  });
}
function importBusy(value) { state.importing = value; el('btnImportGithubUrl').disabled = value || state.deploying || state.appHostingSetupRunning; el('btnBrowseLocalFolder').disabled = value || state.deploying || state.appHostingSetupRunning; renderGithubRepos(); renderRecentProjects(); updateReadiness(); }
async function importGithubRepo(repoUrl, branch = '') {
  if (state.importing || state.deploying || state.appHostingSetupRunning) return; if (!repoUrl) { message('importStatusMsg', 'Enter a GitHub repository or choose one below.', 'error'); return; }
  importBusy(true); message('importStatusMsg', 'Importing repository and checking deployment setup…', 'loading');
  try { const data = await api('/api/project/import-github', 'POST', { repoUrl, branch }); state.config.activeProjectPath = data.project.path; renderInspection(data.inspection); await loadConfig(); message('importStatusMsg', `Imported ${data.project.name}. Review the deployment checks below.`, 'success'); el('project').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  catch (error) { message('importStatusMsg', errorMessage(error), 'error'); }
  finally { importBusy(false); }
}
async function browseLocalFolder() {
  if (state.importing || state.deploying || state.appHostingSetupRunning) return; importBusy(true); message('importStatusMsg', 'Choose a project folder in the Windows folder picker…', 'loading');
  try { const data = await api('/api/project/pick-local-folder', 'POST', {}); if (data.cancelled) { message('importStatusMsg', 'Folder selection canceled.'); return; } state.config.activeProjectPath = data.project.path; renderInspection(data.inspection); await loadConfig(); message('importStatusMsg', 'Opened ' + data.project.name + '.', 'success'); el('project').scrollIntoView({ behavior: 'smooth' }); }
  catch (error) { message('importStatusMsg', errorMessage(error), 'error'); }
  finally { importBusy(false); }
}
async function selectProject(path, useInputFolder = false) {
  if (!path || state.deploying || state.appHostingSetupRunning) return;
  const normalizePath = value => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const changedProject = normalizePath(path) !== normalizePath(projectPath());
  const body = { projectPath: path, firebaseProject: el('firebaseProjectSelect').value || state.config.defaultFirebaseProject || '', deploymentMode: changedProject ? 'auto' : state.config.deploymentMode || 'auto' };
  if (changedProject) body.appSubdir = '';
  if (useInputFolder) body.appSubdir = el('appSubdirInput').value.trim();
  const data = await api('/api/project/select', 'POST', body); state.config.activeProjectPath = path; state.config.deploymentMode = body.deploymentMode; if (body.appSubdir !== undefined) state.config.appSubdir = body.appSubdir; renderInspection(data.inspection); renderRecentProjects();
}
function renderInspection(inspection) {
  const previousPath = state.activeInspection?.repoRoot || state.activeInspection?.rootDir;
  if (previousPath && previousPath !== (inspection?.repoRoot || inspection?.rootDir)) show('githubRepairResult', false);
  state.activeInspection = inspection; state.proposalId = null; show('aiResultBox', false); show('autoFixLogsArea', false); show('noProjectSelectedBanner', !inspection); show('doctorContentArea', Boolean(inspection));
  if (!inspection) { badge('issuesCountBadge', 'No project'); updateReadiness(); return; }
  el('sumProjectName').textContent = inspection.packageName || inspection.projectName || projectPath().split(/[\\/]/).pop() || 'Web project';
  el('sumProjectPath').textContent = inspection.effectiveRoot || inspection.projectDir || inspection.rootDir || '';
  el('sumFramework').textContent = inspection.frameworkLabel || inspection.framework || 'Unknown'; el('sumPublicDir').textContent = inspection.deploymentMode === 'apphosting' ? 'Managed Next.js runtime' : inspection.expectedPublicDir || 'Not detected'; el('sumOutputLabel').textContent = inspection.deploymentMode === 'apphosting' ? 'Build target' : 'Publish folder';
  el('appSubdirInput').value = inspection.relativeSubdir || inspection.appSubdir || '';
  el('appRootsList').replaceChildren(); for (const root of inspection.appRoots || []) el('appRootsList').append(new Option(root.label || root.path, root.path));
  const issues = [...(inspection.issues || [])]; const actionable = issues.filter(issue => issue.severity !== 'info');
  badge('issuesCountBadge', inspection.blocked ? 'Action required' : actionable.length ? `${actionable.length} checks to review` : 'Checks passed', inspection.blocked ? 'error' : actionable.length ? 'warning' : 'success');
  const list = el('issuesListContainer'); list.replaceChildren();
  if (!issues.length) issues.push({ severity: 'success', title: 'Deployment configuration checks passed', description: 'The build and Firebase publish steps will verify that this project can be deployed.' });
  for (const issue of issues) { const severity = ['error', 'warning', 'info', 'success'].includes(issue.severity) ? issue.severity : 'warning'; const row = node('div', 'issue-card ' + severity); const content = node('div'); row.append(node('span', 'issue-mark', severity === 'success' ? '✓' : severity === 'info' ? 'ⓘ' : '!')); content.append(node('strong', '', issue.title || 'Deployment issue'), node('p', '', issue.description || '')); if (issue.autoFixable === false && issue.severity === 'error') content.append(node('span', 'badge warning', 'Manual change required')); row.append(content); list.append(row); }
  renderDeploymentMode(inspection); el('btnAutoFixAll').disabled = state.deploying; updateTarget(); updateReadiness();
}
function renderDeploymentMode(inspection) {
  const mode = inspection.deploymentMode || 'hosting';
  const choices = inspection.deploymentModes || [{ id: 'hosting', label: 'Firebase Hosting · Static website', supported: true }, { id: 'apphosting', label: 'Firebase App Hosting · Full Next.js', supported: inspection.framework === 'nextjs' }];
  const select = el('deploymentModeSelect'); select.replaceChildren();
  for (const choice of choices) { const option = new Option(choice.label, choice.id); option.disabled = choice.supported === false; select.add(option); }
  select.value = mode; select.disabled = state.deploying;
  const recommended = inspection.recommendedDeploymentMode || mode;
  badge('deploymentModeRecommendation', recommended === 'apphosting' ? 'Full Next.js recommended' : 'Static Hosting recommended', '');
  show('btnUseRecommendedMode', recommended !== mode);
  el('deploymentModeHelp').textContent = choices.find(choice => choice.id === mode)?.reason || (mode === 'apphosting' ? 'Runs your Next.js server, API routes, server actions, and database connections. Firebase Blaze billing is required.' : 'Serves built HTML, CSS, and JavaScript. Apps with server features need App Hosting.');
  const chips = el('runtimeCapabilities'); chips.replaceChildren();
  const capabilities = inspection.capabilities || {};
  for (const [key, label] of [['serverRendering', 'Server rendering'], ['apiRoutes', 'API routes'], ['serverActions', 'Server actions'], ['database', 'Database'], ['staticHosting', 'Static output']]) if (capabilities[key]) chips.append(node('span', 'badge', label));
  const environmentNames = (inspection.environmentVariables || []).filter(name => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
  const environmentList = el('appHostingEnvironmentNames'); environmentList.replaceChildren(); for (const name of environmentNames) environmentList.append(node('code', 'badge', name));
  show('appHostingEnvironment', environmentNames.length > 0);
  show('appHostingPanel', mode === 'apphosting');
  if (mode === 'apphosting') loadAppHostingStatus().catch(error => message('appHostingStatusMessage', errorMessage(error), 'error'));
}
async function changeDeploymentMode(override) {
  if (!state.activeInspection || state.deploying || state.appHostingSetupRunning) return;
  const mode = typeof override === 'string' ? override : el('deploymentModeSelect').value;
  el('deploymentModeSelect').disabled = true;
  try { const data = await api('/api/project/select', 'POST', { ...projectBody(), deploymentMode: mode }); state.config.deploymentMode = mode; renderInspection(data.inspection); }
  catch (error) { el('deploymentModeSelect').value = state.activeInspection.deploymentMode || 'hosting'; throw error; }
  finally { el('deploymentModeSelect').disabled = state.deploying || state.appHostingSetupRunning; }
}
async function loadAppHostingStatus(force = false) {
  if (state.activeInspection?.deploymentMode !== 'apphosting') return;
  const firebaseProject = el('firebaseProjectSelect').value;
  if (!firebaseProject) { state.appHostingRequest++; state.appHosting = null; state.appHostingLoading = false; state.appHostingPendingProject = ''; el('btnRefreshAppHosting').disabled = false; renderAppHostingStatus(); return; }
  if (!force && state.appHosting?.firebaseProject === firebaseProject && !state.appHosting.error) { renderAppHostingStatus(); return; }
  if (state.appHostingLoading && state.appHostingPendingProject === firebaseProject) return;
  const request = ++state.appHostingRequest; state.appHostingLoading = true; state.appHostingPendingProject = firebaseProject;
  el('btnRefreshAppHosting').disabled = true; badge('appHostingBillingBadge', 'Checking billing'); message('appHostingStatusMessage', 'Checking billing and loading App Hosting backends…', 'loading'); updateReadiness();
  try { const data = await api('/api/apphosting/status?firebaseProject=' + encodeURIComponent(firebaseProject)); if (request !== state.appHostingRequest) return; state.appHosting = { ...data, firebaseProject }; }
  catch (error) { if (request !== state.appHostingRequest) return; state.appHosting = { firebaseProject, billingEnabled: null, backends: [], error: errorMessage(error) }; }
  finally { if (request === state.appHostingRequest) { state.appHostingLoading = false; el('btnRefreshAppHosting').disabled = Boolean(state.appHostingSetupRunning); renderAppHostingStatus(); updateReadiness(); } }
}
function renderAppHostingStatus() {
  const project = el('firebaseProjectSelect').value; const status = state.appHosting?.firebaseProject === project ? state.appHosting : null;
  const select = el('appHostingBackendSelect'); const selected = select.value || state.config.appHostingBackendId || ''; select.replaceChildren(new Option('Choose a backend…', ''));
  for (const backend of status?.backends || []) { const id = backend.id || (backend.name || '').split('/').pop(); if (id) select.add(new Option(`${id}${backend.location ? ' · ' + backend.location : ''}`, id)); }
  if ([...select.options].some(option => option.value === selected)) select.value = selected;
  select.disabled = state.deploying || state.appHostingLoading || !(status?.backends || []).length;
  el('btnRefreshAppHosting').disabled = Boolean(state.appHostingLoading || state.appHostingSetupRunning);
  if (!project) { badge('appHostingBillingBadge', 'Select project'); message('appHostingStatusMessage', 'Choose a Firebase project in Connections.'); }
  else if (status?.billingEnabled === true) { badge('appHostingBillingBadge', 'Billing enabled', 'success'); message('appHostingStatusMessage', status.backendError || status.error || status.message || (status.backends?.length ? 'Select the backend that should receive this app.' : 'No backends found. Create a backend below to continue.'), status.backendError || status.error ? 'error' : ''); }
  else if (status?.billingEnabled === false) { badge('appHostingBillingBadge', 'Blaze required', 'warning'); message('appHostingStatusMessage', 'This project needs Blaze billing for App Hosting. Review the plan in Firebase, then refresh. This app does not upgrade your plan.', ''); }
  else { badge('appHostingBillingBadge', 'Billing unverified', 'warning'); message('appHostingStatusMessage', status?.billingError || status?.error || 'Billing could not be verified. Check the connection and refresh.', status?.error || status?.billingError ? 'error' : ''); }
  el('appHostingBillingLink').href = project ? `https://console.firebase.google.com/project/${encodeURIComponent(project)}/usage/details` : 'https://console.firebase.google.com/';
  el('appHostingConsoleLink').href = project ? `https://console.firebase.google.com/project/${encodeURIComponent(project)}/apphosting` : 'https://console.firebase.google.com/';
  el('btnCreateAppHostingBackend').disabled = state.deploying || state.appHostingLoading || status?.billingEnabled !== true || status?.cliAvailable === false || !state.activeInspection || state.appHostingSetupRunning;
  const locations = status?.locations || [];
  el('backendLocationsList').replaceChildren();
  for (const location of locations) { const id = typeof location === 'string' ? location : location.id || location.locationId || location.name?.split('/').pop(); if (id) el('backendLocationsList').append(new Option(location.label || id, id)); }
  const availableRegions = [...el('backendLocationsList').options].map(option => option.value);
  if (availableRegions.length && !availableRegions.includes(el('backendLocationInput').value)) el('backendLocationInput').value = availableRegions[0];
  renderBackendHelp(); updateTarget();
}
function selectedBackend() { return (state.appHosting?.backends || []).find(backend => (backend.id || (backend.name || '').split('/').pop()) === el('appHostingBackendSelect').value); }
function renderBackendHelp() {
  const backend = selectedBackend();
  el('appHostingBackendHelp').textContent = backend ? `${backend.uri || backend.id || backend.name}${backend.rootDir ? ' · App folder: ' + backend.rootDir : ''}` : 'Choose the backend for this app. The deployment sends local source files and runs a managed cloud build.';
}
async function changeAppHostingBackend() {
  const backendId = el('appHostingBackendSelect').value; state.config = { ...state.config, ...await api('/api/config', 'POST', { appHostingBackendId: backendId }) }; renderBackendHelp(); updateTarget(); updateReadiness();
}
async function createAppHostingBackend() {
  const backendId = el('newBackendIdInput').value.trim(); const location = el('backendLocationInput').value.trim();
  if (!/^[a-z][a-z0-9-]{1,28}[a-z0-9]$/.test(backendId)) { message('appHostingSetupMessage', 'Use 3–30 lowercase letters, numbers, or hyphens. Start with a letter and end with a letter or number.', 'error'); return; }
  if (!location) { message('appHostingSetupMessage', 'Choose an App Hosting region.', 'error'); return; }
  await busy('btnCreateAppHostingBackend', 'Creating backend…', async () => {
    state.appHostingSetupRunning = true; importBusy(false); lockProjectOperations(true); el('btnRefreshAppHosting').disabled = true; message('appHostingSetupMessage', 'Creating the backend. Your billing plan is unchanged.', 'loading');
    try { const data = await api('/api/apphosting/setup', 'POST', { ...projectBody(), backendId, location }); state.config.appHostingBackendId = data.backendId || backendId; await loadAppHostingStatus(true); el('appHostingBackendSelect').value = state.config.appHostingBackendId; await changeAppHostingBackend(); message('appHostingSetupMessage', data.message || 'Backend created. Review the destination, then deploy when ready.', 'success'); }
    catch (error) { message('appHostingSetupMessage', errorMessage(error), 'error'); }
    finally { state.appHostingSetupRunning = false; lockProjectOperations(false); importBusy(false); renderAppHostingStatus(); updateReadiness(); }
  });
  renderAppHostingStatus(); updateReadiness();
}
async function runAutoFixAll() {
  if (!state.activeInspection || state.deploying) return;
  await busy('btnAutoFixAll', 'Fixing setup…', async () => { try { const data = await api('/api/project/autofix', 'POST', projectBody()); renderInspection(data.inspection); el('chkSyncGithub').checked = false; el('autoFixLogsArea').textContent = ((data.fixedLogs || []).join('\n') || 'No automatic configuration changes were needed.') + '\nGitHub sync is off for the next deployment so your local fixes are preserved.'; show('autoFixLogsArea'); } catch (error) { message('pageMessage', errorMessage(error), 'error'); } });
}

async function checkFirebaseStatus() {
  const button = el('btnRefreshFirebase'); button.disabled = true; badge('fbStatusPill', 'Checking');
  try {
    state.firebase = await api('/api/firebase/status'); const connected = Boolean(state.firebase.isLoggedIn); const unavailable = state.firebase.connectionStatus === 'unavailable';
    badge('fbStatusPill', unavailable ? 'Unavailable' : connected ? 'Connected' : 'Not connected', unavailable ? 'warning' : connected ? 'success' : ''); el('fbStatusText').textContent = unavailable ? `Saved sign-in${state.firebase.email ? ' for ' + state.firebase.email : ''}. ${state.firebase.message || 'Firebase is temporarily unavailable. Check the connection and retry.'}` : connected ? `Signed in as ${state.firebase.email || 'Google account'}. ${state.firebase.message || ''}`.trim() : state.firebase.message || state.firebase.error || 'Sign in to your Google account to select a Firebase project.';
    el('btnLoginFirebase').textContent = connected ? 'Switch account' : 'Sign in';
    const select = el('firebaseProjectSelect'); const selected = state.config.defaultFirebaseProject || select.value; select.replaceChildren(new Option('Choose a project…', ''));
    for (const project of state.firebase.projects || []) select.add(new Option(`${project.displayName || project.projectId} (${project.projectId})`, project.projectId));
    if (selected && [...select.options].some(option => option.value === selected)) select.value = selected;
    if (state.firebase.error && connected) message('pageMessage', 'Firebase could not list projects. ' + state.firebase.error, 'error');
    updateTarget();
    if (connected && state.loginTimer) { clearTimeout(state.loginTimer); state.loginTimer = null; message('pageMessage', 'Firebase account connected. Choose the project to deploy to.', 'success'); }
  } catch (error) { state.firebase = { ...state.firebase, connectionStatus: 'unavailable' }; badge('fbStatusPill', 'Unavailable', 'warning'); el('fbStatusText').textContent = errorMessage(error); }
  finally { button.disabled = false; updateReadiness(); if (state.activeInspection?.deploymentMode === 'apphosting') loadAppHostingStatus().catch(error => message('appHostingStatusMessage', errorMessage(error), 'error')); }
}
async function triggerFirebaseLogin() {
  await busy('btnLoginFirebase', 'Opening sign-in…', async () => { const data = await api('/api/firebase/login', 'POST', {}); message('pageMessage', data.message || 'Complete Google sign-in in the opened browser window, then check the connection.'); state.loginChecks = 0; if (state.loginTimer) clearTimeout(state.loginTimer); state.loginTimer = setTimeout(pollLogin, 4000); });
}
async function pollLogin() { state.loginChecks++; await checkFirebaseStatus(); if (!state.firebase.isLoggedIn && state.loginChecks < 30) state.loginTimer = setTimeout(pollLogin, 5000); }
async function changeFirebaseProject() {
  const value = el('firebaseProjectSelect').value; state.appHostingRequest++; state.appHosting = null; state.appHostingLoading = false; state.appHostingPendingProject = ''; updateTarget(); state.config = { ...state.config, ...await api('/api/config', 'POST', { defaultFirebaseProject: value }) }; if (state.activeInspection) await selectProject(projectPath()); updateReadiness();
}
function updateTarget() {
  const id = el('firebaseProjectSelect').value || state.config.defaultFirebaseProject || '';
  const apphosting = state.activeInspection?.deploymentMode === 'apphosting'; const backend = apphosting ? selectedBackend() : null;
  el('selectedWebAppPreview').textContent = id ? apphosting ? `App Hosting · ${id}` : `https://${id}.web.app` : '';
  el('sumTargetUrl').textContent = id ? apphosting ? validWebsite(backend?.uri) || (backend ? `${backend.id || backend.name} · ${id}` : 'Choose an App Hosting backend') : `https://${id}.web.app` : 'Choose a Firebase project';
}
async function createNewFirebaseProject() {
  const projectId = el('newFbProjectId').value.trim().toLowerCase(); const displayName = el('newFbProjectName').value.trim(); if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) { message('createFbProjectMsg', 'Use 6–30 lowercase letters, numbers, or hyphens. Start with a letter and end with a letter or number.', 'error'); return; }
  await busy('btnCreateFbProject', 'Creating…', async () => { message('createFbProjectMsg', 'Creating Firebase project…', 'loading'); try { await api('/api/firebase/create-project', 'POST', { projectId, displayName }); state.config.defaultFirebaseProject = projectId; await checkFirebaseStatus(); el('firebaseProjectSelect').value = projectId; updateTarget(); updateReadiness(); message('createFbProjectMsg', 'Project created. You can deploy to it now.', 'success'); } catch (error) { message('createFbProjectMsg', errorMessage(error), 'error'); } });
}
function updateReadiness() {
  let reason = ''; const i = state.activeInspection;
  if (state.deploying) reason = state.activeJobType === 'github-repair' ? 'GitHub repair is running. Follow its progress below.' : 'Deployment is running. Follow its progress below.';
  else if (state.importing) reason = 'Wait for the current import to finish.';
  else if (state.appHostingSetupRunning) reason = 'Wait for backend creation to finish.';
  else if (!i) reason = 'Import a repository or open a local folder first.';
  else if (state.unknownJob) reason = 'The last deployment status is unknown. Check its status or the Firebase console before deploying again.';
  else if (state.firebase.connectionStatus === 'unavailable') reason = 'Firebase is temporarily unavailable. Check the connection and retry.';
  else if (!state.firebase.isLoggedIn) reason = 'Sign in to Firebase before deploying.';
  else if (!el('firebaseProjectSelect').value) reason = 'Choose your Firebase project in Connections.';
  else if (i.blocked) reason = (i.blockReasons || []).join(' ') || 'Resolve the required project changes above before deploying.';
  else if (i.deploymentMode === 'apphosting' && state.appHostingLoading) reason = 'Checking App Hosting billing and backends…';
  else if (i.deploymentMode === 'apphosting' && state.appHosting?.cliAvailable === false) reason = 'Firebase CLI is unavailable. Check the connection and refresh App Hosting status.';
  else if (i.deploymentMode === 'apphosting' && state.appHosting?.billingEnabled !== true) reason = state.appHosting?.billingEnabled === false ? 'App Hosting requires Blaze billing. Review Firebase billing, then refresh backends.' : 'Verify billing and load your App Hosting backends before deploying.';
  else if (i.deploymentMode === 'apphosting' && !el('appHostingBackendSelect').value) reason = 'Choose or create an App Hosting backend before deploying.';
  el('deployReadiness').textContent = reason || (i.deploymentMode === 'apphosting' ? 'Ready to deploy local source. Firebase will build and run the full Next.js app. Cloud build and runtime usage may incur charges.' : 'Ready to deploy. The app will install dependencies, build, and publish your site.');
  el('btnDeployNow').disabled = Boolean(reason);
  el('btnDeployNow').textContent = i?.deploymentMode === 'apphosting' ? 'Deploy full Next.js app ↗' : 'Deploy project ↗';
  const recent = (state.config.recentProjects || []).find(project => project.path === projectPath());
  const githubProject = recent?.sourceType === 'github' || Boolean(recent?.repoUrl);
  el('btnFixGithub').disabled = !i || !state.github.connected || !githubProject || state.deploying || state.importing || state.appHostingSetupRunning;
  el('githubRepairHelp').textContent = !state.github.connected ? 'Connect GitHub to save fixes back to your repository.' : !githubProject ? 'Import a GitHub repository to use automatic repair branches and pull requests.' : 'Includes supported setup fixes and reviewed AI changes. Your default branch stays unchanged until you review and merge the pull request.';
  el('deploymentModeSelect').disabled = state.deploying || state.appHostingSetupRunning;
  el('firebaseProjectSelect').disabled = state.deploying || state.appHostingSetupRunning;
}

async function runAiDoctor(useDeployError) {
  if (!state.activeInspection || state.deploying) return;
  const provider = el('aiProviderSelect').value;
  if (!(provider === state.config.aiProvider && state.config.hasAiKey) && !state.config.aiKeyStatus?.[provider] && !(provider === 'gemini' && state.config.hasGeminiKey)) { el('aiSettings').open = true; message('pageMessage', 'Choose an AI provider and save its API key in Connections first. Deployment setup fixes do not need AI.'); el('aiSettings').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  await busy('btnRunAiDoctor', 'Analyzing…', async () => {
    show('aiResultBox'); show('btnApplyAiPatches', false); state.proposalId = null; el('aiSummaryTitle').textContent = 'Analyzing project'; el('aiSummaryText').textContent = 'Your selected AI provider is reviewing the source and issue details.'; el('aiStepsList').replaceChildren(); el('aiPatchesArea').replaceChildren();
    try {
      const data = await api('/api/project/ai-fix', 'POST', { ...projectBody(), provider, model: el('aiModelInput').value.trim(), errorLog: useDeployError ? state.lastDeployErrorLog : '', userPrompt: el('aiCustomPrompt').value.trim() });
      const diagnosis = data.aiDiagnosis || data; state.proposalId = data.proposalId;
      el('aiSummaryTitle').textContent = 'Review proposed changes'; el('aiSummaryText').textContent = diagnosis.summary || 'Analysis complete.';
      for (const step of diagnosis.steps || []) el('aiStepsList').append(node('li', '', step));
      const fixes = data.fixes || diagnosis.fixes || diagnosis.patches || [];
      for (const fix of fixes) {
        const row = node('div', 'patch-item'); row.append(node('code', '', fix.path || fix.filePath), node('span', '', fix.reason || 'Suggested code change'));
        if (typeof fix.previousContent === 'string') { const previous = node('details'); previous.append(node('summary', '', 'Review current file'), node('pre', 'patch-preview', fix.previousContent || '(New file)')); row.append(previous); }
        const content = fix.diff || fix.updatedContent || fix.content || fix.after || fix.newContent;
        if (typeof content === 'string') { const details = node('details'); details.append(node('summary', '', fix.diff ? 'Review diff' : 'Review proposed file'), node('pre', 'patch-preview', content)); row.append(details); }
        el('aiPatchesArea').append(row);
      }
      if (!fixes.length) el('aiPatchesArea').append(node('p', 'help', 'No file changes were proposed.'));
      show('btnApplyAiPatches', Boolean(state.proposalId && fixes.length)); el('btnApplyAiPatches').textContent = `Apply ${fixes.length} reviewed file change${fixes.length === 1 ? '' : 's'}`;
    } catch (error) { el('aiSummaryTitle').textContent = 'Analysis could not finish'; el('aiSummaryText').textContent = errorMessage(error); }
  });
}
async function applyAiPatches() {
  if (!state.proposalId || state.deploying) return;
  await busy('btnApplyAiPatches', 'Applying…', async () => { try { const data = await api('/api/project/ai-apply', 'POST', { proposalId: state.proposalId }); renderInspection(data.inspection); el('chkSyncGithub').checked = false; message('pageMessage', 'Reviewed AI changes applied. GitHub sync is off for the next deployment to preserve your local fixes. The build will verify the result.', 'success'); } catch (error) { message('pageMessage', errorMessage(error), 'error'); } });
}
async function startDeployPipeline() {
  if (state.deploying || el('btnDeployNow').disabled || !state.activeInspection) return;
  state.activeJobType = 'deploy'; state.deploying = true; state.pollFailures = 0; updateReadiness(); importBusy(false); lockProjectOperations(true); configureJobProgress('deploy');
  show('deployProgressWrapper'); show('liveSuccessBanner', false); show('deployErrorAiBar', false); show('deployUnknownBanner', false); show('deployRecoveryResult', false); el('deployTerminalBody').textContent = ''; badge('deployStatusBadge', 'Starting', 'running');
  try { const data = await api('/api/project/deploy', 'POST', { ...projectBody(), backendId: el('appHostingBackendSelect').value, syncGithubFirst: el('chkSyncGithub').checked, autoFixFirst: el('chkAutoFixBeforeDeploy').checked }); state.activeJobId = data.jobId; await pollDeployJob(); }
  catch (error) { state.deploying = false; badge('deployStatusBadge', 'Failed', 'error'); message('pageMessage', errorMessage(error), 'error'); lockProjectOperations(false); importBusy(false); updateReadiness(); }
}
function lockProjectOperations(locked) {
  for (const id of ['btnAutoFixAll', 'btnRunAiDoctor', 'btnRescanProject', 'btnSetAppFolder', 'btnApplyAiPatches', 'btnUseRecommendedMode', 'btnFixGithub', 'btnCreateAppHostingBackend']) el(id).disabled = locked;
  el('deploymentModeSelect').disabled = locked; el('appHostingBackendSelect').disabled = locked; el('firebaseProjectSelect').disabled = locked;
  if (!locked && state.activeInspection?.deploymentMode === 'apphosting') renderAppHostingStatus();
  updateReadiness();
}
function configureJobProgress(type) {
  const labels = type === 'github-repair' ? ['Inspect', 'Fix', 'Commit', 'Sync', 'Open PR'] : state.activeInspection?.deploymentMode === 'apphosting' ? ['Sync', 'Configure', 'Upload', 'Cloud build', 'Publish'] : ['Sync', 'Configure', 'Install', 'Build', 'Publish'];
  labels.forEach((label, index) => { const step = el('pStep' + (index + 1)); step.textContent = label; step.className = ''; });
}
async function startGithubRepair() {
  if (state.deploying || el('btnFixGithub').disabled || !state.activeInspection) return;
  state.activeJobType = 'github-repair'; state.deploying = true; state.pollFailures = 0; updateReadiness(); importBusy(false); lockProjectOperations(true); configureJobProgress('github-repair');
  const box = el('githubRepairResult'); box.className = 'notice'; box.textContent = 'Checking this project and preparing supported fixes for GitHub…';
  show('deployProgressWrapper'); show('liveSuccessBanner', false); show('deployErrorAiBar', false); el('deployTerminalBody').textContent = ''; badge('deployStatusBadge', 'Repair running', 'running');
  el('deployCurrentStepText').textContent = 'Preparing GitHub repair…';
  try { const data = await api('/api/project/fix-github', 'POST', projectBody()); state.activeJobId = data.jobId; await pollDeployJob(); el('deployProgressWrapper').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  catch (error) { state.deploying = false; box.className = 'notice error'; box.textContent = errorMessage(error); badge('deployStatusBadge', 'Repair failed', 'error'); lockProjectOperations(false); importBusy(false); updateReadiness(); }
}
function renderGithubRepairResult(job) {
  const box = el('githubRepairResult'); box.replaceChildren(); box.className = 'notice ' + (job.status === 'failed' ? 'error' : 'success');
  if (job.status === 'failed') {
    box.append(node('strong', '', 'GitHub repair stopped'), node('p', '', job.errorLog || job.message || job.step || 'Check the job log for details.'));
    if (job.branch) box.append(node('code', '', 'Repair branch: ' + job.branch));
    const compareUrl = validGithubCompare(job.compareUrl);
    if (compareUrl) { const link = node('a', 'btn', 'Open repair branch on GitHub ↗'); link.href = compareUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; box.append(link); }
    return;
  }
  const pullRequestUrl = validPullRequest(job.pullRequestUrl);
  if (job.noChanges || !job.fixedFiles?.length && !pullRequestUrl) { box.append(node('strong', '', 'No setup changes needed'), node('p', '', job.message || 'No supported configuration changes were found. No repair pull request was created. Code bugs can be investigated separately with your chosen AI provider.')); return; }
  box.append(node('strong', '', pullRequestUrl ? 'Fixes are ready on GitHub' : 'Repair branch prepared'), node('p', '', job.message || (pullRequestUrl ? 'Review the pull request and merge it when ready. Your default branch has not been changed.' : 'Check the job log for the branch and pull request status.')));
  if (job.branch) box.append(node('code', '', job.branch));
  if (job.fixedFiles?.length) { const files = node('ul', 'repair-file-list'); for (const file of job.fixedFiles) files.append(node('li', '', file)); box.append(files); }
  if (pullRequestUrl) { const actions = node('div', 'action-row'); const link = node('a', 'btn btn-primary', 'Review pull request ↗'); link.href = pullRequestUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; const copy = node('button', 'btn', 'Copy PR link'); copy.type = 'button'; copy.id = 'btnCopyRepairPr'; copy.addEventListener('click', () => copyText(pullRequestUrl, 'btnCopyRepairPr', 'Copied')); actions.append(link, copy); box.append(actions); }
}
async function pollDeployJob() {
  if (!state.activeJobId) return;
  try {
    const job = await api('/api/jobs/' + encodeURIComponent(state.activeJobId)); state.pollFailures = 0;
    if (!await updateJob(job)) return;
  } catch (error) { state.pollFailures++; message('pageMessage', 'Connection to the deployment log was interrupted. Retrying… ' + errorMessage(error), 'error'); }
  state.pollTimer = setTimeout(pollDeployJob, Math.min(1000 * Math.max(1, state.pollFailures), 10000));
}
async function updateJob(job) {
  el('deployCurrentStepText').textContent = job.step || 'Deployment';
  const repair = (job.type || state.activeJobType) === 'github-repair'; const complete = job.status === 'completed'; const failed = job.status === 'failed'; const unknown = job.status === 'unknown';
  badge('deployStatusBadge', job.retryAllowed ? 'Ready to retry' : unknown ? 'Status unknown' : complete ? repair ? 'Repair completed' : 'Completed' : failed ? repair ? 'Repair failed' : 'Failed' : repair ? 'Repair running' : 'Running', job.retryAllowed || unknown ? 'warning' : complete ? 'success' : failed ? 'error' : 'running');
  for (let i = 1; i <= 5; i++) el('pStep' + i).className = complete || i < job.stepIndex ? 'done' : i === job.stepIndex ? unknown ? 'unknown' : failed ? 'failed' : 'active' : '';
  const terminal = el('deployTerminalBody'); const nearBottom = terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight < 70; terminal.textContent = (job.logs || []).map(log => `[${log.time || ''}] ${log.text || ''}`).join('\n'); if (nearBottom) terminal.scrollTop = terminal.scrollHeight;
  if (!complete && !failed && !unknown) return true;
  if (state.pollTimer) clearTimeout(state.pollTimer); state.pollTimer = null;
  state.deploying = false; state.activeJobId = null;
  if (unknown) renderUnknownDeployment(job);
  else if (state.unknownJob?.id === job.id) clearUnknownDeployment();
  lockProjectOperations(false); importBusy(false); updateReadiness();
  if (unknown) return false;
  if (job.retryAllowed) { show('liveSuccessBanner', false); show('deployErrorAiBar', false); el('deployRecoveryResult').textContent = (job.message || 'Firebase confirmed that no build or rollout is active. You can start another deployment when ready.') + '\nNo deployment was started.'; show('deployRecoveryResult'); return false; }
  if (repair) { renderGithubRepairResult(job); if (complete) { el('chkSyncGithub').checked = false; await loadConfig(); await selectProject(projectPath()); } }
  else if (complete) { const url = validWebsite(job.liveUrl); if (url) { el('livePrimaryUrl').textContent = url; el('livePrimaryUrl').href = url; el('btnOpenLiveSite').href = url; show('liveSuccessBanner'); } await loadConfig(); }
  else { state.lastDeployErrorLog = job.errorLog || ''; el('deployErrorText').textContent = job.errorLog ? job.errorLog.slice(-1500) : 'Check the deployment log for details.'; show('deployErrorAiBar'); }
  return false;
}
function renderUnknownDeployment(job) {
  const project = el('firebaseProjectSelect').value || state.config.defaultFirebaseProject;
  const consoleUrl = validFirebaseConsole(job.consoleUrl || job.recoveryUrl) || (project ? `https://console.firebase.google.com/project/${encodeURIComponent(project)}/apphosting` : 'https://console.firebase.google.com/');
  state.unknownJob = { id: job.id, consoleUrl, message: String(job.message || job.errorLog || job.step || 'Firebase may still be building or publishing this app. Check its status before starting another deployment.').slice(0, 2400) };
  try { sessionStorage.setItem('firebase-direct-unknown-deployment', JSON.stringify(state.unknownJob)); } catch {}
  el('deployUnknownText').textContent = state.unknownJob.message; el('deployRecoveryConsoleLink').href = consoleUrl;
  show('deployProgressWrapper'); show('deployUnknownBanner'); show('checkDeploymentStatus'); show('acknowledgeDeployment'); show('deployAcknowledgementHelp'); show('deployRecoveryResult', false); show('liveSuccessBanner', false); show('deployErrorAiBar', false);
  badge('deployStatusBadge', 'Status unknown', 'warning'); updateReadiness();
}
function clearUnknownDeployment() {
  state.unknownJob = null; try { sessionStorage.removeItem('firebase-direct-unknown-deployment'); } catch {}
  show('deployUnknownBanner', false); updateReadiness();
}
function handleMissingDeploymentJob() {
  clearUnknownDeployment(); el('deployUnknownText').textContent = 'The server restarted and no longer has this job record. Check Firebase console before deploying again. You can refresh App Hosting status below; the server will check pending rollouts before another deployment.';
  show('deployUnknownBanner'); show('checkDeploymentStatus', false); show('acknowledgeDeployment', false); show('deployAcknowledgementHelp', false); badge('deployStatusBadge', 'Status unknown', 'warning');
}
async function restoreUnknownDeployment() {
  if (state.deploying) return;
  let saved; try { saved = JSON.parse(sessionStorage.getItem('firebase-direct-unknown-deployment') || 'null'); } catch { return; }
  if (!saved || typeof saved.id !== 'string' || !saved.id || saved.id.length > 200) return;
  renderUnknownDeployment(saved);
  try { const job = await api('/api/jobs/' + encodeURIComponent(saved.id)); if (await updateJob(job)) { state.activeJobId = job.id; state.activeJobType = job.type || 'deploy'; state.deploying = true; lockProjectOperations(true); await pollDeployJob(); } }
  catch (error) { if (error.status === 404) handleMissingDeploymentJob(); else el('deployUnknownText').textContent = saved.message + '\n' + errorMessage(error); }
}
async function checkDeploymentStatus() {
  if (!state.unknownJob?.id || state.reconcilingDeployment) return;
  const id = state.unknownJob.id;
  await busy('checkDeploymentStatus', 'Checking status…', async () => {
    state.reconcilingDeployment = true; el('acknowledgeDeployment').disabled = true;
    try { const job = await api('/api/jobs/' + encodeURIComponent(id) + '/check', 'POST', {}); if (await updateJob(job)) { state.activeJobId = job.id || id; state.activeJobType = job.type || 'deploy'; state.deploying = true; lockProjectOperations(true); await pollDeployJob(); } }
    catch (error) { if (error.status === 404) handleMissingDeploymentJob(); else el('deployUnknownText').textContent = (state.unknownJob?.message || 'Deployment status is unknown.') + '\n' + errorMessage(error); }
    finally { state.reconcilingDeployment = false; el('acknowledgeDeployment').disabled = false; }
  });
}
async function acknowledgeDeployment() {
  if (!state.unknownJob?.id || state.reconcilingDeployment) return;
  const id = state.unknownJob.id;
  await busy('acknowledgeDeployment', 'Checking Firebase…', async () => {
    state.reconcilingDeployment = true; el('checkDeploymentStatus').disabled = true;
    try { const job = await api('/api/jobs/' + encodeURIComponent(id) + '/acknowledge', 'POST', { checkedFirebase: true }); await updateJob(job); }
    catch (error) { if (error.status === 404) handleMissingDeploymentJob(); else el('deployUnknownText').textContent = (state.unknownJob?.message || 'Deployment status is unknown.') + '\n' + errorMessage(error); }
    finally { state.reconcilingDeployment = false; el('checkDeploymentStatus').disabled = false; }
  });
}
async function copyText(value, id, label) { try { await navigator.clipboard.writeText(value); const button = el(id); const old = button.textContent; button.textContent = label; setTimeout(() => { button.textContent = old; }, 1800); } catch { message('pageMessage', 'The browser could not copy this text. Select it and copy manually.'); } }
