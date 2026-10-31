import { useId, useMemo, useState } from 'react';
import type { CustomFormat, Preferences } from '../types';
import { BUILTIN_FORMATS } from '../lib/builtin-formats';
import { compileFormat, matchCustomFormat, TOKEN_REFERENCE, KNOWN_GROUPS } from '../lib/custom-formats';
import { parseTimes } from '../lib/parse';
import { MAX_CUSTOM_FORMATS, MAX_LABEL, newFormatId } from '../lib/storage';
import { toIsoUtc, viewInZone } from '../lib/tz';

interface Props {
  readonly prefs: Preferences;
  readonly update: (next: Preferences) => void;
}

/** An accessible on/off switch. */
export function Switch({
  checked,
  label,
  onChange,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly onChange: (next: boolean) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`tzx-switch${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="tzx-switch-track" aria-hidden>
        <span className="tzx-switch-thumb" />
      </span>
      <span className="tzx-switch-text">{checked ? 'On' : 'Off'}</span>
    </button>
  );
}

function describeInstant(epochMs: number, prefs: Preferences): string {
  const v = viewInZone(epochMs, prefs.homeZone, prefs.hour12);
  return `${v.weekday} ${v.date} ${v.time} ${v.offset} (${prefs.homeZone}) · ${toIsoUtc(epochMs)}`;
}

/** Live "what would happen if I selected this?" box, using every current setting. */
function FormatTester({ prefs }: { readonly prefs: Preferences }): JSX.Element {
  const testId = useId();
  const [text, setText] = useState('');
  const results = useMemo(
    () =>
      text.trim()
        ? parseTimes(text, {
            assumedZone: prefs.homeZone,
            dateOnlyPolicy: prefs.dateOnlyPolicy,
            customFormats: prefs.customFormats,
            disabledFormats: prefs.disabledFormats,
          })
        : [],
    [text, prefs.homeZone, prefs.dateOnlyPolicy, prefs.customFormats, prefs.disabledFormats],
  );
  return (
    <div className="tzx-tester">
      <label className="tzx-label" htmlFor={testId}>
        Test text
      </label>
      <input
        id={testId}
        className="tzx-input"
        placeholder="Try some text, e.g. 2024-12-31 10:30 UTC or 1700000000"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {text.trim() !== '' && (
        <div className="tzx-test-out" role="status" aria-live="polite">
          {results.length === 0 ? (
            <span className="tzx-bad">No enabled format recognizes this text.</span>
          ) : (
            <ul className="tzx-test-list">
              {results.map((r, i) => (
                <li key={`${r.matchedText}-${i}`}>
                  <code>{r.matchedText}</code> → {describeInstant(r.epochMs, prefs)}{' '}
                  <span className="tzx-badge">{r.formatLabel ?? r.kind}</span>
                  {r.assumed && <span className="tzx-muted"> · read in {r.assumedZone}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function BuiltinList({ prefs, update }: Props): JSX.Element {
  const disabled = new Set(prefs.disabledFormats);
  function setEnabled(id: string, on: boolean): void {
    const next = new Set(prefs.disabledFormats);
    if (on) next.delete(id);
    else next.add(id);
    update({ ...prefs, disabledFormats: BUILTIN_FORMATS.map((f) => f.id).filter((x) => next.has(x)) });
  }
  return (
    <>
      <div className="tzx-subhead">
        <h3>Built-in formats</h3>
        {disabled.size > 0 && (
          <button type="button" className="tzx-chip" onClick={() => update({ ...prefs, disabledFormats: [] })}>
            Turn all on
          </button>
        )}
      </div>
      <ul className="tzx-format-list" aria-label="Built-in formats">
        {BUILTIN_FORMATS.map((f) => {
          const on = !disabled.has(f.id);
          return (
            <li className={`tzx-format${on ? '' : ' off'}`} key={f.id} data-format-id={f.id}>
              <div className="tzx-format-main">
                <strong>{f.label}</strong>
                <span className="tzx-format-desc">{f.description}</span>
                <span className="tzx-format-ex">
                  e.g.{' '}
                  {f.examples.map((ex, i) => (
                    <span key={ex}>
                      {i > 0 && ', '}
                      <code>{ex}</code>
                    </span>
                  ))}
                </span>
                <details className="tzx-regex">
                  <summary>Regular expression</summary>
                  <code>{f.regex.source}</code>
                </details>
              </div>
              <Switch checked={on} label={`${f.label} format`} onChange={(v) => setEnabled(f.id, v)} />
            </li>
          );
        })}
      </ul>
    </>
  );
}

interface Draft {
  readonly id: string | null;
  readonly label: string;
  readonly pattern: string;
  readonly advanced: boolean;
  readonly sample: string;
}

const EMPTY_DRAFT: Draft = { id: null, label: '', pattern: '', advanced: false, sample: '' };

function FormatEditor({
  prefs,
  draft,
  setDraft,
  onSave,
  onCancel,
  atLimit,
}: {
  readonly prefs: Preferences;
  readonly draft: Draft;
  readonly setDraft: (d: Draft) => void;
  readonly onSave: (fmt: CustomFormat) => void;
  readonly onCancel: () => void;
  readonly atLimit: boolean;
}): JSX.Element {
  const ids = useId();
  const editing = draft.id !== null;
  const compiled = draft.pattern ? compileFormat(draft) : null;
  const duplicate = prefs.customFormats.find(
    (f) => f.id !== draft.id && f.pattern === draft.pattern && f.advanced === draft.advanced,
  );
  const error = compiled && !compiled.ok
    ? compiled.error
    : duplicate
      ? `You already have this format${duplicate.label && duplicate.label !== duplicate.pattern ? ` (“${duplicate.label}”)` : ''}.`
      : null;
  const warnings = compiled?.ok ? compiled.warnings : [];

  let preview: JSX.Element | null = null;
  if (compiled?.ok && !duplicate && draft.sample.trim()) {
    const [hit] = matchCustomFormat(
      draft.sample,
      { id: 'preview', label: draft.label || draft.pattern, pattern: draft.pattern, advanced: draft.advanced, enabled: true },
      { assumedZone: prefs.homeZone, dateOnlyPolicy: prefs.dateOnlyPolicy },
    );
    preview = hit ? (
      <span className="tzx-good">
        Matches <code>{hit.parsed.matchedText}</code> → {describeInstant(hit.parsed.epochMs, prefs)}
        {hit.parsed.assumed && <> · read in your home zone</>}
      </span>
    ) : (
      <span className="tzx-bad">Valid pattern, but it does not match the test text.</span>
    );
  }

  const canSave = Boolean(compiled?.ok) && !duplicate && (editing || !atLimit);

  function save(): void {
    if (!canSave) return;
    onSave({
      id: draft.id ?? newFormatId(),
      label: (draft.label.trim() || draft.pattern).slice(0, MAX_LABEL),
      pattern: draft.pattern,
      advanced: draft.advanced,
      enabled: editing ? prefs.customFormats.find((f) => f.id === draft.id)?.enabled ?? true : true,
    });
  }

  return (
    <form
      className="tzx-adder"
      aria-label={editing ? 'Edit custom format' : 'Add a custom format'}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <h3 className="tzx-adder-title">{editing ? 'Edit custom format' : 'Add a custom format'}</h3>
      <div className="tzx-segment" role="group" aria-label="Pattern type">
        <button
          type="button"
          className={`tzx-seg-btn${!draft.advanced ? ' active' : ''}`}
          aria-pressed={!draft.advanced}
          onClick={() => setDraft({ ...draft, advanced: false })}
        >
          Tokens
        </button>
        <button
          type="button"
          className={`tzx-seg-btn${draft.advanced ? ' active' : ''}`}
          aria-pressed={draft.advanced}
          onClick={() => setDraft({ ...draft, advanced: true })}
        >
          Regular expression
        </button>
      </div>
      <label className="tzx-label" htmlFor={`${ids}-pattern`}>
        Format pattern
      </label>
      <input
        id={`${ids}-pattern`}
        className="tzx-input tzx-mono"
        aria-invalid={error ? true : undefined}
        aria-describedby={`${ids}-status`}
        placeholder={draft.advanced ? '(?<d>\\d{2})\\.(?<mo>\\d{2})\\.(?<y>\\d{4})' : 'DD/MM/YYYY HH:mm'}
        value={draft.pattern}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setDraft({ ...draft, pattern: e.target.value })}
      />
      <label className="tzx-label" htmlFor={`${ids}-label`}>
        Format name (optional)
      </label>
      <input
        id={`${ids}-label`}
        className="tzx-input"
        placeholder="e.g. European date"
        maxLength={MAX_LABEL}
        value={draft.label}
        onChange={(e) => setDraft({ ...draft, label: e.target.value })}
      />
      <label className="tzx-label" htmlFor={`${ids}-sample`}>
        Sample text to test
      </label>
      <input
        id={`${ids}-sample`}
        className="tzx-input"
        placeholder="Paste an example from a page, e.g. 31/12/2024 10:30"
        value={draft.sample}
        onChange={(e) => setDraft({ ...draft, sample: e.target.value })}
      />
      <p className="tzx-hint" id={`${ids}-status`} aria-live="polite">
        {error ? (
          <span className="tzx-bad">{error}</span>
        ) : compiled?.ok ? (
          preview ?? <span className="tzx-good">Valid pattern. Add test text to check it.</span>
        ) : null}
      </p>
      {warnings.map((w) => (
        <p className="tzx-hint tzx-warn" key={w}>
          {w}
        </p>
      ))}
      {atLimit && !editing && (
        <p className="tzx-hint tzx-bad">You have {MAX_CUSTOM_FORMATS} custom formats, the maximum. Remove one to add another.</p>
      )}
      <div className="tzx-adder-actions">
        <button type="submit" className="tzx-chip tzx-chip-on" disabled={!canSave}>
          {editing ? 'Save changes' : 'Add format'}
        </button>
        {(editing || draft.pattern || draft.label || draft.sample) && (
          <button type="button" className="tzx-chip" onClick={onCancel}>
            {editing ? 'Cancel' : 'Clear'}
          </button>
        )}
      </div>
      <details className="tzx-ref">
        <summary>{draft.advanced ? 'Group names' : 'Token reference'}</summary>
        {draft.advanced ? (
          <p className="tzx-hint">
            Name the parts with these groups: {KNOWN_GROUPS.map((g) => `(?<${g}>…)`).join(' ')}. You need a month
            (<code>mo</code> or <code>moName</code>) and a day (<code>d</code>), or an hour (<code>h</code>) for a
            time-of-day format. Year is optional (defaults to this year). To keep pages responsive, a regex may not
            repeat a group that itself repeats or branches (<code>(a+)+</code>, <code>(a|b)+</code>), may use only a
            couple of open-ended repeats (<code>+</code>, <code>*</code>; prefer <code>\d{'{1,4}'}</code>), matches
            at most 80 characters, and scans the first 500 characters of a selection.
          </p>
        ) : (
          <table className="tzx-ref-table">
            <thead>
              <tr>
                <th scope="col">Token</th>
                <th scope="col">Meaning</th>
                <th scope="col">Example</th>
              </tr>
            </thead>
            <tbody>
              {TOKEN_REFERENCE.map((t) => (
                <tr key={t.token}>
                  <td>
                    <code>{t.token}</code>
                  </td>
                  <td>{t.meaning}</td>
                  <td>
                    <code>{t.example}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </details>
    </form>
  );
}

function CustomList({
  prefs,
  update,
  onEdit,
  editingId,
}: Props & { readonly onEdit: (f: CustomFormat) => void; readonly editingId: string | null }): JSX.Element {
  if (prefs.customFormats.length === 0) {
    return <p className="tzx-hint">No custom formats yet. Add one below for date layouts the built-ins miss.</p>;
  }
  return (
    <ul className="tzx-format-list" aria-label="Custom formats">
      {prefs.customFormats.map((fmt) => {
        const compiled = compileFormat(fmt);
        return (
          <li
            className={`tzx-format${fmt.enabled ? '' : ' off'}${editingId === fmt.id ? ' editing' : ''}`}
            key={fmt.id}
            data-format-id={fmt.id}
          >
            <div className="tzx-format-main">
              <strong>{fmt.label || '(unnamed)'}</strong>
              <code className="tzx-format-pattern">{fmt.pattern}</code>
              <span className="tzx-format-desc">{fmt.advanced ? 'Regular expression' : 'Token pattern'}</span>
              {!compiled.ok && <span className="tzx-bad">Not used: {compiled.error}</span>}
            </div>
            <div className="tzx-format-actions">
              <Switch
                checked={fmt.enabled}
                label={`${fmt.label || fmt.pattern} format`}
                onChange={(v) =>
                  update({
                    ...prefs,
                    customFormats: prefs.customFormats.map((f) => (f.id === fmt.id ? { ...f, enabled: v } : f)),
                  })
                }
              />
              <button
                type="button"
                className="tzx-chip"
                aria-label={`Edit ${fmt.label || fmt.pattern}`}
                onClick={() => onEdit(fmt)}
              >
                Edit
              </button>
              <button
                type="button"
                className="tzx-icon-btn"
                aria-label={`Remove ${fmt.label || fmt.pattern}`}
                title="Remove"
                onClick={() =>
                  update({ ...prefs, customFormats: prefs.customFormats.filter((f) => f.id !== fmt.id) })
                }
              >
                ✕
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** The "Recognized formats" settings section. */
export function FormatsSection({ prefs, update }: Props): JSX.Element {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const atLimit = prefs.customFormats.length >= MAX_CUSTOM_FORMATS;

  function saveFormat(fmt: CustomFormat): void {
    const exists = prefs.customFormats.some((f) => f.id === fmt.id);
    update({
      ...prefs,
      customFormats: exists
        ? prefs.customFormats.map((f) => (f.id === fmt.id ? fmt : f))
        : [...prefs.customFormats, fmt],
    });
    setDraft(EMPTY_DRAFT);
  }

  return (
    <section className="tzx-field" id="formats" aria-labelledby="tzx-formats-h">
      <h2 className="tzx-section-h" id="tzx-formats-h">
        Recognized formats
      </h2>
      <p className="tzx-hint">
        These decide which text counts as a time. Switch off any that misfire on your sites. When formats overlap,
        the longest match wins; on a tie, your custom formats win.
      </p>
      <FormatTester prefs={prefs} />
      <BuiltinList prefs={prefs} update={update} />
      <div className="tzx-subhead">
        <h3>
          Custom formats ({prefs.customFormats.length}/{MAX_CUSTOM_FORMATS})
        </h3>
      </div>
      <CustomList
        prefs={prefs}
        update={update}
        editingId={draft.id}
        onEdit={(f) => setDraft({ id: f.id, label: f.label, pattern: f.pattern, advanced: f.advanced, sample: '' })}
      />
      <FormatEditor
        prefs={prefs}
        draft={draft}
        setDraft={setDraft}
        onSave={saveFormat}
        onCancel={() => setDraft(EMPTY_DRAFT)}
        atLimit={atLimit}
      />
    </section>
  );
}
