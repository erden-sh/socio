import { useFocusEffect } from '@react-navigation/native';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import type { IssueComponentOptions } from '@socio/shared/issues/issue-components';
import type { IssueAssignees, IssueDetail } from '@socio/shared/issues/issue-types';
import type { Page } from '@socio/shared/pages/page-library';
import type { RunTraceView } from '@socio/shared/runs/run-trace';

import type { BoundedItem, BoundedItemState, BoundedStore } from '../sync/bounded-kind';
import type { ScopeCollections } from '../sync/collections';
import { ASSIGNEES_KEY } from '../sync/issue-assignees';
import { OPTIONS_KEY } from '../sync/issue-component-options';
import type { KeptSpaces } from '../sync/kept-spaces';
import { allPageConflicts, type PageConflict, pageConflicts, type PageMergeChange } from '../sync/page-conflicts';
import type { SpacePages } from '../sync/page-store';
import type { ScheduleDetailItems } from '../sync/schedule-details';
import type { SyncStatus } from '../sync/scheduler';
import { type SessionState, writeHold, type WriteHold } from '../sync/session';
import { WORKSPACE_SNAPSHOT } from '../sync/shell';
import type { SnapshotDefinition } from '../sync/snapshot-cache';
import type { ItemsList } from '../sync/space-items';
import { type SpaceSection, spaceSection, type SpaceSectionName } from '../sync/space-sections';
import { type UnsentSnapshot, unsentStore } from '../sync/unsent-store';
import type { VersionGate } from '../sync/versions';
import type { ViewState } from '../sync/view-state';

import { useWorkspaceScope } from './scope-context';

// What screens read of the open workspace, outside src/sync since it needs React and React
// Navigation:
// - the scope's collections, which screens query with useLiveQuery
//   (`useLiveQuery({ query: (q) => q.from({ c: collections.conversations }) })`);
//   re-exported here, with the query operators, so screens import one place;
// - a screen coming into view (`useSyncOnFocus`), which pulls its collections
//   when their last answer is older than 5 s, and polls a module's kind while
//   it stays in view (scheduler.ts);
// - the connection, for the header's "Reconnecting…" (`useSyncStatus`);
// - the minimum-version gate, for the update banner (`useVersionGate`);
// - the session, signed in or Expired, for its banner (`useSessionState`), and
//   why writes wait (`useWriteHold`);
// - the view state in cache.db's `kv`, such as the last screen (`useViewState`);
// - the Spaces kept offline, in user.db's `prefs` (`useKeptSpaces`);
// - a Space's pages, pulled and polled while its screen shows (`useSpacePages`);
// - a page's body, held while its screen shows (`usePageBody`);
// - whether /api/workspace has answered once, so a Space it doesn't list is gone (`useWorkspaceListed`);
// - a page's conflicts, and whether a save of it just merged (`usePageConflicts`, `usePageMerged`);
// - every page conflict, for the Inbox and the library's badges (`useAllPageConflicts`).

export {
    and,
    coalesce,
    count,
    eq,
    gt,
    gte,
    ilike,
    inArray,
    isNull,
    isUndefined,
    like,
    lt,
    lte,
    not,
    or,
    useLiveInfiniteQuery,
    useLiveQuery,
    useLiveSuspenseQuery,
} from '@tanstack/react-db';

/** The open workspace's collections. */
export function useCollections(): ScopeCollections {
    return useWorkspaceScope().collections;
}

/**
 * Pulls `collections` (names, as ScopeCollections has them) each time the
 * screen comes into view, if their last answer is older than 5 s. Pass a list
 * that doesn't change between renders (a constant).
 */
export function useSyncOnFocus(collections: readonly string[]): void {
    const { scheduler } = useWorkspaceScope();
    // Blurred, the screen leaves view: its visible poll stops (scheduler.ts).
    useFocusEffect(useCallback(() => scheduler.view(collections), [scheduler, collections]));
}

/**
 * Pull to refresh's work: pulls `collections` now (the scheduler's `refresh`), whatever their
 * age, and resolves once those pulls end. Pass a list that doesn't change between renders.
 */
export function useSyncRefresh(collections: readonly string[]): () => Promise<void> {
    const { scheduler } = useWorkspaceScope();
    return useCallback(() => scheduler.refresh(collections), [scheduler, collections]);
}

/** The connection: `reconnecting` while the server is away, for the header's "Reconnecting…". */
export function useSyncStatus(): SyncStatus {
    const { scheduler } = useWorkspaceScope();
    return useSyncExternalStore(scheduler.subscribe, scheduler.status);
}

/** The minimum-version gate: 'open', 'closed', or null until two answers first agree. */
export function useVersionGate(): VersionGate | null {
    const { versions } = useWorkspaceScope();
    return useSyncExternalStore(versions.subscribe, versions.gate);
}

