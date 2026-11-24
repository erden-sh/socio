import { setFileProtection } from '../../modules/socio-device';
import { cacheSize, prepareWorkspaceFolders, type Store, workspaceLayout, type WorkspaceSummary } from '../data';
import { rootGate, rootState } from '../navigation/root-gate';
import { preloadKeptChat, preloadKeptIssue, preloadKeptPage, preloadKeptSpace } from '../shell/last-screen';
import { createActiveScope } from '../sync/active-scope';
import { followBackgroundGrace } from '../sync/background-grace';
import { chatManageKinds } from '../sync/chat-manage';
import { chatMessageKind } from '../sync/chat-send';
import { clearWorkspaceCache } from '../sync/clear-cache';
import { issueAttachmentKind } from '../sync/issue-attachments';
import { issueCommentKinds } from '../sync/issue-comments';
import { issueCreateKind } from '../sync/issue-create';
import { issueEditKinds } from '../sync/issue-edit';
import { memoryWriteKinds } from '../sync/memory-writes';
import { newChatKind } from '../sync/new-chat';
import { noticeSeenKind } from '../sync/notices';
import { pageManageKinds } from '../sync/page-manage';
import { pageReviewKind, reviewHold } from '../sync/page-review';
import { pageSaveKind } from '../sync/page-save';
import { roomMessageKind, roomReadKind } from '../sync/room-send';
import { scheduleWriteKinds } from '../sync/schedule-writes';
import { openWorkspaceScope } from '../sync/scope';
import { createScopeHolds } from '../sync/scope-holds';

import { appState } from './app-state';
import { approvalFeedback } from './approval-feedback';
import { createAttachmentFiles } from './attachment-files';
import { backgroundGrace } from './background-grace';
import { createSizeOf } from './cache-size';
import { markScopeOpened } from './cold-start';
import { randomId } from './crypto';
import { appFetch } from './fetch';
import { processImage, processIssueImage, processPageImage } from './image-processor';
import { network } from './network';
import { APP_USER_AGENT } from './user-agent';
import { BUILD_VARIANT } from './variant';

// The active workspace's scope on the phone (src/sync/active-scope.ts), bound
// to the store launch opened, the app's one fetch and User-Agent, AppState and
// NetInfo. It follows the root gate: the shell's workspace has its scope open,
// and any other gate state (Add workspace, adding another, the lock screen)
// has none. Launch waits for the first one before the splash goes
// (device-store.ts), so the first frame draws the cached rows. The switcher
// (`switchTo`) and "Add a workspace" (`startAdding`) change the registry or the
// gate; the scope follows.
//
// Once a scope opens, its images/ and attachments/ get their iOS protection
// classes (src/data/workspace-files.ts), and the outbox's background grace
// follows the open scope (background-grace.ts, iOS only).

/** The store launch opened, handed in by `followRootGate`. */
let opened: Store | null = null;

function store(): Store {
    if (opened === null) {
        throw new Error('The store is not open.');
    }
    return opened;
}

/**
 * Gives the workspace's folders their protection classes. Whatever writes in
 * one prepares it first too (`prepareImagesFolder`, `prepareAttachmentsFolder`),
 * so this covers folders an earlier build made. A failure is only logged: the
 * files would still have iOS's default class, encrypted until the first unlock.
 */
async function prepareFolders(workspaceId: string): Promise<void> {
    const { root, fs } = store();
    try {
        await prepareWorkspaceFolders({ fs, setFileProtection }, workspaceLayout(root, workspaceId));
    } catch (error) {
        console.warn('[files] the workspace folders did not get their protection', error);
    }
}

/** Told after each last contact the open scope keeps (at most once a minute): push's lease deadline (push.ts). */
export const contactMoved = new Set<() => void>();

/**
 * Told when a 401 says the copy is to be wiped (the server's `device_revoked`
 * and `deactivated`): session.ts wipes it, in silence. The scope has
 * already locked it.
 */
export const copyRevoked = new Set<(workspaceId: string, end: 'device-revoked' | 'deactivated') => void>();

