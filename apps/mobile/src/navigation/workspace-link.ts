// Get the app links, held for Add workspace's first screen: the link from outside
// (root-navigation.ts) is read, kept in memory, and the first screen opened through links.ts
// `openRoute`, which waits until the gate shows it, a cold start included. Over the shell or the
// lock screen it first asks the gate for Add workspace (`overGate`, rootState.setAdding). The
// screen takes the link once; a later link replaces one still waiting. No React Native here, so the
// Node tests run it with links.ts as the app does.

export interface WorkspaceLinkHoldOptions<Link> {
    /** This build's link in `url`, or null when it isn't one (another host, variant or kind). */
    readonly read: (url: string) => Link | null;
    /** Opens the first screen (links.ts `openRoute('AddWorkspace', 'popTo')`: back to the gate's root). */
    readonly open: () => void;
    /** Shows Add workspace over the shell or the lock screen, when either shows. */
    readonly overGate: () => void;
}

export interface WorkspaceLinkHold<Link> {
    /** Whether `url` is this build's link. */
    is(url: string): boolean;
    /** A link from outside: held, then the first screen opens (and hears it if it shows). */
    receive(url: string): boolean;
    /** The first screen takes the link waiting, once. */
    take(): Link | null;
    /** The first screen listens while it is mounted; returns the stop. */
    listen(listener: () => void): () => void;
}

export function createWorkspaceLinkHold<Link>({
    read,
    open,
    overGate,
}: WorkspaceLinkHoldOptions<Link>): WorkspaceLinkHold<Link> {
    let waiting: Link | null = null;
    const listeners = new Set<() => void>();
    return {
        is: (url) => read(url) !== null,
        receive(url) {
            const link = read(url);
            if (link === null) {
                return false;
            }
            waiting = link;
            overGate();
            // Always navigate: it brings the first screen back from under Confirm or the address.
            open();
            for (const listener of [...listeners]) {
                listener();
            }
            return true;
        },
        take() {
            const link = waiting;
            waiting = null;
            return link;
        },
        listen(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}
