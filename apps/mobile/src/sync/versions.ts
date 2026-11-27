import { compareVersions as compareReleases, isReleaseVersion } from '@socio/shared/updates/release-seen';

import type { VariantName } from '../../variant';
import type { ServerVersionRow } from '../data';
import { parseCookieDate } from '../net/cookie-date';

// The server's build. Its
// source is `GET /api/state`'s `version` (State.version): the running release,
// from the build's releases.json or package.json, and '0.0.0' when the server
// can read neither (src/server/updates/releases.ts, live/views/state.ts). No
// header carries it, and the web only shows it (the sidebar's footer). A 200
// gives it in its body; a 304 says the body is the one the device holds, and
// the version is part of that body, so it reports the stored state row's
// version (snapshot-cache.ts reads both).
//
// Two rules read each answer, in the order the answers apply:
// - The cache key (T3 Code's "omission key"): the highest version seen,
//   per workspace. A higher one is taken at once. A lower one means two builds
//   answer during a start-first deploy (about 5.5 minutes) and is ignored
//   until answers below the highest have lasted more than ROLLBACK_MS, with
//   none at or above it between: then it's a rollback, and the latest of them
//   becomes the highest. Either move is `fresh`: every scope pulled under
//   another version is due one pull (the cache's `stale`). A snapshot kind just
//   sends its ETag then: the tag's version part holds the server's boot id, so
//   a new build checks the body's hash, and a 304 can only mean the same body.
//   A cursor kind (a chat's history) re-checks only its format number and
//   keeps its runs.
//   The window runs on the server's clock, each answer's Date header (with the
//   device clock and the last Date's offset for an answer without one), so a
//   jump of the device clock can't pass for an old build answering on. A long
//   gap between two lower answers does count: a deploy's old build is gone
//   within 5.5 minutes, so one still answering after the gap is a rollback.
// - The minimum-version gate: a version passes when
//   it is at least MINIMUM_SERVER_VERSION, or is '0.0.0' in a development or
//   preview build (a server run from source that can't read its package.json).
//   Each answer's verdict is the highest version's after that answer, not its
//   own: during a deploy the old build's answers don't count, as for the cache
//   key, so however a load balancer shares the answers between the two builds,
//   the gate moves at most once (an update across the minimum opens it on its
//   second answer; a rollback below it closes it once the lower version has
//   lasted). An answer with a missing or unreadable version votes 'closed'.
//   The gate opens or closes only when two verdicts in a row agree; until two
//   first agree it is undecided. Closed, a banner shows, cached data
//   stays readable and writes wait. The variant is the build's, injected,
//   never a server's say.
//
// The state lives in memory, changed at once, and is written through `persist`
// (the registry, out of Clear cache's reach, so the gate shows at cold start)
// whenever it changes: rarely, since a steady server repeats itself.

/**
 * The lowest server version this build works with: v0.54.0, the first that takes AG-UI 1.0's media
 * parts, the only attachments this build sends (a server before it refuses them). Raise it when the
 * app starts to need something newer; the server's side is shared's client-compat.ts (CB-553).
 */
export const MINIMUM_SERVER_VERSION = '0.54.0';

/** What a server run from source reports when it can't read its package.json. */
export const UNKNOWN_SERVER_VERSION = '0.0.0';

/** How long answers below the highest version must last to be a rollback, not a deploy's old build draining. */
export const ROLLBACK_MS = 6 * 60_000;

export type VersionGate = 'open' | 'closed';

/** The version rules' and the gate's state for one workspace, as the registry keeps it. */
export interface ServerVersionState extends ServerVersionRow {
    readonly versionGate: VersionGate | null;
    readonly versionGateVote: VersionGate | null;
}

export const NO_SERVER_VERSIONS: ServerVersionState = {
    serverVersion: null,
    lowerVersion: null,
    lowerSince: null,
    lastVersion: null,
    versionGate: null,
    versionGateVote: null,
};

/** What one answer changed. */
export interface VersionChange {
    /** The highest version moved: every scope pulled under another is due one pull. */
    readonly fresh: boolean;
    /** The gate opened or closed. */
    readonly gateMoved: boolean;
}

const asGate = (value: string | null): VersionGate | null => (value === 'open' || value === 'closed' ? value : null);

/** A registry row's state, with values a newer build may have written read as undecided. */
export function serverVersionState(row: ServerVersionRow | null): ServerVersionState {
    if (row === null) {
        return NO_SERVER_VERSIONS;
    }
    return { ...row, versionGate: asGate(row.versionGate), versionGateVote: asGate(row.versionGateVote) };
}

/** Whether a build of `variant` lets '0.0.0' through: the test builds. Any other value gets production's rule. */
const testBuild = (variant: string): boolean =>
    variant === ('development' satisfies VariantName) || variant === ('preview' satisfies VariantName);

/** Whether `version` passes the minimum-version gate in a build of `variant` (each answer reads the highest's). */
export function gateVerdict(version: string | null, variant: string): VersionGate {
    if (version === UNKNOWN_SERVER_VERSION) {
        return testBuild(variant) ? 'open' : 'closed';
    }
    return version !== null && isReleaseVersion(version) && compareReleases(version, MINIMUM_SERVER_VERSION) >= 0
        ? 'open'
        : 'closed';
}

/** Whether a scope stamped with `stamp` is due one pull, the highest version being `highest`. */
export const staleFor = (stamp: string | null, highest: string | null): boolean => stamp !== highest;

/**
 * The state after one answer that reported `version` (null for none) at
 * server time `now`, and what moved. Pure: the tracker's core.
 */
