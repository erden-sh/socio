/**
 * What other features may know of the workspace: tags and types only,
 * importing nothing from other server features but their contracts.
 *
 * `WorkspaceStore` splits into four slices, `People`, `Spaces`, `Socios` and
 * `Audit`, plus `Conversations`, added later. Each is a tag over the methods
 * callers use, with the signatures they have today. The slices are synchronous
 * where SQLite is, as every caller is (`People` keeps a synchronous slice),
 * and keep today's promises where a method awaits another store.
 * `workspace/layer.ts` provides them from the boot step's store;
 * `WorkspaceStore` implements all five, as the legacy facade that later
 * changes remove.
 */
import { Context } from 'effect';

import type { TranscriptionProvider, TranscriptionSources } from '@socio/foundation/voice/transcription-provider';
import type { WorkspaceAppEntry } from '@socio/shared/apps/app-types';
import type { OwnedList, TransferParties, TransferTally } from '@socio/shared/auth';
import type { HistoryPage } from '@socio/shared/chat/chat-history';
import type { ReplyReportsState } from '@socio/shared/chat/reply-reports';
import type { ClientFlags } from '@socio/shared/flags';
import type { ModelChoice } from '@socio/shared/inference';
import type { LocalId } from '@socio/shared/mascot';
import type { PluginLauncherEntry } from '@socio/shared/plugins/plugins';
import type { RoomAction, RoomDecision } from '@socio/shared/rooms/rooms';
import type { SpaceRole } from '@socio/shared/space-memory';
import type {
    CallReceipt,
    Conversation,
    DeleteBlocker,
    DeletedSpace,
    Dot,
    SetupStatus,
    Settings,
    Space,
    User,
    WorkspacePermissions,
    WorkspaceState,
} from '@socio/shared/types';
import type { ReleaseView } from '@socio/shared/updates/release-seen';
import type { UserPreferences } from '@socio/shared/voice/dictation';

import type { RoomAccessCheck } from '../rooms/contract.js';

// ── Plain types ──────────────────────────────────────────────────────────

/** One line of a Dot's own audit (`dot_audit`). */
export interface DotAuditEntry {
    /** A user id, or `system`. */
    actor: string;
    action: 'create' | 'update' | 'archive' | 'unarchive';
    /** What changed (setting names, on/off), never instructions' text. */
    detail: string;
    createdAt: number;
}

/**
 * A `workspace_audit` line (CB-64): a soft delete, or the end of state that
 * stays hard but granted something (a Telegram link, a backend), or a
 * person deactivated or reactivated (accounts.ts).
 */
export interface WorkspaceAuditEntry {
    /** A user id, `system`, `dot:<id>`, or `cli` (the auth CLI). */
    actor: string;
    action:
        | 'create'
        | 'update'
        | 'delete'
        | 'move'
        | 'unlink'
        | 'remove'
        | 'deactivate'
        | 'reactivate'
        | 'revoke'
        // A Space memory proposal's course (CB-181).
        | 'propose'
        | 'approve'
        | 'reject'
        | 'withdraw'
        | 'retire'
        // A deleted Space brought back by an admin (CB-277).
        | 'restore'
        // The data key's re-seal and a recovery key check (CB-322).
        | 'reseal'
        // An admin's Back up now of a plugin's own storage (CB-458).
        | 'backup'
        | 'verify'
        // Socio Secrets: a grant to a workload, a workload's read, and a read
        // refused. Never the value.
        | 'grant'
        | 'read'
        | 'deny'
        // What a person owns, moved to another person (CB-360).
        | 'transfer'
        // A data API token's use since its last line: counts, never values.
        | 'use';
    targetKind:
        | 'operations_settings'
        /** Model prices and cost pools (CB-195, CB-196). */
        | 'operations_pricing'
        | 'conversation'
        | 'page'
        | 'memory'
        /** A person's episode, or all of theirs (CB-180): ids only, never text. */
        | 'episode'
        /**
         * A Space memory entry's version (CB-181): proposed, approved, rejected,
         * withdrawn, edited, retired or deleted. Ids only, never its text.
         */
        | 'space_memory'
        /** A person's role in a Space, or a Space's access (CB-181). */
        | 'space_member'
        /** A Space deleted or restored (CB-277). */
        | 'space'
        | 'job'
        | 'app'
        | 'telegram_link'
        | 'inference_backend'
        | 'user'
        | 'agent_grant'
        /** The release feed's settings or an update requested (CB-259). */
        | 'platform_updates'
        // Feature flag rules and choices, and plans (CB-169, CB-182).
        | 'feature_flag'
        | 'flag_tier'
        /** The data key: a re-seal or a recovery key check, by key id only (CB-322). */
        | 'data_key'
        /**
         * A Socio Secret: created, replaced, deleted, granted, revoked, read or
         * refused. Its id (or `name:<NAME>` for a refused name nothing holds);
         * names, versions and apps, never a value.
         */
        | 'workspace_secret'
        /** A revoked service key removed for good (CB-360): its account's and its own name and id, never its hash or hint. */
        | 'service_key'
        /** The app on a person's device (CB-352): its id and label, never its install id. */
        | 'device'
        /** An installed plugin updated from the catalog (CB-370): its versions and public webhook paths, by id. */
        | 'plugin'
        /** An admin's data API token: made, used (a summary), revoked; by id and name, never its value or hash. */
        | 'data_api_token'
        /** The workspace owner recorded or handed over (CB-390), by the new owner's user id. */
        | 'workspace_owner'
        /** AI reply reports' sharing turned on or off (CB-382): the consent id and text version, never a report. */
        | 'reply_reports';
    targetId: string;
    detail?: string;
}

