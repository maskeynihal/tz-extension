// Live demo for the TZ Converter site. Reuses the EXACT same conversion engine
// the extension ships — parse.ts / tz.ts / epoch.ts — so the demo is the real
// thing, not a reimplementation.
import { parseTimes } from '../src/lib/parse';
import { viewInZone, listTimeZones, isValidZone, wallClockToEpochMs } from '../src/lib/tz';
import { toIsoUtc } from '../src/lib/tz';
import { resolveLocalZone } from '../src/types';

const LOCAL = resolveLocalZone();
const DEFAULT_ZONES = [LOCAL, 'UTC', 'America/New_York', 'Europe/London'].filter(
  (z, i, a) => isValidZone(z) && a.indexOf(z) === i,
);

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) el.append(c);
  return el;
}

function rowsFor(epochMs: number, zones: readonly string[], hour12: boolean): HTMLElement {
  const wrap = h('div', { class: 'demo-rows' });
  for (const zone of zones) {
    const v = viewInZone(epochMs, zone, hour12);
    const isLocal = zone === LOCAL;
    const row = h('div', { class: 'demo-row' + (isLocal ? ' is-local' : '') }, [
      h('div', { class: 'demo-zone' }, [
        zone,
        ...(isLocal ? [h('span', { class: 'demo-local' }, ['LOCAL'])] : []),
      ]),
      h('div', { class: 'demo-val' }, [
        h('span', { class: 'demo-date' }, [v.date]),
        h('span', { class: 'demo-time' }, [`${v.weekday} ${v.time}`]),
        h('span', { class: 'demo-off' }, [v.offset]),
      ]),
    ]);
    wrap.append(row);
  }
  return wrap;
}

function mountDemo(): void {
  const root = document.getElementById('demo-app');
  if (!root) return;

  let hour12 = true;
  let zones = [...DEFAULT_ZONES];

  // --- Tabs ---
  const tabs = h('div', { class: 'demo-tabs' });
  const paste = h('button', { class: 'demo-tab is-on', type: 'button' }, ['Any time']);
  const epoch = h('button', { class: 'demo-tab', type: 'button' }, ['Epoch']);
  tabs.append(paste, epoch);

  const input = h('input', {
    class: 'demo-input',
    type: 'text',
    placeholder: 'Paste a time: 1700000000, 2024-07-01T14:30Z, or "Oct 28 2026 4:24 UTC"',
    'aria-label': 'Time to convert',
  }) as HTMLInputElement;

  const hint = h('p', { class: 'demo-hint' }, []);
  const out = h('div', { class: 'demo-out' });

  const clock = h('button', { class: 'demo-chip', type: 'button' }, ['12h']);
  clock.addEventListener('click', () => {
    hour12 = !hour12;
    clock.textContent = hour12 ? '12h' : '24h';
    render();
  });

  let mode: 'paste' | 'epoch' = 'paste';
  function setMode(m: 'paste' | 'epoch'): void {
    mode = m;
    paste.classList.toggle('is-on', m === 'paste');
    epoch.classList.toggle('is-on', m === 'epoch');
    input.placeholder =
      m === 'epoch'
        ? 'Paste a Unix timestamp (seconds or milliseconds)'
        : 'Paste a time: 1700000000, 2024-07-01T14:30Z, or "Oct 28 2026 4:24 UTC"';
    render();
  }
  paste.addEventListener('click', () => setMode('paste'));
  epoch.addEventListener('click', () => setMode('epoch'));

  function render(): void {
    out.replaceChildren();
    const raw = input.value.trim();
    if (!raw) {
      hint.textContent = 'Type or paste a time above to see it in every zone.';
      hint.className = 'demo-hint';
      return;
    }
    const matches = parseTimes(raw, { assumedZone: LOCAL });
    const parsed = matches[0];
    if (!parsed) {
      hint.textContent = "Couldn't read that as a time. Try an epoch, an ISO string, or a full date.";
      hint.className = 'demo-hint is-error';
      return;
    }
    const src = parsed.assumed ? `${parsed.assumedZone} (assumed)` : parsed.sourceZone ?? 'UTC';
    hint.className = 'demo-hint';
    hint.textContent = `Read "${parsed.matchedText}" as ${src} · ${toIsoUtc(parsed.epochMs)}`;
    out.append(rowsFor(parsed.epochMs, zones, hour12));
  }

  // --- Add-zone picker ---
  const picker = h('select', { class: 'demo-select', 'aria-label': 'Add a timezone' }) as HTMLSelectElement;
  picker.append(h('option', { value: '', disabled: 'true', selected: 'true' }, ['+ Add a timezone…']));
  for (const z of listTimeZones()) picker.append(h('option', { value: z }, [z]));
  picker.addEventListener('change', () => {
    const z = picker.value;
    if (z && isValidZone(z) && !zones.includes(z)) {
      zones = [...zones, z];
      render();
    }
    picker.value = '';
  });

  const head = h('div', { class: 'demo-head' }, [tabs, clock]);
  root.append(head, input, hint, out, picker);

  input.addEventListener('input', render);
  // Seed with "now" so the demo is alive on load.
  input.value = String(Math.floor(Date.now() / 1000));
  setMode('paste');
  render();
  void mode;
  void wallClockToEpochMs;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountDemo);
} else {
  mountDemo();
}
