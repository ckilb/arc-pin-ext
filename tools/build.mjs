/**
 * Build the unpacked extension into dist/: TypeScript bundled with rolldown, plus the
 * static files in public/. The worker is an ES module; the content script and the
 * pages are self-contained scripts.
 */

import { cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'rolldown';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = `${root}dist`;

rmSync(dist, { recursive: true, force: true });
cpSync(`${root}public`, dist, { recursive: true });

const entries = [
  { input: 'src/background/index.ts', file: 'background.js', format: 'esm' },
  { input: 'src/content/content.ts', file: 'content.js', format: 'iife' },
  { input: 'src/popup/add.ts', file: 'popup/add.js', format: 'iife' },
  { input: 'src/options/options.ts', file: 'options/options.js', format: 'iife' },
];

for (const entry of entries) {
  await build({
    cwd: root,
    input: entry.input,
    logLevel: 'warn',
    output: { file: `${dist}/${entry.file}`, format: entry.format, minify: false },
  });
}

console.log(`built ${dist}`);
