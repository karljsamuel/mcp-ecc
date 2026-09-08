const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { SQLiteStorage } = require('@mcp-ecc/storage-sqlite');
const { D1Storage } = require('@mcp-ecc/storage-d1');

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
    const missing = backend === 'sqlite' ? ['clientType'] : ['client_type', 'display_name', 'health', 'last_sync_at'];
    // Only remove account display_name, not users/contacts columns.
    sql = sql.replace(/CREATE TABLE IF NOT EXISTS (\w+) \([\s\S]*?\);/g, (table, name) => {
      if (!['accounts', 'oauth_clients'].includes(name)) return table;
      return table.split('\n').filter(line => !missing.some(column => line.trim().startsWith(`${column} `))).join('\n');
    });
    db.exec(sql);
  }
  const port = backend === 'd1' ? new LocalD1(db) : undefined;
  const open = () => {
    const storage = backend === 'sqlite' ? new SQLiteStorage(path, 'isolated-test-key') : new D1Storage(port, 'isolated-test-key');
    if (backend === 'sqlite') handles.push(storage.db);
    return storage;
  };
  return { db, port, open, path };
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
      assert.deepEqual(versions(db), [1, 2]);
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
    if (backend === 'sqlite') assert.deepEqual(versions(db), [1, 2], 'constructor initializes synchronously');
    await storage.initSchema();
    const expected = new DatabaseSync(':memory:');
    try {
      expected.exec(readFileSync(join(__dirname, 'fixtures', `${backend}-legacy-schema.sql`), 'utf8'));
      expected.exec(`ALTER TABLE oauth_clients ADD COLUMN ${backend === 'sqlite' ? 'clientPlatform' : 'client_platform'} TEXT`);
      assert.deepEqual(metadata(db), metadata(expected));
    } finally { expected.close(); }
    const client = { id: 'roundtrip', ownerId: 'owner', provider: 'google', label: 'test', clientId: 'local', clientSecret: 'local-fixture', scopes: [], clientType: 'public', clientPlatform: 'desktop', enabled: true, createdAt: 1, updatedAt: 2 };
    await storage.saveUser({ id: 'owner', username: 'owner', displayName: 'Owner', passwordHash: 'fixture', role: 'user', mcpApiKey: 'fixture', createdAt: 1, updatedAt: 2 });
    await storage.saveOAuthClient(client);
    const saved = await storage.getOAuthClient(client.id);
    assert.equal(saved.clientType, client.clientType);
    assert.equal(saved.clientPlatform, client.clientPlatform);
    assert.equal(saved.clientSecret, client.clientSecret);
  });

  test(`${backend}: legacy rows in every table survive migration and repeated startup unchanged`, async t => {
    const { db, port, open } = database(t, backend, true);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name);
    // Seed parents before children to exercise existing D1 foreign keys too.
    tables.sort((a, b) => (a === 'users' ? 0 : a === 'accounts' ? 1 : 2) - (b === 'users' ? 0 : b === 'accounts' ? 1 : 2));
    const before = new Map();
    for (const table of tables) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all();
      const values = cols.map(col => /owner_?id/i.test(col.name) ? 'users-id' : /account_?id/i.test(col.name) ? 'accounts-id' : col.name === 'id' ? `${table}-id` : col.type === 'INTEGER' ? 7 : `fixture-${col.name}`);
      db.prepare(`INSERT INTO ${table} (${cols.map(col => col.name).join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...values);
      before.set(table, db.prepare(`SELECT * FROM ${table}`).all());
    }
    const storage = open();
    await storage.initSchema();
    const ledger = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    const after = metadata(db);
    if (port) port.statements = [];
    await storage.initSchema();
    await open().initSchema();
    assert.deepEqual(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), ledger);
    assert.deepEqual(metadata(db), after);
    if (port) assert.ok(!port.statements.some(sql => /^(ALTER|INSERT|CREATE INDEX)/.test(sql)), 'applied migrations are skipped');
    for (const [table, rows] of before) {
      const names = Object.keys(rows[0]);
      assert.deepEqual(db.prepare(`SELECT ${names.join(',')} FROM ${table}`).all(), rows, table);
    }
    if (backend === 'd1') {
      for (const column of ['display_name', 'health', 'last_sync_at']) assert.ok(columns(db, 'accounts').includes(column));
      assert.equal(db.prepare('SELECT health FROM accounts').get().health, null, 'legacy added health has no default');
    }
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
  assert.deepEqual(versions(db), [1, 2]);
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
  assert.deepEqual(versions(db), [1, 2]);
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
    assert.deepEqual(versions(db), [1, 2]);
  });
}
