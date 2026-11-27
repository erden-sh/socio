/**
 * What other features may know of memory: a person's memories, profile,
 * time zone notes and episodes, and each Space's shared memory (CB-106,
 * CB-176, CB-180, CB-181). Its tags, as slices of the methods callers use,
 * the error the Space memory routes answer, and the plain types and
 * constants they name. It imports only `effect` and `@socio/*`, and holds
 * no logic.
 *
 * The types here moved from the files that defined them
 * (`domain/repositories.ts`, `turn.ts`, `time-zone.ts`, `space-memory.ts`),
 * which re-export them, so every importer keeps compiling until that importer
 * switches to the contract. The two pure helpers other features call moved to
 * `@socio/foundation/memory/*` (`memory-of`, `person-said`); the feature logic
 * (a turn's recall, its time zone, Space memory, the Memories page) is behind
 * the tags below.
 *
 * Not here, on purpose:
 * - `sqliteMemoryRepositories` (`infra/sqlite`): what the core store
 *   (`composition/core-store.ts`) builds the repositories with,
 *   construction only. It holds them (`memoryItems`, `profiles`,
 *   `timeZoneNotes`, `episodes`, `spaceMemories`).
 * - `memoryRoutes`, `memoriesModule` and the env readers (`turnRecallTokensFromEnv`
 *   and the two retention ones, in `composition/config.ts`): route mounting,
 *   the module registry and the server's start, all entry code.
 * - `spaceMemoryRetentionDays` and `episodeRetentionDays`: Settings' `Limits`
 *   gives the same (`inForce(settings)`); the one folder that calls the
 *   first does so only to build the Space memory service, which the
 *   `SpaceMemory` tag gives it built.
 *
 * `MemoryConfig` is the server's own retention, from the
 * startup configuration: what memory read of `PlatformConfig` through
 * Settings' `limitDefaults(config)`, now read by memory itself.
 */
import { Context } from 'effect';

import type { OwnedList, ThreadFollower, TransferParties, TransferTally } from '@socio/shared/auth';
import type {
    Episode,
    MemoriesState,
    MemoryItem,
    MemorySource,
    ProfileFields,
    UserProfile,
} from '@socio/shared/memory';
import type {
    SpaceMemoryState,
    SpaceMemoryStatus,
    SpaceMemoryVersion,
    SpaceMemoryView,
} from '@socio/shared/space-memory';
import type { Space } from '@socio/shared/types';

import type { TelegramThreadInfo } from '../integrations/contract.js';
import type { SocioReader } from '../workspace/contract.js';

// ── Repositories ─────────────────────────────────────────────────────────

/*
 * The Memory context's repositories (CB-110): a person's
 * memories and profile (CB-106), the notes of a detected time zone that
 * moved (CB-176), their episodes (CB-180) and each Space's shared memory
 * (CB-181). Async, taking and returning plain domain types. Only
 * `memory/infra` implements them; nothing else touches their tables.
 * Every write works inside or outside a unit of work: outside one it opens
 * its own, so there is a single writer path.
 */

/**
 * What adding a memory takes: the person's own (added by them, or asked of
 * a socio in a chat, CB-172), or a socio's proposal.
 */
export interface NewMemory {
    userId: string;
    text: string;
    source: MemorySource;
    shareable?: boolean;
    dotId?: string | null;
    threadId?: string | null;
}

/** What a person may change on a memory. */
export interface MemoryPatch {
    text?: string;
    shareable?: boolean;
}

/** A memory as stored, soft-delete stamps included (admin views, tests). */
export type StoredMemory = MemoryItem & {
    userId: string | null;
    deletedAt: number | null;
    deletedBy: string | null;
};

/**
 * A person's memories (CB-106). Every call names the owner, and a row of
 * anyone else is never read or changed. A memory the person adds is active
 * at once; one a socio proposes waits (`proposed`) until the person
 * approves it. Forgetting stamps it deleted (CB-64): gone from the person,
 * their socios and every turn, and kept.
 */
