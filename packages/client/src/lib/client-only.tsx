import { useSyncExternalStore, type ReactNode } from 'react';

const subscribe = () => () => {};

/**
 * False on the server and while the page hydrates, true after (and on
 * every render that isn't hydration, so tests and client navigations see
 * true at once). For output that only the browser can know.
 */
export const useHydrated = () =>
    useSyncExternalStore(
        subscribe,
        () => true,
        () => false,
    );

/**
 * Renders `children` in the browser only, after hydration; `fallback`
 * before, on the server too. With `React.lazy` inside, the server never
 * loads the module: the chat, the editor, the computer pane.
 */
export function ClientOnly({ children, fallback = null }: { children: () => ReactNode; fallback?: ReactNode }) {
    return useHydrated() ? children() : fallback;
}
