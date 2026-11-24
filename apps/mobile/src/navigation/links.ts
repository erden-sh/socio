import { withoutFragment } from './linking';

// The queue for taps from outside the app: links, notification taps
// (src/push/taps.ts, which switches the workspace first when the tap names
// another) and quick actions later. A tap waits until the root stack is ready
// (a cold start) and the gate shows the screen it opens (not while the lock
// screen shows). Only the latest waits. After T3 Code's rootNavigation.ts,
// extended to wait for the gate. No React Native here, so the Node tests run
// it as the app does.
//
// A link never names a workspace: there is no `/w/<workspace>/…` path. Only a
// notification's tap, which carries the workspace's id beside its path
// in-process, switches workspaces.

/** A navigation action, as React Navigation's container dispatches it. */
export interface LinkAction {
    readonly type: string;
    readonly payload?: object;
    readonly target?: string;
}

/** What a link opens: the root stack's routes it needs, and the action that opens them. */
export interface LinkTarget {
    readonly routes: readonly string[];
    readonly action: LinkAction;
}

/** The slice of React Navigation's container the queue uses. */
export interface LinkNavigator {
    isReady(): boolean;
    getRootState(): { readonly key: string; readonly routeNames: readonly string[] } | undefined;
    dispatch(action: LinkAction): void;
}

export interface ExternalLinkOptions {
    /** What an app path opens, or undefined when no route has it. */
    readonly resolve: (path: string) => LinkTarget | undefined;
    /** Where a link that opens nothing is reported. */
    readonly report?: (message: string, error?: unknown) => void;
}

export interface ExternalLinks {
    /**
     * The container's ref callback. Android's activity replacement mounts the
     * new root before the old one unmounts, so the old one's cleanup leaves the
     * new container in place.
     */
    attach(navigator: LinkNavigator | null): () => void;
    /** Opens an app path (`/chats/abc`) now if the root stack has its screens, else once it does. */
    open(path: string): void;
    /**
     * Opens a root stack route with no path, by name, the same way: what an https link on the link
     * domain hands over in memory (the sign-in sheet's callback opens `SheetSignIn`), so
     * nothing it carries goes into a path or the navigation state. `popTo` goes back to the route
     * when the stack holds it (React Navigation 7's `navigate` pushes another copy), else pushes it:
     * a gate's root (Add workspace's first screen) stays the one copy that took the link.
     */
    openRoute(name: string, how?: 'navigate' | 'popTo'): void;
    /**
     * Opens an app path now, from inside the app (a link in a message, CB-413), when the root stack
     * is ready and has its screens; never waits. False when no screen opens it now, so the caller
     * opens it some other way (the browser).
     */
    openNow(path: string): boolean;
    /** Opens the waiting link if the root stack now has its screens. Wired to the container's onReady and onStateChange. */
    flush(): void;
    /** The path waiting, if any. */
    pending(): string | null;
}

/**
 * What an app path opens, through React Navigation's own parser and the root
 * stack's path config: the routes of the state the path gives, and the action
 * React Navigation would dispatch for it. A fragment is dropped first, as a
 * notification's link can carry one (`/chats/abc#message-9`).
 */
export function linkResolver<Options, State extends { readonly routes: readonly { readonly name: string }[] }>(
    options: Options,
    getStateFromPath: (path: string, options: Options) => State | undefined,
    getActionFromState: (state: State, options: Options) => LinkAction | undefined,
): (path: string) => LinkTarget | undefined {
    return (path) => {
        const state = getStateFromPath(withoutFragment(path), options);
        const action = state === undefined ? undefined : getActionFromState(state, options);
        return state === undefined || action === undefined
            ? undefined
            : { routes: state.routes.map((route) => route.name), action };
    };
}

const warn = (message: string, error?: unknown) => {
    if (error === undefined) {
        console.warn(message);
    } else {
        console.warn(message, error);
    }
};

export function createExternalLinks({ resolve, report = warn }: ExternalLinkOptions): ExternalLinks {
    let navigator: LinkNavigator | null = null;
    let waiting: { readonly path: string; readonly target: LinkTarget } | null = null;

    const flush = () => {
        if (waiting === null || navigator === null || !navigator.isReady()) {
            return;
        }
        const root = navigator.getRootState();
        if (root === undefined || !waiting.target.routes.every((name) => root.routeNames.includes(name))) {
            return;
        }
        const { path, target } = waiting;
        waiting = null;
        try {
            navigator.dispatch({ target: root.key, ...target.action });
        } catch (error) {
            report(`[links] opening ${path} failed`, error);
        }
    };

    return {
        attach(next) {
            navigator = next;
            flush();
            return () => {
                if (navigator === next) {
                    navigator = null;
                }
            };
        },
        open(path) {
            if (!path.startsWith('/')) {
                throw new Error(`An app path starts with '/' (${path}).`);
            }
            const target = resolve(path);
            if (target === undefined) {
                report(`[links] no screen opens ${path}`);
                return;
            }
            waiting = { path, target };
            flush();
        },
        openRoute(name, how = 'navigate') {
            waiting = {
                path: `route:${name}`,
                target: {
                    routes: [name],
                    action: { type: how === 'popTo' ? 'POP_TO' : 'NAVIGATE', payload: { name } },
                },
            };
            flush();
        },
        openNow(path) {
            const target = path.startsWith('/') ? resolve(path) : undefined;
            const root = navigator?.isReady() === true ? navigator.getRootState() : undefined;
            if (target === undefined || root === undefined || navigator === null) {
                return false;
            }
            if (!target.routes.every((name) => root.routeNames.includes(name))) {
                return false;
            }
            try {
                navigator.dispatch({ target: root.key, ...target.action });
                return true;
            } catch (error) {
                report(`[links] opening ${path} failed`, error);
                return false;
            }
        },
        flush,
        pending: () => waiting?.path ?? null,
    };
}
