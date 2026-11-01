// Live converter for the TZ Converter site. Reuses the EXACT same engine the
// extension ships (parse.ts / tz.ts / storage.ts) and the same searchable zone
// picker, so the demo is the real thing, not a reimplementation.
//
// Settings live in localStorage through storage.ts (the website opts in with
// enableWebStorageBackend below), so zones, 12/24h and the day/month order are
// shared with the website's world clock, follow edits made in other tabs, and
// survive reloads.
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseTimes, type ParseOptions } from '../src/lib/parse';
import { isValidZone, sameZone, toIsoUtc, viewInZone, zoneLabel, resolveZone } from '../src/lib/tz';
import {
  loadPreferences,
  onPreferencesChanged,
  savePreferences,
  enableWebStorageBackend,
} from '../src/lib/storage';
import { ZonePicker } from '../src/popup/ZonePicker';
import { readingLabel } from './reading';
import { readEpochInput, wallClockNote } from './convert';
import {
  DEFAULT_PREFERENCES,
  type NumericDateOrder,
  type ParsedTime,
  type Preferences,
} from '../src/types';

// First: the website keeps settings in this site's localStorage.
enableWebStorageBackend();

const SUGGESTED = ['UTC', 'America/New_York', 'Europe/London', 'Asia/Kolkata', 'Asia/Tokyo', 'abbr:PT'];

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

/** Home first, then the saved zones that are not home. */
function shownZones(prefs: Preferences): string[] {
  const out = [prefs.homeZone];
  for (const z of prefs.targetZones) if (!out.some((o) => sameZone(o, z))) out.push(z);
  return out;
}

/** The reading of an ambiguous numeric date that matches the saved preference. */
function preferredEpoch(p: ParsedTime, order: NumericDateOrder): number {
  if (p.dateOrder && p.dateOrder.order !== order) return p.dateOrder.alternate.epochMs;
  return p.epochMs;
}

