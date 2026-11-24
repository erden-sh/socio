import { useCallback, useContext, useEffect, useState, useSyncExternalStore } from 'react';

import {
    compareVersions,
    isReleaseVersion,
    MAX_RELEASE_VIEWS,
    type ReleaseSeen,
} from '@socio/shared/updates/release-seen';
import type { ReleasesResponse, ReleaseSummary } from '@socio/shared/updates/releases';

import { api } from '../../lib/api';
import { CurrentUser } from '../../shell/current-user';
import { useShell } from '../../shell/shell-context';

/** Releases asked for at a time, as the person scrolls. */
export const WHATS_NEW_PAGE = 5;

/** One person's What's new, loaded page by page once per page load. */
interface Feed {
    /** Newest first; empty while the first page loads, or when it failed. */
    releases: ReleaseSummary[];
    /** The `before` of the next page; null once every release is here. */
    nextCursor: string | null;
    /** A page is on its way. */
    loading: boolean;
    /** The newest release they have seen; undefined when it is unknown. */
    lastSeen?: string;
}
const EMPTY: Feed = { releases: [], nextCursor: null, loading: false };
const feeds = new Map<string, Feed>();
const listeners = new Set<() => void>();
const set = (userId: string, feed: Feed) => {
    feeds.set(userId, feed);
    for (const listener of listeners) {
        listener();
    }
};
const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

/** The releases a card can show: anything else in the answer is left out. */
function cards(list: ReleasesResponse): ReleaseSummary[] {
    if (!Array.isArray(list?.releases)) {
        return [];
    }
    return list.releases.filter(
        (release) =>
            isReleaseVersion(release?.version) &&
            typeof release.date === 'string' &&
            typeof release.summary === 'string' &&
            typeof release.url === 'string' &&
            release.url.startsWith('/') &&
            Array.isArray(release.highlights),
    );
}
const cursorOf = (list: ReleasesResponse) => (typeof list?.nextCursor === 'string' ? list.nextCursor : null);

/**
 * Loads the first page and the person's last seen release. Someone who
 * has never seen one (a new person) has seen the running version: only
 * releases after it are new to them. Failures leave the feed empty or the
 * last seen unknown, which shows no dot.
 */
async function load(userId: string) {
    set(userId, { ...EMPTY, loading: true });
    const [list, seen] = await Promise.allSettled([
        api<ReleasesResponse>(`/releases?limit=${WHATS_NEW_PAGE}`),
        api<ReleaseSeen>('/releases/seen'),
    ]);
    const releases = list.status === 'fulfilled' ? cards(list.value) : [];
    let lastSeen =
        seen.status === 'fulfilled' && isReleaseVersion(seen.value.lastSeen) ? seen.value.lastSeen : undefined;
    if (
        seen.status === 'fulfilled' &&
        seen.value.lastSeen === null &&
        list.status === 'fulfilled' &&
        isReleaseVersion(list.value.current)
    ) {
        lastSeen = list.value.current;
        void api('/releases/seen', 'POST', { version: lastSeen }).catch(() => undefined);
    }
    set(userId, {
        releases,
        nextCursor: list.status === 'fulfilled' && releases.length ? cursorOf(list.value) : null,
        loading: false,
        lastSeen,
    });
}

/** The next, older page; a failed one stops the list where it is. */
async function loadMore(userId: string) {
    const feed = feeds.get(userId);
    if (!feed || feed.loading || !feed.nextCursor) {
        return;
    }
    set(userId, { ...feed, loading: true });
    try {
        const page = await api<ReleasesResponse>(
            `/releases?limit=${WHATS_NEW_PAGE}&before=${encodeURIComponent(feed.nextCursor)}`,
        );
        const now = feeds.get(userId) ?? feed;
        const known = new Set(now.releases.map((release) => release.version));
        set(userId, {
            ...now,
            releases: [...now.releases, ...cards(page).filter((release) => !known.has(release.version))],
            nextCursor: cursorOf(page),
            loading: false,
        });
    } catch {
        set(userId, {
            ...(feeds.get(userId) ?? feed),
            nextCursor: null,
            loading: false,
        });
    }
}

/**
 * The person saw `version` elsewhere (they dismissed What's new's modal,
 * CB-527): the dot goes, as when they open the list.
 */
export function noteWorkspaceSeen(userId: string, version: string) {
    const current = feeds.get(userId);
    if (!current || !isReleaseVersion(version)) {
        return;
    }
    if (current.lastSeen && compareVersions(version, current.lastSeen) <= 0) {
        return;
    }
    set(userId, { ...current, lastSeen: version });
}

/** Whether `feed` has a release newer than the last one seen. */
export const hasUnread = ({ releases, lastSeen }: Feed) =>
    !!releases[0] && !!lastSeen && compareVersions(releases[0].version, lastSeen) > 0;

