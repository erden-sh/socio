import { describe, expect, it } from 'vitest';

import { LEASE_LOCK_MS } from '../../src/data/lease';
import { lockCopy, signInAgainParams, workspaceTitle } from '../../src/shell/session';

// The session states' words: the
// lock screen's for Ended and for a lease lock, the workspace's name else its
// host, and the SignIn params that sign the same person in again.

const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
const row = {
    origin: 'https://brain.example.test',
    name: 'Acme',
    state: 'ready',
    createdAt: T0,
    lastContact: T0,
    leaseLockedAt: null,
};

describe('the session states’ words', () => {
    it('names the workspace by its name, else its host', () => {
        expect(workspaceTitle(row)).toBe('Acme');
        expect(workspaceTitle({ ...row, name: '  ' })).toBe('brain.example.test');
        expect(workspaceTitle({ origin: 'http://localhost:4352', name: '' })).toBe('localhost:4352');
    });

    it('says Ended without a date, and the lease’s erase date (contact + 60 days) once it locked', () => {
        expect(lockCopy(row)).toEqual({
            title: 'Sign in to see Acme',
            body: 'You were signed out. Everything on this phone is kept until you sign in again.',
            wipeAt: null,
        });
        const leased = lockCopy({ ...row, leaseLockedAt: T0 + LEASE_LOCK_MS }, 'UTC');
        expect(leased).toEqual({
            title: 'Sign in to see Acme',
            body: 'Sign in by January 1, 2027 or this phone’s copy is erased.',
            wipeAt: T0 + 60 * 86_400_000,
        });
        expect(leased.body).not.toMatch(/\bDot\b/);
    });

    it('signs in again with the workspace filled in, the mascot and no methods', () => {
        expect(signInAgainParams(row)).toEqual({
            origin: 'https://brain.example.test',
            host: 'brain.example.test',
            name: 'Acme',
            logo: { kind: 'mascot' },
            methods: null,
        });
        expect(signInAgainParams({ origin: 'https://other.example.test', name: '' })).toMatchObject({
            host: 'other.example.test',
            name: 'other.example.test',
        });
    });
});
