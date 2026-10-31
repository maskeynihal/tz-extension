// Shared helpers for the store publishing scripts. Zero dependencies (Node 20+).
//
//   - readZip / extractZip: a minimal reader for the stored/deflated zips that
//     `zip` and `git archive` produce, so we can inspect a package without
//     shelling out to `unzip`.
//   - log helpers that emit GitHub Actions annotations when running in CI.
//   - redact(): scrubs secret values out of any text before it is printed.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { dirname, resolve, sep } from 'node:path';

const IN_CI = process.env.GITHUB_ACTIONS === 'true';

/** Error whose message is safe to print as-is; exitCode chooses the process exit status. */
export class PublishError extends Error {
  constructor(message, { exitCode = 1, details } = {}) {
    super(message);
    this.name = 'PublishError';
    this.exitCode = exitCode;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

const secrets = new Set();

/** Register a value that must never appear in output. Short values are ignored. */
export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 6) secrets.add(value);
}

/** Replace every registered secret (and anything that looks like a bearer token) with ***. */
export function redact(text) {
  let out = String(text);
  for (const s of secrets) out = out.split(s).join('***');
  return out
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, '$1***')
    .replace(/("(?:access_token|refresh_token|id_token|client_secret)"\s*:\s*")[^"]*"/g, '$1***"');
}

// ---------------------------------------------------------------------------
// Logging (GitHub annotations in CI, plain text locally)
// ---------------------------------------------------------------------------

function annotate(kind, prefix, msg) {
  const safe = redact(msg);
  if (IN_CI) {
    // Annotation text must be single-line; %0A is the documented newline escape.
    console.log(`::${kind}::${prefix}${safe.replace(/%/g, '%25').replace(/\r?\n/g, '%0A')}`);
  } else {
    console.error(`${kind.toUpperCase()}: ${prefix}${safe}`);
  }
}

export function makeLogger(prefix) {
  const p = `[${prefix}] `;
  return {
    info: (msg) => console.log(`${p}${redact(msg)}`),
    notice: (msg) => annotate('notice', p, msg),
    warn: (msg) => annotate('warning', p, msg),
    error: (msg) => annotate('error', p, msg),
  };
}

/** Run main(), mapping thrown errors to a clear message and non-zero exit. */
export async function runMain(prefix, main) {
  const log = makeLogger(prefix);
  try {
    await main(log);
  } catch (err) {
    if (err instanceof PublishError) {
      log.error(err.message);
      if (err.details) console.error(redact(err.details));
      process.exitCode = err.exitCode;
    } else {
      log.error(`unexpected failure: ${err?.stack ?? err}`);
      process.exitCode = 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Zip reading
// ---------------------------------------------------------------------------

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/**
 * Open a zip file and return { names, has(name), read(name) -> Buffer|null }.
 * Supports stored (0) and deflate (8) entries; rejects zip64 archives.
 */
export function readZip(path) {
  let buf;
  try {
    buf = readFileSync(path);
  } catch (err) {
    throw new PublishError(`cannot read zip ${path}: ${err.code ?? err.message}`, { exitCode: 2 });
  }
  const bad = (why) => new PublishError(`${path} is not a valid zip: ${why}`, { exitCode: 2 });

  let eocd = -1;
  const stop = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw bad('no end-of-central-directory record');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || off === 0xffffffff) throw bad('zip64 archives are not supported');

  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CEN_SIG) throw bad('corrupt central directory');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.set(name, { method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }

  function read(name) {
    const e = entries.get(name);
    if (!e) return null;
    const lo = e.localOff;
    if (buf.readUInt32LE(lo) !== LOC_SIG) throw bad(`bad local header for ${name}`);
    const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    const raw = buf.subarray(start, start + e.compSize);
    if (e.method === 0) return Buffer.from(raw);
    if (e.method === 8) return inflateRawSync(raw);
    throw bad(`unsupported compression method ${e.method} for ${name}`);
  }

  return { names: [...entries.keys()], has: (n) => entries.has(n), read };
}

/** Extract every file entry of a zip into destDir, refusing path traversal. */
export function extractZip(path, destDir) {
  const zip = readZip(path);
  const root = resolve(destDir);
  for (const name of zip.names) {
    if (name.endsWith('/')) continue;
    const target = resolve(root, name);
    if (!target.startsWith(root + sep)) {
      throw new PublishError(`refusing to extract unsafe path from ${path}: ${name}`, { exitCode: 2 });
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, zip.read(name));
  }
  return zip.names.length;
}

/** Parse manifest.json at the root of an extension zip. */
export function readManifestFromZip(path) {
  const zip = readZip(path);
  const raw = zip.read('manifest.json');
  if (!raw) {
    throw new PublishError(`${path} has no manifest.json at its root (was it zipped from inside dist/?)`, {
      exitCode: 2,
    });
  }
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch (err) {
    throw new PublishError(`manifest.json in ${path} is not valid JSON: ${err.message}`, { exitCode: 2 });
  }
}

/** Read the version from package.json at the repo root. */
export function packageVersion(root) {
  return JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
