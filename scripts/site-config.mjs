// What the website is made of, shared by the production build
// (scripts/build-site.mjs) and the dev server (scripts/dev-site.mjs), so the
// two can never disagree about which entries and pages exist.
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const siteDir = resolve(root, 'site');
export const PAGES = ['index.html', 'app.html', 'clock.html', 'guide.html', 'privacy.html', 'terms.html'];

/** esbuild options for the site's two script entries, written into `outdir`. */
export function siteBuildOptions(outdir, { dev = false } = {}) {
  return {
    entryPoints: {
      demo: resolve(siteDir, 'demo.ts'),
      clock: resolve(siteDir, 'clock.ts'),
    },
    bundle: true,
    format: 'iife',
    target: 'es2022',
    minify: !dev,
    sourcemap: dev ? 'inline' : false,
    jsx: 'automatic',
    loader: { '.css': 'css' },
    define: { 'process.env.NODE_ENV': dev ? '"development"' : '"production"' },
    outdir,
    logLevel: 'info',
    absWorkingDir: root,
  };
}

/**
 * Support buttons ("Buy me a coffee" / "Buy me chiya") are switched by env
 * vars, set in Cloudflare (Workers Builds -> Variables) and read at build time:
 *   SHOW_BUY_COFFEE  default on
 *   SHOW_BUY_TEA     default off
 * Values "1", "true", "on", "yes" turn one on; anything else turns it off.
 * Pages mark each button with <!--support:coffee-->...<!--/support:coffee-->
 * (or :tea), and the privacy note with <!--support-text:...--> markers.
 */
function flag(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|on|yes)$/i.test(value.trim());
}

export function supportFlags(env = process.env) {
  return {
    coffee: flag(env.SHOW_BUY_COFFEE, true),
    tea: flag(env.SHOW_BUY_TEA, false),
  };
}

/** Drops the marked blocks of disabled support buttons; keeps the rest. */
export function applySupportFlags(html, flags = supportFlags()) {
  const enabled = { ...flags, any: flags.coffee || flags.tea };
  const re = /[ \t]*<!--(support|support-text):(coffee|tea|any)-->\n?([\s\S]*?)[ \t]*<!--\/\1:\2-->\n?/g;
  // Blocks can nest (the "any" wrapper holds the per-service text), so repeat
  // until no marker is left.
  let out = html;
  for (let prev = ''; prev !== out; ) {
    prev = out;
    out = out.replace(re, (_m, _kind, key, body) => (enabled[key] ? body : ''));
  }
  return out;
}
