import { LIMIT_KEYS, type LimitValues } from '../limits.js';
import type { Settings } from '../types.js';

/** The limits in force: an admin's over the server's. */
export function limitsInForce(settings: Settings, defaults: LimitValues): LimitValues {
    const saved = settings.limits ?? {};
    return Object.fromEntries(LIMIT_KEYS.map((key) => [key, saved[key] ?? defaults[key]])) as LimitValues;
}

/** The saved limits after a change: a number sets one, null goes back to the server's. */
export function savedLimits(
    saved: Settings['limits'],
    change: Record<string, number | null | undefined>,
): Partial<LimitValues> {
    const next: Partial<LimitValues> = { ...saved };
    for (const key of LIMIT_KEYS) {
        const value = change[key];
        if (value === null) {
            delete next[key];
        } else if (value !== undefined) {
            next[key] = value;
        }
    }
    return next;
}
