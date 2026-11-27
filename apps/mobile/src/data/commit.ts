import { AbortedError } from '../net/errors';

import { workspaceKeyName } from './keys';
import { type Hasher, workspaceId, workspaceLayout } from './layout';
import { openCacheDb, openUserDb } from './open';
import { decidePerson } from './person-check';
import type { SessionRow, WorkspaceManifestRow } from './registry';
import { type Store, wipe, type WipeOptions } from './wipe';

// Committing a sign-in to the phone, once the server accepted it
// and the person check (person-check.ts) allows it. An ordered plan, so a
// failure anywhere, or a kill, leaves the store as it was before the
// sign-in.
//
// A new workspace, in this order:
// 1. `registered`: a 'pending' registry row (launch wipes one a kill leaves);
// 2. `directory`: `socio/<id>/`;
// 3. `databases`: both database keys, then cache.db and user.db made through
//    `store.driver` (and closed again: the workspace's scope opens them);
// 4. `jar`: the staging jar's cookies written into the workspace's jar slot;
// 5. `install`: the install id the sign-in sent written into the
//    workspace's install slot, when it sent one;
// 6. `ready`: the row becomes 'ready';
// 7. `active`: it becomes the active workspace.
// The row is added with what the workspace's manifest said (its id and lease
// policy), when the probe read one.
// A failure at or after step 1 wipes the workspace ('unfinished', wipe.ts),
// which deletes the row, the directory, the keys and the jar, and puts the
// active workspace back as it was (`registry.restoreActive`, which doesn't
// count as a use, so every row's `lastUsed` and the switcher's order are as
// they were). Step 1 itself failing leaves nothing to undo.
//
// The same person signing in again (from Expired, Ended or a lease lock)
// keeps everything, outbox included:
// 1. `jar`: the staging jar's cookies replace the workspace's jar;
// 2. `install`: the install id the sign-in sent replaces the workspace's (a
//    copy from before install ids had none), and the manifest read before
//    the sign-in replaces what the row kept of it;
// 3. `active`: it becomes the active workspace, unlocked (`endedAt` and
//    `leaseLockedAt` cleared) with the sign-in as its last contact, in one
//    transaction.
// A failure puts the old jar, install id and manifest, the active workspace,
// the row's `lastUsed` and its lock and lease state back. It never wipes.
//
// The commit refuses (step `check`, nothing done) when the phone holds the
// workspace for another person, whose copy the caller wipes first after the
// confirmation, or when the person's own row is still being added
// or wiped. The staging jar is spent either way: discarded once its cookies
// are in the workspace's jar slot, or released (its session signed out on the
// server, then discarded) when the commit refused or rolled back, so no
// session is left on the server that nobody holds. The caller stops the
// workspace's scope and jar first when the same person signs in again, so no
// late write of the old jar lands on the new one.

/** The staging jar as the commit needs it (src/net's StagingJar). */
export interface CommitJar {
    /** The jar's stored form, written into the workspace's jar slot as it is. */
    serialize(): string;
    /** After a commit: drops the staging jar, with no request. Its session lives on in the workspace's jar. */
    discard(): Promise<void>;
    /** After a refusal or a rollback: ends the staged session on the server (best effort), then drops the jar. */
    release(): Promise<void>;
}

/** What a sign-in commits: who, where, and the staging jar (src/net's StagedSignIn, with the workspace's name). */
export interface SignInToCommit {
    /** The workspace's exact origin. */
    readonly origin: string;
    /** `user.id` from `GET /api/auth/session`. */
    readonly appUserId: string;
    /** The workspace's name (`branding.name`). */
    readonly name: string;
    /** The logo's file name in the workspace's directory, or null for the bundled mascot. */
    readonly logo?: string | null;
    readonly personName: string | null;
    readonly personEmail: string | null;
    readonly jar: CommitJar;
    /** The install id the sign-in sent (src/net's StagedSignIn), moved into the workspace's install slot; none: none. */
    readonly installId?: string | null;
    /** What the workspace's manifest said before the sign-in, for the row; none on a server with no manifest. */
    readonly manifest?: WorkspaceManifestRow | null;
}

/** A commit's steps, as each ends. */
export type CommitStep = 'registered' | 'directory' | 'databases' | 'jar' | 'install' | 'ready' | 'active';

/** A new workspace's steps, in order. */
export const NEW_WORKSPACE_STEPS: readonly CommitStep[] = [
    'registered',
    'directory',
    'databases',
    'jar',
    'install',
    'ready',
    'active',
];
/** The same person's steps, in order. */
export const SAME_PERSON_STEPS: readonly CommitStep[] = ['jar', 'install', 'active'];

export interface CommitOptions {
    /** SHA-256 for the directory id (layout.ts). */
    readonly hash: Hasher;
    /** Called as each step ends; the tests throw from it to fail the commit there. */
    readonly afterStep?: (step: CommitStep) => void | Promise<void>;
    /** Passed to the rollback's wipe. */
    readonly wipeOptions?: WipeOptions;
    /**
     * The person going back: checked after the commit's last read and right before its first
     * write, with no await between, so an aborted sign-in writes nothing. It rejects with
     * AbortedError and releases the staging jar (its session signed out), like any refusal.
     */
    readonly signal?: AbortSignal;
}

