import { useCallback, useSyncExternalStore } from 'react';

/**
 * "A Space's pages changed here": the view that created or deleted a page
 * tells the other lists of that Space (the sidebar's page tree) to reload
 * now instead of at their next poll.
 */
const listeners = new Set<(spaceId: string) => void>();

export function notifyPagesChanged(spaceId: string) {
    for (const listener of listeners) {
        listener(spaceId);
    }
}

/** Calls `listener` with the Space id on every change; returns the unsubscribe. */
export function onPagesChanged(listener: (spaceId: string) => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/**
 * Whether a page is a folder (CB-426), as this tab last saw it: the Space
 * view reports the page it shows each time it reads, saves or switches it,
 * and the newest revision wins. The Ask panel reads it, so it follows a
 * page turned into a folder or back, here or in another tab.
 */
const folders = new Map<string, { revision: number; folder: boolean }>();
const folderListeners = new Set<() => void>();

export function reportPageFolder(page: { id: string; revision: number; folder: boolean }) {
    const known = folders.get(page.id);
    if (
        known &&
        (known.revision > page.revision || (known.revision === page.revision && known.folder === page.folder))
    ) {
        return;
    }
    folders.set(page.id, { revision: page.revision, folder: page.folder });
    for (const listener of folderListeners) {
        listener();
    }
}

/** A page's folder flag as last reported; undefined when no view reported it. */
export function usePageFolder(id: string | undefined): boolean | undefined {
    const subscribe = useCallback((listener: () => void) => {
        folderListeners.add(listener);
        return () => {
            folderListeners.delete(listener);
        };
    }, []);
    return useSyncExternalStore(
        subscribe,
        () => (id ? folders.get(id)?.folder : undefined),
        () => undefined,
    );
}
