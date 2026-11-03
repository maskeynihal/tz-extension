#!/usr/bin/env node
// Dev server for the website: the same pages and entries as
// scripts/build-site.mjs, served from site/ with live reload, and nothing
// written to docs/ (which is the committed deploy).
//   - demo.js / clock.js / clock.css: rebuilt by esbuild on every change to
//     site/ or src/, held in memory, unminified with inline source maps.
//   - HTML pages and site/assets/: read straight from site/ on each request.
//   - Extension-less paths resolve like Cloudflare's: /clock -> clock.html.
//   - Every page gets a tiny script that reloads it after a rebuild or when a
//     file in site/ changes.
// PORT overrides the default 5174 (the extension's Vite dev server has 5173).
import { context } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream, watch } from 'node:fs';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
import { siteDir, PAGES, siteBuildOptions } from './site-config.mjs';

const PORT = Number(process.env.PORT ?? 5174);
const RELOAD_PATH = '/__reload';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.json': 'application/json',
};

const RELOAD_SNIPPET = `<script>new EventSource(${JSON.stringify(RELOAD_PATH)}).addEventListener('reload', () => location.reload());</script>`;

/** Built entries, by served name ("clock.js"). */
const built = new Map();
/** Open live-reload connections. */
const clients = new Set();

function reloadAll() {
  for (const res of clients) res.write('event: reload\ndata: \n\n');
}

const ctx = await context({
  ...siteBuildOptions(resolve(siteDir, '..', '.site-dev'), { dev: true }),
  write: false,
  plugins: [
    {
      name: 'memory-and-reload',
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length > 0) return;
          built.clear();
          for (const file of result.outputFiles ?? []) built.set(basename(file.path), file.contents);
          reloadAll();
        });
      },
    },
  ],
});
await ctx.watch();

// esbuild watches what the entries import; pages and assets are not imported.
let pending;
watch(siteDir, { recursive: true }, (_event, file) => {
  if (!file || /\.(ts|tsx)$/.test(file)) return;
  clearTimeout(pending);
  pending = setTimeout(reloadAll, 50);
});

/** The site/ file a URL path names, or null when it would leave site/. */
function sitePath(pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  else if (!extname(rel) && PAGES.includes(`${basename(rel)}.html`)) rel += '.html';
  const full = normalize(join(siteDir, rel));
  return full === siteDir || full.startsWith(siteDir + sep) ? full : null;
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');

  if (pathname === RELOAD_PATH) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  const name = pathname.slice(1);
  if (built.has(name)) {
    res.writeHead(200, { 'content-type': TYPES[extname(name)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(built.get(name));
    return;
  }

  const file = sitePath(pathname);
  try {
    if (!file || !(await stat(file)).isFile()) throw new Error('not a file');
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Not found: ${pathname}`);
    return;
  }

  const type = TYPES[extname(file)] ?? 'application/octet-stream';
  if (extname(file) === '.html') {
    const html = await readFile(file, 'utf8');
    const withReload = html.includes('</body>') ? html.replace('</body>', `${RELOAD_SNIPPET}</body>`) : html + RELOAD_SNIPPET;
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(withReload);
    return;
  }
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
});

server.listen(PORT, () => {
  console.log(`[site] dev server on http://localhost:${PORT}/ (clock: /clock, converter: /app)`);
});

function shutdown() {
  server.close();
  for (const res of clients) res.end();
  void ctx.dispose().then(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