export interface MemoryRepository {
    /** The person's live memories, active and proposed, newest first. */
    list(userId: string): Promise<MemoryItem[]>;
    /** The person's active memories, for a turn; only shareable ones when asked. */
    active(userId: string, options?: { shareableOnly?: boolean }): Promise<MemoryItem[]>;
    get(id: string, userId: string): Promise<MemoryItem | undefined>;
    /** By id, whoever's and deleted or not, with its stamp. */
    withDeleted(id: string): Promise<StoredMemory | undefined>;
    /**
     * Adds one. A socio's proposal of what the person already has (active or
     * waiting, the same words but for case and spaces) adds nothing and
     * returns that one; so does one the person asked a socio to save
     * (CB-172: `source` person, with the socio's `dotId`), which approves
     * the same words waiting.
     */
    add(memory: NewMemory, now?: number): Promise<MemoryItem>;
    update(id: string, userId: string, patch: MemoryPatch, now?: number): Promise<MemoryItem | undefined>;
    /** A proposal becomes active; anything else is left as it is. */
    approve(id: string, userId: string, now?: number): Promise<MemoryItem | undefined>;
    /** The person says an active memory still holds. */
    confirm(id: string, userId: string, now?: number): Promise<MemoryItem | undefined>;
    /** Forgets a memory, or turns down a proposal. */
    forget(id: string, userId: string, now?: number): Promise<boolean>;
    /** How many proposals wait for the person. */
    waiting(userId: string): Promise<number>;
    /** Gives memories from before user accounts to a user; says how many. */
    assignUnowned(userId: string): Promise<number>;
}

/**
 * A person's profile (CB-106). Only the person writes it. One live version
 * per person: saving stamps the one before as deleted and adds the new
 * one, and clearing stamps it (CB-64), so every earlier version is kept.
 */
export interface ProfileRepository {
    get(userId: string): Promise<UserProfile | null>;
    /**
     * Saves the fields given (empty ones left out); none at all clears it.
     * The time zone is marked detected (CB-159) when `timezoneDetected` says
     * so, or when it was and is saved again unchanged.
     */
    save(
        userId: string,
        profile: {
            fields: ProfileFields;
            shareable: boolean;
            timezoneDetected?: boolean;
        },
        now?: number,
    ): Promise<UserProfile | null>;
    clear(userId: string, now?: number): Promise<boolean>;
    /** Whether the person had a profile and cleared it: none live, some kept. */
    cleared(userId: string): Promise<boolean>;
}

/** Where the person sees a note: their next chat, or the Memories page. */
export type TimeZoneNotePlace = 'chat' | 'page';

/**
 * The quiet notes of a detected time zone that moved (CB-176). When a
 * person's detected zone follows their browser to another, they are told
 * once in their next chat and once on the Memories page: "Your time zone
 * is now Europe/Madrid (detected from your browser)". One note per person,
 * the latest move's; a newer move starts it over.
 */
export interface TimeZoneNoteRepository {
    /** Notes that the person's detected zone is now `zone`, to show in both places. */
    add(userId: string, zone: string, now?: number): Promise<void>;
    /** The zone of the note still to show in `place`, if there is one. */
    pending(userId: string, place: TimeZoneNotePlace): Promise<string | null>;
    /**
     * Marks the note of `zone` shown in `place`; says whether it was still to
     * show there, so two turns at once show it only once.
     */
    shown(userId: string, place: TimeZoneNotePlace, zone: string, now?: number): Promise<boolean>;
}

/**
 * What one compaction of a person's own chat gives their episodes
 * (CB-180): the facts its notes newly pinned, and its summary now.
 */
export interface EpisodeCapture {
    userId: string;
    threadId: string;
    dotId?: string | null;
    facts: readonly string[];
    /** The chat's running summary, the model's; none when it fell back. */
    summary?: string;
    /** When it happened (the newest folded turn's time), else now. */
    occurredAt?: number;
}

/**
 * A person's episodes (CB-180). Every call names the owner, and a row of
 * anyone else is never read or removed. Captured automatically, with no
 * approval: they are not memories. Removing one deletes its row (no soft
 * delete): gone from the person, their socios and every turn at once.
 */
