import type { WorkspaceManifest } from '@socio/shared/device-sign-in';

import { memoryJarStore, openCookieJar } from '../net/cookie-jar';
import { AbortedError } from '../net/errors';
import type { FetchFunction } from '../net/fetch-function';
import { readManifest } from '../net/probe';
import { createPublicFetch } from '../net/public-fetch';
import {
    type SignInProblem,
    type SignInResult,
    signInWithPassword,
    signOutJar,
    type StagedSignIn,
} from '../net/sign-in';

import { commitSignIn, SignInCommitError } from './commit';
import { newInstallId, type RandomBytes, workspaceKeyName } from './keys';
import type { Hasher } from './layout';
import { checkPerson, type PreviousPerson, sameEmail } from './person-check';
import type { WorkspaceManifestRow } from './registry';
import { type Store, wipe } from './wipe';

// The SignIn screen's whole sign-in, under Node: src/net's sign-in, the person
// check, then the commit.
// - A refusal is the problem the copy table words. BANNED_USER also wipes, in
//   silence, any copy the phone holds on that origin for that email.
// - The same person, or a new workspace, commits at once.
// - Another person's copy on the origin waits for the person's answer:
//   `cancel()` signs the new session out and changes nothing; `confirm()`
//   signs the previous person's session out (best effort), wipes their copy
//   ('other-person'), then commits.
// - The person's own copy still being added or wiped ('unfinished') signs the
//   new session out: a relaunch finishes that wipe first.
// The caller moves the staged logo in once a new workspace commits, and
// refreshes the root gate.
//
// Before anything is sent:
// - The workspace's manifest: the probe's, or read now (signing in again
//   comes with none). When the phone keeps a workspace id for the origin and
//   the manifest names another, the address leads to another workspace now:
//   nothing is sent (`workspace-changed`). No manifest (an older server, no
//   answer) checks nothing.
// - The install id the sign-in sends: the one the phone's only copy on the
//   origin has when the email typed is that copy's person's (trimmed, any case)
//   and this build recorded writing it (`installSetAt`), so signing in again
//   stays the same device to the server; else a new one. Another person never
//   gets someone else's id. It is staged: the commit moves it into the workspace's slot, and
//   a sign-in that doesn't commit leaves nothing of it.
//
// The same person signing in again replaces the copy's jar, so the session it
// held would stay live on the server for its 30 days with nobody holding it.
// Once the commit is in, that session is signed out, best effort and in the
// background (`later`), with the install id it was made with: the commit never
// waits for it and never fails on it.
//
// Any way of signing in: the request carries either the password, or `stage`,
// which sends the method's own request with the install id chosen here and
// resolves with its staged sign-in (the sheet's redeem, a sign-in code's or Add
// a device's). Everything after it, the person check, BANNED_USER, the
// commit and its rollback, is the same for all. A method that asks no email
// (the sheet: the person signs in on the web) passes `email: null`, so it gets a
// new install id (it can't be shown to be the same person before the server
// answers) and a BANNED_USER wipes nothing here: that copy's own next request
// answers 401 `deactivated`, which wipes it.

export interface SignInFlowDeps {
    readonly store: Store;
    /** SHA-256 for the workspace's directory id (layout.ts). */
    readonly hash: Hasher;
    /** The app's one fetch (src/platform/fetch.ts). */
    readonly fetch: FetchFunction;
    /** The app's User-Agent, which carries nothing about the person. */
    readonly userAgent: string;
    /** The device clock, for the jars. */
    readonly now?: () => number;
    /** Secure random bytes, for a new install id. */
    readonly randomBytes: RandomBytes;
    /**
     * Runs work that nothing waits for (the replaced session's sign-out). By default it runs
     * on its own and its failure is ignored; tests pass one that collects it.
     */
    readonly later?: (work: Promise<void>) => void;
}

/** Sends a method's sign-in with `installId` through a fresh staging jar (src/net). */
export type StageSignIn = (installId: string) => Promise<SignInResult>;

interface SignInBase {
    /** The workspace's exact origin, where the address probe ended. */
    readonly origin: string;
    /** The logo's file name the commit records for a new workspace (`logo.<ext>`), or null for the mascot. */
    readonly logo: string | null;
    /** The person going back: the sign-in rejects with AbortedError. */
    readonly signal?: AbortSignal;
    /** The manifest the probe read; none: it is read before the sign-in. */
    readonly manifest?: WorkspaceManifest | null;
}