/** An audit line as `auditOf` reads it back. */
export type WorkspaceAuditLine = Required<WorkspaceAuditEntry> & { createdAt: number };

/**
 * A change that may end delegated access (CB-232): a socio archived or
 * changed, a person's role changed, a chat archived or deleted. Listeners
 * re-check the matching grants at once; the leader's sweep and the 5-s
 * check on every use are the guarantee, this the fast path.
 */
export type AccessChange = { socioId: string } | { personId: string } | { conversationId: string };

/** A new Space's access (`createSpaceFor`). */
export interface SpaceCreateInput {
    name: string;
    description: string;
    private: boolean;
    people?: ReadonlyArray<{ userId: string; role: SpaceRole }>;
    grantTo?: string;
}

/** A Space, deleted or not, with its stamps (`withDeletedSpace`). */
export type SpaceWithStamps = Space & { deletedAt: number | null; deletedBy: string | null };

/** What `updateDot` changes. */
export type DotPatch = Pick<Dot, 'name' | 'researchAllowed' | 'memoryAllowed'> & {
    /**
     * Omitted: unchanged. Changed: its Soul's next version, with these
     * standing instructions and the rest of the Soul as it is (CB-179).
     */
    instructions?: string;
    spaceId?: string;
    spaceIds?: string[];
    learningContainerId?: string | null;
    skillDeliveryEnabled?: boolean;
    /** Omitted: unchanged. */
    issuesAllowed?: boolean;
    /** Omitted: unchanged; null: automatic. */
    inference?: ModelChoice | null;
    /** Its Local (CB-256); omitted: unchanged. */
    character?: LocalId;
};

// ── People ───────────────────────────────────────────────────────────────

/** The people who use the workspace, their preferences and what they have seen. */
export interface PeopleShape {
    /** Records a user seen through the auth provider, which owns name and role. */
    recordUser(user: User): void;
    /**
     * Everyone who has used the workspace, deactivated people included:
     * content keeps their name.
     */
    users(): User[];
    /** Whether anyone with this id has used the workspace. */
    hasUser(userId: string): boolean;
    /**
     * Who is deactivated, as the auth provider says (createApp wires it):
     * the users table keeps them, so names stay, and this keeps new work
     * from them (issue assignments, job runs).
     */
    useDeactivated(ids: () => readonly string[]): void;
    /** App user ids of deactivated people (`useDeactivated`). */
    deactivatedUsers(): Set<string>;
    isDeactivated(userId: string): boolean;
    /**
     * Moves single-owner data (from before user accounts) to a real user.
     * Idempotent: once moved, nothing references the legacy owner id.
     */
    migrateLegacyOwner(legacyOwnerId: string, userId: string): number;
    /** The person's own preferences, with defaults for what they never set. */
    preferences(userId: string): UserPreferences;
    /** Saves the preferences given over the stored ones; returns them all. */
    setPreferences(userId: string, patch: Partial<UserPreferences>): UserPreferences;
    /** The newest release the person has seen in What's new (CB-166). */
    lastSeenRelease(userId: string): string | null;
    /**
     * Records that the person has seen `version` (a release version), unless
     * they had already seen a newer one; returns what is kept.
     */
    markReleaseSeen(userId: string, version: string): string;
    /**
     * Records that the person was shown these releases' cards (CB-166), the
     * first time only: showing one again keeps its first time.
     */
    recordReleaseViews(userId: string, versions: readonly string[], now?: number): void;
    /** The releases the person was shown, newest release first (CB-166). */
    releaseViews(userId: string): ReleaseView[];
}

