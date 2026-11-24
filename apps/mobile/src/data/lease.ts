import type { WorkspaceRow } from './registry';
import { type Store, wipe, type WipeOptions } from './wipe';

// The lease: a copy that hasn't
// reached its workspace for 30 days locks, as for Ended, and is wiped 30 days
// after that lock, so at most 60 days after the last contact. Contact is the
// registry's `lastContact` (src/sync/contact.ts, the server's clock), or the
// row's `createdAt` before the first; a same-person sign-in counts as contact
// and unlocks (registry.setActive's `signedIn`). An Ended copy keeps counting
// from its last contact, since it makes none while locked.
//
// The lock is put at the 30th day after contact, not at the moment the app
// notices, so a phone left off for 50 days is wiped 10 days later, never 30:
// the lock screen's "Sign in by <date>" is always contact + 60 days. The device
// clock decides, at launch before the root gate reads the registry, and on each
// return to the foreground (src/platform/session.ts); minutes of clock skew don't
// matter over days. Nothing here talks to the server: by day 60 a session has
// ended by itself (a device session lasts 30 days at most).
//
// A workspace whose manifest gave a policy (`leaseDays` and
// `wipeDays`, kept in the registry at sign-in) counts with its own days; one
// without (an older server, a row an older build added) keeps 30 and 30.

const DAY_MS = 24 * 60 * 60 * 1000;
/** No contact for this long locks the copy. */
export const LEASE_LOCK_MS = 30 * DAY_MS;
/** This long after the lock, the copy is wiped. */
export const LEASE_WIPE_MS = 30 * DAY_MS;

type LeaseRow = Pick<WorkspaceRow, 'state' | 'createdAt' | 'lastContact' | 'leaseLockedAt' | 'leaseDays' | 'wipeDays'>;

/** The most days a manifest's policy may give either period: a longer one is taken as this. */
export const MAX_POLICY_DAYS = 365;
/** The fewest lease days a policy may give: a shorter one is taken as this. */
export const MIN_LEASE_DAYS = 1;
/**
 * The fewest wipe days a policy may give: the app's guard
 * against a policy erasing an outbox's unsent work cheaply, a week after the
 * lock at the soonest. Open to the owner's decision.
 */
export const MIN_WIPE_DAYS = 7;

/**
 * A policy's days as a period, held to `min` and MAX_POLICY_DAYS, or
 * `fallback` when there are none (or they aren't a whole number).
 */
function policyMs(days: number | null | undefined, fallback: number, min: number): number {
    if (days === null || days === undefined || !Number.isInteger(days)) {
        return fallback;
    }
    return Math.min(Math.max(days, min), MAX_POLICY_DAYS) * DAY_MS;
}

/** When the lease locks (or locked) the copy: its last contact, else when it was added, plus its lease days (30). */
export function leaseLockAt(row: LeaseRow): number {
    return (row.lastContact ?? row.createdAt) + policyMs(row.leaseDays, LEASE_LOCK_MS, MIN_LEASE_DAYS);
}

/** When the copy is erased: its wipe days (30) after its lease lock, or after the lock it would get now. */
export function leaseWipeAt(row: LeaseRow): number {
    return (row.leaseLockedAt ?? leaseLockAt(row)) + policyMs(row.wipeDays, LEASE_WIPE_MS, MIN_WIPE_DAYS);
}

/** What the lease asks of a row at `now`: nothing, the lock, or the wipe. Only a ready row has a lease. */
export function leaseDue(row: LeaseRow, now: number): 'none' | 'lock' | 'wipe' {
    if (row.state !== 'ready') {
        return 'none';
    }
    if (now >= leaseWipeAt(row)) {
        return 'wipe';
    }
    return row.leaseLockedAt === null && now >= leaseLockAt(row) ? 'lock' : 'none';
}

export interface EnforceLeasesOptions {
    /** The device clock. */
    readonly now: () => number;
    /**
     * After the locks are written and before any wipe: the app reads the gate
     * again, so a locked copy's scope closes and the lock screen shows.
     */
    readonly afterLock?: (locked: readonly string[]) => void | Promise<void>;
    /** Before each wipe: the app stops that workspace's scope and jar (wipe.ts asks for it). */
    readonly beforeWipe?: (id: string) => void | Promise<void>;
    readonly wipeOptions?: WipeOptions;
}

export interface EnforcedLeases {
    /** The workspaces this pass locked. */
    readonly locked: readonly string[];
    /** The workspaces this pass wiped. */
    readonly wiped: readonly string[];
    /** A wipe that failed; the next pass (or launch's resumeWipes, for a marked row) runs it again. */
    readonly failed: readonly { readonly id: string; readonly error: unknown }[];
}

/**
 * Locks every ready copy its lease days (30) past its contact and wipes every
 * one its wipe days (30) past its lock (reason 'lease'). When the active workspace is wiped, the most
 * recently used one left becomes active, as after a sign-out, or none.
 */
export async function enforceLeases(store: Store, options: EnforceLeasesOptions): Promise<EnforcedLeases> {
    const { registry } = store;
    const now = options.now();
    const rows = await registry.list();
    const locked: string[] = [];
    const due: string[] = [];
    for (const row of rows) {
        const verdict = leaseDue(row, now);
        if (verdict === 'none') {
            continue;
        }
        if (row.leaseLockedAt === null) {
            await registry.setLeaseLocked(row.id, leaseLockAt(row));
            locked.push(row.id);
        }
        if (verdict === 'wipe') {
            due.push(row.id);
        }
    }
    if (locked.length > 0) {
        await options.afterLock?.(locked);
    }
    const wiped: string[] = [];
    const failed: { id: string; error: unknown }[] = [];
    if (due.length === 0) {
        return { locked, wiped, failed };
    }
    const active = await registry.active();
    for (const id of due) {
        try {
            await options.beforeWipe?.(id);
            await wipe(store, id, 'lease', options.wipeOptions);
            wiped.push(id);
        } catch (error) {
            failed.push({ id, error });
        }
    }
    if (active !== null && wiped.includes(active)) {
        const next = (await registry.list())
            .filter((row) => row.state === 'ready')
            .sort((a, b) => b.lastUsed - a.lastUsed)[0];
        await registry.setActive(next?.id ?? null);
    }
    return { locked, wiped, failed };
}
