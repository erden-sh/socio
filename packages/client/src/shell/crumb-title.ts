import { useEffect, useSyncExternalStore } from 'react';

/**
 * The title of the thing a view shows (a page), for the header's
 * breadcrumb (CB-38). Route crumbs are built from shell data, which has no
 * page titles; the view that loaded the page publishes its title here,
 * keyed by the route param it belongs to, and the header re-renders when
 * it changes (a rename shows at once).
 */
export interface CrumbTitle {
    /** What the title belongs to (a page id), so a stale one never shows. */
    key: string;
    title: string;
    /** Already resolved from the current Space's authorized page list. */
    ancestry?: { spaceId: string; pages: Array<{ id: string; title: string }> };
}

let current: CrumbTitle | undefined;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};
const set = (next: CrumbTitle | undefined) => {
    if (
        next?.key === current?.key &&
        next?.title === current?.title &&
        JSON.stringify(next?.ancestry) === JSON.stringify(current?.ancestry)
    ) {
        return;
    }
    current = next;
    for (const listener of listeners) {
        listener();
    }
};

/** Publishes the title of `key` while the calling view is mounted. */
export function useCrumbTitle(key: string, title: string, ancestry?: CrumbTitle['ancestry']) {
    useEffect(() => {
        set({ key, title, ancestry });
    }, [key, title, ancestry]);
    useEffect(
        () => () => {
            if (current?.key === key) {
                set(undefined);
            }
        },
        [key],
    );
}

/** The published title, for the header. */
export const useCurrentCrumbTitle = () =>
    useSyncExternalStore(
        subscribe,
        () => current,
        () => undefined,
    );

/** The title published for `key`, if it is the current one. */
export const crumbTitleFor = (title: CrumbTitle | undefined, key: string | undefined) =>
    key !== undefined && title?.key === key ? title.title : undefined;