export interface CommittedSignIn {
    /** The workspace's directory id, now the active workspace. */
    readonly id: string;
    readonly kind: 'new' | 'same-person';
}

/**
 * The commit failed at `step` (`check`: refused before any step), with the
 * failure as its cause. `rolledBack` says whether the store is as it was
 * before; when the rollback failed too (`rollbackError`), the row is left
 * 'pending' or 'wiping' and the next launch finishes the wipe.
 */
export class SignInCommitError extends Error {
    override readonly name = 'SignInCommitError';
    readonly step: CommitStep | 'check';
    readonly rolledBack: boolean;
    readonly rollbackError: unknown;

    constructor(step: CommitStep | 'check', cause: unknown, rolledBack: boolean, rollbackError: unknown = null) {
        super(
            step === 'check'
                ? `The sign-in wasn't committed: ${cause instanceof Error ? cause.message : 'refused'}`
                : `The sign-in failed to commit at step ${step}${rolledBack ? '; the phone is as it was' : ', and its rollback failed too'}.`,
        );
        this.step = step;
        this.cause = cause;
        this.rolledBack = rolledBack;
        this.rollbackError = rollbackError;
    }
}

/**
 * Commits the sign-in: a new workspace, or the same person's again, by the
 * plan above. Resolves with the workspace now active, and discards the
 * staging jar; rejects with SignInCommitError, and releases it.
 */
export async function commitSignIn(
    store: Store,
    signIn: SignInToCommit,
    options: CommitOptions,
): Promise<CommittedSignIn> {
    let committed = false;
    try {
        let id: string;
        let check: ReturnType<typeof decidePerson>;
        let previous: Previous;
        try {
            id = await workspaceId(options.hash, signIn.origin, signIn.appUserId);
            const rows = await store.registry.byOrigin(signIn.origin);
            check = decidePerson({
                origin: signIn.origin,
                rows,
                answer: { kind: 'signed-in', appUserId: signIn.appUserId },
            });
            const own = check.kind === 'same-person' ? rows.find((row) => row.id === id) : undefined;
            previous = {
                active: await store.registry.active(),
                lastUsed: new Map(own === undefined ? [] : [[own.id, own.lastUsed]]),
                // The same person's jar as it was, for the rollback. A keychain that can't be read refuses here.
                jar: check.kind === 'same-person' ? await store.keys.read(workspaceKeyName(id, 'jar')) : null,
                install: check.kind === 'same-person' ? await store.keys.read(workspaceKeyName(id, 'install')) : null,
                installSetAt: own?.installSetAt ?? null,
                manifest:
                    own === undefined
                        ? null
                        : {
                              serverWorkspaceId: own.serverWorkspaceId ?? null,
                              leaseDays: own.leaseDays ?? null,
                              wipeDays: own.wipeDays ?? null,
                          },
                session: own === undefined ? null : await store.registry.session(own.id),
            };
        } catch (error) {
            throw new SignInCommitError('check', error, true);
        }
        if (check.kind === 'other-person') {
            throw new SignInCommitError(
                'check',
                new Error('another person’s copy of this workspace is on the phone; wipe it first.'),
                true,
            );
        }
        if (check.kind !== 'new' && check.kind !== 'same-person') {
            throw new SignInCommitError(
                'check',
                new Error('this person’s copy of the workspace is still being added or wiped.'),
                true,
            );
        }
        // The last await above was a read: from here to the first write there is none.
        if (options.signal?.aborted) {
            throw new AbortedError(signIn.origin, options.signal.reason);
        }
        if (check.kind === 'same-person') {
            await commitSamePerson(store, id, signIn, options, previous);
        } else {
            await commitNew(store, id, signIn, options, previous);
        }
        committed = true;
        return { id, kind: check.kind };
    } finally {
        await (committed ? signIn.jar.discard() : signIn.jar.release()).catch(() => undefined);
    }
}

/**
 * What a rollback puts back: the active workspace, the `lastUsed` of the rows
 * the commit may touch, and the same person's jar.
 */
interface Previous {
    readonly active: string | null;
    readonly lastUsed: ReadonlyMap<string, number>;
    readonly jar: string | null;
    /** The same person's install id as it was (null: none, as on a copy from before install ids). */
    readonly install: string | null;
    /** What the same person's row kept of the manifest. */
    readonly manifest: WorkspaceManifestRow | null;
    /** When the same person's install id was recorded as written (migration 10). */
    readonly installSetAt: number | null;
    /** The same person's lock and lease state, which the commit clears (Ended or a lease lock). */
    readonly session: SessionRow | null;
}

/** Runs the steps in order, noting each as it ends; resolves the step that failed with its error, or null. */
async function runSteps(
    steps: ReadonlyArray<readonly [CommitStep, () => Promise<void>]>,
    afterStep: CommitOptions['afterStep'],
): Promise<{ step: CommitStep; error: unknown } | null> {
    for (const [step, work] of steps) {
        try {
            await work();
            await afterStep?.(step);
        } catch (error) {
            return { step, error };
        }
    }
    return null;
}