export interface EpisodeRepository {
    /**
     * Adds the facts as episodes, and the summary as the chat's one summary
     * episode. A fact the chat pinned before is the same row, moved on to
     * `occurredAt`. Says how many rows it added or moved.
     */
    capture(capture: EpisodeCapture, now?: number): Promise<number>;
    /**
     * The person's episodes, newest first: all, or those whose words match
     * `query`, best first (BM25 over the newest `EPISODES_SEARCHED`).
     * `kind` keeps one kind; `excludeThreadId` leaves out one chat's.
     */
    list(
        userId: string,
        options?: {
            query?: string;
            limit?: number;
            kind?: Episode['kind'];
            excludeThreadId?: string;
        },
    ): Promise<Episode[]>;
    /** How many episodes the person has. */
    count(userId: string): Promise<number>;
    /** Deletes one of the person's episodes; false when it isn't theirs. */
    remove(id: string, userId: string): Promise<boolean>;
    /** Deletes all of the person's episodes, or one chat's; says how many. */
    removeAll(userId: string, options?: { threadId?: string }): Promise<number>;
    /**
     * Retention: deletes episodes that last came up before `before`, at
     * most `max` (oldest first); says how many. The leader runs it.
     */
    expire(before: number, max?: number): Promise<number>;
}

/**
 * What a Space memory version starts from (CB-181): a new entry (no
 * `entryId`), or a change to the entry's version in use (`supersedes`).
 */
export interface NewSpaceMemory {
    spaceId: string;
    text: string;
    proposedBy: string;
    dotId?: string | null;
    threadId?: string | null;
    /** The entry it changes, with the version in use it replaces. */
    entryId?: string;
    supersedes?: string | null;
}

/** Why a Space memory change did not happen. */
export type SpaceMemoryRefusal =
    /** No such version or entry in the Space. */
    | 'not_found'
    /** It is not waiting any more (approved, rejected, withdrawn). */
    | 'not_waiting'
    /** The entry changed since it was proposed, or was retired. */
    | 'changed'
    /** The same words are in use or waiting already. */
    | 'duplicate'
    /** The entry is still in use (retire it first). */
    | 'in_use';

export type SpaceMemoryResult =
    | { ok: true; version: SpaceMemoryVersion }
    | { ok: false; reason: SpaceMemoryRefusal; version?: SpaceMemoryVersion };

/**
 * A Space's shared memory (CB-181). Every call names the Space, and a row
 * of another Space is never read or changed through it. Each change is a
 * new row or a status move inside one unit of work: an approved change
 * supersedes the version before, so an entry has one version in use at
 * most. Nothing here checks who may: `SpaceMemoryService` does, with the
 * Space's access, before it calls.
 */
export interface SpaceMemoryRepository {
    /** One version, in its Space. */
    get(spaceId: string, id: string): Promise<SpaceMemoryVersion | undefined>;
    /** An entry's versions, newest first. */
    history(spaceId: string, entryId: string): Promise<SpaceMemoryVersion[]>;
    /** The Space's versions in `statuses`, newest first, at most `limit`. */
    list(spaceId: string, statuses: readonly SpaceMemoryStatus[], limit?: number): Promise<SpaceMemoryVersion[]>;
    /** The versions in use in these Spaces, newest first. */
    active(spaceIds: readonly string[]): Promise<SpaceMemoryVersion[]>;
    /** How many versions of the Space are in `status`. */
    count(spaceId: string, status: SpaceMemoryStatus): Promise<number>;
    /**
     * Adds a proposal. The same words in use or waiting in the Space (but
     * for case and spaces) add nothing: `duplicate`, with that version.
     * A change to an entry names its version in use, which must still be.
     */
    propose(memory: NewSpaceMemory, now?: number): Promise<SpaceMemoryResult>;
    /**
     * Adds a version in use at once, decided by `by` (an editor's own entry
     * or edit): a change supersedes the version in use, which must be the
     * one it names.
     */
    add(memory: NewSpaceMemory, by: string, now?: number): Promise<SpaceMemoryResult>;
    /**
     * A proposal becomes the entry's version in use (with `text` when the
     * editor changed its words), numbered after the entry's last, and the
     * version it supersedes is superseded. Refused when it waits no more,
     * or the entry moved on since it was proposed.
     */
    approve(
        spaceId: string,
        id: string,
        by: string,
        options?: { text?: string },
        now?: number,
    ): Promise<SpaceMemoryResult>;
    /** An editor turns a proposal down (`rejected`), or its proposer takes it back (`withdrawn`). */
    close(
        spaceId: string,
        id: string,
        by: string,
        status: 'rejected' | 'withdrawn',
        now?: number,
    ): Promise<SpaceMemoryResult>;
    /**
     * Takes the entry out of use (`retired`); the proposals waiting to
     * change it are rejected with it.
     */
    retire(spaceId: string, entryId: string, by: string, now?: number): Promise<SpaceMemoryResult>;
    /**
     * Deletes an entry out of use, every version of it; refused while it is
     * in use. Says how many rows went.
     */
    remove(
        spaceId: string,
        entryId: string,
    ): Promise<{ ok: true; deleted: number } | { ok: false; reason: SpaceMemoryRefusal }>;
    /**
     * Retention: deletes what has been out of use since before `before`
     * (superseded, rejected and withdrawn versions; retired entries whole)
     * and proposals waiting since before it, at most `max` rows, oldest
     * first. Says how many. The leader runs it.
     */
    expire(before: number, max?: number): Promise<number>;
}

