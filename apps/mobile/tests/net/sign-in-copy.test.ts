import { describe, expect, it } from 'vitest';

import { DEACTIVATED_MESSAGE } from '@socio/shared/auth';

import type { SignInProblem, SignInProblemKind } from '../../src/net/sign-in';
import { otherPersonCopy, signInCopy, UNFINISHED, waitText } from '../../src/net/sign-in-copy';

// The sign-in copy table (src/net/sign-in-copy.ts): a line for every
// problem, in plain words with no code or status in them, the web's
// deactivated line, the wait in words, and the another-person confirmation.

const KINDS: readonly SignInProblemKind[] = [
    'wrong-credentials',
    'deactivated',
    'method-off',
    'password-disabled',
    'rate-limited',
    'invalid-email',
    'email-not-verified',
    'unreachable',
    'not-signed-in',
    'server-error',
    'unknown',
];

const problem = (kind: SignInProblemKind, code: string | null = 'SOME_CODE'): SignInProblem =>
    kind === 'rate-limited' ? { kind, status: 429, code, retryAfterSeconds: 30 } : { kind, status: 400, code };

describe('signInCopy', () => {
    it('words every problem in plain sentences, with no code, status or jargon', () => {
        for (const kind of KINDS) {
            const { message } = signInCopy(problem(kind));
            expect(message, kind).toMatch(/^[A-Z].*[.]$/);
            expect(message, kind).not.toMatch(
                /[A-Z]{2,}_[A-Z_]+|\b[1-5]\d\d\b|error|invalid|SOME_CODE|undefined|null/i,
            );
        }
    });

    it('says the deactivated line the web says, and opens the web when password sign-in is off', () => {
        expect(signInCopy(problem('deactivated', 'BANNED_USER')).message).toBe(DEACTIVATED_MESSAGE);
        for (const kind of KINDS) {
            const expected = kind === 'method-off' || kind === 'password-disabled' ? 'open-web' : 'retry';
            expect(signInCopy(problem(kind)).action, kind).toBe(expected);
        }
    });

    it('leaves what a newcomer does to the screen’s invite line, so the two never say it twice', () => {
        // No account is ever created in the app: NEWCOMER_LINE points at the invite.
        const { message } = signInCopy(problem('wrong-credentials'));
        expect(message).toBe("That email and password don't match. Check both and try again.");
        expect(message).not.toMatch(/invit|admin|link|create|account|sign up|new here/i);
    });
});

describe('waitText', () => {
    it('puts the server’s seconds in words', () => {
        expect(waitText(null)).toBe('a minute');
        expect(waitText(Number.NaN)).toBe('a minute');
        expect(waitText(-5)).toBe('a minute');
        expect(waitText(0)).toBe('1 second');
        expect(waitText(1)).toBe('1 second');
        expect(waitText(42)).toBe('42 seconds');
        expect(waitText(59.2)).toBe('1 minute');
        expect(waitText(60)).toBe('1 minute');
        expect(waitText(61)).toBe('2 minutes');
        expect(waitText(3600)).toBe('60 minutes');
    });
});

describe('otherPersonCopy', () => {
    it('counts the previous person’s unsent items, and never reads an unknown count as none', () => {
        expect(otherPersonCopy(0).message).toMatch(/Nothing of theirs is waiting to be sent\.$/);
        expect(otherPersonCopy(1).message).toMatch(/ 1 unsent item from the previous person will be deleted\.$/);
        expect(otherPersonCopy(3).message).toMatch(/ 3 unsent items from the previous person will be deleted\.$/);
        expect(otherPersonCopy(null).message).toMatch(/Anything they haven't sent yet will be deleted\.$/);
        expect(otherPersonCopy(2)).toMatchObject({ confirm: 'Sign in anyway', cancel: 'Cancel' });
    });

    it('has a line for a copy still being removed', () => {
        expect(UNFINISHED).toMatch(/open it again/);
    });
});
