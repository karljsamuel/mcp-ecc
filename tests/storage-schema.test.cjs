const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { SQLiteStorage } = require('@mcp-ecc/storage-sqlite');
const { D1Storage } = require('@mcp-ecc/storage-d1');
// The canonical blob writer, shared by both backends. Requires a prior build.
const { encrypt: encryptValue } = require('../packages/storage/sqlite/dist/crypto.js');

const GENERATION_COLUMN = { sqlite: 'encryptionKeyGeneration', d1: 'encryption_key_generation' };
const SECRET_COLUMN = {
  sqlite: { users: 'mcpApiKey', accounts: 'credentials', oauth_clients: 'clientSecret' },
  d1: { users: 'mcp_api_key', accounts: 'credentials_json', oauth_clients: 'client_secret' },
};
// Plaintext seeded under each encrypted column. Credentials must be valid JSON.
const SECRET_PLAINTEXT = {
  sqlite: {
    users: { mcpApiKey: 'fixture-mcp-api-key' },
    accounts: { credentials: JSON.stringify({ accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh-token' }) },
    oauth_clients: { clientSecret: 'fixture-client-secret' },
  },
  d1: {
    users: { mcp_api_key: 'fixture-mcp-api-key' },
    accounts: { credentials_json: JSON.stringify({ accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh-token' }) },
    oauth_clients: { client_secret: 'fixture-client-secret' },
  },
};

// Local D1-compatible SQL port, NOT live Cloudflare D1. Every successful query
// executes against a real isolated SQLite file. No .env or network is used.
globalThis.fetch = async () => { throw new Error('Network forbidden in schema tests'); };
class LocalD1 {
  constructor(db) { this.db = db; this.statements = []; this.fault = undefined; }
  prepare(sql) {
    const execute = async (params, read) => {
      this.statements.push(sql);
      const fault = this.fault?.(sql);
      if (fault === 'throw') throw new Error('Injected SQL failure');
      if (fault === 'result') return { success: false, results: [], meta: {} };
      const stmt = this.db.prepare(sql);
      const result = read ? stmt.all(...params) : stmt.run(...params);
      return { success: true, results: read ? result : [], meta: read ? {} : result };
    };
    const statement = (params = []) => ({
      bind: (...values) => statement(values),
      all: () => execute(params, true),
      run: () => execute(params, false),
      first: async (column) => {
        const result = await execute(params, true);
        return column ? result.results[0]?.[column] ?? null : result.results[0] ?? null;
      },
    });
    return statement();
  }
  async exec(sql) { this.db.exec(sql); }
  async batch(statements) { return Promise.all(statements.map(stmt => stmt.run())); }
}

function database(t, backend, legacy = false) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-ecc-schema-'));
  const path = join(dir, 'test.sqlite');
  const db = new DatabaseSync(path);
  const handles = [db];
  t.after(() => {
    for (const handle of handles.reverse()) handle.close();
    rmSync(dir, { recursive: true, force: true });
  });
  if (legacy) {
    let sql = readFileSync(join(__dirname, 'fixtures', `${backend}-legacy-schema.sql`), 'utf8');
    const missing = backend === 'sqlite' ? ['clientType', 'clientPlatform', 'apiKeyHash'] : ['client_type', 'client_platform', 'apiKeyHash', 'display_name', 'health', 'last_sync_at'];
    // Only remove account display_name, not users/contacts columns.
    sql = sql.replace(/CREATE TABLE IF NOT EXISTS (\w+) \([\s\S]*?\);/g, (table, name) => {
      if (!['accounts', 'oauth_clients', 'users'].includes(name)) return table;
      return table.split('\n').filter(line => !missing.some(column => line.trim().startsWith(`${column} `))).join('\n');
    });
    db.exec(sql);
  }
  const port = backend === 'd1' ? new LocalD1(db) : undefined;
  const open = (key = 'isolated-test-key', retiredKeys = {}, currentGeneration) => {
    const storage = backend === 'sqlite' ? new SQLiteStorage(path, key, retiredKeys, currentGeneration) : new D1Storage(port, key, retiredKeys, currentGeneration);
    if (backend === 'sqlite') handles.push(storage.db);
    return storage;
  };
  return { db, port, open, path };
}

// Seeds one row per table (parents first) with canonical-layout ciphertext for
// every secret column, encrypted for the owning user id the loop assigns.
function seedLegacyRows(db, backend) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name);
  tables.sort((a, b) => (a === 'users' ? 0 : a === 'accounts' ? 1 : 2) - (b === 'users' ? 0 : b === 'accounts' ? 1 : 2));
  const before = new Map();
  for (const table of tables) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    const values = cols.map(col => {
      const plaintext = SECRET_PLAINTEXT[backend][table]?.[col.name];
      if (plaintext !== undefined) return encryptValue(plaintext, 'isolated-test-key', 'users-id');
      if (col.name === 'scopes' || col.name === 'scopes_json') return '[]';
      return /owner_?id/i.test(col.name) ? 'users-id' : /account_?id/i.test(col.name) ? 'accounts-id' : col.name === 'id' ? `${table}-id` : col.type === 'INTEGER' ? 7 : `fixture-${col.name}`;
    });
    db.prepare(`INSERT INTO ${table} (${cols.map(col => col.name).join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...values);
    before.set(table, db.prepare(`SELECT * FROM ${table}`).all());
  }
  return before;
}


for (const operation of ['CREATE TABLE IF NOT EXISTS users', 'PRAGMA table_info(oauth_clients)', 'ALTER TABLE oauth_clients ADD COLUMN client_platform', 'INSERT INTO schema_migrations']) {
  for (const mode of ['throw', 'result']) {
    test(`d1: ${mode} failure at ${operation} is visible and retryable`, async t => {
      const { db, port, open } = database(t, 'd1', true);
      const storage = open();
      port.fault = sql => sql.startsWith(operation) ? mode : undefined;
      await assert.rejects(storage.initSchema(), /schema|failure/i);
      const applied = versions(db);
      assert.ok(!applied.includes(operation.startsWith('CREATE') || operation.startsWith('INSERT') ? 1 : 2));
      port.fault = undefined;
      await storage.initSchema();
      assert.deepEqual(versions(db), [1, 2, 3, 4, 5]);
      assert.ok(columns(db, 'oauth_clients').includes('client_platform'));
    });
  }
}


function metadata(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'schema_migrations' ORDER BY name").all().map(({ name }) => ({
    name,
    columns: db.prepare(`PRAGMA table_info(${name})`).all().map(({ cid, ...column }) => column).sort((a, b) => a.name.localeCompare(b.name)),
    foreignKeys: db.prepare(`PRAGMA foreign_key_list(${name})`).all(),
    indexes: db.prepare(`PRAGMA index_list(${name})`).all().map(({ seq, ...index }) => ({
      ...index, columns: db.prepare(`PRAGMA index_xinfo(${index.name})`).all().map(({ cid, ...column }) => column),
    })).sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

for (const backend of ['sqlite', 'd1']) {
  test(`${backend}: fresh schema preserves every legacy column, constraint and index`, async t => {
    const { db, open } = database(t, backend);
    const storage = open();
    if (backend === 'sqlite') assert.deepEqual(versions(db), [1, 2, 3, 4, 5], 'constructor initializes synchronously');
    await storage.initSchema();
    const expected = new DatabaseSync(':memory:');
    try {
      expected.exec(readFileSync(join(__dirname, 'fixtures', `${backend}-legacy-schema.sql`), 'utf8'));
      expected.exec(`ALTER TABLE oauth_clients ADD COLUMN ${backend === 'sqlite' ? 'clientPlatform' : 'client_platform'} TEXT`);
      expected.exec(`ALTER TABLE users ADD COLUMN apiKeyHash TEXT`);
      expected.exec(`CREATE INDEX IF NOT EXISTS idx_users_api_key_hash ON users(apiKeyHash)`);
      for (const table of ['accounts', 'oauth_clients', 'users']) {
        expected.exec(`ALTER TABLE ${table} ADD COLUMN ${GENERATION_COLUMN[backend]} INTEGER NOT NULL DEFAULT 1`);
      }
      // v5 adds the account display name to SQLite only. D1 has had the column since
      // v2, which is exactly the asymmetry that made PATCH silently drop it here.
      if (backend === 'sqlite') expected.exec(`ALTER TABLE accounts ADD COLUMN displayName TEXT`);
      assert.deepEqual(metadata(db), metadata(expected));
    } finally { expected.close(); }

    const client = { id: 'roundtrip', ownerId: 'owner', provider: 'google', label: 'test', clientId: 'local', clientSecret: 'local-fixture', scopes: [], clientType: 'public', clientPlatform: 'desktop', enabled: true, createdAt: 1, updatedAt: 2 };
    const account = { id: 'account-roundtrip', ownerId: 'owner', provider: 'google', name: 'Round trip', slug: 'round-trip', email: 'owner@example.com', credentials: { accessToken: 'token-a', refreshToken: 'refresh-a' }, status: 'active', health: 'unknown', createdAt: 1, updatedAt: 2 };
    await storage.saveUser({ id: 'owner', username: 'owner', displayName: 'Owner', passwordHash: 'fixture', role: 'user', mcpApiKey: 'fixture-api-key', createdAt: 1, updatedAt: 2 });
    await storage.saveOAuthClient(client);
    await storage.saveAccount(account);

    const saved = await storage.getOAuthClient(client.id);
    assert.equal(saved.clientType, client.clientType);
    assert.equal(saved.clientPlatform, client.clientPlatform);
    assert.equal(saved.clientSecret, client.clientSecret, 'client secret round-trips through the owner-derived key');

    const savedAccount = await storage.getAccount(account.id);
    assert.deepEqual(savedAccount.credentials, account.credentials, 'credentials round-trip through the owner-derived key');
    assert.equal((await storage.getUser('owner')).mcpApiKey, 'fixture-api-key', 'api key round-trips');
    assert.equal((await storage.getUserByApiKey('fixture-api-key')).id, 'owner');
    assert.equal(await storage.getUserByApiKey('not-the-key'), null);
    assert.equal(storage.encryptionKeyGeneration, 1, 'a single configured key is generation 1');
  });

  test(`${backend}: an account display name round-trips, updates and survives a reopen`, async t => {
    const { db, open } = database(t, backend);
    const storage = open();
    // SQLite initializes in its constructor; D1 only does so on an explicit call.
    await storage.initSchema();
    await storage.saveUser({ id: 'owner', username: 'owner', displayName: 'Owner', passwordHash: 'fixture', role: 'admin', mcpApiKey: 'fixture-api-key', createdAt: 1, updatedAt: 1 });

    // v5 adds the column under each backend's own naming convention.
    assert.ok(columns(db, 'accounts').includes(backend === 'sqlite' ? 'displayName' : 'display_name'));

    const account = {
      id: 'acct-display', ownerId: 'owner', provider: 'imap', name: 'Mail', slug: 'mail',
      email: 'owner@example.com', status: 'active', health: 'unknown', createdAt: 1, updatedAt: 1,
      credentials: { appPassword: 'app-password-fixture', config: { email: 'owner@example.com' } },
    };

    await storage.saveAccount({ ...account, displayName: undefined });
    assert.equal((await storage.getAccount(account.id)).displayName, undefined);

    // The update path PATCH /api/accounts/:id uses. Before v5 this was silently dropped
    // on SQLite, so outbound mail fell back to the internal account id.
    await storage.updateAccount(account.id, { displayName: 'Karl J Samuel' });
    assert.equal((await storage.getAccount(account.id)).displayName, 'Karl J Samuel');

    // Read through a fresh adapter over the same database: it has to be in the row.
    const reopened = await open().getAccount(account.id);
    assert.equal(reopened.displayName, 'Karl J Samuel');
    assert.equal(reopened.credentials.appPassword, 'app-password-fixture', 'the app password round-trips too');
    assert.equal(reopened.credentials.config.email, 'owner@example.com');

    // Clearing arrives from the API as an empty string (JSON has no undefined) and both
    // backends treat that as "no display name". An explicit `undefined` is not used to
    // clear: on D1 it means "not provided", which partial updates rely on.
    await storage.updateAccount(account.id, { displayName: '' });
    assert.equal((await open().getAccount(account.id)).displayName, undefined);
  });

  test(`${backend}: legacy rows in every table survive migration and repeated startup unchanged`, async t => {
    const { db, port, open } = database(t, backend, true);
    const before = seedLegacyRows(db, backend);
    const storage = open();
    await storage.initSchema();
    const ledger = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    const after = metadata(db);
    if (port) port.statements = [];
    await storage.initSchema();
    await open().initSchema();
    assert.deepEqual(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), ledger);
    assert.deepEqual(metadata(db), after);

    // Migration must never rewrite ciphertext: there is no legacy format to convert.
    for (const [table, rows] of before) {
      const names = Object.keys(rows[0]);
      const secret = SECRET_COLUMN[backend][table];
      if (secret) {
        const actual = db.prepare(`SELECT ${names.join(',')} FROM ${table}`).all()[0];
        assert.equal(actual[secret], rows[0][secret], `${table}.${secret} must be untouched by migration`);
        assert.equal(
          db.prepare(`SELECT ${GENERATION_COLUMN[backend]} AS g FROM ${table}`).get().g, 1,
          `${table} rows predate rotation and read as generation 1`,
        );
      } else {
        assert.deepEqual(db.prepare(`SELECT ${names.join(',')} FROM ${table}`).all(), rows, table);
      }
    }

    // ...and the adapter still reads every seeded secret.
    assert.equal((await storage.getUser('users-id')).mcpApiKey, SECRET_PLAINTEXT[backend].users[SECRET_COLUMN[backend].users]);
    assert.deepEqual((await storage.getAccount('accounts-id')).credentials, JSON.parse(SECRET_PLAINTEXT[backend].accounts[SECRET_COLUMN[backend].accounts]));
    assert.equal((await storage.getOAuthClient('oauth_clients-id')).clientSecret, SECRET_PLAINTEXT[backend].oauth_clients[SECRET_COLUMN[backend].oauth_clients]);

    if (backend === 'd1') {
      for (const column of ['display_name', 'health', 'last_sync_at']) assert.ok(columns(db, 'accounts').includes(column));
      assert.equal(db.prepare('SELECT health FROM accounts').get().health, null, 'legacy added health has no default');
    }
  });

  test(`${backend}: rotation re-encrypts every value and both generations stay readable`, async t => {
    const { open } = database(t, backend);
    const original = open('generation-one-key');
    await original.initSchema();
    const account = { id: 'acct-1', ownerId: 'owner-1', provider: 'google', name: 'A', slug: 'a', email: 'a@example.com', credentials: { accessToken: 'token-1', refreshToken: 'refresh-1' }, status: 'active', health: 'unknown', createdAt: 1, updatedAt: 1 };
    await original.saveUser({ id: 'owner-1', username: 'owner-1', displayName: 'Owner', passwordHash: 'hash', role: 'admin', mcpApiKey: 'api-key-1', createdAt: 1, updatedAt: 1 });
    await original.saveAccount(account);
    await original.saveOAuthClient({ id: 'client-1', ownerId: 'owner-1', provider: 'google', label: 'L', clientId: 'cid', clientSecret: 'client-secret-1', scopes: [], enabled: true, createdAt: 1, updatedAt: 1 });
    assert.equal(original.encryptionKeyGeneration, 1);

    // Changeover: the new key is current, the retired one is still configured.
    const changeover = open('generation-two-key', { 1: 'generation-one-key' }, 2);
    assert.equal(changeover.encryptionKeyGeneration, 2);
    assert.deepEqual(changeover.readableKeyGenerations, [1, 2]);
    assert.equal((await changeover.getAccount('acct-1')).credentials.refreshToken, 'refresh-1', 'generation-1 rows still decrypt');
    assert.equal((await changeover.getOAuthClient('client-1')).clientSecret, 'client-secret-1');
    assert.equal((await changeover.getUser('owner-1')).mcpApiKey, 'api-key-1');

    assert.equal(await changeover.rotateEncryptionKeys(), 3, 'accounts + oauth_clients + users were rewritten');
    await changeover.saveAccount({ ...account, id: 'acct-2', slug: 'b', credentials: { accessToken: 'token-2' } });

    // The retired key is no longer needed once every row is on generation 2.
    const after = open('generation-two-key', {}, 2);
    assert.deepEqual(after.readableKeyGenerations, [2]);
    assert.equal((await after.getAccount('acct-1')).credentials.refreshToken, 'refresh-1');
    assert.equal((await after.getAccount('acct-2')).credentials.accessToken, 'token-2');
    assert.equal((await after.getOAuthClient('client-1')).clientSecret, 'client-secret-1');
    assert.equal((await after.getUser('owner-1')).mcpApiKey, 'api-key-1');
    assert.equal((await after.getUserByApiKey('api-key-1')).id, 'owner-1');

    // ...and generation-2 blobs really are unreadable with the old key alone.
    const stale = open('generation-one-key');
    await assert.rejects(stale.getAccount('acct-1'), /could not be decrypted/);
  });

  test(`${backend}: rotation also re-encrypts rows whose generation is higher than the current one`, async t => {
    const { open } = database(t, backend);
    const account = { id: 'acct-hi', ownerId: 'owner-hi', provider: 'google', name: 'H', slug: 'h', email: 'h@example.com', credentials: { accessToken: 'token-hi', refreshToken: 'refresh-hi' }, status: 'active', health: 'unknown', createdAt: 1, updatedAt: 1 };

    // Author the row on generation 2.
    const generationTwo = open('key-two', {}, 2);
    await generationTwo.initSchema();
    await generationTwo.saveUser({ id: 'owner-hi', username: 'owner-hi', displayName: 'Hi', passwordHash: 'hash', role: 'admin', mcpApiKey: 'api-key-hi', createdAt: 1, updatedAt: 1 });
    await generationTwo.saveAccount(account);

    // The operator then runs with generation 1 as current (misconfigured generation
    // number, restored old .env, or a dropped-and-recreated keyring). Generation 2
    // is retired so the row is still readable.
    const backwards = open('key-one', { 2: 'key-two' }, 1);
    await backwards.initSchema();
    assert.equal(backwards.encryptionKeyGeneration, 1);
    assert.equal((await backwards.getAccount('acct-hi')).credentials.refreshToken, 'refresh-hi', 'generation-2 row readable while its key is retired');

    // A `<` predicate would silently skip this row; `<>` brings it onto generation 1.
    assert.ok(await backwards.rotateEncryptionKeys() >= 1, 'the higher-generation row must be rewritten');

    // Now drop the generation-2 key entirely: the row only survives if it really moved.
    const withoutRetired = open('key-one', {}, 1);
    await withoutRetired.initSchema();
    assert.equal((await withoutRetired.getAccount('acct-hi')).credentials.refreshToken, 'refresh-hi', 'row is now encrypted under generation 1');
  });

  test(`${backend}: a corrupt blob errors naming the record instead of blanking it`, async t => {
    const { db, open } = database(t, backend);
    const storage = open();
    await storage.initSchema();
    const account = { id: 'acct-1', ownerId: 'owner-1', provider: 'google', name: 'A', slug: 'a', email: 'a@example.com', credentials: { accessToken: 'token-1', refreshToken: 'refresh-1' }, status: 'active', health: 'unknown', createdAt: 1, updatedAt: 1 };
    await storage.saveUser({ id: 'owner-1', username: 'owner-1', displayName: 'Owner', passwordHash: 'hash', role: 'admin', mcpApiKey: 'api-key-1', createdAt: 1, updatedAt: 1 });
    await storage.saveAccount(account);

    const column = SECRET_COLUMN[backend].accounts;
    const stored = db.prepare(`SELECT ${column} AS c FROM accounts WHERE id = ?`).get('acct-1').c;
    const tampered = Buffer.from(stored, 'base64');
    tampered[tampered.length - 1] ^= 0x01;
    db.prepare(`UPDATE accounts SET ${column} = ? WHERE id = ?`).run(tampered.toString('base64'), 'acct-1');
    const corrupt = db.prepare(`SELECT ${column} AS c FROM accounts WHERE id = ?`).get('acct-1').c;

    await assert.rejects(storage.getAccount('acct-1'), error => {
      assert.equal(error.name, 'EncryptionError');
      assert.match(error.message, /accounts\.credentials for account 'acct-1'/);
      assert.match(error.message, /could not be decrypted/);
      return true;
    });
    // The write path reads first, so the failed read must not become a blank overwrite.
    await assert.rejects(storage.updateCredentials('acct-1', { accessToken: 'should-not-persist' }), /could not be decrypted/);
    assert.equal(
      db.prepare(`SELECT ${column} AS c FROM accounts WHERE id = ?`).get('acct-1').c, corrupt,
      'the row was not overwritten with an empty value',
    );

    // A row encrypted for a different owner is rejected too.
    const wrongOwner = encryptValue(JSON.stringify({ accessToken: 'stolen' }), 'isolated-test-key', 'some-other-owner');
    db.prepare(`UPDATE accounts SET ${column} = ? WHERE id = ?`).run(wrongOwner, 'acct-1');
    await assert.rejects(storage.getAccount('acct-1'), /could not be decrypted/);
  });
}

for (const backend of ['sqlite', 'd1']) {
  test(`${backend}: a missing or placeholder master key is a hard construction error`, t => {
    const { open, path, port } = database(t, backend);
    // Direct constructors: the `open` helper defaults its key argument, which
    // would mask a missing key.
    const build = key => backend === 'sqlite' ? new SQLiteStorage(path, key) : new D1Storage(port, key);
    const saved = process.env.MCP_ENCRYPTION_KEY;
    delete process.env.MCP_ENCRYPTION_KEY;
    try {
      assert.throws(() => build(undefined), /missing or is a placeholder/);
      assert.throws(() => build('default-secret-key'), /placeholder/);
      // The value .env.example historically told people to paste in must not be
      // usable as a real key, and neither may the variants around it.
      assert.throws(() => build('change-me-to-a-long-random-secret'), /placeholder/);
      assert.throws(() => build('change-me'), /placeholder/);
      assert.throws(() => build('CHANGE-ME-TO-A-LONG-RANDOM-SECRET'), /placeholder/);
      assert.throws(() => build('   '), /missing or is a placeholder/);
    } finally {
      if (saved === undefined) delete process.env.MCP_ENCRYPTION_KEY; else process.env.MCP_ENCRYPTION_KEY = saved;
    }
    assert.equal(open('a-real-key').encryptionKeyGeneration, 1);
  });
}

for (const backend of ['sqlite', 'd1']) {
  test(`${backend}: the master key is never written to or read from the settings table`, async t => {
    const { db, open } = database(t, backend);
    const storage = open('isolated-test-key');
    await storage.initSchema();
    await storage.saveSettings({ encryptionKey: 'leaked-master-key', uiPreferences: { theme: 'dark' }, updatedAt: 1 });

    const settings = await storage.getSettings();
    assert.equal(settings.encryptionKey, undefined, 'the key is not read back from storage');
    assert.deepEqual(settings.uiPreferences, { theme: 'dark' });
    assert.equal(
      JSON.stringify(db.prepare('SELECT * FROM settings').all()).includes('leaked-master-key'), false,
      'the key is not on disk either',
    );
  });
}

test('sqlite: ledger write failure rolls back the entire version; constructor throws and retry succeeds', async t => {
  const { db, open } = database(t, 'sqlite', true);
  db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);
    CREATE TRIGGER block_migration BEFORE INSERT ON schema_migrations WHEN NEW.version = 2
    BEGIN SELECT RAISE(ABORT, 'injected ledger failure'); END;`);
  assert.throws(open, error => /migration 2/.test(error.message) && /injected ledger failure/.test(error.cause.message));
  assert.deepEqual(versions(db), [1]);
  assert.ok(!columns(db, 'oauth_clients').includes('clientType'), 'ALTER rolled back');
  assert.ok(!columns(db, 'oauth_clients').includes('clientPlatform'), 'ALTER rolled back');
  db.exec('DROP TRIGGER block_migration');
  open();
  assert.deepEqual(versions(db), [1, 2, 3, 4, 5]);
});

test('sqlite: a real ALTER failure is visible and leaves its version unapplied', async t => {
  const { db, open } = database(t, 'sqlite');
  db.exec('CREATE VIEW oauth_clients AS SELECT 1 AS id');
  assert.throws(open, error => /migration 2/.test(error.message) && /view/.test(error.cause.message));
  assert.deepEqual(versions(db), [1]);
});


test('d1: concurrent initSchema calls on one adapter share initialization', async t => {
  const { db, open } = database(t, 'd1', true);
  const storage = open();
  await Promise.all([storage.initSchema(), storage.initSchema(), storage.initSchema()]);
  assert.deepEqual(versions(db), [1, 2, 3, 4, 5]);
});

function columns(db, table) { return db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name); }
function versions(db) { return db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row => row.version); }

for (const backend of ['sqlite', 'd1']) {
  test(`${backend}: initSchema migrates old OAuth columns and records successful versions`, async t => {
    const { db, open } = database(t, backend, true);
    const storage = open();
    assert.equal(typeof storage.initSchema, 'function', 'both adapters expose initSchema');
    await storage.initSchema();
    const names = columns(db, 'oauth_clients');
    for (const column of backend === 'sqlite' ? ['clientType', 'clientPlatform'] : ['client_type', 'client_platform']) {
      assert.ok(names.includes(column), `missing ${column}`);
    }
    assert.ok(columns(db, 'accounts').includes(GENERATION_COLUMN[backend]), 'v4 records the key generation');
    assert.deepEqual(versions(db), [1, 2, 3, 4, 5]);
  });
}
