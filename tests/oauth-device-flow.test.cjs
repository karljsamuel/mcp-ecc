/**
 * OAuth flow selection for Microsoft, and device-flow completion from the web UI.
 *
 * The rule under test: Microsoft uses the device flow wherever its app registration
 * permits it — including when the account is added from the browser — and uses the
 * browser authorisation-code flow only when Microsoft declines for that specific
 * reason. Every other failure must surface rather than quietly switching flows.
 *
 * fetch is stubbed throughout; nothing here contacts Microsoft.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { SQLiteStorage } = require('@mcp-ecc/storage-sqlite');
const {
  AuthError,
  DeviceFlowUnsupportedError,
  OAuthManager,
  isPublicClientFlowsDisabled,
} = require('@mcp-ecc/core');
const { ManagementApi } = require('@mcp-ecc/management-api');

const MASTER_KEY = 'isolated-test-key';
const PUBLIC_DIR = resolve(__dirname, '../packages/admin-ui/dist');
const DEVICE_ENDPOINT = /login\.microsoftonline\.com\/.*\/oauth2\/v2\.0\/devicecode/;
const TOKEN_ENDPOINT = /login\.microsoftonline\.com\/.*\/oauth2\/v2\.0\/token/;

/** Microsoft's answer when the registration is not enabled for public client flows. */
const PUBLIC_CLIENT_FLOWS_OFF = JSON.stringify({
  error: 'invalid_client',
  error_description:
    "AADSTS7000218: The request body must contain the following parameter: 'client_assertion' or 'client_secret'.",
  error_codes: [7000218],
});

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Bad Request',
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

/**
 * Install a fetch stub. `handler(url)` returns a response, or throws. An unexpected
 * URL fails loudly so a stray call cannot pass unnoticed.
 */
