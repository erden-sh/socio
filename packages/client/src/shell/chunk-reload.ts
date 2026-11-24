/**
 * After a deploy, an open tab still asks for the old build's chunks, which
 * are gone (404). A failed module import reloads the page, so the tab picks
 * up the new build. At most once per 30 s per tab: a second failure inside
 * that window is a real error and reaches the error boundary. While the
 * server is away (a deploy's restart, CB-108) the import fails too: the
 * reload waits for it to answer, so the tab never lands on the proxy's
 * error page.
 */
import { waitForServer } from './reconnect';

/** `sessionStorage` key: when this tab last reloaded for a failed import. */
export const CHUNK_RELOAD_KEY = 'socio:chunk-reload-at';
export const CHUNK_RELOAD_WINDOW_MS = 30_000;

/** Reloads the page once the server is up (`waitForServer`). */
export const reloadWhenUp = () => void waitForServer().then(() => location.reload());

/**
 * Reloads (`go`) unless this tab already did in the last 30 s. Returns
 * whether it reloaded. Without storage (blocked), it never reloads: the
 * guard against a reload loop can't be kept.
 */
export function reloadOnce(
    go: () => void = reloadWhenUp,
    storage?: Pick<Storage, 'getItem' | 'setItem'>,
    now = Date.now(),
): boolean {
    try {
        // Reading `sessionStorage` itself throws where storage is blocked.
        const store = storage ?? sessionStorage;
        const last = Number(store.getItem(CHUNK_RELOAD_KEY));
        if (last && now - last >= 0 && now - last < CHUNK_RELOAD_WINDOW_MS) {
            return false;
        }
        store.setItem(CHUNK_RELOAD_KEY, String(now));
    } catch {
        return false;
    }
    go();
    return true;
}

/** Never settles: what an import returns while the page reloads. */
const reloading = <T>() => new Promise<T>(() => {});

/**
 * Wraps a module import: a failed import reloads the page once (`go`) and
 * then never settles, so no error screen flashes before the reload. When
 * Vite's preload handler already started the reload (below), the import
 * resolves to `undefined`; that waits for the reload too.
 */
export async function importOrReload<T>(load: () => Promise<T>, go?: () => void): Promise<T> {
    let module: T | undefined;
    try {
        module = await load();
    } catch (error) {
        if (reloadOnce(go)) {
            return reloading<T>();
        }
        throw error;
    }
    return module ?? reloading<T>();
}

/**
 * Vite dispatches a cancelable `vite:preloadError` when a dynamic import
 * (a lazy route, the editor, the chat) or its CSS fails to load. This
 * reloads once on it; canceling it makes the import resolve to `undefined`
 * instead of throwing. A second failure inside the window is left to throw.
 */
export function installChunkReload(go?: () => void): () => void {
    const onError = (event: Event) => {
        if (reloadOnce(go)) {
            event.preventDefault();
        }
    };
    window.addEventListener('vite:preloadError', onError);
    return () => window.removeEventListener('vite:preloadError', onError);
}
