import '@testing-library/jest-dom/vitest';
import { beforeEach, vi } from 'vitest';

// Minimal in-memory chrome.storage mock so storage.ts works under jsdom.
interface Store {
  [k: string]: unknown;
}

function makeArea() {
  let data: Store = {};
  return {
    get: vi.fn(async (key?: string | string[] | null) => {
      if (key == null) return { ...data };
      if (typeof key === 'string') return { [key]: data[key] };
      const out: Store = {};
      for (const k of key) out[k] = data[k];
      return out;
    }),
    set: vi.fn(async (items: Store) => {
      data = { ...data, ...items };
    }),
    clear: vi.fn(async () => {
      data = {};
    }),
  };
}

beforeEach(() => {
  const sync = makeArea();
  const local = makeArea();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      sync,
      local,
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
    runtime: {
      openOptionsPage: vi.fn(),
      onInstalled: { addListener: vi.fn() },
    },
  };
});
