import { useCallback, useEffect, useRef, useState } from 'react';

import type { CursorPage } from '@socio/shared/operations/operations';

import { api } from '../../lib/api';

/** A cursor-paged list as it loads (`useCursorList`). */
export interface CursorList<T> {
    /** Every page loaded so far, in the server's order. */
    items: T[];
    /** A page is on its way. */
    loading: boolean;
    /** Why the last page didn't load; `loadMore` tries it again. */
    error: string;
    /** There is a page after the last one loaded (or the first is still to come). */
    hasMore: boolean;
    /** Loads the next page, unless one is on its way or there is none. */
    loadMore: () => void;
    /** Starts again from the first page. */
    reload: () => void;
}

interface ListState<T> {
    items: T[];
    /** Where the next page starts: null for the first, done when there is none. */
    cursor: string | null;
    done: boolean;
    loading: boolean;
    error: string;
}
const fresh = <T>(): ListState<T> => ({
    items: [],
    cursor: null,
    done: false,
    loading: true,
    error: '',
});

/**
 * A keyset-paged list from an API path that answers `{ items, next }`
 * (CB-164): `GET <path>?cursor=&limit=`. The first page loads at once;
 * `loadMore` reads the next from the last page's cursor, with no offsets
 * or page numbers. A new `path` (its filters are in it) starts over and
 * drops answers still on their way; null loads nothing.
 */
export function useCursorList<T>(path: string | null, { limit = 50 }: { limit?: number } = {}): CursorList<T> {
    const [state, setState] = useState<ListState<T>>(fresh);
    const [round, setRound] = useState(0);
    // The request on its way, so a new path or an unmount stops it, and a
    // second loadMore before the first lands asks nothing.
    const pending = useRef<AbortController | null>(null);

    const load = useCallback(
        (cursor: string | null) => {
            if (!path || pending.current) {
                return;
            }
            const controller = new AbortController();
            pending.current = controller;
            setState((current) => ({ ...current, loading: true, error: '' }));
            const params = new URLSearchParams({ limit: String(limit) });
            if (cursor) {
                params.set('cursor', cursor);
            }
            const join = path.includes('?') ? '&' : '?';
            api<CursorPage<T>>(`${path}${join}${params}`, 'GET', undefined, controller.signal)
                .then((page) => {
                    if (controller.signal.aborted) {
                        return;
                    }
                    setState((current) => ({
                        items: [...current.items, ...page.items],
                        cursor: page.next,
                        done: page.next === null,
                        loading: false,
                        error: '',
                    }));
                })
                .catch((error: unknown) => {
                    if (controller.signal.aborted) {
                        return;
                    }
                    setState((current) => ({
                        ...current,
                        loading: false,
                        error: error instanceof Error && error.message ? error.message : 'Could not load the list.',
                    }));
                })
                .finally(() => {
                    if (pending.current === controller) {
                        pending.current = null;
                    }
                });
        },
        [path, limit],
    );

    useEffect(() => {
        setState(path ? fresh() : { ...fresh(), done: true, loading: false });
        load(null);
        return () => {
            pending.current?.abort();
            pending.current = null;
        };
    }, [load, path, round]);

    const { cursor, done, loading, error } = state;
    // After a failure, the same page again: the cursor stays where it stopped.
    const loadMore = useCallback(() => {
        if (!done && !loading) {
            load(cursor);
        }
    }, [load, cursor, done, loading]);
    const reload = useCallback(() => setRound((value) => value + 1), []);
    return {
        items: state.items,
        loading,
        error,
        hasMore: !done,
        loadMore,
        reload,
    };
}