function mountDemo(): void {
  const root = document.getElementById('demo-app');
  if (!root) return;

  let prefs: Preferences = DEFAULT_PREFERENCES;

  function save(next: Preferences): void {
    prefs = next;
    void savePreferences(next);
    render();
  }

  // --- Tabs ---
  const tabs = h('div', { class: 'demo-tabs', role: 'group', 'aria-label': 'Input type' });
  const paste = h('button', { class: 'demo-tab is-on', type: 'button', 'aria-pressed': 'true' }, ['Any time']);
  const epoch = h('button', { class: 'demo-tab', type: 'button', 'aria-pressed': 'false' }, ['Epoch']);
  tabs.append(paste, epoch);

  const input = h('input', {
    class: 'demo-input',
    type: 'text',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Time to convert',
  });

  const hint = h('p', { class: 'demo-hint', 'aria-live': 'polite' });
  const format = h('p', { class: 'demo-format' });
  const note = h('p', { class: 'demo-note' });
  const orderBox = h('div', { class: 'demo-order', role: 'group', 'aria-label': 'Read this date as' });
  const out = h('div', { class: 'demo-out' });

  // 12h | 24h: the same labelled segmented control as the extension popup.
  const clock = h('div', { class: 'demo-seg', role: 'group', 'aria-label': 'Clock format' });
  const clockButtons = ([true, false] as const).map((h12) => {
    const label = h12 ? '12-hour clock' : '24-hour clock';
    const b = h('button', { class: 'demo-seg-btn', type: 'button', 'aria-label': label, title: label, 'aria-pressed': 'false' }, [
      h12 ? '12h' : '24h',
    ]);
    b.addEventListener('click', () => {
      if (prefs.hour12 !== h12) save({ ...prefs, hour12: h12 });
    });
    clock.append(b);
    return { b, h12 };
  });

  let mode: 'paste' | 'epoch' = 'paste';
  const PLACEHOLDER = {
    paste: 'Paste a time: 1700000000, 2024-07-01T14:30Z, 22/03/2024 14:05 or "Oct 28 2026 4:24 UTC"',
    epoch: 'Paste a Unix timestamp (seconds or milliseconds)',
  } as const;
  function setMode(m: 'paste' | 'epoch'): void {
    mode = m;
    paste.classList.toggle('is-on', m === 'paste');
    epoch.classList.toggle('is-on', m === 'epoch');
    paste.setAttribute('aria-pressed', String(m === 'paste'));
    epoch.setAttribute('aria-pressed', String(m === 'epoch'));
    input.placeholder = PLACEHOLDER[m];
    render();
  }
  paste.addEventListener('click', () => setMode('paste'));
  epoch.addEventListener('click', () => setMode('epoch'));

  function rows(epochMs: number): HTMLElement {
    const wrap = h('ul', { class: 'demo-rows', 'aria-label': 'Converted times' });
    for (const zone of shownZones(prefs)) {
      const v = viewInZone(epochMs, zone, prefs.hour12);
      const isHome = sameZone(zone, prefs.homeZone);
      const detail = resolveZone(zone)?.long;
      const name = h('div', { class: 'demo-zone' }, [
        h('span', { class: 'demo-zone-name' }, [zoneLabel(zone)]),
        ...(detail && detail !== zoneLabel(zone) ? [h('span', { class: 'demo-zone-detail' }, [detail])] : []),
        ...(isHome ? [h('span', { class: 'demo-local' }, ['HOME'])] : []),
      ]);
      const val = h('div', { class: 'demo-val' }, [
        h('span', { class: 'demo-date' }, [v.date]),
        h('span', { class: 'demo-time' }, [`${v.weekday} ${v.time}`]),
        h('span', { class: 'demo-off' }, [`UTC${v.offset}`]),
      ]);
      const row = h('li', { class: 'demo-row' + (isHome ? ' is-local' : '') }, [name, val]);
      if (!isHome) {
        const del = h('button', { class: 'demo-del', type: 'button', 'aria-label': `Remove ${zoneLabel(zone)}`, title: 'Remove' }, ['×']);
        del.addEventListener('click', () => {
          save({ ...prefs, targetZones: prefs.targetZones.filter((z) => !sameZone(z, zone)) });
          pickerInput()?.focus();
        });
        row.append(del);
      }
      wrap.append(row);
    }
    return wrap;
  }

  function renderOrder(p: ParsedTime): void {
    orderBox.replaceChildren();
    if (!p.dateOrder) {
      orderBox.hidden = true;
      return;
    }
    orderBox.hidden = false;
    orderBox.append(h('span', { class: 'demo-order-label' }, ['Read as']));
    for (const order of ['dmy', 'mdy'] as const) {
      const on = prefs.numericDateOrder === order;
      const b = h('button', { class: 'demo-chip' + (on ? ' is-on' : ''), type: 'button', 'aria-pressed': String(on) }, [
        `${readingLabel(p, order) ?? ''} (${order === 'dmy' ? 'day first' : 'month first'})`,
      ]);
      b.addEventListener('click', () => {
        if (prefs.numericDateOrder !== order) save({ ...prefs, numericDateOrder: order });
      });
      orderBox.append(b);
    }
  }

  function render(): void {
    for (const { b, h12 } of clockButtons) {
      const on = prefs.hour12 === h12;
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('is-on', on);
    }
    out.replaceChildren();
    format.textContent = '';
    note.textContent = '';
    orderBox.hidden = true;
    const raw = input.value.trim();
    if (!raw) {
      hint.textContent = 'Type or paste a time above to see it in every zone.';
      hint.className = 'demo-hint';
      renderPicker();
      return;
    }
    const opts: ParseOptions & { readonly numericDateOrder: NumericDateOrder } = {
      assumedZone: prefs.homeZone,
      dateOnlyPolicy: prefs.dateOnlyPolicy,
      customFormats: prefs.customFormats,
      disabledFormats: prefs.disabledFormats,
      numericDateOrder: prefs.numericDateOrder,
    };
    if (mode === 'epoch') {
      // The Epoch tab reads one integer, like the popup's Epoch tab: 0 and
      // negative values (before 1970) included.
      const e = readEpochInput(raw);
      if (!e) {
        hint.textContent =
          "That isn't a Unix timestamp. Paste a whole number of seconds (like 1700000000) or milliseconds (13 digits); 0 and negative values work too.";
        hint.className = 'demo-hint is-error';
        renderPicker();
        return;
      }
      hint.className = 'demo-hint';
      hint.textContent = `Read "${raw}" as Unix ${e.unit} · ${toIsoUtc(e.epochMs)}`;
      out.append(rows(e.epochMs));
      renderPicker();
      return;
    }
    const matches = parseTimes(raw, opts);
    const parsed = matches[0];
    if (!parsed) {
      hint.textContent = readEpochInput(raw)
        ? "Couldn't read that as a time. To read it as a Unix timestamp, use the Epoch tab."
        : "Couldn't read that as a time. Try an epoch, an ISO string, or a full date.";
      hint.className = 'demo-hint is-error';
      renderPicker();
      return;
    }
    const epochMs = preferredEpoch(parsed, prefs.numericDateOrder);
    const src = parsed.assumed ? `${zoneLabel(parsed.assumedZone)} (assumed)` : zoneLabel(parsed.sourceZone ?? 'UTC');
    hint.className = 'demo-hint';
    hint.textContent = `Read "${parsed.matchedText}" as ${src} · ${toIsoUtc(epochMs)}`;
    if (parsed.formatLabel) format.textContent = `Matched by format: ${parsed.formatLabel}`;
    // The DST flag describes the parser's own reading, not a swapped day/month one.
    note.textContent = (epochMs === parsed.epochMs ? wallClockNote(parsed, prefs.hour12) : null) ?? '';
    renderOrder(parsed);
    out.append(rows(epochMs));
    renderPicker();
  }

  // --- Add-zone picker: the extension's searchable, grouped combobox. ---
  const pickerHost = h('div', { class: 'demo-picker' });
  let pickerRoot: Root | null = null;
  function pickerInput(): HTMLInputElement | null {
    return pickerHost.querySelector('input');
  }
  function renderPicker(): void {
    pickerRoot ??= createRoot(pickerHost);
    pickerRoot.render(
      createElement(ZonePicker, {
        label: 'Add a timezone',
        placeholder: '+ Add a timezone: search a city, UTC+5:45, PDT…',
        exclude: shownZones(prefs),
        suggested: SUGGESTED,
        onSelect: (z: string) => {
          if (!isValidZone(z) || shownZones(prefs).some((s) => sameZone(s, z))) return;
          save({ ...prefs, targetZones: [...prefs.targetZones, z] });
        },
      }),
    );
  }

  const head = h('div', { class: 'demo-head' }, [tabs, clock]);
  root.append(head, input, hint, note, format, orderBox, out, pickerHost);

  input.addEventListener('input', render);
  // Seed with "now" so the demo is alive on load.
  input.value = String(Math.floor(Date.now() / 1000));
  input.placeholder = PLACEHOLDER.paste;
  render();

  void loadPreferences().then((p) => {
    prefs = p;
    render();
  });
  // Edits from another tab (e.g. the world clock) show up here too.
  onPreferencesChanged((p) => {
    prefs = p;
    render();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountDemo);
} else {
  mountDemo();
}
