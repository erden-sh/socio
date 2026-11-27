import { CLIENT_UPDATE_STATUS } from '@socio/shared/client-compat';
import { installIdSchema } from '@socio/shared/device-sign-in';
import type { Page } from '@socio/shared/pages/page-library';
import type { LiveTurn } from '@socio/shared/rooms/live-turn';
import type { RunTraceView } from '@socio/shared/runs/run-trace';
import type { UserPreferences } from '@socio/shared/voice/dictation';

import {
    openCacheDb,
    type SetFileProtection,
    openUserDb,
    type Store,
    type UserDbState,
    workspaceKeyName,
    workspaceLayout,
    type WorkspaceRow,
} from '../data';
import { type AuthedFetch, createAuthedFetch } from '../net/authed-fetch';
import { type CookieJar, openCookieJar } from '../net/cookie-jar';
import type { FetchFunction } from '../net/fetch-function';
import type { SessionEnd } from '../net/session';

import { type ApprovalActions, type ApprovalFeedback, createApprovalActions } from './approval-actions';
import { type AttachmentFiles, type Attachments, type ImageProcessor, openAttachments } from './attachments';
import type { BoundedStore } from './bounded-kind';
import { type Drafts, openDrafts } from './chat-drafts';
import { followStoredChats } from './chat-send';
import { type ClientCompat, createClientCompat } from './client-compat';
import {
    cleanupScopeCollections,
    createScopeCollections,
    type ScopeCollections,
    SYNCED_COLLECTIONS,
} from './collections';
import { type ContactTracker, createContactTracker } from './contact';
import { createFollowStore, type FollowStore } from './follow';
import { createHistoryStore, type HistoryStore } from './history';
import { createIssueAssignees, type IssueAssigneeList } from './issue-assignees';
import { createIssueComponentOptions, type IssueComponentOptionList } from './issue-component-options';
import { createLocalIssues, issueCommentsDraft, type LocalIssues } from './issue-create';
import { createIssueDetails, followIssueList, type IssueDetails } from './issue-details';
import { createKeepOffline, type KeepOffline } from './keep-offline';
import { type KeptSpaces, openKeptSpaces } from './kept-spaces';
import { firstFrameSnapshots, MODULE_KINDS, MODULE_SNAPSHOTS } from './kinds';
import { chatLanes, CONVERSATION_IDS, isLocalChat, isLocalIssue, ISSUE_IDS } from './local-ids';
import { createMediaListings, type MediaListings } from './media-library';
import { createLocalChats, type LocalChats } from './new-chat';
import { createNoticeFeed, type NoticeFeed } from './notices';
import { createNotificationSettings, type NotificationSettings } from './notification-settings';
import { openOutbox, type Outbox, type OutboxKind, UNSENT_GONE, type UnsentWrite } from './outbox';
import { bindOutboxTriggers, notesToPull } from './outbox-triggers';
import { createOwnTurns, type OwnTurns } from './own-turns';
import { createPageLandings, type PageLandings } from './page-conflicts';
import { createPageChats, type PageChats } from './page-conversation';
import { createPageDrafts, type PageDrafts } from './page-drafts';
import { createLocalPages, heldFolder, isFolder, type LocalPages, pendingFolder } from './page-manage';
import { followStoredReviews, reviewLane } from './page-review';
import { createPageSaves, type PageLanding, type PageText, type PageTheirs } from './page-save';
import { createPagesStore, type PageMove, type PagesStore } from './page-store';
import { pageBodyKey } from './pages';
import { createPresence, type Presence, PRESENCE_POLL_MS } from './presence';
import { createReactionsStore, type ReactionsStore } from './reactions';
import { createReviewDrafts, dropEdits } from './review-edits';
import { createRoomActions, type RoomActions } from './room-actions';
import { createRoomCreate, type RoomCreate } from './room-create';
import { ROOM_INVITES_SNAPSHOT } from './room-invites';
import { createRoomViews, createRoomWatch, type RoomViews, type RoomWatch } from './rooms';
import { createRunFailures, type RunFailures } from './run-failures';
import { createRunTraces, isOwnRun } from './run-traces';
import { RUNS, runRow } from './runs';
import { createScheduleDetails, type ScheduleDetails } from './schedule-details';
import { createScheduler, type SyncJob, type SyncScheduler } from './scheduler';
import { createServerClock, type ServerClock } from './server-clock';
import { createSessionWatch, type SessionWatch, writeHold } from './session';
import {
    CONVERSATIONS,
    SHELL,
    SHELL_SNAPSHOTS,
    SPACES,
    STATE_SNAPSHOT,
    WORKSPACE_KEY,
    WORKSPACE_SNAPSHOT,
} from './shell';
import { openSnapshotCache, type SnapshotCache } from './snapshot-cache';
import { createSnapshotSource } from './snapshot-source';
import { createSpaceCreate, type SpaceCreate } from './space-create';
import { createSteeringStore, type SteeringStore } from './steering';
import { type AppStateSource, createNetworkWatch, isForeground, type NetworkSource } from './triggers';
import { type FileUploads, openFileUploads } from './upload-file';
import { createServerVersions, type ServerVersions } from './versions';
import { openViewState, type ViewState } from './view-state';

