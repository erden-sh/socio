// The app icon's badge: the open workspace's approvals
// waiting plus its rooms' unread, set on each pull, and 0 while no workspace
// is open (`followBadge`: the last one removed, the lock screen). The extension and the
// messaging service never touch it, and no summed badge of every workspace is
// kept yet.

/** The badge for the open workspace: its approvals still pending and its rooms' unread turns. */
export function badgeCount(
    approvals: readonly { readonly status: string }[],
    chats: readonly { readonly unread: number | null }[],
): number {
    const waiting = approvals.filter((approval) => approval.status === 'pending').length;
    const unread = chats.reduce((sum, chat) => sum + (chat.unread !== null && chat.unread > 0 ? chat.unread : 0), 0);
    return waiting + unread;
}

/** The active scope as {@link followBadge} reads it (src/sync/active-scope.ts). */
export interface BadgeScopes {
    get(): { readonly kind: 'none' | 'opening' | 'open' | 'failed' };
    subscribe(listener: () => void): () => void;
}

/**
 * Clears the badge whenever no workspace's scope is open or opening: the last
 * one removed, the lock screen, Add workspace, or one that didn't open. The
 * open workspace's summary sets it again as its pulls land. Returns the
 * unsubscribe.
 */
export function followBadge(scopes: BadgeScopes, setBadge: (count: number) => void): () => void {
    let cleared = false;
    const check = () => {
        const { kind } = scopes.get();
        const none = kind === 'none' || kind === 'failed';
        if (none && !cleared) {
            setBadge(0);
        }
        cleared = none;
    };
    const off = scopes.subscribe(check);
    check();
    return off;
}
