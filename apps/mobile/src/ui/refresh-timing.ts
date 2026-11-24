// Pull to refresh's timing, under Node: the spinner shows at least this
// long, so a pull answered from a warm connection doesn't flash it.

export const REFRESH_MIN_MS = 500;

/** Resolves once the spinner has shown REFRESH_MIN_MS since `started`. */
export function refreshDone(
    started: number,
    now: number,
    wait = (ms: number) => new Promise((r) => setTimeout(r, ms)),
) {
    const left = REFRESH_MIN_MS - (now - started);
    return left > 0 ? wait(left).then(() => undefined) : Promise.resolve();
}
