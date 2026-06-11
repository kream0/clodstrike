/**
 * Dev server for Clodstrike — works on Bun 1.1.x and newer.
 *
 * Why this exists: `bun ./index.html` requires Bun ≥ 1.2. The local machine
 * runs Bun 1.1.29 (npm shim) where that command either fails or emits a 0.11 KB
 * stub bundle that shows a stale, textureless game. This script uses only
 * stable Bun.serve + Bun.build APIs available since 1.0.
 *
 * Routes:
 *   GET /                → index.html (script src rewritten to /main.js)
 *   GET /index.html      → same
 *   GET /main.js         → on-demand Bun.build of src/main.ts (rebuilt every request)
 *   GET /assets/*        → repo assets/ directory, path-traversal safe
 *   GET /styles.css      → repo root styles.css
 *   *                    → 404
 *
 * Every response carries Cache-Control: no-store.
 * Run with: bun scripts/dev.ts
 */

import { readFileSync } from 'node:fs';
import { join, resolve, normalize } from 'node:path';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const INDEX_HTML_PATH = join(ROOT, 'index.html');
const ASSETS_DIR = resolve(join(ROOT, 'assets'));
const STYLES_PATH = join(ROOT, 'styles.css');
const ENTRY_POINT = join(ROOT, 'src', 'main.ts');

// ---------------------------------------------------------------------------
// MIME helpers
// ---------------------------------------------------------------------------

function mimeForAsset(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.glb')) return 'model/gltf-binary';
  if (lower.endsWith('.gltf')) return 'model/gltf+json';
  if (lower.endsWith('.bin')) return 'application/octet-stream';
  return 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// Cache-Control header applied to every response
// ---------------------------------------------------------------------------

const NO_CACHE = { 'Cache-Control': 'no-store' };

function noCache(headers?: Record<string, string>): Record<string, string> {
  return { ...NO_CACHE, ...(headers ?? {}) };
}

// ---------------------------------------------------------------------------
// Route: /  and /index.html
// Rewrite the module script that points at ./src/main.ts → /main.js so the
// browser fetches our on-demand bundle instead of trying to load a raw TS file.
// ---------------------------------------------------------------------------

function serveIndex(): Response {
  let html: string;
  try {
    html = readFileSync(INDEX_HTML_PATH, 'utf8');
  } catch (err) {
    return new Response(`Cannot read index.html: ${String(err)}`, {
      status: 500,
      headers: noCache({ 'Content-Type': 'text/plain' }),
    });
  }

  // Rewrite: src="./src/main.ts"  →  src="/main.js"
  // Also handle without leading ./
  html = html.replace(
    /(<script[^>]*\btype=["']module["'][^>]*\bsrc=["'])\.?\/?src\/main\.ts(["'][^>]*>)/g,
    '$1/main.js$2',
  );

  return new Response(html, {
    status: 200,
    headers: noCache({ 'Content-Type': 'text/html; charset=utf-8' }),
  });
}

// ---------------------------------------------------------------------------
// Route: /main.js
// Bundle src/main.ts on every request so there are never stale builds.
// ---------------------------------------------------------------------------

async function serveBundle(): Promise<Response> {
  let result: Awaited<ReturnType<typeof Bun.build>>;
  try {
    result = await Bun.build({
      entrypoints: [ENTRY_POINT],
      target: 'browser',
      format: 'esm',
      sourcemap: 'inline',
      minify: false,
    });
  } catch (err) {
    const msg = `Bun.build threw: ${String(err)}`;
    console.error('[dev] Build error:', msg);
    return new Response(msg, {
      status: 500,
      headers: noCache({ 'Content-Type': 'text/plain' }),
    });
  }

  if (!result.success) {
    const logs = result.logs.map((l) => String(l)).join('\n');
    console.error('[dev] Build failed:\n', logs);
    return new Response(`Build failed:\n${logs}`, {
      status: 500,
      headers: noCache({ 'Content-Type': 'text/plain' }),
    });
  }

  const output = result.outputs[0];
  if (!output) {
    return new Response('Build produced no outputs', {
      status: 500,
      headers: noCache({ 'Content-Type': 'text/plain' }),
    });
  }

  const js = await output.text();
  return new Response(js, {
    status: 200,
    headers: noCache({ 'Content-Type': 'application/javascript; charset=utf-8' }),
  });
}

// ---------------------------------------------------------------------------
// Route: /assets/*
// Serve files from the repo assets/ directory with path-traversal protection.
// ---------------------------------------------------------------------------

async function serveAsset(assetPath: string): Promise<Response> {
  // Strip leading slash, join with assets dir, resolve symlinks/..
  const stripped = assetPath.replace(/^\/+/, '');
  const candidate = resolve(join(ASSETS_DIR, stripped));

  // Security: ensure resolved path is still inside ASSETS_DIR
  const normalizedAssets = normalize(ASSETS_DIR);
  const normalizedCandidate = normalize(candidate);
  if (!normalizedCandidate.startsWith(normalizedAssets + '\\') &&
      !normalizedCandidate.startsWith(normalizedAssets + '/') &&
      normalizedCandidate !== normalizedAssets) {
    return new Response('Forbidden', {
      status: 403,
      headers: noCache({ 'Content-Type': 'text/plain' }),
    });
  }

  let file: ReturnType<typeof Bun.file>;
  try {
    file = Bun.file(candidate);
  } catch (err) {
    return new Response(`Not found: ${assetPath}`, {
      status: 404,
      headers: noCache({ 'Content-Type': 'text/plain' }),
    });
  }

  const exists = await file.exists();
  if (!exists) {
    return new Response(`Not found: ${assetPath}`, {
      status: 404,
      headers: noCache({ 'Content-Type': 'text/plain' }),
    });
  }

  const mime = mimeForAsset(candidate);
  return new Response(file, {
    status: 200,
    headers: noCache({ 'Content-Type': mime }),
  });
}

// ---------------------------------------------------------------------------
// Route: /styles.css
// ---------------------------------------------------------------------------

function serveStyles(): Response {
  let css: string;
  try {
    css = readFileSync(STYLES_PATH, 'utf8');
  } catch (err) {
    return new Response(`Cannot read styles.css: ${String(err)}`, {
      status: 500,
      headers: noCache({ 'Content-Type': 'text/plain' }),
    });
  }
  return new Response(css, {
    status: 200,
    headers: noCache({ 'Content-Type': 'text/css; charset=utf-8' }),
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const PORT = 3000;

Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const pathname = url.pathname;

    if (pathname === '/' || pathname === '/index.html') {
      return serveIndex();
    }

    if (pathname === '/main.js') {
      return serveBundle();
    }

    if (pathname === '/styles.css') {
      return serveStyles();
    }

    if (pathname.startsWith('/assets/')) {
      return serveAsset(pathname.slice('/assets'.length));
    }

    return new Response(`Not found: ${pathname}`, {
      status: 404,
      headers: noCache({ 'Content-Type': 'text/plain' }),
    });
  },
});

console.log(`[dev] Clodstrike dev server running at http://localhost:${PORT}`);
console.log('[dev] Bundling src/main.ts on every /main.js request (no stale builds).');
console.log('[dev] Press Ctrl+C to stop.');
