import { workspaceKeyName } from './keys';
import { joinPath, workspaceLayout } from './layout';
import { openEncrypted } from './open';
import type { WorkspaceRow } from './registry';
import type { Store } from './wipe';

// Who signed in, against what the phone holds for that workspace. It runs
// after the server answered and before anything is committed (commit.ts):
// - **The same person** (the exact origin and the app user id of a row on the
//   phone) signs in again: everything stays, outbox included, and only the jar
//   is replaced (Expired, Ended or a lease lock).
// - **Another person** on an origin the phone holds for someone else: the app
//   warns "N unsent items from the previous person will be deleted" and needs a
//   confirmation; on Cancel the new sign-in is dropped. N counts the
//   previous person's outbox and unsent rows in user.db; a count that fails is
//   null, never 0.
// - **BANNED_USER** for an email the phone holds a copy for on that origin:
//   that copy is wiped silently (revoked or deactivated). The answer comes
//   only after the password check, so only the person's own password gets it.
// The decision itself, `decidePerson`, is pure; `checkPerson` reads the
// registry and the counts for it. Rows being added ('pending', only during a
// commit or after a kill, which launch wipes) or being wiped ('wiping') aren't
// on the phone for this purpose, except that the same person's own row in that
// state is `unfinished`: a commit can't add it again until its wipe is done.

/** What the server answered, as the person check needs it. */
export type SignInAnswer =
    /** It signed someone in: `user.id` from `GET /api/auth/session`, the app user id. */
    | { readonly kind: 'signed-in'; readonly appUserId: string }
    /** It answered BANNED_USER to the right password for `email`, as the person typed it. */
    | { readonly kind: 'deactivated'; readonly email: string };

/** Someone whose copy of the workspace is on the phone. */
export interface PreviousPerson {
    readonly id: string;
    readonly personName: string | null;
    readonly personEmail: string | null;
    /** Their outbox and unsent rows; null when they couldn't be counted. */
    readonly unsent: number | null;
}

export type PersonCheck =
    /** The phone doesn't hold this workspace: commit it as new. */
    | { readonly kind: 'new' }
    /** The same person signing in again: commit replaces the jar of workspace `id` and keeps everything else. */
    | { readonly kind: 'same-person'; readonly id: string }
    /**
     * The phone holds this workspace for someone else. After a confirmation,
     * their copies are wiped ('other-person'), then the sign-in commits.
     * `unsent` is the total, null when any count failed.
     */
    | { readonly kind: 'other-person'; readonly previous: readonly PreviousPerson[]; readonly unsent: number | null }
    /** The same person's row is still being added or wiped: nothing can commit until it is gone (a relaunch finishes it). */
    | { readonly kind: 'unfinished'; readonly id: string }
    /** BANNED_USER: wipe these workspaces silently ('deactivated'). Empty when the phone holds no copy for that email. */
    | { readonly kind: 'deactivated'; readonly wipe: readonly string[] };

export interface PersonCheckInput {
    /** The workspace's exact origin. Rows of any other origin are left out. */
    readonly origin: string;
    /** The registry's rows for the origin (`registry.byOrigin`). */
    readonly rows: readonly WorkspaceRow[];
    readonly answer: SignInAnswer;
    /** The unsent count of each row, by id; a row missing here counts as null. */
    readonly unsent?: ReadonlyMap<string, number | null>;
}

/** States of a row that isn't settled on the phone: being added, or being wiped. */
const UNSETTLED: ReadonlySet<string> = new Set(['pending', 'wiping']);

/** An email as Better Auth looks it up (lower case), with the spaces a person may type around it. */
export const sameEmail = (a: string | null, b: string) =>
    a !== null && a.trim().toLowerCase() === b.trim().toLowerCase();

/** What the sign-in means for the phone. Pure: everything it needs is in `input`. */
export function decidePerson({ origin, rows, answer, unsent }: PersonCheckInput): PersonCheck {
    const here = rows.filter((row) => row.origin === origin);
    // A newer build's state is taken as settled: that copy may hold someone's data.
    const settled = here.filter((row) => !UNSETTLED.has(row.state));
    if (answer.kind === 'deactivated') {
        const wipe = settled.filter((row) => sameEmail(row.personEmail, answer.email)).map((row) => row.id);
        return { kind: 'deactivated', wipe };
    }
    const own = here.find((row) => row.appUserId === answer.appUserId);
    if (own !== undefined && UNSETTLED.has(own.state)) {
        return { kind: 'unfinished', id: own.id };
    }
    const others = settled.filter((row) => row.appUserId !== answer.appUserId);
    if (others.length > 0) {
        const previous = others.map((row) => ({
            id: row.id,
            personName: row.personName,
            personEmail: row.personEmail,
            unsent: unsent?.get(row.id) ?? null,
        }));
        let total: number | null = 0;
        for (const person of previous) {
            total = total === null || person.unsent === null ? null : total + person.unsent;
        }
        return { kind: 'other-person', previous, unsent: total };
    }
    return own === undefined ? { kind: 'new' } : { kind: 'same-person', id: own.id };
}

/** Counts workspace `id`'s unsent items. Rejects when it can't: the caller takes that as unknown. */
export type UnsentCounter = (store: Store, id: string) => Promise<number>;

/**
 * Reads the registry for `origin` and counts the unsent items of every other
 * person on it, then decides (`decidePerson`). A count that rejects is null.
 * `countUnsent` is for tests; by default `countUnsentItems`.
 */
export async function checkPerson(
    store: Store,
    origin: string,
    answer: SignInAnswer,
    countUnsent: UnsentCounter = countUnsentItems,
): Promise<PersonCheck> {
    const rows = await store.registry.byOrigin(origin);
    const unsent = new Map<string, number | null>();
    if (answer.kind === 'signed-in') {
        for (const row of rows) {
            if (row.appUserId !== answer.appUserId && !UNSETTLED.has(row.state)) {
                unsent.set(row.id, await countUnsent(store, row.id).catch(() => null));
            }
        }
    }
    return decidePerson({ origin, rows, answer, unsent });
}

/**
 * Workspace `id`'s outbox and unsent rows in its user.db, counted on a
 * connection of its own through `store.driver`, closed after. It changes
 * nothing: no migration runs, and a missing file or key rejects rather than
 * being made.
 */
export async function countUnsentItems(store: Store, id: string): Promise<number> {
    const layout = workspaceLayout(store.root, id);
    const key = await store.keys.read(workspaceKeyName(id, 'user'));
    if (key === null) {
        throw new Error(`Workspace ${id} has no user.db key.`);
    }
    if (!(await store.fs.exists(joinPath(layout.user.directory, layout.user.name)))) {
        throw new Error(`Workspace ${id} has no user.db.`);
    }
    const { db } = await openEncrypted(store.driver, layout.user, key);
    try {
        const row = await db.get<{ items: unknown }>(
            // A row `sent` and waiting for the stored history is the server's already.
            "SELECT (SELECT count(*) FROM outbox WHERE state <> 'sent') + (SELECT count(*) FROM unsent) AS items",
        );
        const items = Number(row?.items);
        if (!Number.isInteger(items) || items < 0) {
            throw new Error(`Workspace ${id}'s user.db gave no count.`);
        }
        return items;
    } finally {
        await db.close();
    }
}
