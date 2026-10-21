'use strict';

// Read the Firebase CLI's saved identity without starting the entire CLI.
// OAuth credentials stay in this process and never enter an API response.
const ALLOWED_ORIGINS = new Set(['https://firebase.googleapis.com', 'https://cloudbilling.googleapis.com', 'https://firebaseapphosting.googleapis.com']);
function defaultAccount() { return require('firebase-tools/lib/auth').getGlobalDefaultAccount(); }
function clientCredentials() { const api = require('firebase-tools/lib/api'); return { clientId: api.clientId(), clientSecret: api.clientSecret() }; }
function firebaseProjectId(id) { if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(id)) throw new Error('Choose a valid Firebase project.'); return id; }
function backendId(id) { if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{1,28}[a-z0-9]$/.test(id)) throw new Error('Backend ID must be 3–30 lowercase letters, digits, or hyphens; start with a letter and end with a letter or digit.'); return id; }
function backendResource(name, project, projectNumber) {
  firebaseProjectId(project);
  const match = typeof name === 'string' && name.match(/^projects\/([^/]+)\/locations\/([a-z]+-[a-z]+[0-9])\/backends\/([a-z][a-z0-9-]{1,28}[a-z0-9])$/);
  if (!match || (match[1] !== project && !(typeof projectNumber === 'string' && /^[0-9]+$/.test(projectNumber) && match[1] === projectNumber))) throw new Error('App Hosting returned an unexpected backend resource.');
  return name;
}
function backendUrl(value) { if (typeof value !== 'string') throw new Error('App Hosting did not return a live address.'); const url = new URL(value.startsWith('https://') ? value : 'https://' + value); if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.endsWith('.hosted.app') || url.search || url.hash || url.pathname !== '/') throw new Error('App Hosting returned an unexpected live address.'); return url.origin; }
const PENDING_ROLLOUT_STATES = new Set(['STATE_UNSPECIFIED', 'QUEUED', 'PENDING_BUILD', 'PROGRESSING', 'PAUSED']);
const FAILED_ROLLOUT_STATES = new Set(['FAILED', 'CANCELLED', 'SKIPPED']);
function rolloutError(message, state = 'unknown') { const error = new Error(message); error.state = state; return error; }
function hasPendingRollout(rollouts) { if (!Array.isArray(rollouts)) throw rolloutError('App Hosting rollout status is unavailable. Check the Firebase console before deploying.'); return rollouts.some(value => !value || value.reconciling === true || PENDING_ROLLOUT_STATES.has(value.state) || !['SUCCEEDED', ...FAILED_ROLLOUT_STATES].includes(value.state)); }
async function limitedJson(response) {
  const reader = response.body?.getReader(); if (!reader) throw new Error('Firebase returned an empty response.');
  let size = 0; const chunks = [];
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('Firebase returned too much data.'); } chunks.push(Buffer.from(value)); } }
  finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Firebase returned invalid data.'); }
}
function createFirebaseClient({ getAccount = defaultAccount, getClientCredentials = clientCredentials, fetchImpl = (...args) => fetch(...args) } = {}) {
  let tokenCache, refreshPromise, projectCache = [], projectCacheIdentity = '';
  const projectNumbers = new Map();
  const rolloutSnapshots = new WeakMap();
  function account() { try { return getAccount(); } catch { throw new Error('Firebase credentials are unavailable. Start the app setup and connect Firebase again.'); } }
  async function accessToken(force = false) {
    const saved = account(); if (!saved?.user?.email || !saved.tokens) { const e = new Error('Sign in to Firebase first.'); e.authRequired = true; throw e; }
    const tokens = saved.tokens;
    if (!force && tokenCache?.refreshToken === tokens.refresh_token && tokenCache.expires > Date.now() + 60000) return tokenCache.token;
    if (!force && tokens.access_token && tokens.expires_at > Date.now() + 60000) return tokens.access_token;
    if (!tokens.refresh_token) { const e = new Error('Firebase sign-in expired. Sign in again.'); e.authRequired = true; throw e; }
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const client = getClientCredentials(); let response;
      try { response = await fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.clientId, client_secret: client.clientSecret }) }); }
      catch { throw new Error('Could not reach Google to check your saved sign-in. Check your internet connection and retry.'); }
      if (!response.ok) { const e = new Error(response.status === 400 || response.status === 401 ? 'Firebase sign-in expired. Sign in again.' : 'Google could not verify your saved sign-in. Try again.'); e.authRequired = response.status === 400 || response.status === 401; throw e; }
      const data = await limitedJson(response); if (typeof data.access_token !== 'string' || !data.access_token) throw new Error('Google returned an invalid sign-in response.');
      tokenCache = { token: data.access_token, refreshToken: tokens.refresh_token, expires: Date.now() + Math.min(Number(data.expires_in) || 300, 3600) * 1000 }; return data.access_token;
    })().finally(() => { refreshPromise = null; }); return refreshPromise;
  }
  async function request(origin, route, { retry = true } = {}) {
    if (!ALLOWED_ORIGINS.has(origin) || typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//') || /[\r\n]/.test(route)) throw new Error('Invalid Firebase API request.');
    const token = await accessToken(); let response;
    try { response = await fetchImpl(origin + route, { redirect: 'error', signal: AbortSignal.timeout(25000), headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } }); }
    catch { throw new Error('Could not reach Firebase. Your saved sign-in is still present. Check your internet connection and retry.'); }
    if (response.status === 401 && retry) { await accessToken(true); return request(origin, route, { retry: false }); }
    const data = await limitedJson(response);
    if (!response.ok) {
      const disabled = data.error?.details?.some(item => item.reason === 'SERVICE_DISABLED');
      const error = new Error(disabled ? 'The App Hosting API is not enabled. Use Create backend or open App Hosting in the Firebase console to finish setup.' : response.status === 401 ? 'Firebase sign-in expired. Sign in again.' : response.status === 403 ? 'Firebase denied access. Check project, billing, and account permissions.' : `Firebase request failed (${response.status}).`);
      error.authRequired = response.status === 401; error.apiDisabled = disabled; error.status = response.status; throw error;
    }
    return data;
  }
  async function pages(origin, route, key) { const result = []; let token = ''; for (let i = 0; i < 50; i++) { const data = await request(origin, route + (token ? (route.includes('?') ? '&' : '?') + 'pageToken=' + encodeURIComponent(token) : '')); result.push(...(Array.isArray(data[key]) ? data[key] : [])); token = data.nextPageToken; if (!token) return result; } throw new Error('Firebase returned too many result pages.'); }
  async function status() {
    const saved = account(); if (!saved?.user?.email) return { isLoggedIn: false, email: '', projects: [], cliAvailable: true, connectionStatus: 'signed-out', message: 'Sign in to Firebase to choose a project.' };
    if (projectCacheIdentity !== saved.user.email) { projectCache = []; projectNumbers.clear(); tokenCache = null; projectCacheIdentity = saved.user.email; }
    try { const projects = await pages('https://firebase.googleapis.com', '/v1beta1/projects?pageSize=100', 'results'); for (const p of projects) if (p.projectNumber) projectNumbers.set(p.projectId, String(p.projectNumber)); projectCache = projects.map(p => ({ projectId: p.projectId, displayName: p.displayName || p.projectId })); return { isLoggedIn: true, email: saved.user.email, projects: projectCache, cliAvailable: true, connectionStatus: 'connected', message: '' }; }
    catch (error) { return { isLoggedIn: !error.authRequired, email: saved.user.email, projects: projectCache, cliAvailable: true, connectionStatus: error.authRequired ? 'signed-out' : 'unavailable', message: error.message }; }
  }
  async function billing(project) { const data = await request('https://cloudbilling.googleapis.com', `/v1/projects/${firebaseProjectId(project)}/billingInfo`); if (typeof data.billingEnabled !== 'boolean') throw new Error('Google did not confirm the project billing status.'); return data.billingEnabled; }
  async function projectNumber(project) { if (!projectNumbers.has(project)) { const data = await request('https://firebase.googleapis.com', `/v1beta1/projects/${firebaseProjectId(project)}`); if (data.projectId !== project || !/^[0-9]+$/.test(String(data.projectNumber || ''))) throw new Error('Firebase could not verify this project identity.'); projectNumbers.set(project, String(data.projectNumber)); } return projectNumbers.get(project); }
  async function getBackend(project, name) { const number = /^projects\/[0-9]+\//.test(name) ? await projectNumber(project) : undefined; backendResource(name, project, number); return request('https://firebaseapphosting.googleapis.com', '/v1beta/' + name); }
  async function backendKey(project, name) {
    const number = /^projects\/[0-9]+\//.test(name) ? await projectNumber(project) : undefined;
    backendResource(name, project, number);
    const parts = name.split('/');
    return `projects/${project}/locations/${parts[3]}/backends/${parts[5]}`;
  }
  async function childResource(project, backend, value, kind) {
    const match = typeof value === 'string' && value.match(/^(projects\/[^/]+\/locations\/[^/]+\/backends\/[^/]+)\/(rollouts|builds)\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/);
    if (!match || match[2] !== kind || await backendKey(project, match[1]) !== backend) throw rolloutError('App Hosting returned a rollout or build for an unexpected backend.');
    return { name: value, id: match[3], key: backend + '/' + kind + '/' + match[3] };
  }
  // Official API: Rollout.state=SUCCEEDED and Build.state=READY. A preexisting
  // backend URI or a READY build alone does not prove a new live deployment.
  async function listRollouts(project, name) {
    try {
      const key = await backendKey(project, name), capturedAt = Date.now();
      const rows = [];
      let pageToken = '';
      for (let page = 0; page < 50; page++) {
        const route = '/v1beta/' + name + '/rollouts?pageSize=100&orderBy=createTime%20desc' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
        const data = await request('https://firebaseapphosting.googleapis.com', route);
        if (!data || (data.rollouts !== undefined && !Array.isArray(data.rollouts)) || (Array.isArray(data.unreachable) && data.unreachable.length)) throw rolloutError('App Hosting could not list all rollout states. Check the Firebase console before deploying.');
        for (const value of data.rollouts || []) {
          const resource = await childResource(project, key, value?.name, 'rollouts');
          const build = await childResource(project, key, value?.build, 'builds');
          if (typeof value.state !== 'string' || typeof value.createTime !== 'string' || !Number.isFinite(Date.parse(value.createTime))) throw rolloutError('App Hosting returned incomplete rollout metadata.');
          rows.push(Object.freeze({ name: resource.name, build: build.name, state: value.state, createTime: value.createTime, reconciling: value.reconciling === true }));
        }
        if (!data.nextPageToken) {
          const result = Object.freeze(rows);
          rolloutSnapshots.set(result, Object.freeze({ key, capturedAt, latestTime: rows.reduce((latest, row) => Math.max(latest, Date.parse(row.createTime)), 0) }));
          return result;
        }
        if (typeof data.nextPageToken !== 'string' || data.nextPageToken.length > 4096) throw rolloutError('App Hosting returned an invalid rollout page token.');
        pageToken = data.nextPageToken;
      }
      throw rolloutError('App Hosting returned too many rollout pages to verify deployment safely.');
    } catch (error) { error.state ||= 'unknown'; throw error; }
  }
  async function verifyRollout(project, name, baseline) {
    try {
      const before = rolloutSnapshots.get(baseline), key = await backendKey(project, name);
      if (!before || before.key !== key) throw rolloutError('Capture App Hosting rollout status before deploying, then verify that same backend.');
      if (hasPendingRollout(baseline)) throw rolloutError('An earlier App Hosting rollout was already pending. Check it in Firebase before starting another deployment.', 'pending');
      const previousNames = new Set();
      for (const row of baseline) previousNames.add((await childResource(project, key, row.name, 'rollouts')).key);
      const after = await listRollouts(project, name), created = [];
      for (const row of after) if (!previousNames.has((await childResource(project, key, row.name, 'rollouts')).key)) created.push(row);
      if (created.length !== 1) throw rolloutError(created.length ? 'More than one new App Hosting rollout was found. Check the Firebase console to identify this deployment.' : 'Firebase did not confirm a new App Hosting rollout. An existing live address does not prove this deployment succeeded.');
      const rollout = created[0], createdAt = Date.parse(rollout.createTime);
      // Allow bounded local/Google clock skew; names must still be new and the
      // server timestamp must be later than every rollout in the baseline.
      if (createdAt < before.capturedAt - 120000 || createdAt <= before.latestTime || createdAt > Date.now() + 120000) throw rolloutError('The rollout timestamp does not identify a new deployment. Check the Firebase console.');
      if (FAILED_ROLLOUT_STATES.has(rollout.state)) throw rolloutError('The new App Hosting rollout failed, was cancelled, or was skipped. Check its build logs in Firebase.', 'failed');
      if (rollout.state !== 'SUCCEEDED' || rollout.reconciling) throw rolloutError('The new App Hosting rollout is not finished. Check Firebase before starting another deployment.', 'pending');
      const expected = await childResource(project, key, rollout.build, 'builds');
      for (const previous of baseline) if ((await childResource(project, key, previous.build, 'builds')).key === expected.key) throw rolloutError('The new rollout reuses an earlier build. Firebase did not confirm a new source build for this deployment.');
      const build = await request('https://firebaseapphosting.googleapis.com', '/v1beta/' + expected.name);
      const actual = await childResource(project, key, build?.name, 'builds');
      if (actual.key !== expected.key) throw rolloutError('App Hosting returned a different build than the completed rollout.');
      const builtAt = typeof build.createTime === 'string' ? Date.parse(build.createTime) : NaN;
      if (!Number.isFinite(builtAt) || builtAt < before.capturedAt - 120000 || builtAt <= before.latestTime || builtAt > Date.now() + 120000) throw rolloutError('The build timestamp does not identify a new source build. Check the Firebase console.');
      if (['FAILED', 'SKIPPED', 'EXPIRED'].includes(build.state)) throw rolloutError('The rollout build is not usable. Check its errors in the Firebase console.', 'failed');
      if (build.state !== 'READY' || build.reconciling === true) throw rolloutError('The rollout build is not READY. Check Firebase before starting another deployment.', 'pending');
      const traffic = await request('https://firebaseapphosting.googleapis.com', '/v1beta/' + name + '/traffic');
      const trafficName = typeof traffic?.name === 'string' && traffic.name.endsWith('/traffic') ? traffic.name.slice(0, -8) : '';
      if (!trafficName || await backendKey(project, trafficName) !== key || !Array.isArray(traffic.current?.splits)) throw rolloutError('App Hosting did not confirm the deployed backend traffic.');
      if (traffic.reconciling === true) throw rolloutError('App Hosting is still updating backend traffic. Check Firebase before retrying.', 'pending');
      let expectedPercent = 0, totalPercent = 0;
      for (const split of traffic.current.splits) {
        // Protobuf JSON can omit an integer field whose value is zero.
        const percent = split.percent === undefined ? 0 : split.percent;
        if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw rolloutError('App Hosting returned invalid backend traffic allocation.');
        const target = await childResource(project, key, split.build, 'builds');
        totalPercent += percent;
        if (target.key === expected.key) expectedPercent += percent;
      }
      if (totalPercent !== 100 || expectedPercent !== 100) throw rolloutError('The newly completed build is not serving all backend traffic. Check the Firebase console before retrying.');
      return { rolloutName: rollout.name, buildName: expected.name };
    } catch (error) { error.state ||= 'unknown'; throw error; }
  }
  async function assertNoActiveDeployment(project, name, baseline) {
    try {
      const key = await backendKey(project, name);
      if (baseline !== undefined && rolloutSnapshots.get(baseline)?.key !== key) throw rolloutError('The earlier deployment snapshot does not match this backend. Refresh its status.');
      // Always read fresh state: a build can begin between an earlier snapshot
      // and this check, including before its rollout resource has been created.
      const rollouts = await listRollouts(project, name);
      if (hasPendingRollout(rollouts)) throw rolloutError('A cloud rollout is still active. Wait for it to finish before allowing another deployment.', 'pending');
      let pageToken = '';
      for (let page = 0; page < 50; page++) {
        const data = await request('https://firebaseapphosting.googleapis.com', '/v1beta/' + name + '/builds?pageSize=100' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''));
        if (!data || (data.builds !== undefined && !Array.isArray(data.builds)) || (Array.isArray(data.unreachable) && data.unreachable.length)) throw rolloutError('Firebase could not list every cloud build. Check the Firebase console before allowing another deployment.');
        for (const build of data.builds || []) {
          await childResource(project, key, build?.name, 'builds');
          if (build.reconciling === true || ['BUILDING', 'BUILT', 'DEPLOYING'].includes(build.state)) throw rolloutError('A cloud build is still active, even if no rollout is visible yet. Wait for it to finish before allowing another deployment.', 'pending');
          if (!['READY', 'FAILED', 'SKIPPED', 'EXPIRED'].includes(build.state)) throw rolloutError('A cloud build has an unknown state. Check Firebase before allowing another deployment.');
        }
        if (!data.nextPageToken) return true;
        if (typeof data.nextPageToken !== 'string' || data.nextPageToken.length > 4096) throw rolloutError('Firebase returned an invalid build page token.');
        pageToken = data.nextPageToken;
      }
      throw rolloutError('Firebase returned too many cloud build pages to verify that deployment is inactive.');
    } catch (error) { error.state ||= 'unknown'; throw error; }
  }
  async function appHostingStatus(project) {
    firebaseProjectId(project);
    const [bill, list, locations] = await Promise.allSettled([
      billing(project), pages('https://firebaseapphosting.googleapis.com', `/v1beta/projects/${project}/locations/-/backends`, 'backends'), pages('https://firebaseapphosting.googleapis.com', `/v1beta/projects/${project}/locations`, 'locations')
    ]);
    const number = list.status === 'fulfilled' && list.value.some(value => /^projects\/[0-9]+\//.test(value.name)) ? await projectNumber(project) : undefined;
    const backends = list.status === 'fulfilled' ? list.value.map(value => { backendResource(value.name, project, number); const parts = value.name.split('/'); return { id: parts[5], name: value.name, location: parts[3], uri: value.uri ? backendUrl(value.uri) : '', repository: value.codebase?.repository || '', rootDir: value.codebase?.rootDirectory || '' }; }) : [];
    return { cliAvailable: true, billingEnabled: bill.status === 'fulfilled' ? bill.value : null, billingError: bill.status === 'rejected' ? bill.reason.message : '', backends, backendError: list.status === 'rejected' ? list.reason.message : '', locations: locations.status === 'fulfilled' ? locations.value.map(l => ({ id: l.locationId, label: l.displayName || l.locationId })) : [{ id: 'us-east4', label: 'us-east4 (Firebase CLI default)' }], consoleUrl: `https://console.firebase.google.com/project/${project}/apphosting`, billingUrl: `https://console.firebase.google.com/project/${project}/usage/details` };
  }
  return { account, status, request, billing, appHostingStatus, getBackend, listRollouts, verifyRollout, hasPendingRollout, assertNoActiveDeployment };
}
module.exports = { ...createFirebaseClient(), createFirebaseClient, firebaseProjectId, backendId, backendResource, backendUrl, hasPendingRollout };