export class People extends Context.Service<People, PeopleShape>()('socio/workspace/People') {}

// ── Spaces ───────────────────────────────────────────────────────────────

/** The workspace's Spaces: made, deleted and restored, and who reads them. */
export interface SpacesShape {
    /** The live Spaces, oldest first. */
    spaces(): Space[];
    createSpace(name: string, description: string): Space;
    /**
     * A new Space and its access, in one unit of work (CB-181): a private
     * one never shows, not even for a moment, to people outside it. Who may
     * make which is `createSpaceAs` (spaces/create.ts). `grantTo`: the socio
     * that made it for `by` (CB-271), given the Space in the same unit.
     */
    createSpaceFor(by: string, input: SpaceCreateInput): Promise<Space>;
    /**
     * Renames a Space (CB-366), as its editors (workspace admins edit every
     * Space): only the name changes. Its id, pages, chats, memory, people
     * and grants stay, so every link to it and its pages, which name the
     * id, keeps working. `dotId`: the socio that renamed it for `by`.
     * `guard`: the caller's own checks (a socio's access, its name rule),
     * run under the write lock with the editor check, so a change queued
     * before the rename is seen; it throws to refuse.
     */
    renameSpace(
        spaceId: string,
        by: string,
        name: string,
        options?: { dotId?: string; now?: number; guard?: (name: string) => void },
    ): Promise<Space>;
    /** Deletes a Space (CB-277), soft: the row is stamped and everything in it is kept. */
    deleteSpace(spaceId: string, by: string, now?: number): Promise<void>;
    /**
     * Why a Space its editor may delete can't be now (CB-277): it is the
     * workspace's only one, or a socio saves new pages to it by default.
     */
    spaceDeleteBlocker(spaceId: string, by: string): string | undefined;
    /** Brings a deleted Space back (CB-277, workspace admins). */
    restoreSpace(spaceId: string, by: string, now?: number): Promise<Space>;
    /** A Space, deleted or not, with its stamps (admins' view, tests). */
    withDeletedSpace(spaceId: string): SpaceWithStamps | undefined;
    /** The deleted Spaces, newest delete first (Settings → Deleted Spaces). */
    deletedSpaces(): DeletedSpace[];
    /**
     * Whether a person may read a Space, and everything in it, now (CB-181:
     * `SpaceAccess.reads`, the one rule).
     */
    readsSpace(userId: string, spaceId: string): boolean;
    /**
     * Whether a person may edit a Space now (`SpaceAccess.canEdit`: a
     * workspace admin, or a member with the editor role).
     */
    editsSpace(userId: string, spaceId: string): boolean;
    /** Called after a Space's people or access change (CB-181). */
    onSpaceAccessChange(listener: (spaceId: string) => void): () => void;
}

export class Spaces extends Context.Service<Spaces, SpacesShape>()('socio/workspace/Spaces') {}

// ── Socios ───────────────────────────────────────────────────────────────

/**
 * The socios: made, changed, archived, their Space grants and their audit.
 * Once the `Dots` slice, renamed for the product's word (CB-163: the
 * copy guard refuses a bare `Dots` in code); its methods keep today's names.
 */