export interface MemoryRepositories {
    memories: MemoryRepository;
    profiles: ProfileRepository;
    timeZoneNotes: TimeZoneNoteRepository;
    episodes: EpisodeRepository;
    spaceMemories: SpaceMemoryRepository;
}

/*
 * The repositories as tags, one each, as the core store holds them
 * (`store.memoryItems`, `store.profiles`, `store.timeZoneNotes`,
 * `store.episodes`, `store.spaceMemories`). `infra/sqlite`'s classes
 * implement them.
 */

export class MemoryItems extends Context.Service<MemoryItems, MemoryRepository>()('socio/memory/MemoryItems') {}

export class Profiles extends Context.Service<Profiles, ProfileRepository>()('socio/memory/Profiles') {}

export class TimeZoneNotes extends Context.Service<TimeZoneNotes, TimeZoneNoteRepository>()(
    'socio/memory/TimeZoneNotes',
) {}

export class Episodes extends Context.Service<Episodes, EpisodeRepository>()('socio/memory/Episodes') {}

export class SpaceMemories extends Context.Service<SpaceMemories, SpaceMemoryRepository>()(
    'socio/memory/SpaceMemories',
) {}

// ── Constants (`turn.ts`) ────────────────────────────────────────────────

export { DEFAULT_EPISODE_RETENTION_DAYS, DEFAULT_SPACE_MEMORY_RETENTION_DAYS } from '@socio/shared/memory/retention';

// ── Config ───────────────────────────────────────────────────────────────

/**
 * What memory reads of the server's configuration: the
 * retentions' starting values (`EPISODE_RETENTION_DAYS` and
 * `SPACE_MEMORY_RETENTION_DAYS`, as the boot step read them), unset when
 * left out. An admin's value in Settings → Limits is over them, and the
 * defaults above under them (`retention.ts`).
 */
export interface MemoryConfigShape {
    readonly episodeRetentionDays?: number;
    readonly spaceMemoryRetentionDays?: number;
}

export class MemoryConfig extends Context.Service<MemoryConfig, MemoryConfigShape>()('socio/memory/MemoryConfig') {}

// ── A turn's recall (`turn.ts`, `space-memory.ts`) ───────────────────────

/** One entry a turn may use, with the Space it is from. */
export interface SpaceMemoryHit {
    entryId: string;
    spaceId: string;
    spaceName: string;
    text: string;
    /** When the version in use was approved. */
    approvedAt: number;
}

/** The turn `personalContext` gives its person's context for. */
export interface PersonalContextTurn {
    userId: string;
    shared: boolean;
    query: string;
    /** The recall budget in force (CB-173); the default when unset. */
    recallTokens?: number;
    /**
     * The chat the turn is in (CB-180): its own episodes are in its notes
     * already, so the note gives only other chats'.
     */
    threadId?: string;
    /** A chat of the person's by id, for an episode's provenance. */
    chatTitle?: (threadId: string) => string | undefined;
    /**
     * The Space memory this chat may have (CB-181, `spaceMemoryForTurn`):
     * entries of Spaces every reader of the chat can read, best first.
     */
    spaceMemory?: readonly SpaceMemoryHit[];
}