// One workspace's scope: one
// disposable object holding everything of one workspace and person that
// lives while it is open, so a switch, a sign-out or a wipe stops it all at
// once and no other workspace's data can show:
// - its cache.db and user.db connections, opened through `store.driver`;
// - its cookie jar, its authedFetch, and the AbortController whose signal stops
//   every request it made;
// - its snapshot cache (the shell's rows in memory, and the kept screen's
//   module kind; the other kinds load as sync starts, kinds.ts), its server versions and
//   minimum-version gate (versions.ts, kept in the registry), its last contact
//   (contact.ts, kept in the registry);
// - its view state (view-state.ts, cache.db's `kv`), read as it opens;
// - its TanStack DB collections (collections.ts), with ids that carry the
//   scope's id;
// - the scheduler and its timers (scheduler.ts);
// - its chat histories (history.ts): per conversation, loaded one at a time
//   from cache.db as a chat opens or is preloaded;
// - its steering snapshots (steering.ts): per conversation, in memory;
// - its issue details (issue-details.ts, a bounded kind): read as a detail
//   opens, when the issues list's poll changes its row, and after a write that
//   names it; a gone issue's writes go to the Unsent list;
// - its pages (page-store.ts): each Space's summaries, pulled while a
//   screen shows the Space, and page bodies (a bounded kind) read on open when
//   missing or older; a moved page re-keys, a gone one's writes and a lost
//   Space's go to the Unsent list;
// - the Spaces kept offline (kept-spaces.ts, user.db's `prefs`), whose
//   bodies stay on disk, and their prefetch (keep-offline.ts): on start and
//   each return to the foreground, as one is kept, after each pull that
//   changes its pages, and when the network comes back;
// - its outbox (outbox.ts), on user.db, which fills `pending` and keeps the
//   registry's count of its rows, so the drawer says "Waiting to send" while
//   another workspace is open;
//   its kinds get the histories and steering snapshots (chat-send.ts's chat messages),
//   a return to the foreground pokes it and the network back wakes it
//   (outbox-triggers.ts), and a write's `notesForWrite` topics are pulled;
// - its drafts (chat-drafts.ts, user.db's `drafts`), read as it opens, and
//   its page editors' drafts (page-drafts.ts), written at most every
//   1.5 s and at once on going to the background, the network going and
//   `dispose()`;
// - its new chats' local ids (local-ids.ts, new-chat.ts): the histories,
//   steering snapshots and follow streams never read the network for one, and
//   once a create resolves its draft and the last screen move to the server
//   id (`chats`), as they do again at open for one a kill left;
// - its follow streams (follow.ts): one per chat a screen shows, checked
//   again on each return to the foreground, woken when the network comes back;
// - its presence (presence.ts): one tab id, `X-CB-Presence` on every
//   `/api/state` pull (polled every 5 s in the foreground), and the away post
//   on going to the background and on `dispose()` (best effort: sent first,
//   it goes while the rest closes, and stops with every other request);
// - its in-app notices (notices.ts): each new one shown once, marked
//   seen through the outbox's `notice-seen` kind;
// - its rooms (rooms.ts): each room's view in cache.db (a bounded
//   kind), polled with its presence while a screen shows it; the follow
//   streams know the person (`me`), and every RUN_ERROR's code the streams and
//   this device's runs see is kept by run id (run-failures.ts), since
//   `/history` drops it.
//
// `openWorkspaceScope` resolves with the collections already filled from
// cache.db, and pending from user.db, before any request: the first frame
// draws from them. Sync starts with `start()`, which the app calls once
// it draws that frame, and not for a locked copy.
//
// Wired here: a higher server version makes the scheduler pull the scopes it
// left stale; a write the server confirms while a pull is in flight makes it
// run again; the app going to the background, or the network going, writes
// the cache, the versions and the last contact at once. The session watch
// (session.ts) reads the jar after every answer, for the Expired banner; an
// Ended 401 stops sync and keeps `endedAt` in the registry, so the root gate
// locks the copy.
//
// `dispose()` stops the scheduler and the listeners first, then the page
// editors' drafts and the drafts (a send begun commits, typing is written),
// then the outbox (its
// rows in flight become `unknown` before their requests stop), aborts every request
// in flight (an answer that comes after changes nothing), writes what is
// pending, closes the jar, ends the collections and the live queries that read
// them (for good: a query made on them later finds no rows, collections.ts),
// and closes both files. Nothing of it is left: no timer, no listener, no
// connection. A wipe (src/data/wipe.ts) runs after it.

/** The scope couldn't open: the workspace isn't ready on the phone, or a key is missing. */
export class WorkspaceScopeError extends Error {
    override readonly name = 'WorkspaceScopeError';
}

export interface WorkspaceScopeOptions {
    /** The store launch opened (src/data's openStore). */
    readonly store: Store;
    /** The workspace's directory id: a ready row of the registry. */
    readonly workspaceId: string;
    /** The app's one fetch (src/platform/fetch.ts). */
    readonly fetch: FetchFunction;
    /** The app's User-Agent (src/platform/user-agent.ts), which says nothing about the person. */
    readonly userAgent: string;
    /** The build's variant, for the minimum-version gate. */
    readonly variant: string;
    /** The app's state (src/platform/app-state.ts). */
    readonly appState: AppStateSource;
    /** The network (src/platform/network.ts). */
    readonly network: NetworkSource;
    /**
     * Each 401, classified (authedFetch's), after the scope has acted on it:
     * an Ended one is kept in the registry (`endedAt`) and stops sync first, so
     * the app reads the root gate again, which locks the copy. A wiping one
     * (`device-revoked`, `deactivated`) does the same first, so
     * the copy is hidden at once; the app then wipes it.
     */
    readonly onUnauthorized?: (end: SessionEnd, url: string) => void | Promise<void>;
    /** A failure nothing waits for: a pull's other than the server away, a write, a close. */
    readonly onError?: (error: unknown) => void;
    /** The device clock (the jar's, the cache's times, the versions' fallback). */
    readonly now?: () => number;
    /** The back-off's jitter, for tests. */
    readonly random?: () => number;
    /**
     * The outbox's write kinds; none by default, so every row waits.
     * A function gets what the kinds work on (chat-send.ts's chat messages: the
     * histories and steering snapshots, and the pull after a write).
     */
    readonly outboxKinds?:
        | readonly OutboxKind<unknown>[]
        | ((scope: OutboxKindScope) => readonly OutboxKind<unknown>[]);
    /**
     * What attachments need from the platform: the file operations,
     * socio-device's `setFileProtection`, fresh ids and the image processor.
     * Without it (tests), the store's file system with no copy or read.
     */
    readonly attachments?: {
        readonly files: AttachmentFiles;
        readonly setFileProtection: SetFileProtection;
        readonly newId: () => string;
        readonly processImage?: ImageProcessor;
        /** The page image profile, for uploads to the person's Files. */
        readonly processPageImage?: ImageProcessor;
        /** The issue profile, for files picked into an issue's box. */
        readonly processIssueImage?: ImageProcessor;
    };
    /** A monotonic clock in milliseconds, for `onOpened`'s timings. */
    readonly clock?: () => number;
    /** Called once the scope has opened, with how long each step took and the rows it read (the cold-start marks). */
    readonly onOpened?: (timings: ScopeOpenTimings) => void;
    /** Called after each last contact is kept in the registry (at most once a minute): push's lease deadline. */
    readonly onContact?: (at: number) => void;
    /** Fresh ids for the scope's own writes (a notice's seen mark): expo-crypto's UUIDs in the app. */
    readonly newId?: () => string;
    /** Random bytes for the presence tab id: crypto.getRandomValues by default. */
    readonly randomBytes?: (length: number) => Uint8Array;
    /** An approval decision's haptic: the platform's, which reads the phone's setting. */
    readonly approvalFeedback?: ApprovalFeedback;
}