export interface SociosShape {
    /** Every live Dot, archived ones too. */
    dots(): Dot[];
    /** Every Dot, archived ones too, company Dots first (admins' list). */
    allDots(): Dot[];
    /** The company's live Dots: shared by the team, managed by admins. */
    companyDots(): Dot[];
    /** The Dots `userId` may see: the company's, then their own. */
    dotsFor(userId: string, options?: { archived?: boolean }): Dot[];
    /** A live Dot. One query, not every Dot: views ask once per row. */
    dot(id: string): Dot | undefined;
    /** Whether `userId` may use the Dot: a company Dot or their own, not archived. */
    canUseDot(userId: string, dotId: string): boolean;
    /** How many Dots of their own `userId` has in use (not archived). */
    personalDotCount(userId: string): number;
    createDot(
        spaceId: string,
        name: string,
        instructions: string,
        researchAllowed: boolean,
        memoryAllowed: boolean,
        spaceIds?: string[],
        learningContainerId?: string | null,
        skillDeliveryEnabled?: boolean,
        inference?: ModelChoice | null,
        issuesAllowed?: boolean,
        /** A person's own Dot; null (default): the company's. */
        ownerId?: string | null,
        /** Who made it, for the Dot's audit: a user id, or `system`. */
        actor?: string,
        /** Its Local (CB-256); null: the one its id hashes to. */
        character?: LocalId | null,
    ): Dot;
    updateDot(id: string, patch: DotPatch, actor?: string): Dot;
    /** Archives a Dot: it leaves every list and picker; never a delete. */
    archiveDot(id: string, actor: string, now?: number): Dot;
    /** Brings an archived Dot back; its paused schedules stay paused. */
    unarchiveDot(id: string, actor: string, now?: number): Dot;
    /** Who made, changed, archived and unarchived a Dot, oldest first. */
    dotAudit(dotId: string): DotAuditEntry[];
    /**
     * Whether a socio has the Space (`dot_spaces`): its grant only. What it
     * may read in a chat is `socioReads`, which also asks its readers.
     */
    canAccessSpace(dotId: string, spaceId: string): boolean;
}

export class Socios extends Context.Service<Socios, SociosShape>()('socio/workspace/Socios') {}

// ── Audit ────────────────────────────────────────────────────────────────

/** The workspace's own audit (`workspace_audit`, CB-64). */
export interface AuditShape {
    /** Records a delete that has no audit of its own module (CB-64). */
    audit(entry: WorkspaceAuditEntry, now?: number): void;
    /** Records these lines before anything that follows: awaited, and a failure throws (CB-352). */
    auditNow(entries: readonly WorkspaceAuditEntry[], now?: number): Promise<void>;
    /** The audit lines about one target, oldest first. */
    auditOf(targetKind: WorkspaceAuditEntry['targetKind'], targetId: string): WorkspaceAuditLine[];
}

/** What admins' person page reads of the workspace audit (CB-360; `SqliteAudit`). */
export interface AuditTrailShape {
    /**
     * The lines a person made or that are about them (CB-360's trail):
     * theirs as actor, and those about their account, Telegram link,
     * Space memberships and connected agents. Newest first, older than
     * `before` (by time, then id).
     */
    personTrail(
        userId: string,
        before: TrailCursor | undefined,
        limit: number,
    ): (WorkspaceAuditLine & { id: number })[];
}

/** Where a page of an audit trail starts: rows older than this time, or as old with a lower id. */
export interface TrailCursor {
    at: number;
    id: number;
}

export class Audit extends Context.Service<Audit, AuditShape>()('socio/workspace/Audit') {}

// ── Conversations ────────────────────────────────────────────────────────

/** The errors `deleteThread` and `ConversationAdmin.delete` refuse with. */
export const DELETE_BLOCKED: Record<DeleteBlocker, string> = {
    telegram: 'Conversation is a Telegram conversation.',
    page: 'Conversation belongs to a page.',
    call: 'End the current call before deleting this conversation.',
    running: 'Stop the current run before deleting this conversation.',
};

/** How an access check runs: rooms' `RoomAccessCheck` (rooms/contract.ts). */
export type ConversationAccessCheck = RoomAccessCheck;

/**
 * A chat's socio as a Space reader (CB-181), the `SpaceReader` of
 * spaces/access.ts it reads with: its id and the chat's readers, null
 * where Socio can't name them all.
 */
export interface SocioReader {
    dotId: string;
    people: readonly string[] | null;
}

/** A conversation by id, deleted or not, with its stamp (`withDeletedThread`). */
export type ConversationWithStamps = Conversation & { deletedAt: number | null; deletedBy: string | null };

