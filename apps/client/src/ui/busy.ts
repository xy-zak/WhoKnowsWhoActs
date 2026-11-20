import { useState } from "react";

/**
 * A busy flag for async actions (to disable their buttons): `run(fn)` sets it while `fn` runs and
 * hands a failure to `onError` (default: ignored, for calls that already toast their own errors).
 */
export function useBusy(onError: (e: Error) => void = () => {}) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(e as Error);
    } finally {
      setBusy(false);
    }
  };
  return [busy, run] as const;
}
