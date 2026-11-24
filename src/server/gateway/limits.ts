import {
    CODING_LIMITS,
    CODING_LIMIT_KEYS,
    validCodingLimit,
    type CodingLimitKey,
    type CodingLimits,
} from '@socio/shared/coding/coding-gateway';

/**
 * The coding gateway's limits (CB-239): the environment's
 * defaults, an admin's values over them (Settings → Coding), and the one
 * limit kept per runtime, the request rate.
 *
 * Budgets are rolling 24-hour windows, not calendar days, and there is no
 * instance-wide budget. In-flight caps and budgets are counted from
 * reservation rows inside the reserving transaction (usage.ts), so they
 * hold across runtimes.
 */

/** A rolling day. */
export const WINDOW_MS = 24 * 60 * 60_000;

/** The longest one upstream request may run (model.ts's limit). */
export const UPSTREAM_TOTAL_MS = 15 * 60_000;
/**
 * A reservation this old is settled at its estimate whatever its runtime:
 * its request ended long ago, and only a settle that failed (a busy
 * database) can have left it holding a slot.
 */
export const STALE_RESERVATION_MS = UPSTREAM_TOTAL_MS + 5 * 60_000;

/**
 * The defaults, from `CODING_*` variables where set. A malformed value
 * stops the start, as other limits' variables do.
 */
export function codingLimitDefaults(env: Record<string, string | undefined>): CodingLimits {
    const out = {} as CodingLimits;
    for (const key of CODING_LIMIT_KEYS) {
        const spec = CODING_LIMITS[key];
        const raw = env[spec.env]?.trim();
        if (!raw) {
            out[key] = spec.default;
            continue;
        }
        const value = Number(raw);
        if (!validCodingLimit(key, value)) {
            throw new Error(`${spec.env} must be a whole number from ${spec.min} to ${spec.max}.`);
        }
        out[key] = value;
    }
    return out;
}

/** The limits in force: an admin's saved values over the defaults. */
export function codingLimitsInForce(saved: Record<string, number>, defaults: CodingLimits): CodingLimits {
    const out = { ...defaults };
    for (const key of CODING_LIMIT_KEYS) {
        const value = saved[key];
        if (validCodingLimit(key, value)) {
            out[key] = value;
        }
    }
    return out;
}

export const isCodingLimitKey = (key: string): key is CodingLimitKey =>
    (CODING_LIMIT_KEYS as readonly string[]).includes(key);

/**
 * Requests a minute per session, counted on this runtime only, like the
 * app's other rate limits: at most doubled while a deploy overlaps. A
 * cache: losing it grants a fresh minute, never more than that.
 */
export class SessionRate {
    private hits = new Map<string, number[]>();
    constructor(private now: () => number = Date.now) {}
    /** Counts one request; false when the session is over `perMinute`. */
    take(sessionId: string, perMinute: number) {
        const now = this.now();
        const recent = (this.hits.get(sessionId) ?? []).filter((at) => now - at < 60_000);
        if (recent.length >= perMinute) {
            this.hits.set(sessionId, recent);
            return false;
        }
        recent.push(now);
        this.hits.set(sessionId, recent);
        if (this.hits.size > 5_000) {
            for (const [id, times] of this.hits) {
                if (!times.some((at) => now - at < 60_000)) {
                    this.hits.delete(id);
                }
            }
        }
        return true;
    }
}