/** What the scope hands its outbox's kinds. */
export interface OutboxKindScope {
    readonly histories: HistoryStore;
    readonly steering: SteeringStore;
    readonly follows: FollowStore;
    /** The issue details: a create's or a comment's answer hands its detail here (`put`). */
    readonly issueDetails: IssueDetails;
    /** cache.db's snapshot rows: a confirmed write is handed off there before its row goes. */
    readonly cache: Pick<SnapshotCache, 'confirm' | 'rows'>;
    /** The person's app user id: their own messages in a room and a run's turn. */
    readonly me: string;
    /** A RUN_ERROR on this device's own run: its code is kept (run-failures.ts). */
    onRunError(threadId: string, runId: string, code: unknown): void;
    /** Picked files and their uploads: a message's files go up before it does. */
    readonly attachments: Attachments;
    /** Uploads to the person's Files: a cover's image goes up before its write. */
    readonly uploads: FileUploads;
    /** After a write the server took: the chats and lists its path names are pulled (`notesForWrite`). */
    afterWrite(path: string): void;
    /** Each event of a run this device started, with its turn: the scope's `turns` keep it for the chat. */
    onTurn(threadId: string, turn: LiveTurn): void;
    /** A reaction write's answer: the chat's view, for the scope's `reactions`. */
    onReactions(threadId: string, view: unknown): void;
    /** The outbox's refused rows (empty until it opens): the page review's hold lets a refused Skip go. */
    unsent(): readonly UnsentWrite[];
    /**
     * The pages' bodies: a saved page is handed off there (page-save.ts); a move
     * reads the copy held (memory, else disk, no network) to tell whether it changed the text (page-manage.ts).
     */
    readonly pageBodies: Pick<PagesStore['bodies'], 'put'> & { read(key: string): Promise<Page | null> };
    /** Page `pageId` saved by a row based on the revisions `from`, now `page`: its editor's draft rebases (page-drafts.ts). */
    pageSaved(pageId: string, from: readonly number[], page: Page): void;
    /**
     * A save's 409 moved page `pageId`: its editor's draft lands on
     * the merge or on theirs (page-drafts.ts's `landed`), and `pageLandings` tells the screens.
     */
    pageLanded(pageId: string, from: readonly number[], sent: PageText, to: PageTheirs, how: PageLanding): void;
    /** This phone's move of a page landed: the last screen and the page's screens follow it. */
    pageMoved(move: PageMove): void;
    /** Pulls a Space's pages (page-manage.ts: a move's subpages, in the Space they went to). */
    pullPages(spaceId: string): void;
    /** Whether the outbox holds row `id`, not refused (false until it opens): a page move waits for its parent's create. */
    holdsRow(id: string): boolean;
    /** This phone's decision on a page review reached the chat: its edits in `drafts` go. */
    reviewDecided(threadId: string, toolCallId: string): void;
}

/** How long opening a scope took, step by step, and the rows the first frame has. */
export interface ScopeOpenTimings {
    /** Reading both database keys from the key store. */
    readonly keysMs: number;
    readonly cacheDbMs: number;
    readonly userDbMs: number;
    /** Loading the rows: cache.db's snapshot rows and view state, user.db's pending writes. */
    readonly rowsMs: number;
    /** The rows loaded, per collection. */
    readonly rows: Readonly<Record<string, number>>;
}

export interface WorkspaceScope {
    /** Unique to this scope: the workspace id and a count of scopes opened. Collection ids carry it. */
    readonly id: string;
    /** The workspace as the registry had it when the scope opened. */
    readonly workspace: WorkspaceRow;
    readonly jar: CookieJar;
    /** The workspace's authedFetch: every request of the scope goes through it. */
    readonly fetch: AuthedFetch;
    /** Aborted when the scope closes. */
    readonly signal: AbortSignal;
    readonly cache: SnapshotCache;
    /** The server's versions and the minimum-version gate. */
    readonly versions: ServerVersions;
    /** Whether this app is new enough for the server (CB-553): Update Socio, or the banner. */
    readonly compat: ClientCompat;
    readonly contact: ContactTracker;
    /** The newest Date header the scope's answers carried: the checks' watermarks. */
    readonly serverClock: ServerClock;
    /** Signed in or Expired, from the jar (session.ts). */
    readonly session: SessionWatch;
    readonly scheduler: SyncScheduler;
    readonly collections: ScopeCollections;
    /** The chat histories, per conversation (history.ts). */
    readonly histories: HistoryStore;
    /** The steering snapshots, per conversation (steering.ts). */
    readonly steering: SteeringStore;
    /** The follow streams, per conversation (follow.ts). */
    readonly follows: FollowStore;
    /** The issue details, by number (issue-details.ts, a bounded kind). */
    readonly issueDetails: IssueDetails;
    /** Who an admin can assign an issue to, the last list kept offline (issue-assignees.ts, a bounded kind). */
    readonly issueAssignees: IssueAssigneeList;
    /** The plugins and apps the person may tag an issue with, the last list kept offline (issue-component-options.ts, a bounded kind; CB-442). */
    readonly issueComponentOptions: IssueComponentOptionList;
    /** The task, schedule and job details, kept offline (schedule-details.ts, bounded kinds). */
    readonly scheduleDetails: ScheduleDetails;
    /** Runs' traces, read only on a tap; the person's own kept offline (run-traces.ts, a bounded kind). */
    readonly runTraces: BoundedStore<RunTraceView>;
    /** The Media library's folders, each one's first page kept offline (media-library.ts, a bounded kind; CB-558). */
    readonly mediaListings: MediaListings;
    /** Each Space's page summaries and the page bodies (page-store.ts). */
    readonly pages: PagesStore;
    /** The Spaces kept offline (user.db's `prefs`). */
    readonly keptSpaces: KeptSpaces;
    /** Reads every body of each kept Space (keep-offline.ts), and what each holds on disk. */
    readonly keepOffline: KeepOffline;
    /** The turns of runs this device started, which their follow streams drop (own-turns.ts). */
    readonly turns: OwnTurns;
    /** Each chat's reactions, in memory (reactions.ts). */
    readonly reactions: ReactionsStore;
    /** The view state in cache.db's `kv` (the last screen), read as the scope opened. */
    readonly viewState: ViewState;
    /** The workspace's queued writes (user.db's outbox), which fill `collections.pending`. */
    readonly outbox: Outbox;
    /** The composers' drafts (user.db's `drafts`), read before the first frame; a send goes through `enqueueFromDraft`. */
    readonly drafts: Drafts;
    /** The page editors' drafts (`drafts` scope `page:<pageId>`), flushed before the drafts close. */
    readonly pageDrafts: PageDrafts;
    /** A page review's edits (`drafts` scope `review:<threadId>:<toolCallId>`), keyed by that scope. */
    readonly reviewDrafts: PageDrafts;
    /** New chats' local ids: what a screen or a link opens for one, and each create that resolves. */
    readonly chats: LocalChats;
    /** Filed issues' local keys: what a screen or a link opens for one, and each create that resolves. */
    readonly issues: LocalIssues;
    /** Pages made on the phone: what a screen or a link opens for a local id, and each create that resolves. */
    readonly newPages: LocalPages;
    /** Each 409 that merged a page or left it under the conflict banner, for the screens' words. */
    readonly pageLandings: PageLandings;
    /** Picked files and their uploads (user.db's `files`, attachments.ts). */
    readonly attachments: Attachments;
    /** Uploads to the person's Files: covers and page images (user.db's `files`, upload-file.ts). */
    readonly uploads: FileUploads;
    /** user.db: writable, or read-only and why (an update needed to send what it holds). */
    readonly userDb: UserDbState;
    /** Whether the person is using the app, for the server's presence (presence.ts). */
    readonly presence: Presence;
    /** The in-app notices to show, one at a time (notices.ts). */
    readonly notices: NoticeFeed;
    /** Each room's view, by room id, kept in cache.db (rooms.ts, a bounded kind). */
    readonly roomViews: RoomViews;
    /** A shown room's polls: its view and presence (rooms.ts). */
    readonly rooms: RoomWatch;
    /** The RUN_ERROR codes this device saw, by run id (run-failures.ts): a stored failed run's wording. */
    readonly runFailures: RunFailures;
    /** Approval decisions, online only, and the reads that follow requests (approval-actions.ts). */
    readonly approvals: ApprovalActions;
    /** A room's online-only requests: invites accepted or declined, the notification level (room-actions.ts). */
    readonly roomActions: RoomActions;
    /** New Space, online only (space-create.ts): the web's `POST /api/spaces`, resolving once the Spaces list holds it. */
    readonly spaceCreate: SpaceCreate;
    /** New room, online only (room-create.ts, CB-470): the web's `POST /api/rooms`, resolving once the chat list holds it. */
    readonly roomCreate: RoomCreate;
    /** A page's conversation, online only (page-conversation.ts, CB-499): the web's open and its page banner. */
    readonly pageChats: PageChats;
    /** Settings → Notifications' online-only requests: the channels, the preferences, the test (notification-settings.ts). */
    readonly notificationSettings: NotificationSettings;
    /** Whether `dispose` has been called. */
    readonly disposed: boolean;
    /** Starts sync: the module kinds the first frame didn't read, the scheduler's triggers, a first full pull in the foreground, and the outbox. */
    start(): void;
    /** Stops and closes everything (the header). Never rejects: failures go to `onError`. Calling it again waits for the first. */
    dispose(): Promise<void>;
}