function stubFetch(t, handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    calls.push({ url: target, options });
    return handler(target, options);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

function coreStorage(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-ecc-oauth-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new SQLiteStorage(join(dir, 'oauth.sqlite'), MASTER_KEY);
}

const MICROSOFT_CLIENT = {
  provider: 'microsoft',
  clientId: 'client-id-fixture',
  clientSecret: 'client-secret-fixture',
  scopes: [],
  redirectUri: 'https://ecc.example.test/oauth/callback',
};

/* --------------------- classifying Microsoft's refusal ---------------- */

test('oauth: only a public-client-flows refusal is treated as device-flow unsupported', () => {
  assert.equal(isPublicClientFlowsDisabled(400, PUBLIC_CLIENT_FLOWS_OFF), true);
  assert.equal(isPublicClientFlowsDisabled(400, 'invalid_client - public client flows are not enabled'), true);

  // A server-side failure is transient: it must not be mistaken for a configuration fact.
  assert.equal(isPublicClientFlowsDisabled(500, PUBLIC_CLIENT_FLOWS_OFF), false);
  assert.equal(isPublicClientFlowsDisabled(503, 'service unavailable'), false);
  // Unrelated client errors must surface.
  assert.equal(isPublicClientFlowsDisabled(400, '{"error":"invalid_scope"}'), false);
  assert.equal(isPublicClientFlowsDisabled(400, '{"error":"invalid_client"}'), false);
});

/* --------------------- starting the device flow ----------------------- */

test('oauth: a device flow is started and its code is persisted for later completion', async (t) => {
  const storage = coreStorage(t);
  const calls = stubFetch(t, (url) => {
    assert.match(url, DEVICE_ENDPOINT);
    return jsonResponse(200, {
      device_code: 'device-code-fixture',
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://microsoft.com/devicelogin',
      expires_in: 900,
      interval: 5,
    });
  });

  const flow = await new OAuthManager(storage).startFlow('microsoft', 'device_code', MICROSOFT_CLIENT, 'acct-1');

  assert.equal(flow.userCode, 'ABCD-EFGH');
  assert.equal(flow.deviceCode, 'device-code-fixture');
  assert.equal(calls.length, 1, 'the device endpoint is called exactly once');

  // The web UI returns between attempts, so the code has to survive the request.
  const saved = await storage.getOAuthState(flow.state);
  assert.equal(saved.deviceCode, 'device-code-fixture');
  assert.equal(saved.interval, 5);
  assert.equal(saved.flowType, 'device_code');
  assert.equal(saved.accountId, 'acct-1');
});

test('oauth: a registration without public client flows raises the specific error', async (t) => {
  const storage = coreStorage(t);
  stubFetch(t, () => jsonResponse(400, JSON.parse(PUBLIC_CLIENT_FLOWS_OFF)));

  await assert.rejects(
    () => new OAuthManager(storage).startFlow('microsoft', 'device_code', MICROSOFT_CLIENT, 'acct-1'),
    (error) => error instanceof DeviceFlowUnsupportedError && /Failed to initiate Microsoft device flow/.test(error.message),
  );
});

test('oauth: a server-side failure is not reported as unsupported', async (t) => {
  const storage = coreStorage(t);
  stubFetch(t, () => jsonResponse(500, { error: 'server_error' }));

  await assert.rejects(
    () => new OAuthManager(storage).startFlow('microsoft', 'device_code', MICROSOFT_CLIENT, 'acct-1'),
    (error) => error instanceof AuthError && !(error instanceof DeviceFlowUnsupportedError),
  );
});

/* --------------------- polling a device flow -------------------------- */

test('oauth: a single poll reports pending, complete and expired distinctly', async (t) => {
  const storage = coreStorage(t);
  const manager = new OAuthManager(storage);

  const cases = [
    ['authorization_pending', null, 'pending'],
    ['slow_down', null, 'pending'],
    ['expired_token', 'The code expired', 'expired'],
    ['bad_verification_code', 'Unknown code', 'expired'],
    ['access_denied', 'The user declined', 'error'],
  ];

  for (const [error, description, expected] of cases) {
    stubFetch(t, () => jsonResponse(200, { error, error_description: description }));
    const result = await manager.pollDeviceCodeOnce('device-code-fixture', MICROSOFT_CLIENT);
    assert.equal(result.status, expected, `${error} should be reported as ${expected}`);
  }

  stubFetch(t, () =>
    jsonResponse(200, {
      access_token: 'access-fixture',
      refresh_token: 'refresh-fixture',
      expires_in: 3600,
      scope: 'mail.read',
      token_type: 'Bearer',
    }),
  );
  const complete = await manager.pollDeviceCodeOnce('device-code-fixture', MICROSOFT_CLIENT);
  assert.equal(complete.status, 'complete');
  assert.equal(complete.tokens.accessToken, 'access-fixture');
  assert.equal(complete.tokens.refreshToken, 'refresh-fixture');

  // A transport failure is retryable, so it must not look like a completed flow.
  stubFetch(t, () => {
    throw new Error('socket hang up');
  });
  const unreachable = await manager.pollDeviceCodeOnce('device-code-fixture', MICROSOFT_CLIENT);
  assert.equal(unreachable.status, 'error');
  assert.match(unreachable.message, /socket hang up/);
});

/* --------------------- the same rule over the HTTP API ---------------- */

function cookieOf(response) {
  const raw = response.headers['set-cookie'];
  return (Array.isArray(raw) ? raw[0] : raw).split(';')[0];
}

async function boot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-ecc-api-device-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const storage = new SQLiteStorage(join(dir, 'api.sqlite'), MASTER_KEY);
  const api = new ManagementApi({
    storage,
    port: 0,
    host: '127.0.0.1',
    publicDir: PUBLIC_DIR,
    publicUrl: 'https://ecc.example.test',
    sessionSecret: 'session-secret-fixture',
  });
  const app = api.app;
  const bootstrap = await app.inject({
    method: 'POST',
    url: '/api/auth/bootstrap',
    payload: { username: 'admin', password: 'admin-password-fixture' },
  });
  assert.equal(bootstrap.statusCode, 200, bootstrap.body);
  return { app, storage, cookie: cookieOf(bootstrap) };
}

