/** Shared helpers for the client unit tests. */

/** Lets every pending promise chain run to the end (one macrotask: all queued microtasks drain first). */
export const flushPromises = () => new Promise<void>((r) => setTimeout(r, 0));