/** The turn's lines about its person, and the ids of what they used. */
export interface PersonalContext {
    lines: string[];
    /**
     * Whether `lines` give the person's profile with a language in it: the
     * turn's note then has no line for their app language, which the
     * profile's words win over.
     */
    language: boolean;
    memoryIds: string[];
    episodeIds: string[];
    spaceEntryIds: string[];
}

/** The turn `spaceMemoryForTurn` finds Space memory for. */
export interface SpaceMemoryTurn {
    dotId: string;
    threadId: string;
    userId: string;
    query: string;
}

/**
 * What a socio's turn recalls (CB-106, CB-180, CB-181, CB-210), as `dots/`
 * and `context/` call it, on the platform's store and workspace.
 * `recall.ts`'s `turnMemory` builds it over `turn.ts` and `space-memory.ts`.
 */
export interface TurnMemoryShape {
    /**
     * Whether the chat has people besides `userId` in it (`sharedChat`):
     * every private-context rule keys on it. Unknown chats count as shared.
     */
    sharedChat(threadId: string, userId: string): Promise<boolean>;
    /** The turn's lines about its person (`personalContext`); none when they have nothing to give. */
    personalContext(turn: PersonalContextTurn): Promise<PersonalContext>;
    /** The Space memory the turn may recall (`spaceMemoryForTurn`), best first. */
    spaceMemoryForTurn(turn: SpaceMemoryTurn): Promise<SpaceMemoryHit[]>;
}

export class TurnMemory extends Context.Service<TurnMemory, TurnMemoryShape>()('socio/memory/TurnMemory') {}

// ── A person's time zone (`time-zone.ts`) ────────────────────────────────

/**
 * The time zone a turn speaks in (CB-159): its acting person's, in this
 * order: their profile's, when it names a valid IANA zone; else the zone
 * their browser sent with the request (web turns only); else UTC, which
 * the turn's note then says is not theirs. Read for every turn (web,
 * Telegram, scheduled and job), whether or not the turn uses
 * the rest of the profile.
 *
 * `zone` is for the turn's note, which only this turn sends. What a turn
 * stores and later turns send again (its time marker, a fold's notes) is
 * in `stored`, the same zone.
 *
 * In a chat with other people in it (`shared`), the zone is the person's
 * only when they shared their profile with team chats and it names one
 * (CB-210): neither a private profile's zone nor the browser's reaches the
 * turn, whose answer everyone there reads. Otherwise it is the workspace's
 * (`workspaceZone`, Operations' time zone, UTC unless an admin set one),
 * and the turn's note says so.
 */
export interface TurnTimeZone {
    zone: string;
    source: 'profile' | 'browser' | 'default' | 'workspace';
    stored: string;
}

/**
 * A person's time zone (CB-159, CB-176), as `dots/` reads it for a turn
 * and the composition saves the browser's, on the store's profiles and time zone
 * notes. `recall.ts`'s `timeZones` builds it over `time-zone.ts`.
 */
export interface TimeZonesShape {
    /** The zone the turn speaks in (`turnTimeZone`). */
    turnTimeZone(userId: string, browser?: string, shared?: boolean, workspaceZone?: string): Promise<TurnTimeZone>;
    /** The zone of the quiet note still to show the person in `place` (`movedTimeZone`). */
    movedTimeZone(userId: string, place: TimeZoneNotePlace): Promise<string | undefined>;
    /**
     * Saves the browser's zone to the person's profile when it has none, or
     * a detected one moved, with a note of the move (`rememberBrowserTimeZone`);
     * says whether it saved.
     */
    rememberBrowserTimeZone(userId: string, browser: unknown, now?: number): Promise<boolean>;
}

export class TimeZones extends Context.Service<TimeZones, TimeZonesShape>()('socio/memory/TimeZones') {}

// ── Space memory (`space-memory.ts`) ─────────────────────────────────────

/**
 * A Space memory refusal, with the HTTP status the routes answer it with.
 * Caught with `instanceof` in `spaces/` and the memories module; kept a
 * plain `Error` so its name, message and JSON stay what they are today.
 */
export class SpaceMemoryError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 403 | 404 | 409,
    ) {
        super(message);
        this.name = 'SpaceMemoryError';
    }
}

/** What a person or socio proposes. */
export interface SpaceMemoryProposal {
    text: string;
    /** The entry it changes; its version in use is the one replaced. */
    entryId?: string;
    /** The socio proposing, for the person (`by`) it acts for. */
    dotId?: string | null;
    threadId?: string | null;
}

