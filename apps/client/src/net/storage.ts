/** The part of the Web Storage API the clients use (localStorage, sessionStorage; a Map in tests). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * A browser storage that never throws: a disabled or full storage (private mode, quota, blocked
 * site data) reads as empty and drops writes.
 */
export function safeStorage(get: () => Storage): KeyValueStore {
  return {
    getItem: (k) => {
      try {
        return get().getItem(k);
      } catch {
        return null;
      }
    },
    setItem: (k, v) => {
      try {
        get().setItem(k, v);
      } catch {}
    },
    removeItem: (k) => {
      try {
        get().removeItem(k);
      } catch {}
    },
  };
}

/** An in-memory store (tests, or no storage at all). */
export function memoryStorage(): KeyValueStore & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}
