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
