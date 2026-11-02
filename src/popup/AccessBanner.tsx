import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * One blanket grant instead of per-site ones. Browsers let the user withhold
 * site access (Chrome's "On click", Firefox's per-site menu), and a Firefox
 * MV3 content script only runs where the host permission is granted — a
 * sideloaded add-on starts with nothing and looks dead. The all-sites grant is
 * buried in about:addons, but `permissions.request` from a click asks for
 * every site at once.
 */
const ALL_URLS: chrome.permissions.Permissions = { origins: ['<all_urls>'] };

type Access = 'unknown' | 'granted' | 'withheld';

/**
 * What we actually need from the permissions API, declared here because the
 * bundled @types/chrome does not match the runtime on two points: it types
 * `permissions` as always present (it is absent in the website build and under
 * jsdom), and it gives the events only `addListener`, though both browsers
 * support removing one.
 */
interface PermissionEvent {
  addListener(cb: () => void): void;
  removeListener?(cb: () => void): void;
}

interface PermissionsApi {
  contains(permissions: chrome.permissions.Permissions): Promise<boolean>;
  request(permissions: chrome.permissions.Permissions): Promise<boolean>;
  onAdded?: PermissionEvent;
  onRemoved?: PermissionEvent;
}

/** Absent in the website build and under jsdom; then the banner stays away. */
function permissionsApi(): PermissionsApi | undefined {
  try {
    if (typeof chrome === 'undefined') return undefined;
    const api = chrome.permissions as unknown as PermissionsApi | undefined;
    return api && typeof api.contains === 'function' ? api : undefined;
  } catch {
    return undefined;
  }
}

/** Where the user can change their mind, named for the browser they are in. */
function laterHint(): string {
  const firefox = typeof navigator !== 'undefined' && navigator.userAgent.includes('Firefox');
  return firefox
    ? 'You can allow it later in about:addons → this add-on → Permissions.'
    : 'You can allow it later from the extension’s Site access menu.';
}

export function AccessBanner(): JSX.Element | null {
  const api = permissionsApi();
  const [access, setAccess] = useState<Access>('unknown');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);
  const [confirm, setConfirm] = useState(false);
  // Only a grant that lands while the popup is open deserves a confirmation.
  const wasWithheld = useRef(false);

  const settle = useCallback((ok: boolean): void => {
    setAccess(ok ? 'granted' : 'withheld');
    if (ok && wasWithheld.current) setConfirm(true);
    if (ok) setRefused(false);
    wasWithheld.current = !ok;
  }, []);

  useEffect(() => {
    if (!api) return;
    let alive = true;
    const check = (): void => {
      void Promise.resolve(api.contains(ALL_URLS)).then(
        (ok) => {
          if (alive) settle(ok);
        },
        () => {
          // Cannot tell: say nothing rather than nag.
          if (alive) setAccess('unknown');
        },
      );
    };
    check();
    // Firefox may close the popup to show the prompt, so the grant can land
    // while this popup is gone; a fresh mount re-checks. When the popup does
    // survive, these keep it honest.
    api.onAdded?.addListener(check);
    api.onRemoved?.addListener(check);
    return () => {
      alive = false;
      api.onAdded?.removeListener?.(check);
      api.onRemoved?.removeListener?.(check);
    };
  }, [api, settle]);

  function requestAccess(): void {
    if (!api) return;
    setBusy(true);
    // Must stay inside the click: the prompt needs the user gesture.
    void Promise.resolve(api.request(ALL_URLS)).then(
      (ok) => {
        setBusy(false);
        settle(Boolean(ok));
        if (!ok) setRefused(true);
      },
      () => {
        // A rejected request is indistinguishable from a refusal here.
        setBusy(false);
        setRefused(true);
      },
    );
  }

  if (!api) return null;
  if (access === 'unknown') return null;
  if (access === 'granted') {
    return confirm ? (
      <p className="tzx-access-ok" role="status">
        Access allowed — reading pages now.
      </p>
    ) : null;
  }

  return (
    <section className="tzx-access" aria-label="Site access">
      <p className="tzx-access-text">
        Times on pages won’t convert until you allow this extension to read sites.
      </p>
      <button type="button" className="tzx-access-btn" onClick={requestAccess} disabled={busy}>
        Allow on all sites
      </button>
      {refused && <p className="tzx-access-hint">{laterHint()}</p>}
    </section>
  );
}
