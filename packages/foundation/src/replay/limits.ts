// The replay worker's limits (CB-318). Moved from `src/server/replay/`:
// `replay/contract.ts` re-exports them, and the worker loads them from
// here, so it doesn't load `effect`.

/** The replay cache's default size: the characters of the events its entries cover, in all. */
export const REPLAY_CACHE_BYTES = 64 * 1024 * 1024;

/**
 * How long one replay may take in the worker before it fails and the
 * worker is replaced. A first replay of a very long thread replays all of
 * it (the client copies the history on every event); later ones replay
 * only the new runs.
 */
export const REPLAY_TIMEOUT_MS = 10 * 60_000;
