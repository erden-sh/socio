// Which workspaces' scopes are held closed, whatever the root gate says
// (src/platform/active-scope.ts's `holdScope`): a sign-out, a lease wipe, a
// silent wipe for a revoked device. Counted per workspace, so one
// release never drops a hold another task still keeps, on the same workspace
// or another.

export interface ScopeHolds {
    /** Holds `id`'s scope closed once more. */
    hold(id: string): void;
    /** Ends one hold of `id`; a release with none left does nothing. */
    release(id: string): void;
    /** Whether any hold of `id` is left. */
    isHeld(id: string): boolean;
}

export function createScopeHolds(): ScopeHolds {
    const counts = new Map<string, number>();
    return {
        hold: (id) => {
            counts.set(id, (counts.get(id) ?? 0) + 1);
        },
        release: (id) => {
            const left = (counts.get(id) ?? 0) - 1;
            if (left > 0) {
                counts.set(id, left);
            } else {
                counts.delete(id);
            }
        },
        isHeld: (id) => counts.has(id),
    };
}
