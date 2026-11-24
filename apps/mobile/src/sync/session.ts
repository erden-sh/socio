import type { CookieJar } from '../net/cookie-jar';

import type { VersionGate } from './versions';

// The open workspace's session state, from its cookie jar:
// - signed in while the session's last known expiry (`jar.sessionExpiresAt()`,
//   the server's clock) is ahead of the server's time now;
// - Expired once it has passed: everything stays readable, writes are held,
//   and the shell's banner says "Sign in again to send and get new messages".
//   A 401 after the stored expiry is Expired too, and needs nothing more: by
//   then the expiry has passed. Sync keeps running, so a jar whose clock was
//   wrong puts itself right (authedFetch sends a withheld cookie once more when
//   the 401's Date shows it live) and the banner goes.
// - Ended is no state here: a 401 before the expiry locks the copy in the
//   registry (`endedAt`), the scope stops syncing, and the root gate closes it
//   and shows the lock screen (scope.ts).
// The watch reads the jar again after every answer (the jar has no events) and
// when the expiry comes, so the banner shows on time with no request, offline
// too. No React Native: tests/sync runs it under Node.

/** 'expired' once the session's stored expiry has passed by the server's clock. */
export type SessionState = 'signed-in' | 'expired';

/** Why writes wait (the outbox reads it; the composer draws the line): a sign-in, an update of the workspace, or nothing. */
export type WriteHold = 'sign-in' | 'update' | null;

/** The longest one timer waits before the watch reads the jar again (setTimeout's limit is about 24.8 days). */
const MAX_WAIT_MS = 24 * 60 * 60 * 1000;

export interface SessionWatch {
    state(): SessionState;
    /** Called when the state changes. */
    subscribe(listener: () => void): () => void;
    /** Reads the jar again: after each answer, and when the expiry comes. */
    check(): void;
    /** Stops the timer and drops the listeners. */
    dispose(): void;
}

/** Whether a session expiring at `expiresAt` (server time; null when unknown) has expired at server time `now`. */
export function sessionExpired(expiresAt: number | null, now: number): boolean {
    return expiresAt !== null && now >= expiresAt;
}

export function createSessionWatch(jar: Pick<CookieJar, 'sessionExpiresAt' | 'serverNow'>): SessionWatch {
    let state: SessionState = 'signed-in';
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    const listeners = new Set<() => void>();

    const check = () => {
        if (disposed) {
            return;
        }
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
        const expiresAt = jar.sessionExpiresAt();
        const now = jar.serverNow();
        const next: SessionState = sessionExpired(expiresAt, now) ? 'expired' : 'signed-in';
        if (expiresAt !== null && next === 'signed-in') {
            timer = setTimeout(check, Math.min(expiresAt - now, MAX_WAIT_MS));
        }
        if (next !== state) {
            state = next;
            for (const listener of [...listeners]) {
                listener();
            }
        }
    };
    check();

    return {
        state: () => state,
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        check,
        dispose() {
            disposed = true;
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            listeners.clear();
        },
    };
}

/**
 * Why the open workspace's writes wait, if they do: Expired waits for a
 * sign-in, a closed minimum-version gate for the workspace's update.
 */
export function writeHold(session: SessionState, gate: VersionGate | null): WriteHold {
    if (session === 'expired') {
        return 'sign-in';
    }
    return gate === 'closed' ? 'update' : null;
}