/** How long an accepted invite (or a new Space) waits for the shell to list it before its screen opens anyway. */
const JOIN_WAIT_MS = 10_000;

/** Scopes opened so far in this process: each one's id is different, even for one workspace. */
let opened = 0;

/** Opens workspace `workspaceId`'s scope, with its collections filled from cache.db and user.db. */
export async function openWorkspaceScope(options: WorkspaceScopeOptions): Promise<WorkspaceScope> {
    const { store, workspaceId, fetch, userAgent, variant, appState, network, onUnauthorized } = options;
    const { onError = () => {}, now = Date.now, random, clock = () => performance.now(), onOpened } = options;
    const { outboxKinds = [] } = options;
    const workspace = await store.registry.get(workspaceId);
    if (workspace === null || workspace.state !== 'ready') {
        throw new WorkspaceScopeError(`Workspace ${workspaceId} isn't ready on this phone.`);
    }
    const layout = workspaceLayout(store.root, workspaceId);
    const t0 = clock();
    const cacheKey = await store.keys.read(workspaceKeyName(workspaceId, 'cache'));
    const userKey = await store.keys.read(workspaceKeyName(workspaceId, 'user'));
    if (cacheKey === null || userKey === null) {
        throw new WorkspaceScopeError(`Workspace ${workspaceId} has no database key.`);
    }

    /** What is open so far, closed in reverse when a later step fails. */
    const opens: (() => Promise<void>)[] = [];
    try {
        const t1 = clock();
        const cacheDb = await openCacheDb(store.driver, layout.directory, cacheKey);
        opens.push(() => cacheDb.db.close());
        const t2 = clock();
        const userDb = await openUserDb(store.driver, layout.directory, userKey);
        opens.push(() => userDb.db.close());
        const keptSpaces = await openKeptSpaces({ db: userDb.db, state: userDb.state, onError });
        opens.push(() => keptSpaces.close());
        const t3 = clock();
        const jar = await openCookieJar({
            origin: workspace.origin,
            store: store.keys.slot(workspaceKeyName(workspaceId, 'jar')),
            now,
        });
        opens.push(() => jar.close());
        // This install's id for the workspace; a copy signed in before install ids existed has none until it signs in again.
        // One that isn't an install id (nothing else writes it) is left unsent rather than keeping the scope shut.
        const kept = await store.keys.read(workspaceKeyName(workspaceId, 'install'));
        // Only a key this build's commit recorded writing (migration 10): an older build's wipe can leave one.
        const installId =
            kept !== null && workspace.installSetAt != null && installIdSchema.safeParse(kept).success ? kept : null;

        const versions = createServerVersions({
            variant,
            persist: (state) => store.registry.setServerVersions(workspaceId, state),
            initial: await store.registry.serverVersions(workspaceId),
            onError,
            now,
        });
        const contact = createContactTracker({
            jar,
            persist: async (at) => {
                await store.registry.setLastContact(workspaceId, at);
                options.onContact?.(at);
            },
            onError,
            last: workspace.lastContact,
        });
        const serverClock = createServerClock();
        const session = createSessionWatch(jar);
        opens.push(async () => session.dispose());
        const controller = new AbortController();
        const { signal } = controller;
        /** Set once the scheduler exists; an Ended 401 stops it. */
        let stopSync = () => {};
        /** Set once the view state opens: a 426 closes the app's gate (CB-553). */
        let compatRef: ClientCompat | null = null;
        const authed = createAuthedFetch({
            origin: workspace.origin,
            jar,
            fetch,
            userAgent,
            signal,
            installId,
            onUnauthorized: async (end, url) => {
                if (end !== 'expired') {
                    // Locked: no more requests, and the registry says so before the gate reads it.
                    stopSync();
                    try {
                        await store.registry.setEnded(workspaceId, now());
                    } catch (error) {
                        onError(error);
                    }
                }
                await onUnauthorized?.(end, url);
            },
            onAnswer: (answer) => {
                contact.onAnswer(answer);
                serverClock.observe(answer);
                session.check();
                if (answer.status === CLIENT_UPDATE_STATUS) {
                    compatRef?.refused();
                }
            },
        });
        // The view state first: the kept screen decides which module kind the first frame reads (kinds.ts).
        const viewState = await openViewState(cacheDb.db, onError);
        opens.push(() => viewState.close());
        // The kept numbers first, so a cold start offline shows Update Socio before any answer.
        const compat = createClientCompat({ fetch: authed, userAgent, viewState, signal, onError });
        compatRef = compat;
        opens.push(async () => compat.dispose());
        const cache = await openSnapshotCache({
            db: cacheDb.db,
            definitions: [...SHELL_SNAPSHOTS, ...firstFrameSnapshots(viewState)],
            onWriteError: onError,
            now,
            versions,
        });
        opens.push(() => cache.close());

        opened += 1;
        const id = `${workspaceId}.${opened}`;
        const me = workspace.appUserId;
        const runFailures = createRunFailures(viewState);
        const onRunError = (_threadId: string, runId: string, code: unknown) => runFailures.note(runId, code);
        /** Set once the outbox opens: a chat's runs settle its sent messages (`caughtUp`). */
        let outboxRef: Outbox | null = null;
        /** Set once the page editors' drafts exist (after the outbox): a save rebases them (page-save.ts). */
        let pageDraftsRef: PageDrafts | null = null;
        let draftsRef: Drafts | null = null;
        const pageLandings = createPageLandings(onError);
        const histories = createHistoryStore({
            scopeId: id,
            db: cacheDb.db,
            fetch: authed,
            signal,
            onError,
            now,
            isLocal: isLocalChat,
            onRuns: (threadId, has) => {
                const outbox = outboxRef;
                // A new chat's messages keep its local id's lane: they settle against the server id's runs.
                for (const lane of outbox === null ? [] : chatLanes(outbox, threadId)) {
                    outbox?.caughtUp(lane, has).catch(onError);
                }
                // A page review's decision settles as its result is stored.
                outbox?.caughtUp(reviewLane(threadId), has).catch(onError);
            },
            // Lost access wins over the outbox: the chat's messages go to the Unsent list.
            onGone: (threadId) => {
                const outbox = outboxRef;
                if (outbox !== null && !outbox.status().readOnly) {
                    outbox.refuseLanes(chatLanes(outbox, threadId), UNSENT_GONE).catch(onError);
                }
            },
        });
        opens.push(() => histories.close());
        const steering = createSteeringStore({ scopeId: id, fetch: authed, signal, isLocal: isLocalChat });
        opens.push(() => steering.close());
        const follows = createFollowStore({
            fetch: authed,
            histories,
            steering,
            onError,
            random,
            now,
            isLocal: isLocalChat,
            // The follow stream's carry-over: the person's own messages in a room's live turn are theirs.
            me: () => me,
            onRunError,
        });
        opens.push(() => follows.close());
        const roomViews = createRoomViews({
            db: cacheDb.db,
            fetch: authed,
            signal,
            // Lost access wins over the outbox: the room's messages go to the Unsent list.
            onGone: (roomId) => {
                const outbox = outboxRef;
                if (outbox !== null && !outbox.status().readOnly) {
                    outbox.refuseLanes(chatLanes(outbox, roomId), UNSENT_GONE).catch(onError);
                }
            },
            onError,
            now,
        });
        opens.push(() => roomViews.close());
        const rooms = createRoomWatch({ views: roomViews, follows, fetch: authed, signal, appState, onError });
        opens.push(async () => rooms.close());
        const turns = createOwnTurns();
        opens.push(async () => turns.clear());
        const reactions = createReactionsStore({ fetch: authed, signal, isLocal: isLocalChat });
        opens.push(async () => reactions.close());
        const issueDetails = createIssueDetails({
            db: cacheDb.db,
            fetch: authed,
            signal,
            cache,
            outbox: () => outboxRef,
            // Lost access wins over the outbox: the issue's writes go to the Unsent list.
            onGone: (lanes) => {
                const outbox = outboxRef;
                if (outbox !== null && !outbox.status().readOnly) {
                    outbox.refuseLanes(lanes, UNSENT_GONE).catch(onError);
                }
            },
            onError,
            now,
        });
        opens.push(() => issueDetails.close());
        const issueAssignees = createIssueAssignees({ db: cacheDb.db, fetch: authed, signal, onError, now });
        opens.push(() => issueAssignees.close());
        const issueComponentOptions = createIssueComponentOptions({
            db: cacheDb.db,
            fetch: authed,
            signal,
            onError,
            now,
        });
        opens.push(() => issueComponentOptions.close());
        const scheduleDetails = createScheduleDetails({ db: cacheDb.db, fetch: authed, signal, onError, now });
        opens.push(() => scheduleDetails.close());
        const runTraces = createRunTraces({
            db: cacheDb.db,
            fetch: authed,
            signal,
            onError,
            now,
            ownRun: (runId) => {
                const row = cache.rows(RUNS).get(runId);
                return row !== undefined && isOwnRun(runRow(runId, JSON.parse(row.json)), me);
            },
        });
        opens.push(() => runTraces.close());
        const mediaListings = createMediaListings({ db: cacheDb.db, fetch: authed, signal, onError, now });
        opens.push(() => mediaListings.close());
        /** Set once the scheduler exists: each Space a screen shows gets its job. */
        let schedulerRef: SyncScheduler | null = null;
        const pages = createPagesStore({
            scopeId: id,
            db: cacheDb.db,
            fetch: authed,
            signal,
            cache,
            scheduler: () => schedulerRef,
            viewState,
            outbox: () => outboxRef,
            keptSpaces: () => keptSpaces.list(),
            onError,
            now,
        });
        opens.push(() => pages.close());
        const keepOffline = createKeepOffline({
            kept: keptSpaces,
            pages,
            cache,
            db: cacheDb.db,
            fetch: authed,
            signal,
            onError,
        });
        opens.push(() => keepOffline.close());
        /** Set by `start()`: a locked copy reads nothing for its kept Spaces. */
        let started = false;
        const syncKept = () => {
            if (started) {
                keepOffline.sync();
            }
        };
        /** Set once the scheduler exists: a write's notes poke the shell's sources. */
        let pokeShell = () => {};
        const afterWrite = (path: string) => {
            const notes = notesToPull(path);
            for (const threadId of notes.conversations) {
                if (histories.held().includes(threadId)) {
                    void histories.history(threadId).pull();
                }
                if (steering.held().includes(threadId)) {
                    void steering.steering(threadId).refresh();
                }
            }
            for (const key of notes.issues) {
                void issueDetails.peek(key)?.refresh();
            }
            if (notes.shell) {
                pokeShell();
            }
        };
        const platformFiles = options.attachments;
        let fallbackIds = 0;
        const attachmentFiles: AttachmentFiles = platformFiles?.files ?? {
            list: store.fs.list,
            remove: store.fs.remove,
            mkdir: store.fs.mkdir,
            copy: () => Promise.reject(new Error('This scope has no file access.')),
            body: () => Promise.reject(new Error('This scope has no file access.')),
        };
        const attachments = await openAttachments({
            db: userDb.db,
            state: userDb.state,
            layout,
            files: attachmentFiles,
            setFileProtection: platformFiles?.setFileProtection ?? (async () => {}),
            fetch: authed,
            newId: platformFiles?.newId ?? (() => `file-${now()}-${(fallbackIds += 1)}`),
            processImage: platformFiles?.processImage,
            processIssueImage: platformFiles?.processIssueImage,
            // A new chat's files upload pending until its create resolves.
            serverThread: (threadId) =>
                isLocalChat(threadId) ? (outboxRef?.resolve(CONVERSATION_IDS, threadId) ?? null) : threadId,
            onError,
            now,
        });
        opens.push(() => attachments.close());
        const uploads = await openFileUploads({
            db: userDb.db,
            state: userDb.state,
            layout,
            files: attachmentFiles,
            setFileProtection: platformFiles?.setFileProtection ?? (async () => {}),
            fetch: authed,
            newId: platformFiles?.newId ?? (() => `upload-${now()}-${(fallbackIds += 1)}`),
            processImage: platformFiles?.processPageImage,
            viewState,
            onError,
            now,
        });
        opens.push(() => uploads.close());
        const outbox = await openOutbox({
            db: userDb.db,
            state: userDb.state,
            kinds:
                typeof outboxKinds === 'function'
                    ? outboxKinds({
                          histories,
                          steering,
                          follows,
                          issueDetails,
                          cache,
                          attachments,
                          uploads,
                          afterWrite,
                          onTurn: turns.set,
                          me,
                          onRunError,
                          onReactions: reactions.take,
                          unsent: () => outboxRef?.unsent() ?? [],
                          pageBodies: {
                              put: (key, page) => pages.bodies.put(key, page),
                              read: async (key) => {
                                  try {
                                      return (pages.bodies.peek(key) ?? (await pages.bodies.preload(key))).state.value;
                                  } catch {
                                      return null;
                                  }
                              },
                          },
                          pageSaved: (pageId, from, page) => pageDraftsRef?.rebase(pageId, from, page),
                          pageLanded: (pageId, from, sent, to, how) => {
                              pageDraftsRef?.landed(pageId, from, sent, to);
                              pageLandings.note(pageId, how, sent, to);
                          },
                          pageMoved: (move) => pages.noteMoved(move),
                          pullPages: (spaceId) => void pages.space(spaceId).pull(),
                          holdsRow: (id) => outboxRef?.rows().some((row) => row.id === id) ?? false,
                          reviewDecided: (threadId, toolCallId) => {
                              if (draftsRef !== null) {
                                  dropEdits(draftsRef, threadId, toolCallId, onError);
                              }
                          },
                      })
                    : outboxKinds,
            fetch: authed,
            onError,
            now,
            random,
        });
        outboxRef = outbox;
        opens.push(() => outbox.dispose());
        // Kept numbers below the minimum hold every lane from the start (CB-553).
        outbox.holdForUpdate(compat.state().required);
        const drafts = await openDrafts({ db: userDb.db, state: userDb.state, outbox, onError, now });
        opens.push(() => drafts.close());
        draftsRef = drafts;
        // NetInfo's word, for the page editors' offline writes: unknown counts as online.
        let connected: boolean | null = null;
        // The editor's drafts become the page's `page-save` rows.
        const pageSaves = createPageSaves({
            outbox,
            drafts,
            baseOf: async (spaceId, pageId, revision) => {
                const key = pageBodyKey(spaceId, pageId);
                const item = pages.bodies.peek(key) ?? (await pages.bodies.preload(key));
                const page = item.state.value;
                return page !== null && page.revision === revision ? page : null;
            },
            newId: options.newId ?? (() => `page-save-${now()}-${(fallbackIds += 1)}`),
            // A folder's hidden body takes no saves (CB-426): the editor's draft waits on the phone.
            isFolder: (spaceId, pageId) =>
                pendingFolder(outbox, pageId) ??
                (isFolder(pages.bodies.peek(pageBodyKey(spaceId, pageId))?.state.value) ||
                    heldFolder(cache, spaceId, pageId)),
        });
        const pageDrafts = createPageDrafts({
            drafts,
            connected: () => connected !== false,
            sink: pageSaves,
            onError,
        });
        pageDraftsRef = pageDrafts;
        opens.push(() => pageDrafts.close());
        // A page review's edits, on `review:` scopes, never queued by themselves.
        const reviewDrafts = createReviewDrafts({ drafts, connected: () => connected !== false, onError });
        opens.push(() => reviewDrafts.close());
        const chats = createLocalChats({ outbox, drafts, viewState, onError });
        // A new chat's tray follows its draft to the server id, also for creates a kill left resolved.
        for (const tray of attachments.trays()) {
            const local = tray.startsWith('chat:') ? tray.slice(5) : '';
            const server = isLocalChat(local) ? outbox.resolve(CONVERSATION_IDS, local) : null;
            if (server !== null) {
                attachments.rekey(tray, `chat:${server}`);
            }
        }
        chats.subscribe((local, server) => attachments.rekey(`chat:${local}`, `chat:${server}`));
        opens.push(async () => chats.dispose());
        // A filed issue's comment draft and last screen follow its number.
        const issues = createLocalIssues({ outbox, drafts, viewState, onError });
        // So does its comment box's tray, also for creates a kill left resolved.
        const commentTray = issueCommentsDraft('');
        for (const tray of attachments.trays()) {
            const local = tray.startsWith(commentTray) ? tray.slice(commentTray.length) : '';
            const number = isLocalIssue(local) ? outbox.resolve(ISSUE_IDS, local) : null;
            if (number !== null) {
                attachments.rekey(tray, issueCommentsDraft(number));
            }
        }
        issues.subscribe((local, number) => attachments.rekey(issueCommentsDraft(local), issueCommentsDraft(number)));
        opens.push(async () => issues.dispose());
        // A page made on the phone re-keys its editor draft and the last screen once created.
        const newPages = createLocalPages({ outbox, drafts, viewState, onError });
        opens.push(async () => newPages.dispose());
        const pending = outbox.rows();
        const t4 = clock();

        const collections = createScopeCollections(id, cache, pending);
        opens.push(() => cleanupScopeCollections(collections));
        const presence = createPresence({ fetch: authed, appState, randomBytes: options.randomBytes });
        const notices = createNoticeFeed({
            cache,
            viewState,
            outbox,
            newId: options.newId ?? platformFiles?.newId ?? (() => `notice-${now()}-${(fallbackIds += 1)}`),
            onError,
        });
        opens.push(async () => notices.close());
        // Every /api/state pull says whether the person is using the app, and goes every 5 s.
        const jobs: SyncJob[] = [
            ...SHELL_SNAPSHOTS.map((definition) => {
                const state = definition === STATE_SNAPSHOT;
                return {
                    source: createSnapshotSource({
                        definition,
                        cache,
                        fetch: authed,
                        signal,
                        ...(state ? { headers: presence.headers } : {}),
                    }),
                    collections: [...new Set(definition.feeds.map((feed) => feed.collection))],
                    poll: true,
                    ...(state ? { pollMs: PRESENCE_POLL_MS } : {}),
                };
            }),
            // The modules' kinds: after the shell, and polled only while their screen is in view (kinds.ts).
            ...MODULE_KINDS.map(({ definition, collections: filled, visiblePoll, inView }): SyncJob => ({
                source: createSnapshotSource({ definition, cache, fetch: authed, signal }),
                collections: filled,
                ...(visiblePoll === undefined ? {} : { visiblePoll }),
                ...(inView ? { inView } : {}),
                deferred: true,
            })),
        ];
        const scheduler = createScheduler({ jobs, appState, network, onError, random });
        schedulerRef = scheduler;
        const approvals = createApprovalActions({
            fetch: authed,
            cache,
            appState,
            network,
            away: () => scheduler.status().reconnecting,
            hold: () => writeHold(session.state(), versions.gate()),
            feedback: options.approvalFeedback,
            onError,
            now,
        });
        /** Pulls the shell and resolves once `collection` holds `key`, or after `JOIN_WAIT_MS`. */
        const whenListed = (collection: string, key: string) =>
            new Promise<void>((resolve) => {
                const listed = () => cache.rows(collection).has(key);
                if (listed()) {
                    resolve();
                    return;
                }
                const done = () => {
                    clearTimeout(timer);
                    stop();
                    resolve();
                };
                const timer = setTimeout(done, JOIN_WAIT_MS);
                const stop = cache.subscribe(() => {
                    if (listed()) {
                        done();
                    }
                });
                scheduler.poke([WORKSPACE_SNAPSHOT.id]);
            });
        const roomActions = createRoomActions({
            fetch: authed,
            network,
            away: () => scheduler.status().reconnecting,
            hold: () => writeHold(session.state(), versions.gate()),
            invitesChanged: () => scheduler.poke([ROOM_INVITES_SNAPSHOT.id]),
            joined: (roomId) => whenListed(CONVERSATIONS, roomId),
        });
        const spaceCreate = createSpaceCreate({
            fetch: authed,
            network,
            away: () => scheduler.status().reconnecting,
            hold: () => writeHold(session.state(), versions.gate()),
            listed: (spaceId) => whenListed(SPACES, spaceId),
            refresh: () => scheduler.poke([WORKSPACE_SNAPSHOT.id]),
        });
        const roomCreate = createRoomCreate({
            fetch: authed,
            network,
            away: () => scheduler.status().reconnecting,
            hold: () => writeHold(session.state(), versions.gate()),
            listed: (roomId) => whenListed(CONVERSATIONS, roomId),
            refresh: () => scheduler.poke([WORKSPACE_SNAPSHOT.id]),
        });
        const pageChats = createPageChats({
            fetch: authed,
            network,
            away: () => scheduler.status().reconnecting,
            hold: () => writeHold(session.state(), versions.gate()),
            listed: (chatId) => whenListed(CONVERSATIONS, chatId),
            isLocal: isLocalChat,
        });
        /** The shell's workspace row as cache.db's memory holds it, or null before its first answer. */
        const workspaceRow = (): Record<string, unknown> | null => {
            const row = cache.rows(SHELL).get(WORKSPACE_KEY);
            return row === undefined ? null : (JSON.parse(row.json) as Record<string, unknown>);
        };
        const notificationSettings = createNotificationSettings({
            fetch: authed,
            network,
            away: () => scheduler.status().reconnecting,
            hold: () => writeHold(session.state(), versions.gate()),
            stored: () => workspaceRow()?.preferences as UserPreferences | undefined,
            confirmPreferences: (preferences) => {
                const row = workspaceRow();
                if (row !== null) {
                    cache
                        .confirm({ collection: SHELL, scope: '', key: WORKSPACE_KEY, value: { ...row, preferences } })
                        .catch(onError);
                }
            },
        });
        stopSync = () => scheduler.stop();
        pokeShell = () => scheduler.poke();
        if (onOpened) {
            const rows: Record<string, number> = { pending: pending.length };
            for (const name of SYNCED_COLLECTIONS) {
                rows[name] = cache.rows(name).size;
            }
            onOpened({ keysMs: t1 - t0, cacheDbMs: t2 - t1, userDbMs: t3 - t2, rowsMs: t4 - t3, rows });
        }

        // Writes that must not wait: the app going to the background, the network going.
        const writeNow = () => {
            pageDrafts.flush().catch(onError);
            reviewDrafts.flush().catch(onError);
            cache.flush().catch(onError);
            versions.flush().catch(onError);
            contact.flush().catch(onError);
        };
        const watch = createNetworkWatch();
        network
            .current()
            .then((state) => {
                watch.seed(state);
                connected ??= state.connected;
            })
            .catch(() => {});
        // The registry's count of the outbox's rows, for the drawer while another workspace is open.
        let waiting = workspace.waiting;
        const keepWaiting = (count: number) => {
            if (count !== waiting) {
                waiting = count;
                store.registry.setSummary(workspaceId, { waiting: count }).catch(onError);
            }
        };
        keepWaiting(outbox.status().waiting);
        let background = !isForeground(appState.current());
        // A file goes once the row that carried it has settled or been discarded.
        const sweep = () => void attachments.sweep().catch(onError);
        const unsubscribes = [
            outbox.onUnsent(sweep),
            outbox.subscribe((change) => {
                const { pending: local } = collections;
                if (change.type === 'remove') {
                    sweep();
                    if (local.has(change.id)) {
                        local.delete(change.id);
                    }
                } else if (local.has(change.row.id)) {
                    local.update(change.row.id, (draft) => {
                        Object.assign(draft, change.row);
                    });
                } else {
                    local.insert(change.row);
                }
            }),
            outbox.onStatus((status) => keepWaiting(status.waiting)),
            // Below the server's minimum every lane waits for the update, and goes after it (CB-553).
            compat.subscribe(() => outbox.holdForUpdate(compat.state().required)),
            // Typing counts as using the app (the web counts keys): the keyboard's taps never reach the app's views.
            drafts.subscribe(() => presence.touch()),
            // A message's row sent while its chat's history already holds it goes at once.
            followStoredChats(outbox, histories, onError),
            followStoredReviews(outbox, histories, onError),
            // A held detail is read again when the list's poll changes or drops its row.
            followIssueList(cache, issueDetails),
            // The drain's triggers: the foreground, the network back or changed. Uploads
            // that waited go again first, so a message holding for them can go.
            bindOutboxTriggers({
                appState,
                network,
                poke: () => {
                    attachments.pump();
                    uploads.pump();
                    outbox.poke();
                },
                wake: () => {
                    attachments.pump();
                    uploads.pump();
                    outbox.wake();
                },
            }),
            versions.subscribe((change) => {
                if (change.fresh) {
                    scheduler.stale();
                }
            }),
            cache.subscribe((change) => {
                if (!change.confirmed) {
                    return;
                }
                for (const { collection, scope } of [...change.upserts, ...change.removes]) {
                    scheduler.confirmed(collection, scope);
                }
            }),
            appState.subscribe((state) => {
                if (!isForeground(state)) {
                    background = true;
                    // The server holds pushes back while the app counts as in use: say it doesn't, at once.
                    void presence.away();
                    writeNow();
                } else if (background) {
                    // A stream held open in the background isn't trusted until checked (follow.ts).
                    background = false;
                    follows.foreground();
                    syncKept();
                    // An update may have been installed, or the server's numbers moved (CB-553).
                    if (started) {
                        void compat.check();
                    }
                }
            }),
            network.subscribe((state) => {
                connected = state.connected;
                const change = watch.report(state);
                if (change === 'lost') {
                    writeNow();
                } else if (change !== null) {
                    follows.wake();
                    syncKept();
                }
            }),
        ];

        let disposing: Promise<void> | null = null;
        const dispose = async () => {
            scheduler.stop();
            compat.dispose();
            rooms.close();
            const stoppingKeep = keepOffline.close();
            approvals.dispose();
            roomActions.dispose();
            spaceCreate.dispose();
            roomCreate.dispose();
            pageChats.dispose();
            notificationSettings.dispose();
            // Sent first, so it is on its way while the drafts and the outbox close (best effort).
            const away = presence.away();
            notices.close();
            session.dispose();
            chats.dispose();
            issues.dispose();
            newPages.dispose();
            // The drafts first: a send already begun commits, and what was typed is written
            // (the page editors' latest text into them first).
            await pageDrafts.close();
            await reviewDrafts.close();
            await drafts.close();
            // Uploads stop first (a row waiting on one goes back to the outbox), then the outbox.
            const closingAttachments = Promise.all([attachments.close(), uploads.close()]);
            await outbox.dispose();
            await closingAttachments;
            for (const unsubscribe of unsubscribes.splice(0)) {
                unsubscribe();
            }
            // The away post went out before the closing above; no timer waits for its answer (nothing may outlive dispose).
            await Promise.race([away, Promise.resolve()]);
            controller.abort();
            const steps = [
                () => stoppingKeep,
                () => keptSpaces.close(),
                () => follows.close(),
                () => histories.close(),
                () => steering.close(),
                () => reactions.close(),
                () => issueDetails.close(),
                () => issueAssignees.close(),
                () => issueComponentOptions.close(),
                () => scheduleDetails.close(),
                () => runTraces.close(),
                () => mediaListings.close(),
                () => roomViews.close(),
                () => pages.close(),
                () => cache.close(),
                () => viewState.close(),
                () => versions.flush(),
                () => contact.flush(),
                () => jar.close(),
                () => cleanupScopeCollections(collections),
                () => cacheDb.db.close(),
                () => userDb.db.close(),
            ];
            for (const step of steps) {
                try {
                    await step();
                } catch (error) {
                    onError(error);
                }
            }
        };

        return {
            id,
            workspace,
            jar,
            fetch: authed,
            signal,
            cache,
            versions,
            compat,
            contact,
            serverClock,
            session,
            scheduler,
            collections,
            histories,
            steering,
            follows,
            turns,
            reactions,
            issueDetails,
            issueAssignees,
            issueComponentOptions,
            scheduleDetails,
            runTraces,
            mediaListings,
            pages,
            keptSpaces,
            keepOffline,
            viewState,
            outbox,
            drafts,
            pageDrafts,
            reviewDrafts,
            chats,
            issues,
            newPages,
            pageLandings,
            attachments,
            uploads,
            presence,
            notices,
            roomViews,
            rooms,
            runFailures,
            approvals,
            roomActions,
            spaceCreate,
            roomCreate,
            pageChats,
            notificationSettings,
            userDb: userDb.state,
            get disposed() {
                return disposing !== null;
            },
            start() {
                if (disposing !== null) {
                    throw new WorkspaceScopeError(`Scope ${id} is closed.`);
                }
                // After the first frame: the module kinds it didn't read.
                cache.load(MODULE_SNAPSHOTS).catch(onError);
                scheduler.start();
                outbox.start();
                notices.start();
                started = true;
                // Whether this app is new enough for the server, at every start (CB-553).
                void compat.check();
                // In the background it waits for the foreground, as the scheduler does.
                if (isForeground(appState.current())) {
                    syncKept();
                }
                attachments.pump();
                uploads.pump();
                sweep();
            },
            dispose() {
                disposing ??= dispose();
                return disposing;
            },
        };
    } catch (error) {
        for (const close of opens.reverse()) {
            await close().catch(() => {});
        }
        throw error;
    }
}
