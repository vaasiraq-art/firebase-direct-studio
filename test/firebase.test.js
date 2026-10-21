'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFirebaseClient, firebaseProjectId, backendId, backendResource, backendUrl, hasPendingRollout } = require('../lib/firebase');

const PROJECT = 'example-project';
const ACCESS = 'synthetic-access-token-for-test-only';
const REFRESH = 'synthetic-refresh-token-for-test-only';
const PRIVATE_BODY = 'synthetic-private-response-for-test-only';
function savedAccount(email = 'test@example.invalid', overrides = {}) {
  return { user: { email }, tokens: { access_token: ACCESS, refresh_token: REFRESH, expires_at: Date.now() + 3600000, ...overrides } };
}
function assertNoCredentials(value) {
  const serialized = JSON.stringify(value);
  for (const secret of [ACCESS, REFRESH, PRIVATE_BODY, 'synthetic-oauth-client-secret']) assert.equal(serialized.includes(secret), false);
}
function client(fetchImpl, getAccount = () => savedAccount()) {
  return createFirebaseClient({ getAccount, getClientCredentials: () => ({ clientId: 'synthetic-oauth-client-id', clientSecret: 'synthetic-oauth-client-secret' }), fetchImpl });
}

test('Firebase saved sign-in checks use only the fixed API host and authorization header', async () => {
  const calls = [];
  const firebase = client(async (url, options) => {
    calls.push(url);
    assert.equal(url, 'https://firebase.googleapis.com/v1beta1/projects?pageSize=100');
    assert.equal(options.headers.Authorization, 'Bearer ' + ACCESS);
    assert.equal(options.headers.Accept, 'application/json');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    assert.equal(url.includes(ACCESS), false);
    return Response.json({ results: [{ projectId: PROJECT, displayName: 'Example project' }] });
  });
  const status = await firebase.status();
  assert.equal(status.isLoggedIn, true);
  assert.equal(status.connectionStatus, 'connected');
  assert.equal(status.email, 'test@example.invalid');
  assert.deepEqual(status.projects, [{ projectId: PROJECT, displayName: 'Example project' }]);
  assert.equal(calls.length, 1);
  assertNoCredentials(status);
});

test('Firebase requests reject unapproved origins and unsafe routes before reading credentials', async () => {
  let accountReads = 0;
  const firebase = client(async () => { assert.fail('Unsafe requests must not reach the network.'); }, () => { accountReads++; return savedAccount(); });
  for (const [origin, route] of [
    ['https://evil.invalid', '/v1/projects'], ['http://firebase.googleapis.com', '/v1/projects'],
    ['https://firebase.googleapis.com.evil.invalid', '/v1/projects'],
    ['https://firebase.googleapis.com', '//evil.invalid/path'], ['https://firebase.googleapis.com', '/v1/projects\r\nAuthorization: bad']
  ]) await assert.rejects(firebase.request(origin, route), /Invalid Firebase API request/);
  assert.equal(accountReads, 0);
});

test('a missing Firebase account is signed out without starting authentication or network calls', async () => {
  const firebase = client(async () => assert.fail('No request is allowed without saved account.'), () => null);
  const status = await firebase.status();
  assert.equal(status.isLoggedIn, false);
  assert.equal(status.connectionStatus, 'signed-out');
  assert.deepEqual(status.projects, []);
  assertNoCredentials(status);
  await assert.rejects(firebase.billing(PROJECT), /Sign in/);
});

test('temporary network failures retain the saved account and sanitize network errors', async () => {
  const firebase = client(async () => { throw new Error('Network diagnostic contains ' + ACCESS + ' ' + PRIVATE_BODY); });
  const status = await firebase.status();
  assert.equal(status.isLoggedIn, true);
  assert.equal(status.connectionStatus, 'unavailable');
  assert.equal(status.email, 'test@example.invalid');
  assert.match(status.message, /saved sign-in is still present/);
  assertNoCredentials(status);
});