/**
 * The conversations (`thread_bindings`), who reads and answers in them,
 * their calls and captures, and the scheduled tasks bound to them.
 */
export interface ConversationsShape {
    /** The tasks bound to a Dot's conversations, deleted ones' too. */
    dotThreadTaskIds(dotId: string): Promise<string[]>;
    /**
     * Who reads a chat now (CB-181): a room's active members and live
     * invites; a private chat's owner (a Telegram DM too); null where Socio
     * can't name them all (a Telegram group or team topic) or the chat is
     * gone. Space access asks it afresh at every read.
     */
    chatReaders(threadId: string): string[] | null;
    /**
     * The socio of a chat as a Space reader (CB-181): it reads a Space it
     * has that everyone reading the chat may read (`SpaceAccess.reads`).
     */
    socioReader(threadId: string, dotId?: string): SocioReader;
    /** Adds a source of chats about a page: each answers a page id, or nothing. */
    addChatPages(source: (threadId: string) => string | undefined): void;
    /** The Space of the page a chat is about (deleted or not), if it is about one. */
    chatSpace(threadId: string): string | undefined;
    /**
     * Whether a chat about a page is hidden from `userId` (CB-181): the
     * page's Space is one they may not read now.
     */
    chatHidden(userId: string, threadId: string): boolean;
    /** Whether the socio of `threadId` may read `spaceId` now (`socioReader`). */
    socioReads(threadId: string, spaceId: string, dotId?: string): boolean;
    /**
     * A previous chat or computer action grants access to this socio's
     * shared area; an active room membership counts as a chat (CB-208).
     */
    usedDot(userId: string, dotId: string): boolean;
    /**
     * The user's own conversations, team conversations they can see and the
     * rooms they are an active member of (CB-208), newest first; archived
     * ones are left out.
     */
    conversations(userId: string): Promise<Conversation[]>;
    /** The user's archived conversations, the last archived first. */
    archivedConversations(userId: string): Promise<Conversation[]>;
    /** Archives or unarchives a live conversation. */
    setArchived(id: string, archived: boolean, by: string, now?: number): Conversation | undefined;
    /**
     * Whether `userId` may do `action` in a live conversation (CB-208,
     * `roomAllows`). Undefined thread: it is missing.
     */
    access(
        userId: string,
        id: string,
        action: RoomAction,
        check?: ConversationAccessCheck,
    ): { thread?: Conversation; decision: RoomDecision };
    /**
     * The socios that may answer in a live conversation (CB-206): a private
     * chat's or a legacy topic's own socio; a room's active socios, its lead
     * first. Empty when it is missing.
     */
    answeringSocios(id: string): string[];
    /** Whether `dotId` may answer in the conversation (`answeringSocios`). */
    answers(id: string, dotId: string): boolean;
    /** `access`, allowed or not. */
    allows(userId: string, id: string, action: RoomAction, check?: ConversationAccessCheck): boolean;
    /**
     * Request boundary check by the one rule (CB-208): the conversation, if
     * `userId` may do `action` there (and it is this socio's); else a
     * `RoomAccessError` with the reason.
     */
    requireAccess(userId: string, id: string, action: RoomAction, dotId?: string): Conversation;
    /** A conversation this user may read (`roomAllows` `read`, CB-208). */
    readableThread(
        userId: string,
        id: string,
        check?: Pick<ConversationAccessCheck, 'audit'>,
    ): Promise<Conversation | undefined>;
    /** Any live conversation by id, regardless of owner (internal use). */
    thread(id: string): Conversation | undefined;
    /** The person whose private chat a room was, for a room made from one. */
    convertedFrom(id: string): { userId: string; at: number } | undefined;
    /** A conversation by id, deleted or not, with its stamp (admin, tests). */
    withDeletedThread(id: string): ConversationWithStamps | undefined;
    /** Ids of deleted conversations (the Runs view leaves their runs out). */
    deletedThreadIds(): string[];
    /** Sets a conversation's own model; null: its Dot's default. */
    setThreadInference(id: string, choice: ModelChoice | null): Conversation | undefined;
    bindThread(id: string, dotId: string, title: string, userId: string, inference?: ModelChoice | null): Conversation;
    isTitled(id: string): boolean;
    /**
     * Records the automatic title; without a title, records the attempt only.
     * A chat its owner renamed keeps their title (CB-66).
     */
    setAutomaticTitle(id: string, title?: string): void;
    /** The owner's own title for a live conversation (CB-66). */
    renameThread(id: string, title: string): Conversation | undefined;
    /** Internal lookup for code acting on an already-authorized thread. */
    requireThread(id: string, dotId?: string): Conversation;
    /**
     * Request boundary check for what only a private chat's owner does (a
     * call, a scheduled task, a capture, deletion). Never a room.
     */
    requireOwnedThread(userId: string, id: string, dotId?: string): Conversation;
    /** Request boundary check for a call: it belongs to one of the user's threads. */
    requireOwnedCall(userId: string, id: string): CallReceipt;
    /** The user's call receipts, newest first. */
    callsFor(userId: string): CallReceipt[];
    /** Runs a scheduled task's turns in the conversation. */
    bindTask(taskId: string, threadId: string): Promise<void>;
    /** Ids of the scheduled tasks bound to a conversation. */
    threadTasks(threadId: string): Promise<string[]>;
    /** Deletes a web conversation (CB-64: hides it). */
    deleteThread(id: string, by: string, now?: number): Promise<void>;
    /** Why `deleteThread` would refuse this live conversation, if it would. */
    deleteBlocker(id: string): Promise<Exclude<DeleteBlocker, 'running'> | undefined>;
    /** The conversation a scheduled task's turns run in. */
    taskThread(taskId: string): Promise<string | undefined>;
    /** Calls of live conversations; a deleted one's are kept, not listed. */
    calls(threadId?: string): CallReceipt[];
    createCall(threadId: string): CallReceipt;
    call(id: string): CallReceipt;
    setCall(id: string, status: CallReceipt['status'], transcript: string, error?: string | null): CallReceipt;
    saveLateTranscript(id: string, transcript: string): boolean;
    anchorCall(id: string, anchor: string | undefined): void;
    setCallError(id: string, error: string | null): void;
    saveCapture(threadId: string, value: unknown): void;
    capture(threadId: string): unknown;
}