/** The password form's sign-in, or any other method's staged one. */
export type SignInRequest = SignInBase &
    (
        | { readonly email: string; readonly password: string; readonly stage?: undefined }
        | {
              /** The email the person typed for this method, or null when it asks none (the sheet). */
              readonly email: string | null;
              readonly password?: undefined;
              readonly stage: StageSignIn;
          }
    );

export type SignInOutcome =
    /** The workspace `id` is committed and active. `kind` says whether it is new on the phone. */
    | { readonly kind: 'committed'; readonly id: string; readonly committed: 'new' | 'same-person' }
    /** The server refused. `wiped` lists the copies a BANNED_USER removed. */
    | { readonly kind: 'problem'; readonly problem: SignInProblem; readonly wiped: readonly string[] }
    /** Someone else's copy is on the phone: the person confirms or cancels. Exactly one of the two may run. */
    | {
          readonly kind: 'other-person';
          readonly previous: readonly PreviousPerson[];
          /** Their unsent items, null when they couldn't be counted. */
          readonly unsent: number | null;
          confirm(): Promise<SignInOutcome>;
          cancel(): Promise<void>;
      }
    /** The person's own copy is still being added or wiped; the new session was signed out. */
    | { readonly kind: 'unfinished' }
    /** The commit refused or failed; the staged session was signed out. */
    | { readonly kind: 'commit-failed'; readonly error: SignInCommitError };

/** Signs in to `origin` and commits, or says why not. Rejects only with AbortedError or a store failure. */
export async function signInAndCommit(request: SignInRequest, deps: SignInFlowDeps): Promise<SignInOutcome> {
    const { store } = deps;
    const prepared = await prepareSignIn(request, deps);
    if (prepared.kind === 'workspace-changed') {
        return { kind: 'problem', problem: { kind: 'workspace-changed', status: null, code: null }, wiped: [] };
    }
    const { installId, manifest } = prepared;
    const result =
        request.stage === undefined
            ? await signInWithPassword({
                  origin: request.origin,
                  email: request.email,
                  password: request.password,
                  fetch: deps.fetch,
                  userAgent: deps.userAgent,
                  signal: request.signal,
                  now: deps.now,
                  installId,
              })
            : await request.stage(installId);
    if (!result.ok) {
        const wiped =
            result.problem.kind === 'deactivated' && request.email !== null
                ? await wipeDeactivated(store, request.origin, request.email)
                : [];
        return { kind: 'problem', problem: result.problem, wiped };
    }
    const staged = result.signIn;
    // The person going back once the sign-in's answer is in: nothing commits, and the staged
    // session is signed out (its staging jar no longer follows the signal, so the logout goes).
    await releaseIfAborted(staged, request.signal);
    let check: Awaited<ReturnType<typeof checkPerson>>;
    try {
        check = await checkPerson(store, request.origin, { kind: 'signed-in', appUserId: staged.appUserId });
    } catch (error) {
        await staged.cancel();
        throw error;
    }
    await releaseIfAborted(staged, request.signal);
    if (check.kind === 'unfinished' || check.kind === 'deactivated') {
        await staged.cancel();
        return { kind: 'unfinished' };
    }
    if (check.kind !== 'other-person') {
        const replaced = check.kind === 'same-person' ? await replacedSession(store, check.id) : null;
        const outcome = await commit(staged, request, manifest, deps);
        if (replaced !== null && outcome.kind === 'committed' && outcome.committed === 'same-person') {
            (deps.later ?? runLater)(signOutReplaced(replaced, request.origin, deps));
        }
        return outcome;
    }
    let answered = false;
    const once = () => {
        if (answered) {
            throw new Error('The another-person confirmation was already answered.');
        }
        answered = true;
    };
    return {
        kind: 'other-person',
        previous: check.previous,
        unsent: check.unsent,
        cancel: async () => {
            once();
            await staged.cancel();
        },
        confirm: async () => {
            once();
            try {
                for (const person of check.previous) {
                    await signOutPrevious(person.id, request.origin, deps);
                    await wipe(store, person.id, 'other-person');
                }
            } catch (error) {
                await staged.cancel();
                throw error;
            }
            return commit(staged, request, manifest, deps);
        },
    };
}

/** Signs the staged session out and rejects with AbortedError once `signal` has aborted. */
async function releaseIfAborted(staged: StagedSignIn, signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) {
        await staged.cancel();
        throw new AbortedError(staged.origin, signal.reason);
    }
}

/** What the sign-in sends and commits besides the password, or why it may not be sent. */
type Prepared =
    | { readonly kind: 'ready'; readonly installId: string; readonly manifest: WorkspaceManifestRow | null }
    | { readonly kind: 'workspace-changed' };

