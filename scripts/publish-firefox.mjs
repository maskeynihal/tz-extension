#!/usr/bin/env node
/**
 * Submit a new listed version to addons.mozilla.org (AMO) with web-ext sign
 * (AMO add-on API v5). Does not wait for human review.
 *
 *   node scripts/publish-firefox.mjs [--zip tz-extension-firefox.zip]
 *                                    [--source tz-extension-source.zip]
 *                                    [--dry-run] [--expect-version X.Y.Z]
 *
 * Env: AMO_JWT_ISSUER, AMO_JWT_SECRET  (https://addons.mozilla.org/developers/addon/api/key/)
 *
 * The release zip is unpacked into a temp dir that becomes web-ext's
 * --source-dir, so AMO receives exactly the files of the GitHub release
 * (no source maps or dotfiles). The source archive is attached for review
 * and approval notes with the build steps are sent as version metadata.
 * If AMO reports that the version already exists, exits 0 with a notice so
 * re-runs are safe.
 *
 * Exit codes: 0 success / nothing to do, 1 AMO or web-ext failure,
 * 2 usage or configuration error.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  PublishError,
  extractZip,
  packageVersion,
  readManifestFromZip,
  readZip,
  redact,
  registerSecret,
  runMain,
} from './lib/store-common.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Exact pin: web-ext 10.8.0 requires Node >= 20 (matches package.json engines).
export const WEB_EXT = 'web-ext@10.8.0';
const GECKO_ID = 'tz-converter@maskeynihal';
const AMO_EDIT_URL = 'https://addons.mozilla.org/developers/addon/tz-converter-timezone-tools/versions';

function approvalNotes(version, commit) {
  return `Source code for v${version} is attached (tz-extension-source.zip, a git archive of commit ${commit} from https://github.com/maskeynihal/tz-extension).

BUILD INSTRUCTIONS
Requirements: Node.js 20 or newer (package.json engines: node >=20) and npm. Any OS; no other tools needed.
1. Unzip tz-extension-source.zip and cd into it.
2. npm ci && npm run build:firefox
3. The add-on is written to dist-firefox/ (manifest.json at its root).

build:firefox runs tsc --noEmit, a Vite production build with TARGET=firefox, then scripts/firefox-manifest.mjs, which rewrites the manifest into Firefox MV3 shape (background.scripts, gecko id, strict_min_version, data_collection_permissions none, strips use_dynamic_url). npm run zip:firefox additionally zips dist-firefox/ without source maps or dotfiles; that zip is the exact file submitted.

Expected differences: the build embeds the git commit and build time as display strings. To reproduce the commit string outside a git checkout, run: BUILD_COMMIT=${commit} npm run build:firefox. The build time string will always differ.

Tools: Vite 5.4.11, @crxjs/vite-plugin 2, esbuild 0.21.5 (minifier), TypeScript 5.6.3, @vitejs/plugin-react 4.3.3. No build step fetches remote code; all dependencies are pinned in package-lock.json.

NOTES
No account or login is needed. Select any date/time text on a page, or open the toolbar popup, to convert. Only permission: storage. No network requests. The "innerHTML" validation warnings come from the bundled react-dom library; our source has no innerHTML, outerHTML, insertAdjacentHTML, dangerouslySetInnerHTML or document.write.`;
}

function usage(msg) {
  return new PublishError(
    `${msg}\nusage: node scripts/publish-firefox.mjs [--zip <path>] [--source <path>] [--dry-run] [--expect-version X.Y.Z]`,
    { exitCode: 2 },
  );
}

function parseCli() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        zip: { type: 'string', default: 'tz-extension-firefox.zip' },
        source: { type: 'string', default: 'tz-extension-source.zip' },
        'dry-run': { type: 'boolean', default: false },
        'expect-version': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    }));
  } catch (err) {
    throw usage(err.message);
  }
  if (values.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
    process.exit(0);
  }
  return {
    zip: resolve(process.cwd(), values.zip),
    source: resolve(process.cwd(), values.source),
    dryRun: values['dry-run'],
    expectVersion: values['expect-version'],
  };
}

function readEnv(log) {
  const issuer = process.env.AMO_JWT_ISSUER ?? '';
  const secret = process.env.AMO_JWT_SECRET ?? '';
  registerSecret(secret);
  const missing = [
    ['AMO_JWT_ISSUER', issuer],
    ['AMO_JWT_SECRET', secret],
  ]
    .filter(([, v]) => !v.trim())
    .map(([k]) => k);
  if (missing.length) throw new PublishError(`missing required env: ${missing.join(', ')}`, { exitCode: 2 });
  if (!/^user:\d+:\d+$/.test(issuer)) {
    log.warn('AMO_JWT_ISSUER usually looks like "user:12345:67" (the "JWT issuer" on the AMO API key page); check it if signing fails');
  }
  return { issuer, secret };
}

function inspectZip(zipPath, expectVersion, log) {
  if (!existsSync(zipPath)) throw new PublishError(`zip not found: ${zipPath} (run npm run zip:firefox)`, { exitCode: 2 });
  const m = readManifestFromZip(zipPath);
  const gecko = m.browser_specific_settings?.gecko;
  if (m.manifest_version !== 3) throw new PublishError(`manifest_version is ${m.manifest_version}, expected 3`, { exitCode: 2 });
  if (gecko?.id !== GECKO_ID) {
    throw new PublishError(`gecko id is "${gecko?.id}", expected "${GECKO_ID}" (is this the Chrome zip?)`, { exitCode: 2 });
  }
  if (!Array.isArray(m.background?.scripts)) {
    throw new PublishError('manifest has no background.scripts; run scripts/firefox-manifest.mjs (npm run zip:firefox)', {
      exitCode: 2,
    });
  }
  if (expectVersion && m.version !== expectVersion) {
    throw new PublishError(`zip version ${m.version} does not match --expect-version ${expectVersion}`, { exitCode: 2 });
  }
  const pkgVersion = packageVersion(root);
  if (!expectVersion && pkgVersion !== m.version) {
    log.warn(`zip version ${m.version} differs from package.json ${pkgVersion}; is the zip stale?`);
  }
  log.info(`zip ${zipPath} (${(statSync(zipPath).size / 1024).toFixed(1)} KiB), "${m.name}" v${m.version}, id ${gecko.id}`);
  return m.version;
}

function inspectSource(sourcePath, log) {
  if (!existsSync(sourcePath)) {
    throw new PublishError(`source archive not found: ${sourcePath} (run npm run zip:source)`, { exitCode: 2 });
  }
  const zip = readZip(sourcePath);
  for (const f of ['package.json', 'package-lock.json', 'scripts/firefox-manifest.mjs']) {
    if (!zip.has(f)) throw new PublishError(`source archive is missing ${f}`, { exitCode: 2 });
  }
  if (zip.names.some((n) => n.startsWith('node_modules/'))) {
    throw new PublishError('source archive contains node_modules/', { exitCode: 2 });
  }
  log.info(`source ${sourcePath} (${(statSync(sourcePath).size / 1024).toFixed(0)} KiB, ${zip.names.length} entries)`);
}

/** Run a command, streaming redacted output while also capturing it. */
function run(cmd, args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const onData = (stream) => (chunk) => {
      const text = redact(chunk.toString());
      output += text;
      stream.write(text);
    };
    child.stdout.on('data', onData(process.stdout));
    child.stderr.on('data', onData(process.stderr));
    child.on('error', (err) => reject(new PublishError(`could not start ${cmd}: ${err.message}`)));
    child.on('close', (code) => resolvePromise({ code: code ?? 1, output }));
  });
}

