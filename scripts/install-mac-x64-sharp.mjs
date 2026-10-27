// Install the Intel (x64) sharp natives next to the arm64 ones npm installed
// on an Apple-Silison runner, so one electron-builder run can emit BOTH the
// Apple-Silicon and Intel DMGs. Versions are read from sharp's own
// optionalDependencies so they always match the installed sharp.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const sharpPkg = JSON.parse(readFileSync('node_modules/sharp/package.json', 'utf8'));
const opt = sharpPkg.optionalDependencies || {};
const specs = [
  ['@img/sharp-darwin-x64', opt['@img/sharp-darwin-x64']],
  ['@img/sharp-libvips-darwin-x64', opt['@img/sharp-libvips-darwin-x64']],
].filter(([, v]) => v);

if (!specs.length) {
  console.log('sharp not installed — nothing to add (wasm fallback will be used)');
  process.exit(0);
}

const args = specs.map(([n, v]) => `${n}@${v}`).join(' ');
console.log('installing', args);
// --force: npm refuses foreign-arch binaries (EBADPLATFORM) without it;
// existing arm64 natives are left untouched
execSync(`npm install --no-save --no-audit --no-fund --force ${args}`, { stdio: 'inherit' });
