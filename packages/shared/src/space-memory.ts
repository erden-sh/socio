import { isAdmin } from './roles.js';
import type { Role } from './types.js';

/**
 * Shared memory of a Space (CB-181, docs/MEMORY.md "Space memory"): what
 * the Space's people and socios know together, one entry at a time.
 * Members and socios propose entries; the Space's editors approve them.
 * Who may read and approve is the Space's access (below), checked every
 * time an entry is read: on its page and in every turn.
 */

/**
 * A person's stored role in a Space (`space_members`): an `editor`
 * approves, edits and retires its memory and manages its people; a
 * `member` reads it and proposes. Workspace admins are editors of every
 * Space without a row (they create and manage Spaces).
 */
export const SPACE_ROLES = ['editor', 'member'] as const;
export type SpaceRole = (typeof SPACE_ROLES)[number];

/** What a person may do with a Space's memory, by the rule below. */
export type SpaceAccessLevel = 'editor' | 'reader';

/**
 * The one rule of Space access (CB-181). A Space open to the workspace
 * (the default, as its pages are) is read by every active person; one
 * set to its people only (`membersOnly`) is read by its members and
 * editors alone. Editors are the Space's `editor` rows and the workspace's
 * admins. A deactivated or unknown person, or a Space that is gone,
 * gives nothing.
 */
export function spaceAccessLevel(input: {
    person: { role: Role; deactivated: boolean } | undefined;
    space: { membersOnly: boolean } | undefined;
    member?: { role: SpaceRole };
}): SpaceAccessLevel | null {
    const { person, space, member } = input;
    if (!person || person.deactivated || !space) {
        return null;
    }
    if (isAdmin(person) || member?.role === 'editor') {
        return 'editor';
    }
    if (member) {
        return 'reader';
    }
    return space.membersOnly ? null : 'reader';
}

/** A person's row in a Space. */
export interface SpacePerson {
    userId: string;
    name: string;
    role: SpaceRole;
    addedBy: string | null;
    addedAt: number;
}

/** `GET /api/spaces/:id/people`: who reads and approves the Space's memory. */
export interface SpacePeopleView {
    spaceId: string;
    /** Read by its people only; otherwise by everyone in the workspace. */
    membersOnly: boolean;
    people: SpacePerson[];
    /** The viewer's level. */
    access: SpaceAccessLevel;
    /** Everyone who may be added (editors only); empty for a reader. */
    candidates: Array<{ id: string; name: string }>;
}

/**
 * An entry's version's state. `proposed`: waiting for an editor;
 * `active`: in use (one per entry at most); `superseded`: an earlier
 * version, replaced by a newer approved one; `rejected`: an editor
 * turned the proposal down; `withdrawn`: its proposer took it back;
 * `retired`: the entry's last version, taken out of use by an editor.
 */
export const SPACE_MEMORY_STATUSES = ['proposed', 'active', 'superseded', 'rejected', 'withdrawn', 'retired'] as const;
export type SpaceMemoryStatus = (typeof SPACE_MEMORY_STATUSES)[number];

/**
 * One version of a Space memory entry, with its provenance. Every change
 * is a new row: an entry's versions share `entryId`, and the approved
 * ones are numbered from 1.
 */
export interface SpaceMemoryVersion {
    /** This version's id. */
    id: string;
    /** The entry across its versions. */
    entryId: string;
    spaceId: string;
    /** Numbered when approved (1, 2, …); null while proposed or turned down. */
    version: number | null;
    text: string;
    status: SpaceMemoryStatus;
    /**
     * The person who proposed it: themselves, or the person a socio acted
     * for when it proposed it (`dotId`).
     */
    proposedBy: string;
    /** The socio that proposed it; null when a person did. */
    dotId: string | null;
    /** The chat it was proposed in; null from the Space's Memory tab. */
    threadId: string | null;
    /** The version in use it would replace, for a proposed change. */
    supersedes: string | null;
    createdAt: number;
    /** The editor who approved or rejected it, and when. */
    decidedBy: string | null;
    decidedAt: number | null;
    /** Who superseded, withdrew or retired it, and when. */
    endedBy: string | null;
    endedAt: number | null;
}

/** A version as the Memory tab shows it: names for its ids, when the viewer may see them. */
export interface SpaceMemoryView extends SpaceMemoryVersion {
    proposedByName: string;
    dotName: string | null;
    /** The chat's title, only when the viewer can open that chat. */
    chatTitle: string | null;
    decidedByName: string | null;
    endedByName: string | null;
}

/** `GET /api/spaces/:id/memory`: the Space's memory, as the viewer may see it. */
export interface SpaceMemoryState {
    spaceId: string;
    access: SpaceAccessLevel;
    /** The entries in use, newest change first. */
    entries: SpaceMemoryView[];
    /** Proposals waiting: all of them for an editor, a reader's own otherwise. */
    proposals: SpaceMemoryView[];
    /** Retired entries still kept (editors only), newest first. */
    retired: SpaceMemoryView[];
    /** How long what is out of use is kept (Settings, CB-181). */
    retentionDays: number;
}

/** The longest entry. */
export const SPACE_MEMORY_TEXT_MAX = 1_000;
/** At most this many proposals wait in one Space; more are refused. */
export const SPACE_PROPOSALS_WAITING_MAX = 100;
/** The most entries in use in one Space. */
export const SPACE_MEMORY_ENTRIES_MAX = 500;