export class Conversations extends Context.Service<Conversations, ConversationsShape>()(
    'socio/workspace/Conversations',
) {}

// ── Ownership (CB-360) ───────────────────────────────────────────────────

/**
 * A person's own socios and conversations, and handing them to another
 * person (CB-360's transfer). Rooms are not anyone's: their membership
 * stays. `infra/ownership.ts` implements both.
 */
export interface SocioOwnershipShape {
    owned(userId: string): OwnedList;
    /** Every personal socio of `from`, deleted and archived ones too, inside the caller's transaction. */
    transfer(parties: TransferParties): TransferTally;
}

export interface ConversationOwnershipShape {
    owned(userId: string): OwnedList;
    /**
     * `from`'s conversations (not rooms), all of them or only `threadIds`,
     * inside the caller's transaction; `threadIds` in the result are the
     * ones moved, for what follows a conversation (its page or context
     * link, its episodes, its learning evidence).
     */
    transfer(parties: TransferParties, threadIds?: readonly string[]): TransferTally & { threadIds: string[] };
}

// ── Chat history and messages ────────────────────────────────────────────

/** The person a message is from, as the server knows them. */
export type { MessageSender } from '@socio/foundation/workspace/client-messages';

/**
 * A chat's history as the browser's store reads it (CB-136): `historyPage`
 * (chat-history.ts) over the turn runner, the one function of the
 * workspace another folder calls (operations' transcripts). A functional
 * tag, bridged over today's function (`chatHistory`).
 */
export interface ChatHistoryShape {
    /**
     * A page of a conversation's history. `after`: the runs after it, up to
     * a page. Otherwise the newest before `before` (or the newest of all).
     * `roomReader`: a room's reader, with other people's private results
     * withheld.
     */
    historyPage(
        threadId: string,
        range: { after?: number; before?: number },
        roomReader?: string,
    ): Promise<HistoryPage>;
}

export class ChatHistory extends Context.Service<ChatHistory, ChatHistoryShape>()('socio/workspace/ChatHistory') {}

// ── PeopleSync ───────────────────────────────────────────────────────────