/** The session: 'expired' once its stored expiry has passed (src/sync/session.ts). */
export function useSessionState(): SessionState {
    const { session } = useWorkspaceScope();
    return useSyncExternalStore(session.subscribe, session.state);
}

/** Why the open workspace's writes wait: a sign-in (Expired), its update (the gate closed), or null. */
export function useWriteHold(): WriteHold {
    return writeHold(useSessionState(), useVersionGate());
}

/** The workspace's view state (cache.db's `kv`): the last screen. */
export function useViewState(): ViewState {
    return useWorkspaceScope().viewState;
}

/** The open workspace's Unsent list (the account sheet's, and its badge). */
export function useUnsent(): UnsentSnapshot {
    const store = unsentStore(useWorkspaceScope().outbox);
    return useSyncExternalStore(store.subscribe, store.get);
}

/** The open workspace's Spaces kept offline, oldest first, and the store that changes them. */
export function useKeptSpaces(): { readonly ids: readonly string[]; readonly kept: KeptSpaces } {
    const { keptSpaces } = useWorkspaceScope();
    return { ids: useSyncExternalStore(keptSpaces.subscribe, keptSpaces.list), kept: keptSpaces };
}

/**
 * Space `spaceId`'s pages: their collection, read from cache.db as first
 * asked, pulled as the screen comes into view when older than 5 s and polled
 * every 15 s while it stays (page-store.ts's `view()`).
 */
export function useSpacePages(spaceId: string): SpacePages {
    const { pages } = useWorkspaceScope();
    const space = pages.space(spaceId);
    useFocusEffect(useCallback(() => space.view(), [space]));
    return space;
}

/**
 * A Space's items (pages and datasets, CB-469), pulled and polled while the screen shows, only when
 * `on` (the `datasets-in-spaces` flag): without it nothing is asked of the server.
 */
export function useSpaceItems(spaceId: string, on: boolean): ItemsList {
    const { pages } = useWorkspaceScope();
    const items = pages.items.space(spaceId);
    useFocusEffect(useCallback(() => (on ? items.view() : undefined), [items, on]));
    return items;
}

/** The person's Private group (CB-469), pulled and polled while the screen shows, only when `on`. */
export function usePrivateItems(on: boolean): ItemsList {
    const { pages } = useWorkspaceScope();
    const items = pages.items.private();
    useFocusEffect(useCallback(() => (on ? items.view() : undefined), [items, on]));
    return items;
}

/**
 * Whether the workspace (/api/workspace: its Spaces) has answered at least once
 * on this phone, so a Space it doesn't list is one the person lost.
 */
export function useWorkspaceListed(): boolean {
    const { cache } = useWorkspaceScope();
    return useSyncExternalStore(
        useCallback((onChange: () => void) => cache.subscribe(() => onChange()), [cache]),
        () => cache.meta(WORKSPACE_SNAPSHOT) !== null,
    );
}

/** How often `useKindAnswered` looks again while a kind hasn't answered: an empty answer changes no row, so the cache tells no one. */
const ANSWERED_CHECK_MS = 500;

/** Whether a kind (`definition`) has answered at least once on this phone: an empty list is then empty, not loading. */
export function useKindAnswered(definition: SnapshotDefinition): boolean {
    const { cache } = useWorkspaceScope();
    const [answered, setAnswered] = useState(() => cache.meta(definition) !== null);
    useEffect(() => {
        if (answered) {
            return;
        }
        const check = () => {
            if (cache.meta(definition) !== null) {
                setAnswered(true);
            }
        };
        const stop = cache.subscribe(check);
        const timer = setInterval(check, ANSWERED_CHECK_MS);
        check();
        return () => {
            stop();
            clearInterval(timer);
        };
    }, [cache, definition, answered]);
    return answered;
}

/**
 * Run `runId`'s trace, held while the run's page shows: read from the
 * server only on that open, which is the person's tap (an admin's read of
 * someone else's writes the access log, CB-188), never by the list. The
 * person's own trace shows offline from disk with its age.
 */
export function useRunTrace(runId: string): BoundedItemState<RunTraceView> {
    const { runTraces } = useWorkspaceScope();
    const item = runTraces.item(runId);
    useEffect(() => item.use(), [item]);
    return useBoundedState(item);
}

/**
 * Page `pageId`'s body, held while the screen is mounted: read from
 * disk, then from the server when missing or older than the Space's list says;
 * and, as it opens online, the Space's list first, then the body if its
 * revision moved (page-store.ts's `open()`).
 */
