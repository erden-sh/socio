import { randomBytes } from 'node:crypto';

import type { StepUpResult, StepUpSession } from './contract.js';

/** A step-up challenge works once, for five minutes (CB-124). */
export const STEP_UP_SECONDS = 5 * 60;
/** Failed proofs per account per window before step-up locks. */
export const STEP_UP_FAILURES = 5;
export const STEP_UP_WINDOW_MS = 15 * 60_000;
/** Open challenges kept per account. */
export const OPEN_PER_ACCOUNT = 10;

interface OpenChallenge {
    session: StepUpSession;
    userId: string;
    digest: string;
    expiresAt: number;
    /** The WebAuthn challenge, when a passkey may answer. */
    passkeyChallenge?: string;
}

/**
 * Open challenges and failure counts, in memory: a challenge outlives
 * nothing but this process (a restart ends them, which five minutes
 * tolerates), and each is taken out before it is checked, so it works once
 * whatever the outcome.
 */
export class StepUpChallenges {
    private open = new Map<string, OpenChallenge>();
    private failures = new Map<string, { count: number; resetAt: number }>();

    create(challenge: Omit<OpenChallenge, 'expiresAt'>, now = Date.now()) {
        const mine: string[] = [];
        for (const [id, entry] of this.open) {
            if (entry.expiresAt <= now) {
                this.open.delete(id);
            } else if (entry.session.accountId === challenge.session.accountId) {
                mine.push(id);
            }
        }
        // A few open at once per account (tabs, retries); the oldest go first,
        // so a stolen session can't fill the server's memory with them.
        for (const id of mine.slice(0, Math.max(0, mine.length - OPEN_PER_ACCOUNT + 1))) {
            this.open.delete(id);
        }
        const id = randomBytes(18).toString('base64url');
        const expiresAt = now + STEP_UP_SECONDS * 1000;
        this.open.set(id, { ...challenge, expiresAt });
        return { id, expiresAt: new Date(expiresAt).toISOString() };
    }

    /**
     * Takes a challenge out, then checks it is this session's, this
     * person's, for this change and still fresh. Undefined otherwise.
     */
    take(id: string, expected: { session: StepUpSession; userId: string; digest: string }, now = Date.now()) {
        const entry = this.open.get(id);
        if (!entry) {
            return undefined;
        }
        this.open.delete(id);
        if (
            entry.expiresAt <= now ||
            entry.userId !== expected.userId ||
            entry.session.sessionId !== expected.session.sessionId ||
            entry.session.accountId !== expected.session.accountId ||
            entry.digest !== expected.digest
        ) {
            return undefined;
        }
        return entry;
    }

    /** Step-up is locked for this account until its window ends. */
    locked(accountId: string, now = Date.now()) {
        const window = this.failures.get(accountId);
        return !!window && window.resetAt > now && window.count >= STEP_UP_FAILURES;
    }

    /**
     * Counts a proof before it is checked, so proofs sent at once can't
     * outrun the lock: `locked` when the window's tries are used up (nothing
     * is checked), `last` when this is the try that will lock if it fails.
     * A proof that passes gives its try back (`passed`).
     */
    attempt(accountId: string, now = Date.now()): 'ok' | 'last' | 'locked' {
        let window = this.failures.get(accountId);
        if (!window || window.resetAt <= now) {
            window = { count: 0, resetAt: now + STEP_UP_WINDOW_MS };
            this.failures.set(accountId, window);
        }
        if (window.count >= STEP_UP_FAILURES) {
            return 'locked';
        }
        window.count++;
        return window.count >= STEP_UP_FAILURES ? 'last' : 'ok';
    }

    passed(accountId: string) {
        const window = this.failures.get(accountId);
        if (window && window.count > 0) {
            window.count--;
        }
    }
}

export const STEP_UP_EXPIRED = 'This confirmation has expired or was already used. Confirm the change again.';
export const STEP_UP_LOCKED = 'Too many failed confirmations. Try again in 15 minutes.';

/** The failure for a missing, used, stale or foreign challenge. */
export const expiredStepUp = (): StepUpResult => ({
    ok: false,
    status: 403,
    error: STEP_UP_EXPIRED,
    counted: false,
    locked: false,
});
