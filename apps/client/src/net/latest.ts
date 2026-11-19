import { useState } from "react";

/**
 * A request counter. Each call starts a request and returns `ifLatest`, which wraps that
 * request's callbacks so they run only while no newer request has started: an older reply that
 * lands after a newer one is dropped.
 */
export function latestGuard() {
  let seq = 0;
  return () => {
    const n = ++seq;
    return <A extends unknown[]>(fn: (...args: A) => void) =>
      (...args: A) => {
        if (n === seq) fn(...args);
      };
  };
}

/** One `latestGuard` per component, stable across renders. */
export function useLatest() {
  return useState(latestGuard)[0];
}