async function commitNew(
    store: Store,
    id: string,
    signIn: SignInToCommit,
    options: CommitOptions,
    previous: Previous,
): Promise<void> {
    const { registry, keys, fs, driver } = store;
    const layout = workspaceLayout(store.root, id);
    let registered = false;
    const failed = await runSteps(
        [
            [
                'registered',
                async () => {
                    await registry.add({
                        id,
                        origin: signIn.origin,
                        appUserId: signIn.appUserId,
                        name: signIn.name,
                        logo: signIn.logo ?? null,
                        personName: signIn.personName,
                        personEmail: signIn.personEmail,
                        manifest: signIn.manifest ?? null,
                    });
                    registered = true;
                },
            ],
            ['directory', () => fs.mkdir(layout.directory)],
            [
                'databases',
                async () => {
                    const cacheKey = await keys.create(workspaceKeyName(id, 'cache'));
                    const userKey = await keys.create(workspaceKeyName(id, 'user'));
                    const cache = await openCacheDb(driver, layout.directory, cacheKey);
                    try {
                        const user = await openUserDb(driver, layout.directory, userKey);
                        await user.db.close();
                        if (!user.state.writable) {
                            throw new Error('the new user.db did not take its migrations.');
                        }
                    } finally {
                        await cache.db.close();
                    }
                },
            ],
            ['jar', () => keys.slot(workspaceKeyName(id, 'jar')).write(signIn.jar.serialize())],
            // The wipe a rollback runs deletes it with the other workspace keys.
            [
                'install',
                async () => {
                    if (signIn.installId) {
                        await keys.write(workspaceKeyName(id, 'install'), signIn.installId);
                        // Recorded only after the key is written: the scope sends the header only with it.
                        await registry.setInstallSet(id, Date.now());
                    }
                },
            ],
            ['ready', () => registry.markReady(id)],
            ['active', () => registry.setActive(id)],
        ],
        options.afterStep,
    );
    if (failed === null) {
        return;
    }
    let rollbackError: unknown = null;
    if (registered) {
        try {
            await wipe(store, id, 'unfinished', options.wipeOptions);
        } catch (error) {
            rollbackError = error;
        }
    }
    const activeError = await restoreActive(store, previous);
    rollbackError ??= activeError;
    throw new SignInCommitError(failed.step, failed.error, rollbackError === null, rollbackError);
}

async function commitSamePerson(
    store: Store,
    id: string,
    signIn: SignInToCommit,
    options: CommitOptions,
    previous: Previous,
): Promise<void> {
    const name = workspaceKeyName(id, 'jar');
    const installName = workspaceKeyName(id, 'install');
    const before = previous.jar;
    let touched = false;
    let installTouched = false;
    let manifestTouched = false;
    const failed = await runSteps(
        [
            [
                'jar',
                async () => {
                    const value = signIn.jar.serialize();
                    touched = true;
                    await store.keys.slot(name).write(value);
                },
            ],
            [
                'install',
                async () => {
                    if (signIn.installId) {
                        installTouched = true;
                        if (signIn.installId !== previous.install) {
                            await store.keys.write(installName, signIn.installId);
                        }
                        await store.registry.setInstallSet(id, Date.now());
                    }
                    if (signIn.manifest) {
                        manifestTouched = true;
                        await store.registry.setManifest(id, signIn.manifest);
                    }
                },
            ],
            // Active again, unlocked, and the sign-in counts as contact, so the lease starts over.
            ['active', () => store.registry.setActive(id, { signedIn: true })],
        ],
        options.afterStep,
    );
    if (failed === null) {
        return;
    }
    let rollbackError: unknown = null;
    if (previous.session !== null) {
        try {
            await store.registry.restoreSession(id, previous.session);
        } catch (error) {
            rollbackError = error;
        }
    }
    if (touched) {
        try {
            if (before === null) {
                await store.keys.erase([name]);
            } else {
                await store.keys.write(name, before);
            }
        } catch (error) {
            rollbackError = error;
        }
    }
    if (installTouched) {
        try {
            await store.registry.setInstallSet(id, previous.installSetAt);
            if (previous.install === null) {
                // Out of the index too, so the keychain is as it was.
                await store.keys.delete([installName]);
            } else {
                await store.keys.write(installName, previous.install);
            }
        } catch (error) {
            rollbackError = error;
        }
    }
    if (manifestTouched && previous.manifest !== null) {
        try {
            await store.registry.setManifest(id, previous.manifest);
        } catch (error) {
            rollbackError = error;
        }
    }
    const activeError = await restoreActive(store, previous);
    rollbackError ??= activeError;
    throw new SignInCommitError(failed.step, failed.error, rollbackError === null, rollbackError);
}

/**
 * Puts the active workspace and the rows' `lastUsed` back as they were, without
 * counting as a use; resolves the error if it couldn't, else null.
 */
async function restoreActive(store: Store, previous: Previous): Promise<unknown> {
    try {
        await store.registry.restoreActive(previous.active, previous.lastUsed);
        return null;
    } catch (error) {
        return error;
    }
}
