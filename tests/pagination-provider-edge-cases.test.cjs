const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('Microsoft contact search forwards the continuation cursor', () => {
  const source = read('packages/providers/microsoft/src/index.ts');
  const search = source.slice(source.indexOf('async searchContacts'));
  assert.match(search, /graphCursor\(options\.cursor\)/);
});

test('Google People contact search forwards the continuation cursor', () => {
  const source = read('packages/providers/google/src/index.ts');
  const search = source.slice(source.indexOf('async searchContacts'));
  assert.match(search, /pageToken: options\.cursor/);
});

test('provider page sizes are bounded by provider limits', () => {
  const google = read('packages/providers/google/src/index.ts');
  const microsoft = read('packages/providers/microsoft/src/index.ts');
  const zoho = read('packages/providers/zoho/src/index.ts');
  assert.match(google, /Math\.min\(options\.limit \|\| 50, 500\)/);
  assert.match(google, /Math\.min\(options\.limit \|\| 100, 2500\)/);
  assert.match(google, /Math\.min\(options\.limit \|\| 100, 1000\)/);
  assert.match(microsoft, /Math\.min\(options\.limit \|\| 50, 1000\)/);
  assert.match(zoho, /Math\.min\(options\.limit, 200\)/);
});
