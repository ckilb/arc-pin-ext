/**
 * Build and zip dist/ for the Chrome Web Store. Deliberately independent of the
 * end-to-end tests.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
execFileSync(process.execPath, [`${root}tools/build.mjs`], { stdio: 'inherit' });

const { version } = JSON.parse(readFileSync(`${root}dist/manifest.json`, 'utf8'));
mkdirSync(`${root}release`, { recursive: true });
const zip = `${root}release/tab-pin-${version}.zip`;
rmSync(zip, { force: true });
execFileSync('zip', ['-qr', zip, '.'], { cwd: `${root}dist`, stdio: 'inherit' });
console.log(`packaged ${zip}`);