export function stepServerVersions(
    state: ServerVersionState,
    version: string | null,
    variant: string,
    now: number,
): { readonly state: ServerVersionState; readonly change: VersionChange } {
    let { serverVersion, lowerVersion, lowerSince } = state;
    let fresh = false;
    const adopt = (next: string) => {
        serverVersion = next;
        lowerVersion = null;
        lowerSince = null;
        fresh = true;
    };
    const readable = version !== null && isReleaseVersion(version);
    if (readable) {
        const order =
            serverVersion === null || !isReleaseVersion(serverVersion) ? 1 : compareReleases(version, serverVersion);
        if (order > 0) {
            adopt(version);
        } else if (order === 0) {
            // The highest answers again: whatever answered below it was a deploy's other build.
            lowerVersion = null;
            lowerSince = null;
        } else if (lowerSince === null || now < lowerSince) {
            // The first answer below it (or the device clock went back): the window starts.
            lowerVersion = version;
            lowerSince = now;
        } else if (now - lowerSince > ROLLBACK_MS) {
            adopt(version);
        } else {
            lowerVersion = version;
        }
    }

    let gate = state.versionGate;
    let vote = state.versionGateVote;
    let gateMoved = false;
    // The highest version's verdict, which a readable answer has just set or left: the old build of a deploy
    // has no say until the version rules take it as a rollback.
    const verdict: VersionGate = readable ? gateVerdict(serverVersion, variant) : 'closed';
    if (verdict === gate) {
        vote = null;
    } else if (verdict === vote) {
        gate = verdict;
        vote = null;
        gateMoved = true;
    } else {
        vote = verdict;
    }

    return {
        state: {
            serverVersion,
            lowerVersion,
            lowerSince,
            // Only a release version (at most MAX_RELEASE_VERSION long): the registry is read before the first
            // frame, and the banner names this. Null says the last answer gave none it could read.
            lastVersion: readable ? version : null,
            versionGate: gate,
            versionGateVote: vote,
        },
        change: { fresh, gateMoved },
    };
}

const sameState = (a: ServerVersionState, b: ServerVersionState) =>
    a.serverVersion === b.serverVersion &&
    a.lowerVersion === b.lowerVersion &&
    a.lowerSince === b.lowerSince &&
    a.lastVersion === b.lastVersion &&
    a.versionGate === b.versionGate &&
    a.versionGateVote === b.versionGateVote;

export interface ServerVersionsOptions {
    /** The build's variant (`extra.variant`): only development and preview let '0.0.0' through. */
    readonly variant: string;
    /** Writes the state where it outlives Clear cache (the registry's `setServerVersions`). */
    readonly persist: (state: ServerVersionState) => Promise<void>;
    /** The state the registry holds (`serverVersions`), or null for none yet. */
    readonly initial?: ServerVersionRow | null;
    /** A write failed; the next change, or `flush`, writes again. */
    readonly onError?: (error: unknown) => void;
    /**
     * The device clock. The rollback window runs on the server's, each answer's
     * Date; this times an answer without one, with the offset the last Date gave.
     */
    readonly now?: () => number;
}

export interface ServerVersions {
    /**
     * One answer of the version source, in the order answers apply, with the
     * version it reported (null for none) and its Date header (null for none),
     * the server's clock the rollback window runs on. Listeners hear of a move
     * after this returns, never during it.
     */
    observe(version: string | null, date?: string | null): VersionChange;
    /** The highest version seen: the build every scope's rows are keyed by. */
    highest(): string | null;
    /** The gate, or null until two verdicts in a row first agree. */
    gate(): VersionGate | null;
    /** The whole state: memory's, ahead of the store until its write lands. */
    state(): ServerVersionState;
    /** Calls `listener` after each answer that moved the highest version or the gate. Returns the unsubscribe. */
    subscribe(listener: (change: VersionChange) => void): () => void;
    /** Writes the state if the store is behind, after any write in flight; rejects when that write fails. */
    flush(): Promise<void>;
}

/** The server version rules and the minimum-version gate for one workspace. */
export function createServerVersions({
    variant,
    persist,
    initial = null,
    onError = () => {},
    now = Date.now,
}: ServerVersionsOptions): ServerVersions {
    let state = serverVersionState(initial);
    /** What the store holds, as far as the last write that landed says. */
    let stored = state;
    let writing: Promise<void> = Promise.resolve();
    const listeners = new Set<(change: VersionChange) => void>();
    /** The server's clock less the device's, as the last answer with a readable Date had it. */
    let offset = 0;
    /** The server's time of an answer: its Date, or the device clock with the last offset. */
    const serverTime = (date: string | null): number => {
        const device = now();
        const server = date === null ? null : parseCookieDate(date);
        if (server === null) {
            return device + offset;
        }
        offset = server - device;
        return server;
    };

    const write = (): Promise<void> => {
        const snapshot = state;
        // Writes run one at a time, in order, each with the state of its moment.
        const run = writing
            .then(() => persist(snapshot))
            .then(() => {
                stored = snapshot;
            });
        writing = run.catch(() => {});
        return run;
    };

    return {
        observe(version, date = null) {
            const step = stepServerVersions(state, version, variant, serverTime(date));
            if (!sameState(step.state, state)) {
                state = step.state;
                write().catch(onError);
            }
            const { change } = step;
            if (change.fresh || change.gateMoved) {
                // After the answer has applied: a listener that pulls at once doesn't run inside it.
                void Promise.resolve().then(() => {
                    for (const listener of [...listeners]) {
                        listener(change);
                    }
                });
            }
            return change;
        },
        highest: () => state.serverVersion,
        gate: () => state.versionGate,
        state: () => state,
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        async flush() {
            let current: Promise<void>;
            do {
                current = writing;
                await current;
            } while (current !== writing);
            if (!sameState(stored, state)) {
                await write();
            }
        },
    };
}
