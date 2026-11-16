import { useSyncExternalStore } from "react";

/** Minimal observable store for React (no external state library needed). */
export class Store<T> {
  private listeners = new Set<() => void>();
  constructor(private value: T) {}
  get = () => this.value;
  set(next: T | ((prev: T) => T)) {
    this.value = typeof next === "function" ? (next as (p: T) => T)(this.value) : next;
    for (const l of this.listeners) l();
  }
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
