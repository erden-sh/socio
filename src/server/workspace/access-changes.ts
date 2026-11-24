import type { AccessChange } from './contract.js';

/**
 * The listeners for each `AccessChange` (`WorkspaceStore.onAccessChange`),
 * shared by the slices that make one: People (a role changed), Spaces (a
 * socio given a new Space), Dots (archived or changed) and the
 * conversations (archived or deleted).
 */
export class AccessChanges {
    private listeners = new Set<(change: AccessChange) => void>();
    /** Called after each `AccessChange` (platform.ts: socio access). */
    on(listener: (change: AccessChange) => void) {
        this.listeners.add(listener);
        return () => void this.listeners.delete(listener);
    }
    /** Whether anyone listens: a change nobody hears isn't looked for. */
    get listened() {
        return this.listeners.size > 0;
    }
    emit(change: AccessChange) {
        for (const listener of this.listeners) {
            try {
                listener(change);
            } catch {
                // A listener's failure never undoes the change it hears about.
            }
        }
    }
}
