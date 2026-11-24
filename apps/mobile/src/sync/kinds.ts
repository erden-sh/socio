import { LAST_SCREEN_KEY } from '../shell/last-screen';

import { APPROVALS, APPROVALS_POLL_MS, APPROVALS_SNAPSHOT } from './approvals';
import { ISSUE_COMPONENTS, ISSUE_USERS, ISSUES, ISSUES_POLL_MS, ISSUES_SNAPSHOT } from './issues';
import { MEMORIES, MEMORIES_POLL_MS, MEMORIES_SNAPSHOT, MEMORY_PROFILE } from './memories';
import { ROOM_INVITES, ROOM_INVITES_POLL_MS, ROOM_INVITES_SNAPSHOT } from './room-invites';
import { RUNS, RUNS_POLL_MS, RUNS_SNAPSHOT } from './runs';
import { GOALS, JOBS, SCHEDULE_LIMITS, SCHEDULES, SCHEDULES_POLL_MS, SCHEDULES_SNAPSHOT } from './schedules';
import { SKILLS, SKILLS_SNAPSHOT } from './skills';
import type { SnapshotDefinition } from './snapshot-cache';

// The modules' snapshot kinds, beside the shell's two (shell.ts). Each
// is a whole kind: one conditional GET, its rows in cache.db.
// - Before the first frame, only the kept screen's kind is read from cache.db
//   (`firstFrameSnapshots`), so a cold start reads no more than it draws; the
//   rest is read just after (the scope's `start`), or by the kind's first pull.
// - Each is pulled after the shell (`deferred`), on its screen coming into view,
//   and polled while that screen stays in view at the web's interval
//   (`visiblePoll`), never in the background. Issues are also pulled with the
//   shell (a start, a return), for Home's count and Search's keys; the others
//   (memories, schedules, runs, skills) only while their screen is in
//   view (`inView`), since nothing else shows them.
// - None is gated: the web shows every one of these modules to everyone (none of their
//   manifests has an `access` rule), so a 403 or 404 is an error the poll backs
//   off from, never a wipe.

/** A module's kind: its snapshot, what it fills, and its visible poll. */
export interface ModuleKind {
    readonly definition: SnapshotDefinition;
    readonly collections: readonly string[];
    /** The web's interval while its screen is in view; none for a kind the web reads once (skills). */
    readonly visiblePoll?: number;
    /** Pulled only while its screen is in view, never with the shell. */
    readonly inView?: boolean;
    /** The kept screens (`lastScreen` values) that draw it in the first frame. */
    readonly screens: readonly string[];
}

export const ISSUES_KIND: ModuleKind = {
    definition: ISSUES_SNAPSHOT,
    collections: [ISSUES, ISSUE_USERS, ISSUE_COMPONENTS],
    visiblePoll: ISSUES_POLL_MS,
    // The issue detail isn't a kept screen yet.
    screens: ['Board'],
};

// The person's approval requests, pulled with the shell for the Inbox and the
// badge, and every 60 s while an approvals screen or the Inbox shows. It has
// no kept screens yet.
export const APPROVALS_KIND: ModuleKind = {
    definition: APPROVALS_SNAPSHOT,
    collections: [APPROVALS],
    visiblePoll: APPROVALS_POLL_MS,
    screens: [],
};

// The room invites waiting for the person, only for the Inbox and
// Home: pulled as either comes into view, on a return or the network back
// while one shows, and every 60 s while it stays (`inView`). Home and the Inbox
// read cache.db's copy with the scope's start.
export const ROOM_INVITES_KIND: ModuleKind = {
    definition: ROOM_INVITES_SNAPSHOT,
    collections: [ROOM_INVITES],
    visiblePoll: ROOM_INVITES_POLL_MS,
    inView: true,
    screens: [],
};

// Memories, Schedules, Runs and Learning each keep their own screen.

export const MEMORIES_KIND: ModuleKind = {
    definition: MEMORIES_SNAPSHOT,
    collections: [MEMORIES, MEMORY_PROFILE],
    visiblePoll: MEMORIES_POLL_MS,
    inView: true,
    screens: ['Memories'],
};

export const SCHEDULES_KIND: ModuleKind = {
    definition: SCHEDULES_SNAPSHOT,
    collections: [SCHEDULES, GOALS, JOBS, SCHEDULE_LIMITS],
    visiblePoll: SCHEDULES_POLL_MS,
    inView: true,
    screens: ['Schedules'],
};

export const RUNS_KIND: ModuleKind = {
    definition: RUNS_SNAPSHOT,
    collections: [RUNS],
    visiblePoll: RUNS_POLL_MS,
    inView: true,
    screens: ['Runs'],
};

export const SKILLS_KIND: ModuleKind = {
    definition: SKILLS_SNAPSHOT,
    collections: [SKILLS],
    inView: true,
    screens: ['Learning'],
};

/** Every module's kind, in the order a pull asks them. */
export const MODULE_KINDS: readonly ModuleKind[] = [
    ISSUES_KIND,
    APPROVALS_KIND,
    ROOM_INVITES_KIND,
    MEMORIES_KIND,
    SCHEDULES_KIND,
    RUNS_KIND,
    SKILLS_KIND,
];
export const MODULE_SNAPSHOTS: readonly SnapshotDefinition[] = MODULE_KINDS.map((kind) => kind.definition);

/** The module kinds the kept screen draws, read from cache.db before the first frame. */
export function firstFrameSnapshots(viewState: { get(key: string): string | null }): SnapshotDefinition[] {
    const kept = viewState.get(LAST_SCREEN_KEY);
    return MODULE_KINDS.filter((kind) => kept !== null && kind.screens.includes(kept)).map((kind) => kind.definition);
}