/**
 * A Space's shared memory, governed (CB-181), as `spaces/` serves it: every
 * call asks the Space's access afresh and throws `SpaceMemoryError` (or
 * the access's error) when refused. `space-memory.ts`'s `SpaceMemoryService`
 * implements it.
 *
 * Not in the slice: the service's `access` getter, the workspace's
 * `SpaceAccess` (`spaces/access.ts`, which has no contract yet); the
 * Space people routes reach it through the workspace's own.
 */
export interface SpaceMemoryShape {
    /** `GET /api/spaces/:id/memory`. */
    view(spaceId: string, viewer: string): Promise<SpaceMemoryState>;
    /** An entry's versions, newest first, as the viewer may see them. */
    history(spaceId: string, entryId: string, viewer: string): Promise<SpaceMemoryView[]>;
    /** Proposes an entry or a change for `by`; an editor's own is in use at once. */
    propose(
        spaceId: string,
        by: string,
        proposal: SpaceMemoryProposal,
    ): Promise<{ version: SpaceMemoryVersion; waiting: boolean }>;
    approve(spaceId: string, id: string, by: string, options?: { text?: string }): Promise<SpaceMemoryVersion>;
    reject(spaceId: string, id: string, by: string): Promise<SpaceMemoryVersion>;
    withdraw(spaceId: string, id: string, by: string): Promise<SpaceMemoryVersion>;
    retire(spaceId: string, entryId: string, by: string): Promise<SpaceMemoryVersion>;
    /** Deletes a retired entry, every version of it; says how many rows went. */
    remove(spaceId: string, entryId: string, by: string): Promise<number>;
}

export class SpaceMemory extends Context.Service<SpaceMemory, SpaceMemoryShape>()('socio/memory/SpaceMemory') {}

// ── The Memories page (`routes.ts`) ──────────────────────────────────────

/**
 * What the Memories page shows its person (CB-106), as `web/` reads it for
 * the page's first render. `routes.ts`'s `memoriesViews` builds it over
 * `memoriesView`.
 */
export interface MemoriesViewShape {
    /** `GET /api/memories`: the person's profile, memories and proposals. */
    view(userId: string): Promise<MemoriesState>;
}

export class MemoriesView extends Context.Service<MemoriesView, MemoriesViewShape>()('socio/memory/MemoriesView') {}

/**
 * A person's memories, and handing them to another person (CB-360's
 * transfer); their episodes follow the conversations they came from
 * (`followThreads`). `infra/sqlite/ownership.ts` implements it.
 */
export interface MemoryOwnershipShape extends ThreadFollower {
    owned(userId: string): OwnedList;
    /**
     * Every memory of `from`, inside the caller's transaction: what a
     * socio knew about one person isn't true of another until they say
     * so, so the ones in use arrive as proposals for the new owner to keep,
     * edit or turn down.
     */
    transfer(parties: TransferParties): TransferTally;
}

// ── What the module's tools read above memory ────────────────────────────

/**
 * A chat's Telegram facts, as the module's tools tell a shared chat
 * (`sharedChat`): telegram's `Links`, by the slice they call (telegram is
 * above memory in the folder order, so the port is declared here and the
 * composition provides it from `Links`).
 */
export interface MemoryTelegramShape {
    threadInfo(threadId: string): Promise<TelegramThreadInfo | undefined>;
}

export class MemoryTelegram extends Context.Service<MemoryTelegram, MemoryTelegramShape>()(
    'socio/memory/MemoryTelegram',
) {}

/**
 * The Spaces a socio may propose shared memory to (`propose_space_memory`):
 * the Spaces' `Access`, by the slice the tool calls (spaces is above
 * memory in the folder order, so the port is declared here and the
 * composition provides it from `Access`).
 */
export interface MemorySpacesShape {
    /** `reads` for a person: the one read check. */
    canRead(spaceId: string, userId: string): boolean;
    /** The Spaces `reader` may read now. */
    readable(reader: SocioReader): Space[];
}

export class MemorySpaces extends Context.Service<MemorySpaces, MemorySpacesShape>()('socio/memory/MemorySpaces') {}
