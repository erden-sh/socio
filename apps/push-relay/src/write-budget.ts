// The relay's D1 write budget: every path that writes D1 charges its billed cost, in
// rows written, to one counter per UTC minute (migrations/0002_write_budget.sql), checked before
// the write. The budget holds across every Cloudflare location, which the rate-limiting binding
// can't (it counts per location). A charge the budget refuses writes nothing.
//
// D1 bills each row written, and each index entry written with it. How each cost is counted,
// against the schema in migrations/ (tests/write-budget.test.ts checks the schema still matches):
//
// - the counter's own write: 1. `write_budget.minute` is an INTEGER PRIMARY KEY, the rowid, so
//   the upsert touches the row only, with no index;
// - `registrations` has one index, its TEXT primary key's (the `refreshed_on` index is gone: the
//   daily cron scans the table instead);
// - a create: the counter 1, the row 1, its primary-key entry 1, plus its delete, prepaid now:
//   the row 1 and its primary-key entry 1. Every row is deleted exactly once, by `DELETE` or by
//   the 60-day cron, so neither charges again, and a revocation is never refused for budget;
// - a refresh (`PUT`, with or without a new token; a retried `POST` with a new token also pays a
//   create): the counter 1, the row 1. No indexed column changes;
// - a cleared native token (a provider's "gone"): the counter 1, the row 1;
// - the cron's cleanup of the counter: one row per minute, at most 1,440 a day, reserved in the
//   daily arithmetic below rather than charged per request;
// - the shared APNs provider token (migrations/0003): at most one write per APNs key every
//   50 minutes (a compare-and-swap that loses writes nothing), its first insert 2 (the row and its
//   TEXT primary key), and a delete on ExpiredProviderToken. Reserved below, not charged: a
//   spent budget must never make isolates sign their own tokens and trip
//   TooManyProviderTokenUpdates.

export const WRITE_COST = {
    create: 1 + 1 + 1 + (1 + 1),
    refresh: 1 + 1,
    tokenClear: 1 + 1,
    /** Prepaid by `create`. */
    delete: 0,
} as const;

/** The counter rows the cron deletes a day: one per minute. */
export const COUNTER_CLEANUP_PER_DAY = 24 * 60;

/** The APNs provider token's writes a day, reserved: 29 swaps (one per 50 minutes) rounded up with room for re-inserts after ExpiredProviderToken. */
export const APNS_TOKEN_WRITES_PER_DAY = 100;

/**
 * The default budget, in billed rows written per minute: 50, so 10 new registrations a minute
 * (14,400 a day), or 25 refreshes.
 *
 * It assumes Workers Paid (Ingenio's account is on it), where D1 has no daily write cap: 50
 * million rows written a month are included, then billed by use. So the budget is a cost bound,
 * not a quota guard. At the default, worst case (`monthlyWorstCaseAt`):
 *
 * - charged and reserved writes: 50 × 1,440 + 1,440 counter rows the cron deletes + 100 for the
 *   APNs provider token = 73,540 a day, 2,206,200 a month (30 days). An attacker who creates and deletes as fast as the budget allows
 *   writes about this much, every day;
 * - the deletes are prepaid, so they run later than they are charged: on a given day the cron or
 *   a burst of `DELETE`s can delete rows prepaid on earlier days, so one day can go well past
 *   73,540 (the reviewers' sustained case, about 115,000 a day, is in this range). They are bounded
 *   by the rows that can exist: at most 90 days of creates (60 kept, 30 made this month) at
 *   14,400 a day, 2 rows each, 2,592,000 a month;
 * - so at most 2,206,200 + 2,592,000 = 4,798,200 rows written a month, under a tenth of the 50
 *   million included.
 *
 * On the free plan (100,000 rows written a day, then D1 refuses writes until the next day) this
 * is no guarantee: a backlog of deletes landing on one day could use up the daily quota, and an
 * attacker could do that on purpose. `REGISTRATION_WRITE_BUDGET` raises it on Paid.
 */
export const DEFAULT_REGISTRATION_WRITE_BUDGET = 50;

/** The rows charged or reserved a day at `budget` per minute (not the prepaid deletes that run that day). */
export const dailyWritesAt = (budget: number) => budget * 24 * 60 + COUNTER_CLEANUP_PER_DAY + APNS_TOKEN_WRITES_PER_DAY;

/**
 * The most rows the relay can write in 30 days at `budget` per minute: what it charges and
 * reserves, plus every prepaid delete that could run in that time (90 days of creates: 60 kept
 * before the month, 30 made in it).
 */
export const monthlyWorstCaseAt = (budget: number) =>
    30 * dailyWritesAt(budget) + 90 * Math.floor((budget * 24 * 60) / WRITE_COST.create) * 2;

/** D1's rows written included a month on Workers Paid. */
export const PAID_INCLUDED_WRITES_PER_MONTH = 50_000_000;

/**
 * The budget from `REGISTRATION_WRITE_BUDGET`: a whole number of rows a minute, at least one
 * create's cost (or nothing could ever register). Anything else gives the default.
 */
export function writeBudgetFrom(value: unknown): number {
    const text = typeof value === 'number' ? String(value) : value;
    if (typeof text !== 'string' || !/^\d{1,9}$/.test(text.trim())) {
        return DEFAULT_REGISTRATION_WRITE_BUDGET;
    }
    const budget = Number(text.trim());
    return budget >= WRITE_COST.create ? budget : DEFAULT_REGISTRATION_WRITE_BUDGET;
}