test('Firebase project listing paginates with encoded tokens and does not expose credentials', async () => {
  const routes = [];
  const firebase = client(async url => {
    routes.push(url);
    if (routes.length === 1) return Response.json({ results: [{ projectId: 'first-project' }], nextPageToken: 'opaque+/=?&page=2' });
    assert.equal(new URL(url).searchParams.get('pageToken'), 'opaque+/=?&page=2');
    return Response.json({ results: [{ projectId: 'second-project', displayName: 'Second' }] });
  });
  const status = await firebase.status();
  assert.deepEqual(status.projects.map(project => project.projectId), ['first-project', 'second-project']);
  assert.equal(routes.length, 2);
  assertNoCredentials(status);
});

test('expired access tokens use the refresh grant only at Google OAuth and cache its result', async () => {
  let refreshes = 0;
  let apiCalls = 0;
  const renewed = 'synthetic-renewed-access-for-test-only';
  const firebase = client(async (url, options) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      refreshes++;
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      assert.ok(options.body instanceof URLSearchParams);
      assert.equal(options.body.get('grant_type'), 'refresh_token');
      assert.equal(options.body.get('refresh_token'), REFRESH);
      assert.equal(options.body.get('client_id'), 'synthetic-oauth-client-id');
      assert.equal(options.body.get('client_secret'), 'synthetic-oauth-client-secret');
      return Response.json({ access_token: renewed, expires_in: 3600 });
    }
    apiCalls++;
    assert.equal(options.headers.Authorization, 'Bearer ' + renewed);
    return Response.json({ results: [] });
  }, () => savedAccount(undefined, { expires_at: Date.now() - 1000 }));
  assert.equal((await firebase.status()).isLoggedIn, true);
  assert.equal((await firebase.status()).isLoggedIn, true);
  assert.equal(refreshes, 1);
  assert.equal(apiCalls, 2);
});

test('Firebase retries one unauthorized API response after refreshing and then reports expired sign-in', async () => {
  let refreshes = 0;
  let apiCalls = 0;
  const firebase = client(async url => {
    if (url === 'https://oauth2.googleapis.com/token') { refreshes++; return Response.json({ access_token: 'synthetic-renewed-access-for-test-only', expires_in: 3600 }); }
    apiCalls++;
    return Response.json({ error: { message: PRIVATE_BODY } }, { status: 401 });
  });
  const status = await firebase.status();
  assert.equal(refreshes, 1);
  assert.equal(apiCalls, 2);
  assert.equal(status.isLoggedIn, false);
  assert.equal(status.connectionStatus, 'signed-out');
  assertNoCredentials(status);
});

test('OAuth network failures preserve sign-in while revoked refresh grants require reconnecting', async () => {
  const saved = () => savedAccount(undefined, { expires_at: 1 });
  const offline = client(async () => { throw new Error(REFRESH + PRIVATE_BODY); }, saved);
  const offlineStatus = await offline.status();
  assert.equal(offlineStatus.isLoggedIn, true);
  assert.equal(offlineStatus.connectionStatus, 'unavailable');
  assertNoCredentials(offlineStatus);
  const revoked = client(async () => Response.json({ error: PRIVATE_BODY }, { status: 400 }), saved);
  const revokedStatus = await revoked.status();
  assert.equal(revokedStatus.isLoggedIn, false);
  assert.equal(revokedStatus.connectionStatus, 'signed-out');
  assertNoCredentials(revokedStatus);
});

test('billing is confirmed only by an explicit boolean and errors hide server response bodies', async () => {
  for (const value of [true, false]) {
    const firebase = client(async url => { assert.equal(url, 'https://cloudbilling.googleapis.com/v1/projects/' + PROJECT + '/billingInfo'); return Response.json({ billingEnabled: value }); });
    assert.equal(await firebase.billing(PROJECT), value);
  }
  await assert.rejects(client(async () => Response.json({})).billing(PROJECT), /did not confirm/);
  await assert.rejects(client(async () => Response.json({ billingEnabled: 'true' })).billing(PROJECT), /did not confirm/);
  await assert.rejects(client(async () => Response.json({ error: { message: PRIVATE_BODY } }, { status: 403 })).billing(PROJECT), error => /denied access/.test(error.message) && !error.message.includes(PRIVATE_BODY));
});

