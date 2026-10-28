/** Build metadata injected at compile time by Vite `define`. */
export interface BuildInfo {
  readonly version: string;
  /** Short git commit the build was produced from; may carry a "-dirty" suffix. */
  readonly commit: string;
  /** ISO-8601 UTC timestamp of the build. */
  readonly builtAt: string;
}

function safe(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

export function getBuildInfo(): BuildInfo {
  return {
    version: safe(typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : undefined, '0.0.0'),
    commit: safe(typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : undefined, 'unknown'),
    builtAt: safe(typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : undefined, ''),
  };
}
