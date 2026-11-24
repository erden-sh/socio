import { ROUTES } from './routes';
import { tabOfRoot, tabRootPath } from './tabs';

// The web path the presence header names for what the app shows
// (src/sync/presence.ts): the topmost route with a path of its own,
// so a sheet over a chat (its trace, a page review, a picture) still names
// the chat, which is what the server matches (`/chats/<id>`, encoded as the
// server encodes it) to hold a push back for the chat in view. It looks into
// the tabs: the shown tab's own stack, its top page first. A route with a
// static path names it (`/settings`); the tabs and anything else, `/`. No
// React Native here, so tests/navigation runs it under Node.

/** The slice of React Navigation's state this reads. */
export interface PresenceNavState {
    readonly index?: number;
    /** `tab` for the tab navigator: only its shown tab counts, not the ones beside it. */
    readonly type?: string;
    readonly routes: readonly { readonly name: string; readonly params?: object; readonly state?: PresenceNavState }[];
}

export function presencePath(state: PresenceNavState | undefined): string {
    return (state === undefined ? null : pathIn(state)) ?? '/';
}

/** The path of the topmost route with one in `state`, looking into each nested navigator first; null for none. */
function pathIn(state: PresenceNavState): string | null {
    const top = Math.min(state.index ?? state.routes.length - 1, state.routes.length - 1);
    const bottom = state.type === 'tab' ? top : 0;
    for (let index = top; index >= bottom; index -= 1) {
        const route = state.routes[index]!;
        const inner = route.state === undefined ? null : pathIn(route.state);
        if (inner !== null) {
            return inner;
        }
        if (route.name === 'Chat') {
            const id = (route.params as { id?: unknown } | undefined)?.id;
            if (typeof id === 'string' && id !== '') {
                return `/chats/${encodeURIComponent(id)}`;
            }
            continue;
        }
        // A tab's root names its own path, if it has one (the Spaces list's `/spaces`, CB-459).
        const root = tabOfRoot(route.name);
        const linking =
            root === null
                ? (ROUTES as Record<string, { linking?: unknown }>)[route.name]?.linking
                : (tabRootPath(root) ?? undefined);
        if (typeof linking === 'string') {
            return linking === '' || linking.includes(':') ? '/' : `/${linking}`;
        }
    }
    return null;
}

/** The path the root stack shows now: set by the container (root-navigation.tsx), read by the presence layer. */
export interface ScreenPathStore {
    get(): string;
    set(path: string): void;
    subscribe(listener: () => void): () => void;
}

export function createScreenPathStore(): ScreenPathStore {
    let path = '/';
    const listeners = new Set<() => void>();
    return {
        get: () => path,
        set(next) {
            if (next === path) {
                return;
            }
            path = next;
            for (const listener of [...listeners]) {
                listener();
            }
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}

export const screenPath = createScreenPathStore();
