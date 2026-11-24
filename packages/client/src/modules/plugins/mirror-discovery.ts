import { MANIFEST_PATH } from '../../shell/build-skew';

/**
 * A plugin's address mirror and lazy route discovery (CB-446). Every new
 * deep path makes React Router ask `/__manifest` before the navigation
 * commits; if that request fails, the router shows the shell's error page,
 * which would unmount the plugin's frame. For the one mirror in flight,
 * this guard turns a failed discovery into a mirror that never commits:
 * the address stays where it was, the frame stays mounted, and the next
 * navigation (the app's next report, a link, a revalidation) supersedes
 * it. Any other `/__manifest` request, and every other fetch, is
 * untouched.
 */
interface PendingMirror {
    /** The pathname the mirror navigates to: what discovery asks for. */
    pathname: string;
    /** Called once when discovery for it failed. */
    onFailed: () => void;
}

let pending: PendingMirror | undefined;

/** Mark a mirror navigation to `pathname` as in flight. Returns the function that ends it. */
export function beginMirror(pathname: string, onFailed: () => void) {
    const mirror: PendingMirror = { pathname, onFailed };
    pending = mirror;
    return () => {
        if (pending === mirror) {
            pending = undefined;
        }
    };
}

const requestUrl = (input: RequestInfo | URL) =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

/** Rejects only when `signal` aborts (the router superseded the navigation). */
const untilAborted = (signal: AbortSignal | null | undefined) =>
    new Promise<Response>((_, reject) => {
        if (!signal) {
            return;
        }
        if (signal.aborted) {
            reject(signal.reason);
            return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });

/** Wrap `fetch` (the browser's, once, in entry.client) with the guard. Returns the function that removes it. */
export function installMirrorDiscoveryGuard(target: { fetch: typeof fetch } = globalThis) {
    const original = target.fetch;
    const guarded: typeof fetch = async (input, init) => {
        const mirror = pending;
        let url: URL;
        try {
            url = new URL(requestUrl(input), globalThis.location?.origin ?? 'http://app.invalid');
        } catch {
            return original(input, init);
        }
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        if (
            !mirror ||
            url.pathname !== MANIFEST_PATH ||
            !(url.searchParams.get('paths') ?? '').split(',').includes(mirror.pathname)
        ) {
            return original(input, init);
        }
        try {
            const response = await original(input, init);
            // 204 is "a newer build: load the page again", the router's own to act on.
            if (response.ok || response.status === 204) {
                return response;
            }
        } catch (error) {
            if (signal?.aborted) {
                throw error;
            }
        }
        if (pending === mirror) {
            pending = undefined;
        }
        mirror.onFailed();
        return untilAborted(signal);
    };
    target.fetch = guarded;
    return () => {
        if (target.fetch === guarded) {
            target.fetch = original;
        }
    };
}
