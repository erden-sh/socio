import { useSyncExternalStore } from 'react';

/**
 * The header's Help button, for what opens from it without living in the
 * header: the onboarding offer (CB-308) is anchored to it. Null while no
 * header is mounted.
 */
let anchor: HTMLElement | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
};

/** A ref callback for the Help button. */
export function setHelpAnchor(element: HTMLElement | null) {
    if (anchor === element) {
        return;
    }
    anchor = element;
    for (const listener of listeners) {
        listener();
    }
}

/** The Help button, once it is mounted; null on the server. */
export const useHelpAnchor = () =>
    useSyncExternalStore(
        subscribe,
        () => anchor,
        () => null,
    );