/** The manifest check and the install id (the header). Rejects only with AbortedError or a store failure. */
async function prepareSignIn(request: SignInRequest, deps: SignInFlowDeps): Promise<Prepared> {
    const { store } = deps;
    const rows = await store.registry.byOrigin(request.origin);
    let manifest = request.manifest ?? null;
    if (manifest === null) {
        const read = await readManifest(request.origin, {
            publicFetch: createPublicFetch({ fetch: deps.fetch, userAgent: deps.userAgent }),
            signal: request.signal,
        });
        manifest = read.kind === 'manifest' ? read.manifest : null;
    }
    if (manifest !== null) {
        const id = manifest.id;
        if (rows.some((row) => row.serverWorkspaceId != null && row.serverWorkspaceId !== id)) {
            return { kind: 'workspace-changed' };
        }
    }
    const ready = rows.filter((row) => row.state === 'ready');
    const email = request.email;
    const own =
        email !== null && ready.length === 1 && ready[0].installSetAt != null && sameEmail(ready[0].personEmail, email)
            ? ready[0]
            : null;
    const kept = own === null ? null : await store.keys.read(workspaceKeyName(own.id, 'install'));
    return {
        kind: 'ready',
        installId: kept ?? newInstallId(deps.randomBytes),
        manifest: manifest === null ? null : manifestRow(manifest),
    };
}

/** What the registry keeps of a manifest (migration 10). */
export function manifestRow(manifest: WorkspaceManifest): WorkspaceManifestRow {
    return {
        serverWorkspaceId: manifest.id,
        leaseDays: manifest.policy.leaseDays,
        wipeDays: manifest.policy.wipeDays,
    };
}

async function commit(
    staged: StagedSignIn,
    request: SignInRequest,
    manifest: WorkspaceManifestRow | null,
    deps: SignInFlowDeps,
): Promise<SignInOutcome> {
    try {
        const committed = await commitSignIn(
            deps.store,
            { ...staged, name: staged.workspaceName, logo: request.logo, manifest },
            { hash: deps.hash },
        );
        return { kind: 'committed', id: committed.id, committed: committed.kind };
    } catch (error) {
        if (error instanceof SignInCommitError) {
            return { kind: 'commit-failed', error };
        }
        throw error;
    }
}

/** BANNED_USER: wipes that email's copies on the origin, silently. A wipe that fails is left to the next launch. */
async function wipeDeactivated(store: Store, origin: string, email: string): Promise<string[]> {
    const check = await checkPerson(store, origin, { kind: 'deactivated', email });
    const wiped: string[] = [];
    for (const id of check.kind === 'deactivated' ? check.wipe : []) {
        try {
            await wipe(store, id, 'deactivated');
            wiped.push(id);
        } catch {
            // Marked 'wiping' by then, or untouched: launch's resumeWipes finishes a marked one.
        }
    }
    return wiped;
}

/** The same person's jar and install id as they are before the commit replaces them; null when unreadable. */
async function replacedSession(store: Store, id: string): Promise<{ jar: string; installId: string | null } | null> {
    try {
        const jar = await store.keys.read(workspaceKeyName(id, 'jar'));
        return jar === null ? null : { jar, installId: await store.keys.read(workspaceKeyName(id, 'install')) };
    } catch {
        return null;
    }
}

const runLater = (work: Promise<void>) => {
    work.catch(() => undefined);
};

/** Best effort: ends the session a replaced jar held. Never rejects. */
async function signOutReplaced(
    replaced: { jar: string; installId: string | null },
    origin: string,
    deps: SignInFlowDeps,
): Promise<void> {
    let jar: Awaited<ReturnType<typeof openCookieJar>>;
    try {
        jar = await openCookieJar({ origin, store: memoryJarStore(replaced.jar), now: deps.now });
    } catch {
        return;
    }
    try {
        await signOutJar({ origin, jar, fetch: deps.fetch, userAgent: deps.userAgent, installId: replaced.installId });
    } finally {
        await jar.clear().catch(() => undefined);
        await jar.close().catch(() => undefined);
    }
}

/** Best effort: ends the previous person's session on the server before their copy is wiped. */
async function signOutPrevious(id: string, origin: string, deps: SignInFlowDeps): Promise<void> {
    let jar: Awaited<ReturnType<typeof openCookieJar>>;
    try {
        jar = await openCookieJar({ origin, store: deps.store.keys.slot(workspaceKeyName(id, 'jar')), now: deps.now });
    } catch {
        return;
    }
    try {
        await signOutJar({ origin, jar, fetch: deps.fetch, userAgent: deps.userAgent });
    } finally {
        await jar.close().catch(() => undefined);
    }
}
