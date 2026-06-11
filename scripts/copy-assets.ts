/**
 * Cross-platform post-build script: copies assets/ into dist/assets/.
 * Used by the "build" npm script on both Windows and Linux (CI).
 * Run with: bun scripts/copy-assets.ts
 */
import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const src = join(root, 'assets');
const dest = join(root, 'dist', 'assets');

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log('assets/ -> dist/assets/ copied.');