test('App Hosting status keeps unknown billing distinct from a disabled billing account', async () => {
  for (const billingReply of [{ billingEnabled: false }, { error: { message: PRIVATE_BODY } }]) {
    const firebase = client(async url => {
      if (url.startsWith('https://cloudbilling.googleapis.com/')) return Response.json(billingReply, { status: billingReply.error ? 403 : 200 });
      if (url.endsWith('/backends')) return Response.json({ backends: [{ name: `projects/${PROJECT}/locations/us-east4/backends/test-backend`, uri: 'test-backend--example-project.us-east4.hosted.app', codebase: { rootDirectory: 'store' } }] });
      if (url.endsWith('/locations')) return Response.json({ locations: [{ locationId: 'us-east4', displayName: 'US East' }] });
      assert.fail('Unexpected endpoint: ' + url);
    });
    const status = await firebase.appHostingStatus(PROJECT);
    assert.equal(status.billingEnabled, billingReply.error ? null : false);
    assert.equal(status.backends[0].id, 'test-backend');
    assert.equal(status.backends[0].rootDir, 'store');
    assert.equal(status.backends[0].uri, 'https://test-backend--example-project.us-east4.hosted.app');
    assert.deepEqual(status.locations, [{ id: 'us-east4', label: 'US East' }]);
    assertNoCredentials(status);
  }
});

