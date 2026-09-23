const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

for (const [provider, file] of [
  ['Google', 'packages/providers/google/src/index.ts'],
  ['Microsoft', 'packages/providers/microsoft/src/index.ts'],
  ['Zoho', 'packages/providers/zoho/src/index.ts'],
]) {
  test(`${provider} collection methods use typed paginated results`, () => {
    const source = read(file);
    assert.doesNotMatch(source, /async listMessages\([^\n]+\): Promise<any>/);
    assert.doesNotMatch(source, /async listEvents\([^\n]+\): Promise<any>/);
    assert.doesNotMatch(source, /async listContacts\([^\n]+\): Promise<any>/);
  });
}

test('Microsoft encodes the complete Graph continuation URL in the cursor', () => {
  const source = read('packages/providers/microsoft/src/index.ts');
  assert.match(source, /graphNextCursor\(nextLink\?[^)]*\)/);
  assert.match(source, /graphCursor\(cursor\?[^)]*\)/);
  assert.match(source, /Buffer\.from\(nextLink/);
  assert.match(source, /Buffer\.from\(cursor/);
});

test('accounts.sync follows collection cursors until exhausted', () => {
  const source = read('packages/mcp-server/src/index.ts');
  assert.match(source, /do \{/);
  assert.match(source, /const next = page\.nextCursor/);
  assert.match(source, /while \(cursor\)/);
});
