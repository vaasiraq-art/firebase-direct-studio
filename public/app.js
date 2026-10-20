'use strict';
const state = { config: {}, csrfToken: '', github: {}, githubRepos: [], firebase: {}, activeInspection: null, importing: false, deploying: false, activeJobId: null, proposalId: null, lastDeployErrorLog: '', pollTimer: null, pollFailures: 0, refreshRunning: false, loginTimer: null, loginChecks: 0 };
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
  if (!response.ok) { if (response.status === 403 && /session|csrf/i.test(data.error || '')) state.csrfToken = ''; throw new Error(data.error || `Request failed (${response.status}).`); }
  return data;
}
async function busy(id, label, operation) { const button = el(id); if (button.disabled) return; const previous = button.textContent; button.disabled = true; button.textContent = label; try { return await operation(); } finally { button.disabled = false; button.textContent = previous; } }
function projectPath() { const i = state.activeInspection; return i?.repoRoot || i?.rootDir || state.config.activeProjectPath || ''; }
function projectBody() { return { projectPath: projectPath(), firebaseProject: el('firebaseProjectSelect').value || state.config.defaultFirebaseProject || '', appSubdir: el('appSubdirInput').value.trim() }; }
function validWebsite(raw) { try { const url = new URL(raw); if (url.protocol === 'https:' && (url.hostname.endsWith('.web.app') || url.hostname.endsWith('.firebaseapp.com'))) return url.href; } catch {} return ''; }
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
    btnRunAiDoctor: () => runAiDoctor(false),
    btnApplyAiPatches: applyAiPatches,
    btnDeployNow: startDeployPipeline,
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
  el('aiProviderSelect').addEventListener('change', () => { el('aiApiKeyInput').value = ''; const provider = el('aiProviderSelect').value; el('aiModelInput').value = provider === state.config.aiProvider ? state.config.aiModel || '' : ''; updateAiStatus(provider); });
  for (const link of document.querySelectorAll('.tab')) link.addEventListener('click', () => { document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active')); link.classList.add('active'); });
}
async function loadAllData() {
  if (state.refreshRunning) return; state.refreshRunning = true; el('refreshAllBtn').disabled = true;
  try {
    const session = await api('/api/session'); state.csrfToken = session.csrfToken;
    await loadConfig();
    await Promise.allSettled([checkFirebaseStatus(), loadGithubConnection()]);
    if (state.config.activeProjectPath) { try { await selectProject(state.config.activeProjectPath); } catch (error) { message('pageMessage', errorMessage(error), 'error'); } }
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
  el('btnConnectGithub').textContent = connected ? 'Check GitHub connection' : 'Connect GitHub'; show('btnDisconnectGithub', connected);
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
    const button = node('button', 'btn btn-small repo-import', 'Import'); button.type = 'button'; button.disabled = state.importing || state.deploying; button.addEventListener('click', () => { el('githubRepoUrlInput').value = repo.fullName || repo.cloneUrl; el('branchSelect').replaceChildren(new Option(repo.defaultBranch || 'Default branch', repo.defaultBranch || '')); importGithubRepo(repo.cloneUrl || repo.fullName, repo.defaultBranch || ''); }); row.append(meta, button); list.append(row);
  }
}
function renderRecentProjects() {
  const list = el('recentProjectsList'); list.replaceChildren(); const recent = state.config.recentProjects || [];
  if (!recent.length) { setEmpty(list, 'No imported projects yet.'); return; }
  for (const project of recent.slice(0, 8)) {
    const row = node('div', 'repo-item'); const meta = node('div', 'repo-meta'); const name = node('div', 'repo-name', project.name || 'Project');
    if (project.path === state.config.activeProjectPath) name.append(node('span', 'badge success', 'Selected'));
    meta.append(name, node('div', 'repo-details', project.frameworkLabel || project.sourceType || 'Local project'));
    const button = node('button', 'btn btn-small', 'Open'); button.type = 'button'; button.disabled = state.importing || state.deploying; button.addEventListener('click', () => selectProject(project.path, false).then(() => el('project').scrollIntoView({ behavior: 'smooth' })).catch(error => message('pageMessage', errorMessage(error), 'error'))); row.append(meta, button); list.append(row);
  }
}
async function loadBranches() {
  await busy('btnLoadBranches', 'Loading…', async () => {
    const repo = el('githubRepoUrlInput').value.trim(); if (!repo) { message('importStatusMsg', 'Enter a repository first.', 'error'); return; }
    try { const data = await api('/api/github/branches?repo=' + encodeURIComponent(repo)); const select = el('branchSelect'); select.replaceChildren(new Option('Default branch', '')); for (const branch of data.branches || []) select.add(new Option(branch.name || branch, branch.name || branch)); message('importStatusMsg', `${(data.branches || []).length} branches loaded. Choose a branch, then import.`, 'success'); }
    catch (error) { message('importStatusMsg', errorMessage(error), 'error'); }
  });
}
function importBusy(value) { state.importing = value; el('btnImportGithubUrl').disabled = value || state.deploying; el('btnBrowseLocalFolder').disabled = value || state.deploying; renderGithubRepos(); renderRecentProjects(); updateReadiness(); }
async function importGithubRepo(repoUrl, branch = '') {
  if (state.importing || state.deploying) return; if (!repoUrl) { message('importStatusMsg', 'Enter a GitHub repository or choose one below.', 'error'); return; }
  importBusy(true); message('importStatusMsg', 'Importing repository and checking deployment setup…', 'loading');
  try { const data = await api('/api/project/import-github', 'POST', { repoUrl, branch }); state.config.activeProjectPath = data.project.path; renderInspection(data.inspection); await loadConfig(); message('importStatusMsg', `Imported ${data.project.name}. Review the deployment checks below.`, 'success'); el('project').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  catch (error) { message('importStatusMsg', errorMessage(error), 'error'); }
  finally { importBusy(false); }
}
async function browseLocalFolder() {
  if (state.importing || state.deploying) return; importBusy(true); message('importStatusMsg', 'Choose a project folder in the Windows folder picker…', 'loading');
  try { const data = await api('/api/project/pick-local-folder', 'POST', {}); if (data.cancelled) { message('importStatusMsg', 'Folder selection canceled.'); return; } state.config.activeProjectPath = data.project.path; renderInspection(data.inspection); await loadConfig(); message('importStatusMsg', 'Opened ' + data.project.name + '.', 'success'); el('project').scrollIntoView({ behavior: 'smooth' }); }
  catch (error) { message('importStatusMsg', errorMessage(error), 'error'); }
  finally { importBusy(false); }
}
async function selectProject(path, useInputFolder = false) {
  if (!path || state.deploying) return;
  const body = { projectPath: path, firebaseProject: el('firebaseProjectSelect').value || state.config.defaultFirebaseProject || '' };
  if (useInputFolder) body.appSubdir = el('appSubdirInput').value.trim();
  const data = await api('/api/project/select', 'POST', body); state.config.activeProjectPath = path; renderInspection(data.inspection); renderRecentProjects();
}
function renderInspection(inspection) {
  state.activeInspection = inspection; state.proposalId = null; show('aiResultBox', false); show('autoFixLogsArea', false); show('noProjectSelectedBanner', !inspection); show('doctorContentArea', Boolean(inspection));
  if (!inspection) { badge('issuesCountBadge', 'No project'); updateReadiness(); return; }
  el('sumProjectName').textContent = inspection.packageName || inspection.projectName || projectPath().split(/[\\/]/).pop() || 'Web project';
  el('sumProjectPath').textContent = inspection.effectiveRoot || inspection.projectDir || inspection.rootDir || '';
  el('sumFramework').textContent = inspection.frameworkLabel || inspection.framework || 'Unknown'; el('sumPublicDir').textContent = inspection.expectedPublicDir || 'Not detected';
  el('appSubdirInput').value = inspection.relativeSubdir || inspection.appSubdir || '';
  el('appRootsList').replaceChildren(); for (const root of inspection.appRoots || []) el('appRootsList').append(new Option(root.label || root.path, root.path));
  const issues = [...(inspection.issues || [])]; const actionable = issues.filter(issue => issue.severity !== 'info');
  badge('issuesCountBadge', inspection.blocked ? 'Action required' : actionable.length ? `${actionable.length} checks to review` : 'Checks passed', inspection.blocked ? 'error' : actionable.length ? 'warning' : 'success');
  const list = el('issuesListContainer'); list.replaceChildren();
  if (!issues.length) issues.push({ severity: 'success', title: 'Deployment configuration checks passed', description: 'The build and Firebase publish steps will verify that this project can be deployed.' });
  for (const issue of issues) { const severity = ['error', 'warning', 'info', 'success'].includes(issue.severity) ? issue.severity : 'warning'; const row = node('div', 'issue-card ' + severity); const content = node('div'); row.append(node('span', 'issue-mark', severity === 'success' ? '✓' : severity === 'info' ? 'ⓘ' : '!')); content.append(node('strong', '', issue.title || 'Deployment issue'), node('p', '', issue.description || '')); if (issue.autoFixable === false && issue.severity === 'error') content.append(node('span', 'badge warning', 'Manual change required')); row.append(content); list.append(row); }
  el('btnAutoFixAll').disabled = state.deploying; updateReadiness();
}
async function runAutoFixAll() {
  if (!state.activeInspection || state.deploying) return;
  await busy('btnAutoFixAll', 'Fixing setup…', async () => { try { const data = await api('/api/project/autofix', 'POST', projectBody()); renderInspection(data.inspection); el('chkSyncGithub').checked = false; el('autoFixLogsArea').textContent = ((data.fixedLogs || []).join('\n') || 'No automatic configuration changes were needed.') + '\nGitHub sync is off for the next deployment so your local fixes are preserved.'; show('autoFixLogsArea'); } catch (error) { message('pageMessage', errorMessage(error), 'error'); } });
}

async function checkFirebaseStatus() {
  const button = el('btnRefreshFirebase'); button.disabled = true; badge('fbStatusPill', 'Checking');
  try {
    state.firebase = await api('/api/firebase/status'); const connected = Boolean(state.firebase.isLoggedIn);
    badge('fbStatusPill', connected ? 'Connected' : 'Not connected', connected ? 'success' : ''); el('fbStatusText').textContent = connected ? `Signed in as ${state.firebase.email || 'Google account'}. ${state.firebase.message || ''}`.trim() : state.firebase.message || state.firebase.error || 'Sign in to your Google account to select a Firebase project.';
    el('btnLoginFirebase').textContent = connected ? 'Switch account' : 'Sign in';
    const select = el('firebaseProjectSelect'); const selected = state.config.defaultFirebaseProject || select.value; select.replaceChildren(new Option('Choose a project…', ''));
    for (const project of state.firebase.projects || []) select.add(new Option(`${project.displayName || project.projectId} (${project.projectId})`, project.projectId));
    if (selected && [...select.options].some(option => option.value === selected)) select.value = selected;
    if (state.firebase.error && connected) message('pageMessage', 'Firebase could not list projects. ' + state.firebase.error, 'error');
    updateTarget();
    if (connected && state.loginTimer) { clearTimeout(state.loginTimer); state.loginTimer = null; message('pageMessage', 'Firebase account connected. Choose the project to deploy to.', 'success'); }
  } catch (error) { state.firebase = { isLoggedIn: false }; badge('fbStatusPill', 'Unavailable', 'warning'); el('fbStatusText').textContent = errorMessage(error); }
  finally { button.disabled = false; updateReadiness(); }
}
async function triggerFirebaseLogin() {
  await busy('btnLoginFirebase', 'Opening sign-in…', async () => { const data = await api('/api/firebase/login', 'POST', {}); message('pageMessage', data.message || 'Complete Google sign-in in the opened browser window, then check the connection.'); state.loginChecks = 0; if (state.loginTimer) clearTimeout(state.loginTimer); state.loginTimer = setTimeout(pollLogin, 4000); });
}
async function pollLogin() { state.loginChecks++; await checkFirebaseStatus(); if (!state.firebase.isLoggedIn && state.loginChecks < 30) state.loginTimer = setTimeout(pollLogin, 5000); }
async function changeFirebaseProject() {
  const value = el('firebaseProjectSelect').value; updateTarget(); state.config = { ...state.config, ...await api('/api/config', 'POST', { defaultFirebaseProject: value }) }; if (state.activeInspection) await selectProject(projectPath()); updateReadiness();
}
function updateTarget() {
  const id = el('firebaseProjectSelect').value || state.config.defaultFirebaseProject || ''; el('selectedWebAppPreview').textContent = id ? `https://${id}.web.app` : ''; el('sumTargetUrl').textContent = id ? `https://${id}.web.app` : 'Choose a Firebase project';
}
async function createNewFirebaseProject() {
  const projectId = el('newFbProjectId').value.trim().toLowerCase(); const displayName = el('newFbProjectName').value.trim(); if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) { message('createFbProjectMsg', 'Use 6–30 lowercase letters, numbers, or hyphens. Start with a letter and end with a letter or number.', 'error'); return; }
  await busy('btnCreateFbProject', 'Creating…', async () => { message('createFbProjectMsg', 'Creating Firebase project…', 'loading'); try { await api('/api/firebase/create-project', 'POST', { projectId, displayName }); state.config.defaultFirebaseProject = projectId; await checkFirebaseStatus(); el('firebaseProjectSelect').value = projectId; updateTarget(); updateReadiness(); message('createFbProjectMsg', 'Project created. You can deploy to it now.', 'success'); } catch (error) { message('createFbProjectMsg', errorMessage(error), 'error'); } });
}
function updateReadiness() {
  let reason = ''; const i = state.activeInspection;
  if (state.deploying) reason = 'Deployment is running. Follow its progress below.';
  else if (state.importing) reason = 'Wait for the current import to finish.';
  else if (!i) reason = 'Import a repository or open a local folder first.';
  else if (!state.firebase.isLoggedIn) reason = 'Sign in to Firebase before deploying.';
  else if (!el('firebaseProjectSelect').value) reason = 'Choose your Firebase project in Connections.';
  else if (i.blocked) reason = (i.blockReasons || []).join(' ') || 'Resolve the required project changes above before deploying.';
  el('deployReadiness').textContent = reason || 'Ready to deploy. The app will install dependencies, build, and publish your site.';
  el('btnDeployNow').disabled = Boolean(reason);
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
  state.deploying = true; state.pollFailures = 0; updateReadiness(); importBusy(false); el('btnAutoFixAll').disabled = true; el('btnRunAiDoctor').disabled = true;
  show('deployProgressWrapper'); show('liveSuccessBanner', false); show('deployErrorAiBar', false); el('deployTerminalBody').textContent = ''; badge('deployStatusBadge', 'Starting', 'running');
  try { const data = await api('/api/project/deploy', 'POST', { ...projectBody(), syncGithubFirst: el('chkSyncGithub').checked, autoFixFirst: el('chkAutoFixBeforeDeploy').checked }); state.activeJobId = data.jobId; await pollDeployJob(); }
  catch (error) { state.deploying = false; badge('deployStatusBadge', 'Failed', 'error'); message('pageMessage', errorMessage(error), 'error'); el('btnAutoFixAll').disabled = false; el('btnRunAiDoctor').disabled = false; importBusy(false); updateReadiness(); }
}
async function pollDeployJob() {
  if (!state.activeJobId) return;
  try {
    const job = await api('/api/jobs/' + encodeURIComponent(state.activeJobId)); state.pollFailures = 0; el('deployCurrentStepText').textContent = job.step || 'Deployment';
    const complete = job.status === 'completed'; const failed = job.status === 'failed'; badge('deployStatusBadge', complete ? 'Completed' : failed ? 'Failed' : 'Running', complete ? 'success' : failed ? 'error' : 'running');
    for (let i = 1; i <= 5; i++) el('pStep' + i).className = complete || i < job.stepIndex ? 'done' : i === job.stepIndex ? failed ? 'failed' : 'active' : '';
    const terminal = el('deployTerminalBody'); const nearBottom = terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight < 70; terminal.textContent = (job.logs || []).map(log => `[${log.time || ''}] ${log.text || ''}`).join('\n'); if (nearBottom) terminal.scrollTop = terminal.scrollHeight;
    if (complete || failed) {
      state.deploying = false; state.activeJobId = null; el('btnAutoFixAll').disabled = false; el('btnRunAiDoctor').disabled = false; importBusy(false); updateReadiness();
      if (complete) { const url = validWebsite(job.liveUrl); if (url) { el('livePrimaryUrl').textContent = url; el('livePrimaryUrl').href = url; el('btnOpenLiveSite').href = url; show('liveSuccessBanner'); } await loadConfig(); }
      else { state.lastDeployErrorLog = job.errorLog || ''; el('deployErrorText').textContent = job.errorLog ? job.errorLog.slice(-1500) : 'Check the deployment log for details.'; show('deployErrorAiBar'); }
      return;
    }
  } catch (error) { state.pollFailures++; message('pageMessage', 'Connection to the deployment log was interrupted. Retrying… ' + errorMessage(error), 'error'); }
  state.pollTimer = setTimeout(pollDeployJob, Math.min(1000 * Math.max(1, state.pollFailures), 10000));
}
async function copyText(value, id, label) { try { await navigator.clipboard.writeText(value); const button = el(id); const old = button.textContent; button.textContent = label; setTimeout(() => { button.textContent = old; }, 1800); } catch { message('pageMessage', 'The browser could not copy this text. Select it and copy manually.'); } }