/** How many of the releases loaded so far are newer than the last seen. */
export const unreadCount = ({ releases, lastSeen }: Feed) =>
    lastSeen ? releases.filter((release) => compareVersions(release.version, lastSeen) > 0).length : 0;

/**
 * The signed-in person's What's new: the releases loaded so far, newest
 * first, `loadMore` for the next page, whether one is new to them, and
 * `markSeen` for when they open the list. Shared by Home and the header.
 */
export function useWhatsNew() {
    const userId = useShell().workspace.user.id;
    const feed = useSyncExternalStore(
        subscribe,
        () => feeds.get(userId) ?? EMPTY,
        () => EMPTY,
    );
    useEffect(() => {
        if (feeds.has(userId)) {
            return;
        }
        void load(userId).catch(() => set(userId, EMPTY));
    }, [userId]);
    const more = useCallback(() => void loadMore(userId), [userId]);
    const markSeen = useCallback(() => {
        const current = feeds.get(userId);
        const newest = current?.releases[0]?.version;
        if (!current || !newest) {
            return;
        }
        if (current.lastSeen && compareVersions(newest, current.lastSeen) <= 0) {
            return;
        }
        set(userId, { ...current, lastSeen: newest });
        void api('/releases/seen', 'POST', { version: newest }).catch(() => undefined);
    }, [userId]);
    return {
        releases: feed.releases,
        loading: feed.loading,
        hasMore: !!feed.nextCursor,
        loadMore: more,
        unread: hasUnread(feed),
        unreadCount: unreadCount(feed),
        markSeen,
    };
}

/** How long a card is at least half in view before it counts as seen. */
export const VIEW_MS = 1000;
/** How long views wait to go together in one request. */
export const VIEW_BATCH_MS = 2000;

// Versions this page load has sent or will send, per person, and those
// waiting for the next batch.
const viewed = new Map<string, Set<string>>();
let pending: { userId: string; versions: Set<string> } | undefined;
let batch: ReturnType<typeof setTimeout> | undefined;

/** Sends the views waiting (on a timer, or as the page goes away). */
export function flushReleaseViews(keepalive = false) {
    clearTimeout(batch);
    batch = undefined;
    const waiting = pending;
    pending = undefined;
    if (!waiting?.versions.size) {
        return;
    }
    const versions = [...waiting.versions];
    for (let at = 0; at < versions.length; at += MAX_RELEASE_VIEWS) {
        const chunk = versions.slice(at, at + MAX_RELEASE_VIEWS);
        const sent = keepalive
            ? fetch('/api/releases/views', {
                  method: 'POST',
                  keepalive: true,
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ versions: chunk }),
              }).then((response) => {
                  if (!response.ok) {
                      throw new Error(String(response.status));
                  }
              })
            : api('/releases/views', 'POST', { versions: chunk });
        // Not recorded: shown again later, it is tried again.
        void sent.catch(() => {
            for (const version of chunk) {
                viewed.get(waiting.userId)?.delete(version);
            }
        });
    }
}
if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => flushReleaseViews(true));
}

/** Notes that the person was shown a release's card. */
function noteView(userId: string, version: string) {
    let seen = viewed.get(userId);
    if (!seen) {
        viewed.set(userId, (seen = new Set()));
    }
    if (seen.has(version)) {
        return;
    }
    seen.add(version);
    // Another person's leftovers (a user switch) go first.
    if (pending && pending.userId !== userId) {
        flushReleaseViews();
    }
    pending ??= { userId, versions: new Set() };
    pending.versions.add(version);
    batch ??= setTimeout(() => flushReleaseViews(), VIEW_BATCH_MS);
}

/**
 * A ref for a release's card: once at least half of it has been in view
 * for `VIEW_MS`, the person has seen that release (CB-166), recorded in
 * batches. Cards in a scrolling list count only where the list shows them.
 */
export function useReleaseView(version: string) {
    const userId = useContext(CurrentUser)?.id;
    const [node, setNode] = useState<Element | null>(null);
    useEffect(() => {
        if (!node || !userId || typeof IntersectionObserver === 'undefined') {
            return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const observer = new IntersectionObserver(
            ([entry]) => {
                if (entry && entry.intersectionRatio >= 0.5) {
                    timer ??= setTimeout(() => {
                        observer.disconnect();
                        noteView(userId, version);
                    }, VIEW_MS);
                } else {
                    clearTimeout(timer);
                    timer = undefined;
                }
            },
            { threshold: [0, 0.5] },
        );
        observer.observe(node);
        return () => {
            observer.disconnect();
            clearTimeout(timer);
        };
    }, [node, userId, version]);
    return setNode;
}

/** Forgets every loaded feed and view (tests). */
export function forgetWhatsNew() {
    feeds.clear();
    viewed.clear();
    clearTimeout(batch);
    batch = undefined;
    pending = undefined;
}