function authed(cookie, options) {
  return { ...options, headers: { ...(options.headers || {}), cookie } };
}

const MICROSOFT_ACCOUNT = {
  name: 'Work mail',
  provider: 'microsoft',
  slug: 'work-mail',
  email: 'owner@example.test',
  // Created inline, which defaults to clientPlatform 'web' — the case the user cares
  // about: a browser client must still get the device flow when the app allows it.
  client: { label: 'Work app', clientId: 'client-id-fixture', clientSecret: 'client-secret-fixture' },
};

test('api: microsoft uses device code from the browser UI when the app allows it', async (t) => {
  const { app, cookie } = await boot(t);
  stubFetch(t, (url) => {
    assert.match(url, DEVICE_ENDPOINT);
    return jsonResponse(200, {
      device_code: 'device-code-fixture',
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://microsoft.com/devicelogin',
      expires_in: 900,
      interval: 5,
    });
  });

  const response = await app.inject(authed(cookie, { method: 'POST', url: '/api/accounts', payload: MICROSOFT_ACCOUNT }));
  assert.equal(response.statusCode, 201, response.body);
  const body = response.json();

  assert.equal(body.flowType, 'device_code', 'a web-platform client must still get the device flow');
  assert.equal(body.userCode, 'ABCD-EFGH');
  assert.ok(body.state, 'the flow state is returned so the browser can poll');
  assert.equal(body.authorizeUrl, 'https://microsoft.com/devicelogin');
});

test('api: microsoft falls back to the browser flow when public client flows are off', async (t) => {
  const { app, cookie } = await boot(t);
  stubFetch(t, (url) => {
    assert.match(url, DEVICE_ENDPOINT);
    return jsonResponse(400, JSON.parse(PUBLIC_CLIENT_FLOWS_OFF));
  });

  const response = await app.inject(authed(cookie, { method: 'POST', url: '/api/accounts', payload: MICROSOFT_ACCOUNT }));

  assert.equal(response.statusCode, 201, response.body);
  const body = response.json();
  assert.equal(body.flowType, 'authorization_code', 'the fallback is the browser flow');
  assert.match(body.authorizeUrl, /login\.microsoftonline\.com\/.*\/oauth2\/v2\.0\/authorize/);
  assert.equal(body.userCode, '');
});

test('api: a real failure is not silently converted into the browser flow', async (t) => {
  const { app, cookie } = await boot(t);
  stubFetch(t, (url) => {
    assert.match(url, DEVICE_ENDPOINT);
    return jsonResponse(500, { error: 'server_error' });
  });

  const response = await app.inject(authed(cookie, { method: 'POST', url: '/api/accounts', payload: MICROSOFT_ACCOUNT }));

  // A transient failure must surface. AuthError carries status 401, so any error status
  // is acceptable here — what matters is that it does not turn into a browser flow.
  assert.ok(response.statusCode >= 400, `expected a failure, got ${response.statusCode}: ${response.body}`);
  assert.ok(!response.body.includes('microsoftonline.com'), 'must not report a browser URL for a transient failure');
});