export const activeScope = createActiveScope({
    // A kept chat's history is read before the first frame too.
    open: async (workspaceId) => {
        const scope = await openWorkspaceScope({
            store: store(),
            workspaceId,
            // Chat attachments: HEIC to JPEG, downscaled under the model's 10 MB; uploads to Files: a
            // page's image under 5 MB; issue attachments: an issue file under 5 MiB (image-processor.ts).
            attachments: {
                files: createAttachmentFiles(store().fs),
                setFileProtection,
                newId: randomId,
                processImage,
                processPageImage,
                processIssueImage,
            },
            fetch: appFetch,
            userAgent: APP_USER_AGENT,
            variant: BUILD_VARIANT,
            appState,
            network,
            // An Ended 401 kept `endedAt` (scope.ts): the gate locks the copy. Not awaited: the scope closes after it.
            // A wiping one locks it the same way, then session.ts wipes it.
            onUnauthorized: (end) => {
                if (end !== 'expired') {
                    rootState.refresh().catch((error: unknown) => console.warn('[session] gate not read', error));
                }
                if (end === 'device-revoked' || end === 'deactivated') {
                    for (const listener of [...copyRevoked]) {
                        listener(workspaceId, end);
                    }
                }
            },
            onError: (error) => console.warn('[sync]', error),
            // The scope's own writes (a notice's seen mark) take expo-crypto's ids.
            newId: randomId,
            // Approvals: a decision's haptic, by the phone's setting.
            approvalFeedback,
            // Messages in a private chat, as runs or steering; new chats; rename, archive,
            // delete, reactions, steering edit and cancel. Page review decisions, and the hold
            // on a chat's messages while one is open. In-app notices marked seen. Issues filed,
            // offline and exactly once; their comments added, edited and deleted; field edits
            // and votes; files, one row each. Room messages (always steering) and read marks.
            outboxKinds: (scope) => [
                noticeSeenKind(),
                chatMessageKind({ ...scope, newId: randomId, prepare: reviewHold(scope.unsent) }),
                pageReviewKind({ ...scope, newId: randomId }),
                newChatKind({ afterWrite: scope.afterWrite }),
                ...chatManageKinds(scope),
                issueCreateKind({ issueDetails: scope.issueDetails, afterWrite: scope.afterWrite }),
                ...issueCommentKinds({ issueDetails: scope.issueDetails, afterWrite: scope.afterWrite }),
                ...issueEditKinds({ issueDetails: scope.issueDetails, afterWrite: scope.afterWrite }),
                issueAttachmentKind({
                    attachments: scope.attachments,
                    issueDetails: scope.issueDetails,
                    afterWrite: scope.afterWrite,
                }),
                // Memories, proposals, the profile and the moved time zone's note.
                ...memoryWriteKinds(scope),
                // Pause, resume and cancel a schedule, and goal comments.
                ...scheduleWriteKinds(scope),
                // Room messages and read marks.
                roomMessageKind({ ...scope, newId: randomId }),
                roomReadKind({ cache: scope.cache }),
                // Page saves, one coalesced row per page.
                pageSaveKind({
                    bodies: scope.pageBodies,
                    cache: scope.cache,
                    onSaved: scope.pageSaved,
                    // Merges and conflicts move the editor and tell the screens.
                    onLanded: scope.pageLanded,
                    newId: randomId,
                }),
                // Creating, moving and deleting pages, and their covers.
                ...pageManageKinds({
                    bodies: scope.pageBodies,
                    cache: scope.cache,
                    uploads: scope.uploads,
                    onSaved: scope.pageSaved,
                    onMoved: scope.pageMoved,
                    pull: scope.pullPages,
                    holdsRow: scope.holdsRow,
                    newId: randomId,
                }),
            ],
            onOpened: (timings) => markScopeOpened(workspaceId, timings),
            onContact: () => {
                for (const listener of [...contactMoved]) {
                    listener();
                }
            },
        });
        // After the open, so only a ready workspace's directory gets them, and
        // not awaited, so the first frame doesn't wait for two native calls.
        void prepareFolders(workspaceId);
        await preloadKeptChat(scope, (error) => console.warn('[chat] the kept chat did not load', error));
        await preloadKeptPage(scope, (error) => console.warn('[pages] the kept page did not load', error));
        await preloadKeptSpace(scope, (error) => console.warn('[pages] the kept Space did not load', error));
        await preloadKeptIssue(scope, (error) => console.warn('[issues] the kept issue did not load', error));
        return scope;
    },
    onError: (error) => console.warn('[scope] the workspace did not open', error),
});

