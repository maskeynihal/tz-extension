#!/usr/bin/env node
/**
 * Create tz-extension-source.zip for AMO's source-code submission.
 *
 *   node scripts/source-archive.mjs [--ref HEAD] [--out tz-extension-source.zip]
 *
 * Uses `git archive`, so the zip holds tracked files at <ref> only: no
 * node_modules, no dist/, no uncommitted edits. Marketing media that the
 * extension build never reads (the built site in docs/, launch-video sources,
 * site screenshots/videos, store artwork) is left out to keep the upload small.
 * Everything `npm ci && npm run build:firefox` needs is included; the script
 * fails if any of it is missing.
 */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readZip, runMain, PublishError } from './lib/store-common.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Not needed to build the extension; pathspecs are relative to the repo root.
const EXCLUDE = ['docs', 'brag-output-*', 'site/assets', 'store'];
// Must be present for reviewers to reproduce the build.
const REQUIRED = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vite.config.ts',
  'src/manifest.ts',
  'scripts/firefox-manifest.mjs',
];

await runMain('source', async (log) => {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        ref: { type: 'string', default: 'HEAD' },
        out: { type: 'string', default: 'tz-extension-source.zip' },
      },
      strict: true,
    }));
  } catch (err) {
    throw new PublishError(`${err.message}\nusage: node scripts/source-archive.mjs [--ref <git-ref>] [--out <path>]`, {
      exitCode: 2,
    });
  }
  const out = resolve(process.cwd(), values.out);

  let sha;
  try {
    sha = execFileSync('git', ['rev-parse', '--verify', `${values.ref}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    throw new PublishError(`git ref not found: ${values.ref}`, { exitCode: 2 });
  }

  execFileSync(
    'git',
    ['archive', '--format=zip', `--output=${out}`, sha, '--', '.', ...EXCLUDE.map((p) => `:(exclude,glob)${p}/**`)],
    { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] },
  );

  const zip = readZip(out);
  const missing = REQUIRED.filter((f) => !zip.has(f));
  if (missing.length) throw new PublishError(`source archive is missing ${missing.join(', ')}`);
  if (zip.names.some((n) => n.startsWith('node_modules/') || n.startsWith('dist'))) {
    throw new PublishError('source archive unexpectedly contains node_modules/ or dist output');
  }
  log.info(`wrote ${out} from ${sha.slice(0, 12)} (${zip.names.length} entries, ${(statSync(out).size / 1024).toFixed(0)} KiB)`);
});
