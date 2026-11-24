import type { Answered } from '../net/authed-fetch';

// The server's clock for the outbox's checks: the newest Date header the
// scope's answers carried. A write keeps it in its watermark, and a check counts as a
// candidate only what the server stored at or after it, less a slack, on the server's own
// clock (`createdAt`, `finishedAt`), so a device clock 10 minutes off either way changes
// nothing.
//
// It is only an approximate bound: the Date header comes from whatever
// answered (a reverse proxy such as nginx writes its own, not the app
// server's), while `createdAt` and `finishedAt` are the app server's. A proxy
// clock a few seconds ahead would put the bound after the write's own row, so
// the checks read it through `serverSince`, which takes `SERVER_CLOCK_SLACK_MS`
// off. A bound too early only lets in more candidates (the person decides
// between two); it never leaves out the write's own, so it never causes a
// resend. Kept in memory: a scope that opened offline has none, and its writes
// fall back to the rest of the watermark.

/** How far the Date header's clock may run ahead of the app server's (a proxy's, say). */
export const SERVER_CLOCK_SLACK_MS = 2 * 60_000;

/** The earliest server time a write's candidate may carry, from its watermark's `serverAt`; null for none. */
export function serverSince(serverAt: number | null | undefined): number | null {
    return serverAt === undefined || serverAt === null ? null : serverAt - SERVER_CLOCK_SLACK_MS;
}

export interface ServerClock {
    /** Takes an answer's Date header (authedFetch's `onAnswer`). */
    observe(answer: Pick<Answered, 'date'>): void;
    /** The newest Date seen, in milliseconds of the server's clock, or null for none yet. */
    lastDate(): number | null;
}

export function createServerClock(): ServerClock {
    let last: number | null = null;
    return {
        observe({ date }) {
            const at = date === null ? Number.NaN : Date.parse(date);
            if (Number.isFinite(at) && (last === null || at > last)) {
                last = at;
            }
        },
        lastDate: () => last,
    };
}