/**
 * Workspaces being signed out or wiped (sign-out.ts, session.ts): their scopes
 * stay closed whatever the gate says. Counted per workspace, so one
 * release can't drop another's hold.
 */
const holds = createScopeHolds();

/** The workspace whose scope the gate shows: the active one while the gate is the shell, else none. */
function wantedScope(): string | null {
    const state = rootState.get();
    const id = rootGate(state) === 'shell' && state.active !== null ? state.active.id : null;
    return id !== null && holds.isHeld(id) ? null : id;
}

/**
 * Closes workspace `id`'s scope and keeps it closed until `releaseScope`, for
 * signing out: resolves once the scope has disposed (its jar and files closed).
 */
export function holdScope(id: string): Promise<void> {
    holds.hold(id);
    return activeScope.show(wantedScope());
}

/** Ends one `holdScope` of `id`: once none is left, its scope follows the gate again. */
export function releaseScope(id: string): Promise<void> {
    holds.release(id);
    return activeScope.show(wantedScope());
}

/**
 * Opens the scope the root gate shows on `launched`, the store launch opened
 * (device-store.ts), and keeps it following the gate. Resolves once the first
 * has opened (or failed to).
 */
export function followRootGate(launched: Store): Promise<void> {
    if (opened === null) {
        opened = launched;
        if (backgroundGrace !== null) {
            followBackgroundGrace(activeScope, backgroundGrace, appState, (error) => console.warn('[grace]', error));
        }
        rootState.subscribe(() => {
            void activeScope.show(wantedScope());
        });
    }
    return activeScope.show(wantedScope());
}

/**
 * The switcher: makes workspace `id` active; the gate and the scope follow.
 * Resolves once the scope the gate then shows has opened (or failed to), so
 * a notification's tap opens its path in the new workspace's tree.
 */
export async function switchTo(id: string): Promise<void> {
    await store().registry.setActive(id);
    await rootState.refresh();
    await activeScope.show(wantedScope());
}

/** "Add a workspace": the gate shows Add workspace, over the shell, until a sign-in or Cancel. */
export function startAdding(): void {
    rootState.setAdding(true);
}

/** Cancel on Add workspace while adding: back to the open workspace. */
export function cancelAdding(): void {
    rootState.setAdding(false);
}

/** The open workspace's name and unread, kept in the registry for the switcher. */
export function keepSummary(id: string, summary: WorkspaceSummary): Promise<void> {
    return store().registry.setSummary(id, summary);
}

/** Workspace `id` as the registry holds it, or null: the lock screen's. */
export function readWorkspace(id: string) {
    return store().registry.get(id);
}

/** Every workspace on the phone, for the switcher. */
export function listWorkspaces() {
    return store().registry.list();
}

/** The app's document directory, the store's root, for the paths of workspace files (logos). */
export function storeRoot(): string {
    return store().root;
}

/** The store's file system, for the image cache (image-cache.ts). */
export function storeFiles() {
    return store().fs;
}

/** Workspace `id`'s local cache in bytes, for Settings: cache.db and the images. */
export function localCacheSize(id: string): Promise<number> {
    return cacheSize(createSizeOf(), store().root, id);
}

/**
 * Settings' Clear cache for the open workspace `id`: its scope closes, the
 * cache goes, and the scope opens again on the empty cache, so the app mounts
 * again on Home (src/sync/clear-cache.ts).
 */
export function clearLocalCache(id: string): Promise<void> {
    return clearWorkspaceCache({ store: store(), hold: holdScope, release: releaseScope }, id);
}
