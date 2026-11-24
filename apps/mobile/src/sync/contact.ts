import type { Answered } from '../net/authed-fetch';
import type { CookieJar } from '../net/cookie-jar';

// The last contact with a workspace: the
// time of the last answer that passed the server's session check. The lease
// locks a copy after 30 days without one; this file only records it. An
// answer counts when:
// - it is 2xx or 304 (a 304 passed the session check too);
// - its path is under /api/, but not /api/auth or /api/auth/*: those run before
//   the session check (src/server/composition/http/auth.ts), and
//   /api/auth/session answers 200 with `user: null` for a dead cookie;
// - its request carried the session cookie, as authedFetch's `onAnswer`
//   reports what each request took from the jar: the few /api routes outside
//   /api/auth that skip the check (tokens, plugin services) don't count either.
// The time is the server's (the answer's Date, else the device clock with the
// jar's offset), as the session's expiry is. It is kept in memory at once and
// written through `persist` (the registry, out of Clear cache's reach) at most
// once a minute, and on `flush`: a lease counts days.

/** The least time between two writes of the last contact. */
export const CONTACT_WRITE_MS = 60_000;

/** Whether an answer of `status` to `url` passed the session check, given that its request carried the session cookie. */
export function countsAsContact(url: URL, status: number): boolean {
    const path = url.pathname;
    const auth = path === '/api/auth' || path.startsWith('/api/auth/');
    return path.startsWith('/api/') && !auth && ((status >= 200 && status < 300) || status === 304);
}

/** Whether a Cookie header carries the cookie `name`. */
function carries(cookie: string | null, name: string): boolean {
    return cookie !== null && cookie.split('; ').some((pair) => pair.slice(0, pair.indexOf('=')) === name);
}

export interface ContactTrackerOptions {
    /** The workspace's jar: its session cookie's name, and the server's clock. */
    readonly jar: CookieJar;
    /** Writes the last contact where it outlives Clear cache (the registry). */
    readonly persist: (at: number) => Promise<void>;
    /** A write failed; the next counted answer tries again. */
    readonly onError?: (error: unknown) => void;
    /** The last contact already recorded, server time, or null. */
    readonly last?: number | null;
}

export interface ContactTracker {
    /** For authedFetch's `onAnswer`. */
    readonly onAnswer: (answer: Answered) => void;
    /** The last contact, server time, or null: memory's, ahead of the store by up to a minute. */
    last(): number | null;
    /**
     * Writes the last contact if the store is behind, after any write in
     * flight, and resolves when it has it; rejects when that write fails.
     */
    flush(): Promise<void>;
}

export function createContactTracker({
    jar,
    persist,
    onError = () => {},
    last: initial = null,
}: ContactTrackerOptions): ContactTracker {
    let last = initial;
    let written = initial;
    let writing: Promise<void> = Promise.resolve();

    const write = (at: number): Promise<void> => {
        const before = written;
        written = at;
        writing = writing.then(
            () => persist(at),
            () => persist(at),
        );
        return writing.catch((error: unknown) => {
            // Behind again, so the next answer writes.
            if (written === at) {
                written = before;
            }
            throw error;
        });
    };

    return {
        onAnswer({ url, status, date, sent }) {
            if (!carries(sent.cookie, jar.sessionCookie) || !countsAsContact(url, status)) {
                return;
            }
            const at = jar.serverNow(date);
            if (last !== null && at <= last) {
                return;
            }
            last = at;
            if (written === null || at - written >= CONTACT_WRITE_MS) {
                write(at).catch(onError);
            }
        },
        last: () => last,
        async flush() {
            // A write in flight may fail and leave the store behind: wait for every one, then catch up.
            let current: Promise<void>;
            do {
                current = writing;
                await current.catch(() => {});
            } while (current !== writing);
            if (last !== null && last !== written) {
                await write(last);
            }
        },
    };
}