/**
 * People and socios, read synchronously: exactly what the Board's services
 * ask of the workspace (`BoardDependencies` in `issues/services.ts`).
 * `sqliteBoard` calls these synchronously, so a promise or Effect façade
 * can't stand in for it. Built from the `People` and `Socios`
 * slices (`PeopleSyncLive`).
 */
export interface PeopleSyncShape {
    readonly userExists: (id: string) => boolean;
    readonly deactivated: (id: string) => boolean;
    readonly canManageDependencies: (id: string) => boolean;
    readonly user: (id: string) => User | undefined;
    readonly dot: (id: string) => { name: string; ownerId?: string | null } | undefined;
}

export class PeopleSync extends Context.Service<PeopleSync, PeopleSyncShape>()('socio/workspace/PeopleSync') {}

// ── WorkspaceViews ───────────────────────────────────────────────────────

/**
 * The shell's views of the workspace (`GET /api/workspace` and its
 * version), moved out of `live/views/workspace.ts` and
 * `live/view-versions.ts`.
 * Viewer-first: the sources they read are bound once, by the layer.
 */
export interface WorkspaceViewsShape {
    /**
     * A socio as `viewer` sees it: only the Spaces they may read among
     * those it has (CB-181). Saving keeps the ones they can't see.
     */
    readonly dotForViewer: (viewer: string, dot: Dot) => Dot;
    /** What `user` may do, as `GET /api/workspace` tells the client. */
    readonly workspacePermissions: (user: User) => WorkspacePermissions;
    /** `GET /api/workspace`: what the shell shows this user. */
    readonly workspaceView: (user: User) => Promise<WorkspaceState>;
    /** The version of `workspaceView` (`conditionalJsonAsync`). */
    readonly workspaceVersion: (user: User) => Promise<string>;
}

export class WorkspaceViews extends Context.Service<WorkspaceViews, WorkspaceViewsShape>()(
    'socio/workspace/WorkspaceViews',
) {}

/**
 * What the views read beyond the workspace's own slices, as the
 * composition root fills it (a port over the graph's tags,
 * read when a request runs). Each member is the slice the views call.
 */
export interface WorkspaceViewSourcesShape {
    /** Who may read which Space (CB-181): `SpaceAccess`. */
    readonly spaceAccess: {
        spacesFor(userId: string): Space[];
        readableIds(reader: { userId: string }): Set<string>;
    };
    /** The Telegram team topics a person is in. */
    readonly telegram: { memberChats(userId: string): Promise<string[]> };
    /** The rooms a person is an active member of (CB-208). */
    readonly roomAccess: { viewerRooms(userId: string): Array<{ roomId: string }> };
    /** The change counters (`live/change-counters.ts`). */
    readonly counters: { read(keys: string[]): string };
    /** Each room's unread state (CB-215): rooms' `Reads`. */
    readonly reads: {
        withUnread(userId: string, conversations: Conversation[]): Promise<Conversation[]>;
        version(userId: string): Promise<string>;
    };
    /** What of each room reaches the person (CB-216): rooms' notices. */
    readonly roomNotices: { withLevels(userId: string, conversations: Conversation[]): Promise<Conversation[]> };
    readonly apps: {
        readonly enabled: boolean;
        readonly promotions: { launcherFor(userId: string): WorkspaceAppEntry[] };
    };
    readonly flags: { forUser(userId: string): ClientFlags };
    readonly plugins: { launcher(person: User): PluginLauncherEntry[] };
    /** The workspace's settings, read when a view runs. */
    settings(): Settings;
    setup(userId?: string): Promise<SetupStatus>;
    adminSetup(): Promise<Pick<SetupStatus, 'dataKey' | 'backup' | 'datasetFiles'>>;
    statusEpoch(): number;
    transcriptionSources(): TranscriptionSources;
    /** Live dictation (CB-222): whether it records only. */
    readonly dictationStreams: { recordingsOnly(provider: TranscriptionProvider): boolean };
    /** Whether a thumbs-down may carry an AI reply report (CB-382): `cloud/`'s `ReplyReports`. None: never. */
    replyReports?(): ReplyReportsState;
}

export class WorkspaceViewSources extends Context.Service<WorkspaceViewSources, WorkspaceViewSourcesShape>()(
    'socio/workspace/WorkspaceViewSources',
) {}