test('Firebase API response size and JSON validation fail safely', async () => {
  const large = client(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(large.billing(PROJECT), /too much data/);
  const invalid = client(async () => new Response(PRIVATE_BODY, { headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(invalid.billing(PROJECT), error => /invalid data/.test(error.message) && !error.message.includes(PRIVATE_BODY));
});

test('backend destinations reject cross-project resources, redirects, credentials, and unsafe hostnames', () => {
  const resource = `projects/${PROJECT}/locations/us-east4/backends/test-backend`;
  assert.equal(firebaseProjectId(PROJECT), PROJECT);
  assert.equal(backendId('test-backend'), 'test-backend');
  assert.equal(backendResource(resource, PROJECT), resource);
  assert.throws(() => backendResource(resource.replace(PROJECT, 'other-project'), PROJECT), /unexpected backend/);
  for (const value of ['test--example.us-east4.hosted.app', 'https://test--example.us-east4.hosted.app/']) assert.equal(backendUrl(value), 'https://test--example.us-east4.hosted.app');
  for (const value of ['https://hosted.app.evil.invalid', 'http://test.hosted.app', 'https://user:password@test.hosted.app', 'https://test.hosted.app:444', 'https://test.hosted.app/path', 'https://test.hosted.app/?secret=value', 'https://test.hosted.app/#fragment', 'javascript:alert(1)']) assert.throws(() => backendUrl(value));
  for (const value of ['bad;command', 'UPPER-project', '../project', '--project=other']) assert.throws(() => firebaseProjectId(value));
});

test('cached projects never cross Firebase account identities during an outage', async () => {
  let current = savedAccount('first@example.invalid');
  let offline = false;
  const firebase = client(async () => {
    if (offline) throw new Error('offline');
    return Response.json({ results: [{ projectId: 'first-account-project' }] });
  }, () => current);
  assert.equal((await firebase.status()).projects.length, 1);
  offline = true;
  const same = await firebase.status();
  assert.equal(same.projects[0].projectId, 'first-account-project');
  current = savedAccount('second@example.invalid', { access_token: 'synthetic-second-token', refresh_token: 'synthetic-second-refresh' });
  const switched = await firebase.status();
  assert.equal(switched.email, 'second@example.invalid');
  assert.deepEqual(switched.projects, []);
  assert.equal(switched.isLoggedIn, true);
});

test('numeric backend resources are accepted only with the verified matching project number', () => {
  const numeric = 'projects/123456789012/locations/us-east4/backends/test-backend';
  assert.throws(() => backendResource(numeric, PROJECT), /unexpected backend/);
  assert.throws(() => backendResource(numeric, PROJECT, '999999999999'), /unexpected backend/);
  assert.equal(backendResource(numeric, PROJECT, '123456789012'), numeric);
  assert.throws(() => backendResource('projects/other-project/locations/us-east4/backends/test-backend', PROJECT, '123456789012'), /unexpected backend/);
});

test('the Firebase client verifies canonical numeric backend identity through project metadata', async () => {
  const numeric = 'projects/123456789012/locations/us-east4/backends/test-backend';
  const metadataRoute = 'https://firebase.googleapis.com/v1beta1/projects/' + PROJECT;
  let verifications = 0;
  let backendReads = 0;
  const firebase = client(async url => {
    if (url === metadataRoute) { verifications++; return Response.json({ projectId: PROJECT, projectNumber: '123456789012' }); }
    if (url.startsWith('https://cloudbilling.googleapis.com/')) return Response.json({ billingEnabled: true });
    if (url.endsWith('/backends')) return Response.json({ backends: [{ name: numeric, uri: 'test-backend--example-project.us-east4.hosted.app' }] });
    if (url.endsWith('/locations')) return Response.json({ locations: [{ locationId: 'us-east4' }] });
    if (url === 'https://firebaseapphosting.googleapis.com/v1beta/' + numeric) { backendReads++; return Response.json({ name: numeric, uri: 'test-backend--example-project.us-east4.hosted.app' }); }
    assert.fail('Unexpected route: ' + url);
  });
  const status = await firebase.appHostingStatus(PROJECT);
  assert.equal(status.billingEnabled, true);
  assert.equal(status.backends[0].name, numeric);
  assert.equal(verifications, 1);
  assert.equal((await firebase.getBackend(PROJECT, numeric)).name, numeric);
  assert.equal(verifications, 1);
  assert.equal(backendReads, 1);
});

test('canonical backend lookup rejects another project number before requesting its backend', async () => {
  const numeric = 'projects/999999999999/locations/us-east4/backends/test-backend';
  let backendReads = 0;
  const firebase = client(async url => {
    if (url === 'https://firebase.googleapis.com/v1beta1/projects/' + PROJECT) return Response.json({ projectId: PROJECT, projectNumber: '123456789012' });
    backendReads++;
    assert.fail('No backend request is allowed for another project: ' + url);
  });
  await assert.rejects(firebase.getBackend(PROJECT, numeric), /unexpected backend/);
  assert.equal(backendReads, 0);
});

test('project metadata with the wrong project ID cannot validate canonical backend resources', async () => {
  const firebase = client(async () => Response.json({ projectId: 'other-project', projectNumber: '123456789012' }));
  await assert.rejects(firebase.getBackend(PROJECT, 'projects/123456789012/locations/us-east4/backends/test-backend'), /could not verify this project identity/);
});

test('concurrent authenticated requests share one OAuth refresh grant', async () => {
  let refreshes = 0;
  const firebase = client(async url => {
    if (url === 'https://oauth2.googleapis.com/token') { refreshes++; return Response.json({ access_token: 'synthetic-renewed-access-for-test-only', expires_in: 3600 }); }
    return Response.json({ billingEnabled: true });
  }, () => savedAccount(undefined, { expires_at: 1 }));
  assert.deepEqual(await Promise.all([firebase.billing(PROJECT), firebase.billing(PROJECT)]), [true, true]);
  assert.equal(refreshes, 1);
});

test('unreadable saved credentials produce a setup error without leaking diagnostics', async () => {
  const firebase = client(async () => assert.fail('Unreadable credentials must not cause network calls.'), () => { throw new Error(PRIVATE_BODY + REFRESH); });
  await assert.rejects(firebase.status(), error => /credentials are unavailable/.test(error.message) && !error.message.includes(PRIVATE_BODY) && !error.message.includes(REFRESH));
});

const BACKEND = `projects/${PROJECT}/locations/us-east4/backends/test-backend`;
function rolloutFixture(options = {}) {
  const now = Date.now(), backend = options.backend || BACKEND;
  const old = { name: backend + '/rollouts/old-rollout', build: backend + '/builds/old-build', state: 'SUCCEEDED', createTime: new Date(now - 600000).toISOString() };
  const fresh = { name: backend + '/rollouts/new-rollout', build: backend + '/builds/new-build', state: 'SUCCEEDED', createTime: new Date(now + 100).toISOString(), ...options.rollout };
  let reads = 0;
  const calls = [];
  const firebase = client(async (url, request) => {
    calls.push(url);
    assert.equal(request.method, undefined);
    assert.equal(request.headers.Authorization, 'Bearer ' + ACCESS);
    if (url === 'https://firebase.googleapis.com/v1beta1/projects/' + PROJECT) return Response.json({ projectId: PROJECT, projectNumber: '123456789012' });
    if (url.includes('/rollouts?')) {
      reads++;
      return Response.json({ rollouts: reads === 1 ? options.baseline || [old] : options.after || [fresh, old], ...options.listData });
    }
    if (url.endsWith('/builds/new-build') || url.endsWith('/builds/old-build')) return Response.json({ name: fresh.build, state: 'READY', createTime: new Date(now).toISOString(), ...options.build });
    if (url.endsWith('/traffic')) return Response.json({ name: backend + '/traffic', current: { splits: [{ build: fresh.build, percent: 100 }] }, ...options.traffic });
    assert.fail('Unexpected rollout fixture request: ' + url);
  });
  return { firebase, calls, old, fresh };
}

test('a new SUCCEEDED rollout is verified only with a new READY build and100 percent live traffic', async () => {
  const f = rolloutFixture();
  const baseline = await f.firebase.listRollouts(PROJECT, BACKEND);
  assert.equal(Object.isFrozen(baseline), true);
  assert.equal(hasPendingRollout(baseline), false);
  assert.deepEqual(await f.firebase.verifyRollout(PROJECT, BACKEND, baseline), { rolloutName: f.fresh.name, buildName: f.fresh.build });
  assert.ok(f.calls.some(url => url.endsWith('/builds/new-build')));
  assert.ok(f.calls.some(url => url.endsWith('/traffic')));
  assertNoCredentials(baseline);
});

test('an existing successful backend and a forged baseline cannot produce deployment success', async () => {
  const f = rolloutFixture();
  const baseline = await f.firebase.listRollouts(PROJECT, BACKEND);
  await assert.rejects(f.firebase.verifyRollout(PROJECT, BACKEND, [...baseline]), error => error.state === 'unknown' && /Capture App Hosting/.test(error.message));
  const oldOnly = rolloutFixture({ after: [] });
  const before = await oldOnly.firebase.listRollouts(PROJECT, BACKEND);
  await assert.rejects(oldOnly.firebase.verifyRollout(PROJECT, BACKEND, before), error => error.state === 'unknown' && /did not confirm a new/.test(error.message));
});

test('earlier pending rollouts block another deployment and new pending or failed rollouts never pass', async () => {
  for (const state of ['QUEUED', 'PENDING_BUILD', 'PROGRESSING', 'PAUSED']) {
    const f = rolloutFixture({ rollout: { state } });
    const baseline = await f.firebase.listRollouts(PROJECT, BACKEND);
    await assert.rejects(f.firebase.verifyRollout(PROJECT, BACKEND, baseline), error => error.state === 'pending');
    assert.equal(f.calls.some(url => url.endsWith('/traffic')), false);
  }
  for (const state of ['FAILED', 'CANCELLED', 'SKIPPED']) {
    const f = rolloutFixture({ rollout: { state } });
    const baseline = await f.firebase.listRollouts(PROJECT, BACKEND);
    await assert.rejects(f.firebase.verifyRollout(PROJECT, BACKEND, baseline), error => error.state === 'failed');
  }
  const f = rolloutFixture();
  const pending = { ...f.old, state: 'PENDING_BUILD' };
  const earlier = rolloutFixture({ baseline: [pending] });
  const baseline = await earlier.firebase.listRollouts(PROJECT, BACKEND);
  assert.equal(hasPendingRollout(baseline), true);
  await assert.rejects(earlier.firebase.verifyRollout(PROJECT, BACKEND, baseline), error => error.state === 'pending');
  assert.equal(earlier.calls.length, 1);
});

test('READY old builds, failed builds, wrong build identity, and stale rollout timestamps are rejected', async () => {
  const configurations = [
    { rollout: { build: BACKEND + '/builds/old-build' } },
    { rollout: { createTime: new Date(Date.now() - 3600000).toISOString() } },
    { build: { name: BACKEND + '/builds/another-build' } },
    { build: { createTime: new Date(Date.now() - 3600000).toISOString() } },
    { build: { state: 'FAILED' }, expectedState: 'failed' },
    { build: { state: 'BUILDING' }, expectedState: 'pending' },
    { build: { reconciling: true }, expectedState: 'pending' }
  ];
  for (const options of configurations) {
    const f = rolloutFixture(options);
    const baseline = await f.firebase.listRollouts(PROJECT, BACKEND);
    await assert.rejects(f.firebase.verifyRollout(PROJECT, BACKEND, baseline), error => error.state === (options.expectedState || 'unknown'));
  }
});

test('traffic must belong to the selected backend and route100 percent to the verified new build', async () => {
  const configurations = [
    { current: { splits: [{ build: BACKEND + '/builds/old-build', percent: 100 }] } },
    { name: 'projects/other-project/locations/us-east4/backends/test-backend/traffic' },
    { current: { splits: [{ build: BACKEND + '/builds/new-build', percent: 50 }, { build: BACKEND + '/builds/old-build', percent: 50 }] } },
    { current: { splits: [{ build: BACKEND + '/builds/new-build', percent: '100' }] } }
  ];
  for (const traffic of configurations) {
    const f = rolloutFixture({ traffic });
    const baseline = await f.firebase.listRollouts(PROJECT, BACKEND);
    await assert.rejects(f.firebase.verifyRollout(PROJECT, BACKEND, baseline), error => error.state === 'unknown');
  }
  const f = rolloutFixture({ traffic: { reconciling: true } });
  const baseline = await f.firebase.listRollouts(PROJECT, BACKEND);
  await assert.rejects(f.firebase.verifyRollout(PROJECT, BACKEND, baseline), error => error.state === 'pending');
  const zero = rolloutFixture({ traffic: { current: { splits: [{ build: BACKEND + '/builds/new-build', percent: 100 }, { build: BACKEND + '/builds/old-build' }] } } });
  const zeroBaseline = await zero.firebase.listRollouts(PROJECT, BACKEND);
  assert.equal((await zero.firebase.verifyRollout(PROJECT, BACKEND, zeroBaseline)).buildName, BACKEND + '/builds/new-build');
});

test('rollout verification accepts only verified canonical project numbers and same-backend children', async () => {
  const numeric = 'projects/123456789012/locations/us-east4/backends/test-backend';
  const f = rolloutFixture({ backend: numeric });
  const baseline = await f.firebase.listRollouts(PROJECT, numeric);
  assert.deepEqual(await f.firebase.verifyRollout(PROJECT, numeric, baseline), { rolloutName: f.fresh.name, buildName: f.fresh.build });
  const wrong = rolloutFixture({ rollout: { build: 'projects/999999999999/locations/us-east4/backends/test-backend/builds/new-build' } });
  const before = await wrong.firebase.listRollouts(PROJECT, BACKEND);
  await assert.rejects(wrong.firebase.verifyRollout(PROJECT, BACKEND, before), error => error.state === 'unknown' && /unexpected backend/.test(error.message));
});

test('rollout listing paginates, rejects unreachable metadata, and never follows resource redirects', async () => {
  let reads = 0;
  const f = rolloutFixture();
  const firebase = client(async url => {
    reads++;
    assert.equal(new URL(url).origin, 'https://firebaseapphosting.googleapis.com');
    if (reads === 1) return Response.json({ rollouts: [f.old], nextPageToken: 'opaque+/=&token' });
    assert.equal(new URL(url).searchParams.get('pageToken'), 'opaque+/=&token');
    return Response.json({ rollouts: [f.fresh] });
  });
  assert.equal((await firebase.listRollouts(PROJECT, BACKEND)).length, 2);
  const unreachable = rolloutFixture({ listData: { unreachable: ['us-east4'] } });
  await assert.rejects(unreachable.firebase.listRollouts(PROJECT, BACKEND), error => error.state === 'unknown');
  const unsafe = rolloutFixture();
  await assert.rejects(unsafe.firebase.listRollouts(PROJECT, BACKEND + '/../../other'), /unexpected backend/);
  assert.equal(unsafe.calls.length, 0);
});

test('acknowledging an unknown deployment requires fresh terminal rollout and build states', async () => {
  for (const state of ['READY', 'FAILED', 'SKIPPED', 'EXPIRED']) {
    const calls = [];
    const firebase = client(async url => {
      calls.push(url);
      if (url.includes('/rollouts?')) return Response.json({ rollouts: [] });
      if (url.includes('/builds?')) return Response.json({ builds: [{ name: BACKEND + '/builds/finished-build', state }] });
      assert.fail('Unexpected inactive deployment check route.');
    });
    const baseline = await firebase.listRollouts(PROJECT, BACKEND);
    assert.equal(await firebase.assertNoActiveDeployment(PROJECT, BACKEND, baseline), true);
    assert.equal(calls.filter(url => url.includes('/rollouts?')).length, 2);
  }
});

test('a build created before its rollout prevents retry even when the rollout list is empty', async () => {
  for (const state of ['BUILDING', 'BUILT', 'DEPLOYING']) {
    const firebase = client(async url => url.includes('/rollouts?') ? Response.json({ rollouts: [] }) : Response.json({ builds: [{ name: BACKEND + '/builds/in-progress-build', state }] }));
    await assert.rejects(firebase.assertNoActiveDeployment(PROJECT, BACKEND), error => error.state === 'pending' && /cloud build is still active/.test(error.message));
  }
  const reconciling = client(async url => url.includes('/rollouts?') ? Response.json({ rollouts: [] }) : Response.json({ builds: [{ name: BACKEND + '/builds/in-progress-build', state: 'READY', reconciling: true }] }));
  await assert.rejects(reconciling.assertNoActiveDeployment(PROJECT, BACKEND), error => error.state === 'pending');
  const unknown = client(async url => url.includes('/rollouts?') ? Response.json({ rollouts: [] }) : Response.json({ builds: [{ name: BACKEND + '/builds/unknown-build', state: 'STATE_UNSPECIFIED' }] }));
  await assert.rejects(unknown.assertNoActiveDeployment(PROJECT, BACKEND), error => error.state === 'unknown');
});

test('inactive deployment checks inspect all build pages and reject unreachable or foreign resources', async () => {
  let buildReads = 0;
  const firebase = client(async url => {
    if (url.includes('/rollouts?')) return Response.json({ rollouts: [] });
    buildReads++;
    if (buildReads === 1) return Response.json({ builds: [{ name: BACKEND + '/builds/old-build', state: 'READY' }], nextPageToken: 'next+/=&build' });
    assert.equal(new URL(url).searchParams.get('pageToken'), 'next+/=&build');
    return Response.json({ builds: [{ name: BACKEND + '/builds/active-build', state: 'BUILDING' }] });
  });
  await assert.rejects(firebase.assertNoActiveDeployment(PROJECT, BACKEND), error => error.state === 'pending');
  assert.equal(buildReads, 2);
  for (const data of [{ unreachable: ['us-east4'] }, { builds: [{ name: 'projects/other-project/locations/us-east4/backends/test-backend/builds/foreign-build', state: 'READY' }] }]) {
    const bad = client(async url => url.includes('/rollouts?') ? Response.json({ rollouts: [] }) : Response.json(data));
    await assert.rejects(bad.assertNoActiveDeployment(PROJECT, BACKEND), error => error.state === 'unknown');
  }
});

test('active rollouts and forged snapshots cannot be acknowledged as safe to retry', async () => {
  const f = rolloutFixture({ baseline: [{ name: BACKEND + '/rollouts/active', build: BACKEND + '/builds/active', state: 'PROGRESSING', createTime: new Date().toISOString() }] });
  await assert.rejects(f.firebase.assertNoActiveDeployment(PROJECT, BACKEND), error => error.state === 'pending');
  assert.equal(f.calls.some(url => url.includes('/builds?')), false);
  const valid = rolloutFixture();
  await assert.rejects(valid.firebase.assertNoActiveDeployment(PROJECT, BACKEND, []), error => error.state === 'unknown');
  assert.equal(valid.calls.length, 0);
});
