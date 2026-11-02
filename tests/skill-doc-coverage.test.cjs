/**
 * Keeps SKILL.md honest against the runtime.
 *
 * SKILL.md is the operating contract for an mcp-ecc server: whoever reads it should be able
 * to do anything the server supports. That only holds if the document tracks the code, and
 * nothing about prose makes that happen on its own — so this test derives the real surface
 * from the source and fails when the document falls behind.
 *
 * It checks the mechanical part only (which tools and commands exist). Whether the prose
 * describing them is *correct* is a review question, not a test question.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const skill = readFileSync(join(root, 'SKILL.md'), 'utf8');
const serverSource = readFileSync(join(root, 'packages/mcp-server/src/index.ts'), 'utf8');
const cliSource = readFileSync(join(root, 'packages/cli/src/bin.ts'), 'utf8');

/** Tool ids the server actually registers, e.g. `mail.listMessages`. */
function registeredTools() {
  const found = serverSource.match(/name: ['"`](?:accounts|mail|calendar|contacts)\.[a-zA-Z]+['"`]/g) || [];
  return [...new Set(found.map(m => m.replace(/name: ['"`]/, '').replace(/['"`]$/, '')))].sort();
}

/** Tool ids SKILL.md documents, in backticks. */
function documentedTools() {
  const found = skill.match(/`(?:accounts|mail|calendar|contacts)\.[a-zA-Z]+`/g) || [];
  return [...new Set(found.map(m => m.replace(/`/g, '')))].sort();
}

/** Top-level CLI commands, excluding subcommand verbs that are too generic to be evidence. */
function cliCommands() {
  const GENERIC = new Set(['add', 'edit', 'list', 'remove']);
  const found = cliSource.match(/\.command\('([^']+)'/g) || [];
  const names = [...new Set(found.map(m => m.replace(/\.command\('/, '').replace(/'$/, '')))];
  return names.filter(n => !GENERIC.has(n)).sort();
}

test('SKILL.md documents every MCP tool the server registers', () => {
  const registered = registeredTools();
  const documented = new Set(documentedTools());
  assert.ok(registered.length >= 20, `expected the server to register its tool set, found ${registered.length}`);

  const missing = registered.filter(t => !documented.has(t));
  assert.deepEqual(missing, [], `SKILL.md is missing ${missing.length} tool(s); add them to section 6 and docs/mcp-tools.md`);
});

test('SKILL.md documents no tool the server has removed', () => {
  const registered = new Set(registeredTools());
  const stale = documentedTools().filter(t => !registered.has(t));
  assert.deepEqual(stale, [], `SKILL.md documents tool(s) that no longer exist: ${stale.join(', ')}`);
});

test('SKILL.md tool count matches the registered count', () => {
  // Catches a removal that the "every tool documented" check cannot see on its own.
  assert.equal(documentedTools().length, registeredTools().length);
});

test('SKILL.md covers every CLI command', () => {
  const documented = skill;
  const missing = cliCommands().filter(cmd => !documented.includes(cmd));
  assert.deepEqual(missing, [], `SKILL.md does not mention CLI command(s): ${missing.join(', ')}`);
});

test('SKILL.md keeps valid skill frontmatter', () => {
  assert.match(skill, /^---\n/, 'SKILL.md must open with YAML frontmatter');
  const fm = skill.split('---')[1] || '';
  assert.match(fm, /^name:\s*mcp-ecc\s*$/m, 'frontmatter must declare name: mcp-ecc');
  assert.match(fm, /^description:\s*\S/m, 'frontmatter must declare a description');
  // The description is what other agents match on; keep the trigger at the front.
  const description = (fm.match(/^description:\s*(.+)$/m) || [])[1] || '';
  assert.ok(description.length > 40, 'description is too short to act as a trigger');
});

test('SKILL.md carries the maintenance rule that keeps it in sync', () => {
  assert.match(skill, /Keeping this file current/i, 'the maintenance section is what makes the invariant explicit');
  assert.match(skill, /tests\/skill-doc-coverage\.test\.cjs/, 'the rule must name the test that enforces it');
});
