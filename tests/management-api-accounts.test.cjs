/**
 * Account credential handling over the HTTP API.
 *
 * Covers the two properties that made web-created IMAP/SMTP accounts unusable:
 *   - the app password is accepted on create and update, is stored, and is never
 *     returned in any response; and
 *   - provider settings round-trip so the edit form is populated from stored values
 *     rather than from defaults (which would overwrite the real settings on save).
 *
 * The API is driven through Fastify's inject(), so no port is opened.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { SQLiteStorage } = require('@mcp-ecc/storage-sqlite');
const { ManagementApi } = require('@mcp-ecc/management-api');

const MASTER_KEY = 'isolated-test-key';
const PASSWORD = 'app-password-fixture';
const PUBLIC_DIR = resolve(__dirname, '../packages/admin-ui/dist');

function cookieOf(response) {
  const raw = response.headers['set-cookie'];
  return (Array.isArray(raw) ? raw[0] : raw).split(';')[0];
}

async function boot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-ecc-api-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const storage = new SQLiteStorage(join(dir, 'api.sqlite'), MASTER_KEY);
  const api = new ManagementApi({
    storage,
    port: 0,
    host: '127.0.0.1',
    publicDir: PUBLIC_DIR,
    publicUrl: 'http://localhost:3001',
    sessionSecret: 'session-secret-fixture',
  });
  // `app` is private in TypeScript only; Fastify's inject() avoids a real listener.
  const app = api.app;

  const bootstrap = await app.inject({
    method: 'POST',
    url: '/api/auth/bootstrap',
    payload: { username: 'admin', password: 'admin-password-fixture' },
  });
  assert.equal(bootstrap.statusCode, 200, `bootstrap failed: ${bootstrap.body}`);

  return { app, storage, cookie: cookieOf(bootstrap) };
}

function authed(cookie, options) {
  return { ...options, headers: { ...(options.headers || {}), cookie } };
}

const ACCOUNT = {
  name: 'Work mailbox',
  provider: 'imap',
  slug: 'work-mailbox',
  email: 'owner@example.com',
  displayName: 'Karl J Samuel',
  appPassword: PASSWORD,
  username: 'login-name',
  imapHost: 'imap.example.com',
  imapPort: 143,
  imapTls: false,
  smtpHost: 'smtp.example.com',
  smtpPort: 587,
  smtpSecure: false,
};

async function createAccount(app, cookie, overrides = {}) {
  const response = await app.inject(
    authed(cookie, { method: 'POST', url: '/api/accounts', payload: { ...ACCOUNT, ...overrides } }),
  );
  assert.equal(response.statusCode, 201, `create failed: ${response.body}`);
  return response.json().account.id;
}

test('accounts API: an app password is required for password providers', async (t) => {
  const { app, cookie } = await boot(t);

  const response = await app.inject(
    authed(cookie, { method: 'POST', url: '/api/accounts', payload: { ...ACCOUNT, appPassword: undefined } }),
  );

  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /appPassword is required/);
});

test('accounts API: settings and the secret are stored, and the secret is never returned', async (t) => {
  const { app, storage, cookie } = await boot(t);
  const id = await createAccount(app, cookie);

  // Stored: the secret plus the merged, validated settings.
  const stored = await storage.getAccount(id);
  assert.equal(stored.credentials.appPassword, PASSWORD);
  assert.equal(stored.credentials.config.email, 'owner@example.com');
  assert.equal(stored.credentials.config.username, 'login-name');
  assert.equal(stored.credentials.config.imapHost, 'imap.example.com');
  assert.equal(stored.credentials.config.imapPort, 143);
  assert.equal(stored.credentials.config.imapTls, false);
  assert.equal(stored.displayName, 'Karl J Samuel');

  // Never returned: neither the value nor the field name appears anywhere.
  for (const [method, url] of [['GET', '/api/accounts'], ['GET', `/api/accounts/${id}`]]) {
    const response = await app.inject(authed(cookie, { method, url }));
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(!response.body.includes(PASSWORD), `${url} must not leak the app password`);
    assert.ok(!response.body.includes('appPassword'), `${url} must not expose the secret field`);
  }

  // The non-secret settings are returned, so the edit form is populated from stored
  // values rather than defaults.
  const list = (await app.inject(authed(cookie, { method: 'GET', url: '/api/accounts' }))).json().accounts[0];
  assert.equal(list.mailConfig.imapHost, 'imap.example.com');
  assert.equal(list.mailConfig.imapPort, 143);
  assert.equal(list.mailConfig.smtpHost, 'smtp.example.com');
  assert.equal(list.mailConfig.username, 'login-name');
  assert.equal(list.authenticated, true);
});

test('accounts API: updating other fields keeps the stored password', async (t) => {
  const { app, storage, cookie } = await boot(t);
  const id = await createAccount(app, cookie);

  const response = await app.inject(
    authed(cookie, { method: 'PATCH', url: `/api/accounts/${id}`, payload: { name: 'Renamed' } }),
  );
  assert.equal(response.statusCode, 200, response.body);
  assert.equal((await storage.getAccount(id)).name, 'Renamed');
  assert.equal((await storage.getAccount(id)).credentials.appPassword, PASSWORD, 'password must survive an unrelated edit');
});

test('accounts API: a blank password means keep the stored one', async (t) => {
  const { app, storage, cookie } = await boot(t);
  const id = await createAccount(app, cookie);

  const response = await app.inject(
    authed(cookie, { method: 'PATCH', url: `/api/accounts/${id}`, payload: { appPassword: '', imapPort: 993 } }),
  );

  assert.equal(response.statusCode, 200, response.body);
  const stored = await storage.getAccount(id);
  assert.equal(stored.credentials.appPassword, PASSWORD, 'a blank field must not clear the secret');
  assert.equal(stored.credentials.config.imapPort, 993, 'settings still update');
  assert.equal(stored.credentials.config.imapHost, 'imap.example.com', 'unspecified settings are preserved');
});

test('accounts API: a supplied password replaces the stored one', async (t) => {
  const { app, storage, cookie } = await boot(t);
  const id = await createAccount(app, cookie);

  const response = await app.inject(
    authed(cookie, { method: 'PATCH', url: `/api/accounts/${id}`, payload: { appPassword: 'replacement-secret' } }),
  );

  assert.equal(response.statusCode, 200, response.body);
  assert.equal((await storage.getAccount(id)).credentials.appPassword, 'replacement-secret');
});

test('accounts API: an out-of-range port is rejected and changes nothing', async (t) => {
  const { app, storage, cookie } = await boot(t);
  const id = await createAccount(app, cookie);

  const response = await app.inject(
    authed(cookie, { method: 'PATCH', url: `/api/accounts/${id}`, payload: { imapPort: 70000 } }),
  );

  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /between 1 and 65535/);
  assert.equal((await storage.getAccount(id)).credentials.config.imapPort, 143, 'the stored port is untouched');
});

test('accounts API: mail settings are rejected for providers that do not use them', async (t) => {
  const { app, storage, cookie } = await boot(t);

  // An OAuth-provider account, created through the same route.
  const created = await app.inject(
    authed(cookie, { method: 'POST', url: '/api/accounts', payload: { name: 'Gmail', provider: 'google', slug: 'gmail', email: 'owner@example.com' } }),
  );
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().account.id;

  const response = await app.inject(
    authed(cookie, { method: 'PATCH', url: `/api/accounts/${id}`, payload: { imapHost: 'imap.example.com' } }),
  );

  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /only supported for/);
  assert.equal((await storage.getAccount(id)).credentials.config?.imapHost, undefined);
});

test('accounts API: another user cannot read or edit the account', async (t) => {
  const { app, storage, cookie } = await boot(t);
  const id = await createAccount(app, cookie);

  const created = await app.inject(
    authed(cookie, { method: 'POST', url: '/api/users', payload: { username: 'other', password: 'other-password-fixture', role: 'user' } }),
  );
  assert.equal(created.statusCode, 201, created.body);

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'other', password: 'other-password-fixture' },
  });
  assert.equal(login.statusCode, 200, login.body);
  const otherCookie = cookieOf(login);

  for (const [method, url, payload] of [
    ['GET', `/api/accounts/${id}`, undefined],
    ['PATCH', `/api/accounts/${id}`, { name: 'Hijacked' }],
    ['POST', `/api/accounts/${id}/test-connection`, {}],
  ]) {
    const response = await app.inject(authed(otherCookie, { method, url, payload }));
    assert.equal(response.statusCode, 404, `${method} ${url} must be invisible to another owner`);
  }

  assert.equal((await storage.getAccount(id)).name, 'Work mailbox', 'the account is unchanged');
  assert.equal((await storage.getAccount(id)).credentials.appPassword, PASSWORD);
});

test('accounts API: the CalDAV endpoint is returned so the edit form can show it', async (t) => {
  const { app, storage, cookie } = await boot(t);

  const created = await app.inject(
    authed(cookie, {
      method: 'POST',
      url: '/api/accounts',
      payload: {
        name: 'Team calendar',
        provider: 'caldav',
        slug: 'team-calendar',
        email: 'owner@example.test',
        appPassword: PASSWORD,
        config: { caldavUrl: 'https://dav.example.test/remote.php/dav/' },
      },
    }),
  );
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().account.id;

  // Without this the form renders an empty URL box and hides the account's real endpoint.
  const detail = await app.inject(authed(cookie, { method: 'GET', url: `/api/accounts/${id}` }));
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().account.mailConfig.caldavUrl, 'https://dav.example.test/remote.php/dav/');
  assert.ok(!detail.body.includes(PASSWORD), 'the app password is still never returned');

  const list = await app.inject(authed(cookie, { method: 'GET', url: '/api/accounts' }));
  assert.equal(list.json().accounts[0].mailConfig.caldavUrl, 'https://dav.example.test/remote.php/dav/');

  // And the value round-trips through an update.
  const patched = await app.inject(
    authed(cookie, {
      method: 'PATCH',
      url: `/api/accounts/${id}`,
      payload: { caldavUrl: 'https://dav2.example.test/dav/' },
    }),
  );
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal(
    (await storage.getAccount(id)).credentials.config.caldavUrl,
    'https://dav2.example.test/dav/',
  );
});
