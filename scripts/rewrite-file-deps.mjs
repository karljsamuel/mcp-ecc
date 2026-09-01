#!/usr/bin/env node
/**
 * Rewrites `file:` workspace dependencies to npm version ranges before publish,
 * so a published package resolves its internal deps from the npm registry.
 *
 * Usage:
 *   node scripts/rewrite-file-deps.js <scan-version>
 *
 * It scans every package.json under packages/ and rewrites `file:../*` refs that
 * point at a workspace package into the given <scan-version> (default 0.3.0).
 * Also strips `publishConfig` only where it duplicates; leaves other fields alone.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

const ROOT = resolve(new URL('.', import.meta.url).pathname, '..');
const SCAN_VERSION = process.argv[2] || '0.3.0';
const packagesDir = join(ROOT, 'packages');

// Map packageName -> directory (to know the correct version per package)
const packageMap = {};
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      const pkgPath = join(p, 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        if (pkg.name) packageMap[pkg.name] = { dir: p, version: pkg.version || SCAN_VERSION };
        walk(p);
      } else {
        walk(p);
      }
    }
  }
}
walk(packagesDir);

let changed = [];
for (const name in packageMap) {
  const pkgPath = join(packageMap[name].dir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  let mod = false;
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    if (!pkg[section]) continue;
    for (const key of Object.keys(pkg[section])) {
      const val = pkg[section][key];
      if (typeof val === 'string' && val.startsWith('file:')) {
        const target = packageMap[key];
        if (target) {
          pkg[section][key] = `^${target.version || SCAN_VERSION}`;
          mod = true;
        }
      }
    }
  }
  if (mod) {
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    changed.push(name);
  }
}
console.log('Rewrote file: deps in:', changed.length ? changed.join(', ') : 'none');
process.exit(0);