test('api: polling completes the device flow and stores the tokens', async (t) => {
  const { app, storage, cookie } = await boot(t);
  let tokenAnswer = null;
  stubFetch(t, (url) => {
    if (DEVICE_ENDPOINT.test(url)) {
      return jsonResponse(200, {
        device_code: 'device-code-fixture',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://microsoft.com/devicelogin',
        expires_in: 900,
        interval: 5,
      });
    }
    assert.match(url, TOKEN_ENDPOINT);
    return tokenAnswer;
  });

  const created = await app.inject(authed(cookie, { method: 'POST', url: '/api/accounts', payload: MICROSOFT_ACCOUNT }));
  assert.equal(created.statusCode, 201, created.body);
  const { account, state } = created.json();

  // Nothing approved yet.
  tokenAnswer = jsonResponse(200, { error: 'authorization_pending' });
  const pending = await app.inject(authed(cookie, { method: 'POST', url: '/api/oauth/device/poll', payload: { state } }));
  assert.equal(pending.statusCode, 200, pending.body);
  assert.equal(pending.json().status, 'pending');

  // The user approves in the other tab.
  tokenAnswer = jsonResponse(200, {
    access_token: 'access-fixture',
    refresh_token: 'refresh-fixture',
    expires_in: 3600,
    scope: 'mail.read',
    token_type: 'Bearer',
  });
  const done = await app.inject(authed(cookie, { method: 'POST', url: '/api/oauth/device/poll', payload: { state } }));
  assert.equal(done.statusCode, 200, done.body);
  assert.equal(done.json().status, 'complete');

  // Tokens landed on the pending account, exactly as the browser callback would.
  const stored = await storage.getAccount(account.id);
  assert.equal(stored.credentials.accessToken, 'access-fixture');
  assert.equal(stored.credentials.refreshToken, 'refresh-fixture');
  assert.equal(stored.credentials.clientId, 'client-id-fixture');
  assert.equal(stored.status, 'active');

  // The state is single-use: a repeat poll cannot re-run the exchange.
  const replay = await app.inject(authed(cookie, { method: 'POST', url: '/api/oauth/device/poll', payload: { state } }));
  assert.equal(replay.statusCode, 404, 'a consumed state must not be reused');
});

test('api: an expired code is reported and never completes', async (t) => {
  const { app, storage, cookie } = await boot(t);
  let tokenAnswer = jsonResponse(200, { error: 'authorization_pending' });
  stubFetch(t, (url) => {
    if (DEVICE_ENDPOINT.test(url)) {
      return jsonResponse(200, {
        device_code: 'device-code-fixture',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://microsoft.com/devicelogin',
        expires_in: 900,
        interval: 5,
      });
    }
    return tokenAnswer;
  });

  const created = await app.inject(authed(cookie, { method: 'POST', url: '/api/accounts', payload: MICROSOFT_ACCOUNT }));
  const { account, state } = created.json();

  tokenAnswer = jsonResponse(200, { error: 'expired_token', error_description: 'The code expired' });
  const expired = await app.inject(authed(cookie, { method: 'POST', url: '/api/oauth/device/poll', payload: { state } }));

  assert.equal(expired.statusCode, 200, expired.body);
  assert.equal(expired.json().status, 'expired');
  assert.equal((await storage.getAccount(account.id)).credentials.accessToken, undefined, 'no tokens may be stored');
});

test('api: another user cannot poll someone else\u2019s device flow', async (t) => {
  const { app, cookie } = await boot(t);
  stubFetch(t, (url) => {
    if (DEVICE_ENDPOINT.test(url)) {
      return jsonResponse(200, {
        device_code: 'device-code-fixture',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://microsoft.com/devicelogin',
        expires_in: 900,
        interval: 5,
      });
    }
    return jsonResponse(200, { error: 'authorization_pending' });
  });

  const created = await app.inject(authed(cookie, { method: 'POST', url: '/api/accounts', payload: MICROSOFT_ACCOUNT }));
  const { state } = created.json();

  const otherUser = await app.inject(
    authed(cookie, { method: 'POST', url: '/api/users', payload: { username: 'other', password: 'other-password-fixture', role: 'user' } }),
  );
  assert.equal(otherUser.statusCode, 201, otherUser.body);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'other', password: 'other-password-fixture' } });
  const otherCookie = cookieOf(login);

  const response = await app.inject(authed(otherCookie, { method: 'POST', url: '/api/oauth/device/poll', payload: { state } }));
  assert.equal(response.statusCode, 404, 'the pending account is not visible to another owner');
});
