const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'packages/mcp-server/src/index.ts'), 'utf8');
const types = fs.readFileSync(path.join(root, 'packages/core/src/types.ts'), 'utf8');

test('pagination contract exposes continuation cursors for all collection tools', () => {
  assert.match(types, /export interface PaginatedResult/);
  assert.match(server, /nextCursor/);
  assert.match(server, /cursor: \{ type: 'string' \}/);
});

test('collection tools forward caller cursors to providers', () => {
  assert.match(server, /cursor: args_\.cursor/);
  assert.match(server, /providers\.contacts\.listContacts\(\{ limit: args_\.limit, cursor: args_\.cursor \}\)/);
  assert.match(server, /providers\.mail\.listMessages\(args_\.folderId, \{ limit: args_\.limit, cursor: args_\.cursor/);
  assert.match(server, /providers\.calendar\.listEvents\(args_\.calendarId, \{ timeMin: args_\.timeMin, timeMax: args_\.timeMax, limit: args_\.limit, cursor: args_\.cursor/);
});
