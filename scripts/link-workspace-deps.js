#!/usr/bin/env node
// Manually link file: workspace dependencies in Docker builds
// This is needed because npm workspaces don't create symlinks properly in Docker builds

const fs = require('fs');
const path = require('path');

const pkgs = [
  'core',
  'storage/sqlite',
  'storage/d1',
  'mcp-server',
  'management-api',
  'cli',
  'provider/google',
  'provider/microsoft',
  'provider/zoho',
  'provider/imap-smtp',
  'provider/caldav',
  'provider/carddav',
  'admin-ui'
];

const basePath = '/app/packages';

for (const p of pkgs) {
  const pkgPath = path.join(basePath, p);
  const pkgJson = path.join(pkgPath, 'package.json');
  
  if (fs.existsSync(pkgJson)) {
    const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
    
    if (pkg.dependencies) {
      for (const [dep, ver] of Object.entries(pkg.dependencies)) {
        if (typeof ver === 'string' && ver.startsWith('file:')) {
          const target = path.join('/app/packages', ver.slice(5));
          const targetDist = path.join(target, 'dist');
          
          if (fs.existsSync(targetDist)) {
            const linkDir = path.join(pkgPath, 'node_modules');
            // Handle scoped packages like @mcp-ecc/core - preserve the full package name
            const linkPath = path.join(linkDir, dep);
            fs.mkdirSync(path.dirname(linkPath), { recursive: true });
            
            if (fs.existsSync(linkPath)) {
              fs.rmSync(linkPath, { recursive: true, force: true });
            }
            
            fs.symlinkSync(targetDist, linkPath, 'dir');
            console.log(`Linked ${dep} -> ${targetDist}`);
          } else {
            console.warn(`Target dist not found for ${dep}: ${targetDist}`);
          }
        }
      }
    }
  }
}

console.log('Workspace dependency linking complete');