function commitOf(sourcePath) {
  // git archive stores the commit id in the zip comment; fall back to env/unknown.
  const buf = readFileSync(sourcePath);
  const m = /([0-9a-f]{40})/.exec(buf.subarray(Math.max(0, buf.length - 200)).toString('latin1'));
  return m?.[1] ?? process.env.GITHUB_SHA ?? 'unknown';
}

await runMain('firefox', async (log) => {
  const args = parseCli();
  const version = inspectZip(args.zip, args.expectVersion, log);
  inspectSource(args.source, log);
  const env = readEnv(log);
  const commit = commitOf(args.source);
  const metadata = { version: { approval_notes: approvalNotes(version, commit) } };

  if (args.dryRun) {
    log.info(`approval notes (${metadata.version.approval_notes.length} chars) for commit ${commit.slice(0, 12)}`);
    log.info(`dry run OK: env present, zips valid, would run npx ${WEB_EXT} sign --channel=listed for v${version}. No network calls made.`);
    return;
  }

  const work = mkdtempSync(join(tmpdir(), 'tz-amo-'));
  try {
    const sourceDir = join(work, 'ext');
    const files = extractZip(args.zip, sourceDir);
    const metadataPath = join(work, 'amo-metadata.json');
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
    log.info(`unpacked ${files} entries to a temp source dir; submitting v${version} to AMO (listed channel)...`);

    // Credentials go through web-ext's WEB_EXT_API_KEY / WEB_EXT_API_SECRET env
    // vars, which are equivalent to --api-key / --api-secret but keep the
    // secret out of the process argument list.
    const childEnv = {
      ...process.env,
      WEB_EXT_API_KEY: env.issuer,
      WEB_EXT_API_SECRET: env.secret,
      npm_config_update_notifier: 'false',
    };
    const { code, output } = await run(
      'npx',
      [
        '--yes',
        WEB_EXT,
        'sign',
        '--channel=listed',
        `--source-dir=${sourceDir}`,
        `--artifacts-dir=${resolve(root, 'web-ext-artifacts')}`,
        `--amo-metadata=${metadataPath}`,
        `--upload-source-code=${args.source}`,
        '--approval-timeout=0',
        '--no-input',
        '--no-config-discovery',
      ],
      childEnv,
    );

    if (code === 0) {
      log.notice(`v${version} submitted to AMO; it is now awaiting review. Track it at ${AMO_EDIT_URL}`);
      return;
    }
    // AMO answers a duplicate upload with "Version X already exists." Anything
    // else (including "was uploaded before and deleted") is a real failure.
    if (/version\b[^\n]{0,80}already exists/i.test(output)) {
      log.notice(`AMO already has v${version}; nothing to do.`);
      return;
    }
    throw new PublishError(`web-ext sign failed with exit code ${code}; see the output above`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