export function usePageBody(spaceId: string, pageId: string): BoundedItemState<Page> {
    const { pages } = useWorkspaceScope();
    const item = pages.body(spaceId, pageId);
    useEffect(() => {
        const release = item.use();
        pages.open(spaceId, pageId).catch((error: unknown) => console.warn('[pages] the page did not open', error));
        return release;
    }, [pages, item, spaceId, pageId]);
    return useBoundedState(item);
}

/**
 * Space `spaceId`'s radar or memory, held while the screen shows it:
 * the phone's last copy first, then the server's, read as it opens.
 */
export function useSpaceSection(spaceId: string, section: SpaceSectionName): BoundedItemState<SpaceSection> {
    const { pages } = useWorkspaceScope();
    const item = spaceSection(pages.sections, spaceId, section);
    useEffect(() => item.use(), [item]);
    return useBoundedState(item);
}

/**
 * Issue `key`'s detail, held while the screen is mounted: read from
 * disk, then from the server (`use()`); an issue filed offline reads nothing.
 */
export function useIssueDetail(key: string): BoundedItemState<IssueDetail> {
    const { issueDetails } = useWorkspaceScope();
    const item = issueDetails.item(key);
    useEffect(() => item.use(), [item]);
    return useBoundedState(item);
}

/**
 * Who an admin can assign an issue to, held while the picker is
 * mounted: the last list from disk, then the server's (`use()`).
 */
export function useIssueAssignees(): BoundedItemState<IssueAssignees> {
    const { issueAssignees } = useWorkspaceScope();
    const item = issueAssignees.item(ASSIGNEES_KEY);
    useEffect(() => item.use(), [item]);
    return useBoundedState(item);
}

/**
 * The plugins and apps the person may tag an issue with (CB-442): the last
 * list from disk, and while `read` (the picker shows), the server's (`use()`).
 * Not reading, it only follows the kept copy (a `CB-?` filing's chips).
 */
export function useIssueComponentOptions(read = true): BoundedItemState<IssueComponentOptions> {
    const { issueComponentOptions } = useWorkspaceScope();
    const item = issueComponentOptions.item(OPTIONS_KEY);
    useEffect(() => (read ? item.use() : undefined), [item, read]);
    return useBoundedState(item);
}

/**
 * A scheduled task's, a schedule's or a job's detail, held while the
 * screen is mounted: disk's copy first, then the server's (`use()`).
 */
export function useScheduleDetail<K extends keyof ScheduleDetailItems>(
    kind: K,
    id: string,
): BoundedItemState<ScheduleDetailItems[K]> {
    const { scheduleDetails } = useWorkspaceScope();
    const item = (scheduleDetails[kind] as BoundedStore<ScheduleDetailItems[K]>).item(id);
    useEffect(() => item.use(), [item]);
    return useBoundedState(item);
}

/** A bounded item's state, following its changes. */
export function useBoundedState<T>(item: BoundedItem<T>): BoundedItemState<T> {
    return useSyncExternalStore(
        useCallback((onChange: () => void) => item.subscribe(onChange), [item]),
        () => item.state,
    );
}

/** Page `pageId`'s conflicts waiting for the person, oldest first: the banner's. */
export function usePageConflicts(pageId: string): readonly PageConflict[] {
    const { outbox } = useWorkspaceScope();
    const { writes } = useUnsent();
    // Recomputed when the refused writes change (each snapshot is a new list).
    return useMemo(() => (writes.length === 0 ? [] : pageConflicts(outbox, pageId)), [outbox, pageId, writes]);
}

/** Every page conflict waiting for the person, oldest first: the Inbox's rows and the library's badges. */
export function useAllPageConflicts(): readonly PageConflict[] {
    const { outbox } = useWorkspaceScope();
    const { writes } = useUnsent();
    return useMemo(() => (writes.length === 0 ? [] : allPageConflicts(outbox)), [outbox, writes]);
}

/**
 * Whether a save of page `pageId` merged with changes made elsewhere since
 * the screen showed, for its toast, with the last merge's change for
 * its "See what changed"; `clear` once it is shown.
 */
export function usePageMerged(pageId: string): {
    readonly merged: number;
    readonly change: PageMergeChange | null;
    readonly clear: () => void;
} {
    const { pageLandings } = useWorkspaceScope();
    const [merged, setMerged] = useState<{ count: number; change: PageMergeChange | null }>({
        count: 0,
        change: null,
    });
    useEffect(
        () =>
            pageLandings.subscribe((id, how, change) => {
                if (id === pageId && how === 'merged') {
                    setMerged((last) => ({ count: last.count + 1, change }));
                }
            }),
        [pageLandings, pageId],
    );
    const clear = useCallback(() => setMerged({ count: 0, change: null }), []);
    return { merged: merged.count, change: merged.change, clear };
}
