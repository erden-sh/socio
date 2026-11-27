import { leaseWipeAt } from '../data/lease';
import type { StagedLogo } from '../data/logo';
import type { WorkspaceRow } from '../data/registry';

// The session states' words and the sign-in they lead to. No React Native, so
// tests/shell runs it under Node:
// - the Expired banner, over the shell's screens: readable, writes held;
// - the update banner ("This workspace needs a server update"), while the
//   minimum-version gate is closed: the server is older than this build needs;
// - the lock screen's words: Ended, or the lease's "Sign in by <date> or this
//   phone's copy is erased" (the wipe's date, contact + 60 days);
// - Sign in again: the SignIn screen's params for a workspace already on the
//   phone, from its registry row. The same person's commit keeps everything
//   and unlocks; the logo stays the one on the phone, and the sign-in methods
//   aren't known offline, so "Forgot password?" doesn't show.

export const EXPIRED_BANNER = 'Sign in again to send and get new messages.';
export const UPDATE_BANNER =
    'This workspace needs a server update before you can send from the app. You can still read everything.';
export const SIGN_IN_AGAIN = 'Sign in';

type Row = Pick<WorkspaceRow, 'origin' | 'name'>;

/** The workspace's name (its branding's, then its settings'), else its host. */
export function workspaceTitle(row: Row): string {
    const name = row.name.trim();
    return name === '' ? new URL(row.origin).host : name;
}

/** A date as the lock screen says it, in en-US until the app has its own locale (`November 2, 2026`). */
export function lockDate(ms: number, timeZone?: string): string {
    return new Date(ms).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone });
}

export interface LockCopy {
    readonly title: string;
    readonly body: string;
    /** The lease's: the copy is erased then. Null while only Ended. */
    readonly wipeAt: number | null;
}

/** What the lock screen says for a locked copy: Ended, or locked by the lease. */
export function lockCopy(
    row: Row & Pick<WorkspaceRow, 'state' | 'createdAt' | 'lastContact' | 'leaseLockedAt'>,
    timeZone?: string,
): LockCopy {
    const title = `Sign in to see ${workspaceTitle(row)}`;
    if (row.leaseLockedAt === null) {
        return {
            title,
            body: 'You were signed out. Everything on this phone is kept until you sign in again.',
            wipeAt: null,
        };
    }
    const wipeAt = leaseWipeAt(row);
    return { title, body: `Sign in by ${lockDate(wipeAt, timeZone)} or this phone’s copy is erased.`, wipeAt };
}

/** The SignIn screen's params (screens/sign-in.tsx, ConfirmWorkspaceParams) to sign in again to a workspace on the phone. */
export interface SignInAgainParams {
    readonly origin: string;
    readonly host: string;
    readonly name: string;
    readonly logo: StagedLogo;
    readonly methods: null;
}

export function signInAgainParams(row: Row): SignInAgainParams {
    const url = new URL(row.origin);
    return {
        origin: row.origin,
        host: url.host,
        name: workspaceTitle(row),
        logo: { kind: 'mascot' },
        methods: null,
    };
}
