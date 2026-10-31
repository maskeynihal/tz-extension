/**
 * Messages exchanged between the background worker and the content script.
 * Every receiver validates the shape (and the sender) before acting.
 */

/** Background -> content: convert this selection (from the right-click menu). */
export interface ConvertSelectionMessage {
  readonly type: 'tzx/convert-selection';
  /** The selection text the browser reported for the menu click. */
  readonly text: string;
}

/** Content -> background: open the settings page. */
export interface OpenOptionsMessage {
  readonly type: 'tzx/open-options';
}

export interface Ack {
  readonly ok: boolean;
}

/** Longest selection text we accept over messaging. */
export const MAX_MESSAGE_TEXT = 5000;

export function isConvertSelectionMessage(m: unknown): m is ConvertSelectionMessage {
  if (typeof m !== 'object' || m === null) return false;
  const o = m as Record<string, unknown>;
  return o.type === 'tzx/convert-selection' && typeof o.text === 'string' && o.text.length <= MAX_MESSAGE_TEXT;
}

export function isOpenOptionsMessage(m: unknown): m is OpenOptionsMessage {
  return typeof m === 'object' && m !== null && (m as Record<string, unknown>).type === 'tzx/open-options';
}

/** True when a message came from this extension (not a page or another extension). */
export function fromThisExtension(sender: chrome.runtime.MessageSender | undefined): boolean {
  try {
    return Boolean(sender && sender.id === chrome.runtime.id);
  } catch {
    return false;
  }
}
