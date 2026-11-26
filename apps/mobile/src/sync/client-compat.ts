import {
    appFromUserAgent,
    appVerdict,
    CLIENT_COMPAT_PATH,
    readPlatformCompat,
    type AppPlatform,
    type PlatformCompat,
} from '@socio/shared/client-compat';

import type { AuthedFetch } from '../net/authed-fetch';
import { readText } from '../net/read-body';

import type { ViewState } from './view-state';

// Whether this app is new enough for one workspace's server (CB-553). The
// server publishes, per platform, the lowest app version it serves and the one
// it recommends (`GET /api/client/compat`, shared's client-compat.ts), and
// answers an app below the minimum with 426 `client_update_required`
// everywhere but sign-in and sign-out. Each workspace's scope has its own:
// one phone holds workspaces on different releases, and only the one whose
// server asks for it shows Update Socio.
//
// - **Read** as the scope starts, on each return to the foreground, and after
//   a 426 while the gate is open (`refused`, which closes it at once). One read at a time; one
//   asked meanwhile runs once more after it.
// - **Kept** in cache.db's `kv` (`CLIENT_COMPAT_KEY`), so a cold start offline
//   shows the gate before any answer. Clear cache forgets it until the next read.
// - **An older server** has no endpoint: a 404, or a 2xx that isn't its JSON,
//   means no app minimum (`none`), and the server's own version still decides
//   the reverse case (versions.ts, "needs a server update"). No answer, a 5xx
//   or anything else keeps what was known.
// - **Required** while this version is below the minimum, or since a 426 until
//   a read says otherwise: the shell shows Update Socio in place of the
//   workspace and the outbox holds every lane (`holdForUpdate`). Nothing is
//   signed out or deleted, so drafts, the outbox and the cache wait for the update.
// - **The banner** between the minimum and the recommended version, until the
//   person dismisses it for that recommended version (`CLIENT_COMPAT_DISMISSED_KEY`):
//   a higher recommendation shows it again.

/** cache.db's `kv` key: the last numbers read, `{ v: 1, minimum, recommended }` or `{ v: 1, none: true }`. */
export const CLIENT_COMPAT_KEY = 'client-compat';
/** cache.db's `kv` key: the recommended version whose banner the person dismissed. */
export const CLIENT_COMPAT_DISMISSED_KEY = 'client-compat.dismissed';

/** What the scope knows of the server's numbers for this platform. */
export type CompatKnown =
    | { readonly kind: 'unknown' }
    | { readonly kind: 'none' }
    | ({ readonly kind: 'known' } & PlatformCompat);

/** What the screens read: the gate, and the banner's version. */
export interface ClientCompatState {
    /** This app is below the server's minimum (or the server said so with a 426). */
    readonly required: boolean;
    /** The server's minimum, when known. */
    readonly minimum: string | null;
    /** The version the banner recommends, or null: none, current, dismissed, or the gate shows instead. */
    readonly recommended: string | null;
    /** This app's version, from its User-Agent. */
    readonly version: string | null;
}

export interface ClientCompat {
    state(): ClientCompatState;
    known(): CompatKnown;
    /** Reads the server's numbers; resolves once that read (and one asked during it) is done. Never rejects. */
    check(): Promise<void>;
    /** A 426 came back: the gate closes now, and the numbers are read again. */
    refused(): void;
    /** The person dismissed the banner for the version it recommends. */
    dismiss(): void;
    subscribe(listener: () => void): () => void;
    dispose(): void;
}

export interface ClientCompatOptions {
    /** The scope's authedFetch: the endpoint needs no session, but this sends to the workspace's origin alone. */
    readonly fetch: AuthedFetch;
    /** The app's User-Agent, which names its version and platform. */
    readonly userAgent: string;
    readonly viewState: ViewState;
    readonly signal?: AbortSignal;
    readonly onError?: (error: unknown) => void;
}

/** The kept numbers, or `unknown` for none or a value this build can't read. */
export function readKept(value: string | null, platform: AppPlatform): CompatKnown {
    if (value === null) {
        return { kind: 'unknown' };
    }
    try {
        const kept = JSON.parse(value) as { v?: unknown; none?: unknown } | null;
        if (kept?.v !== 1) {
            return { kind: 'unknown' };
        }
        if (kept.none === true) {
            return { kind: 'none' };
        }
        const numbers = readPlatformCompat({ platforms: { [platform]: kept } }, platform);
        return numbers === null ? { kind: 'unknown' } : { kind: 'known', ...numbers };
    } catch {
        return { kind: 'unknown' };
    }
}

const keep = (known: CompatKnown): string | null =>
    known.kind === 'none'
        ? JSON.stringify({ v: 1, none: true })
        : known.kind === 'known'
          ? JSON.stringify({ v: 1, minimum: known.minimum, recommended: known.recommended })
          : null;

/**
 * What one answer of the endpoint says: the numbers, `none` for a server without the endpoint, or
 * null to keep what was known (no answer, the server away, a refusal of another kind).
 */
export async function compatFromAnswer(
    response: Response,
    platform: AppPlatform,
    signal?: AbortSignal,
): Promise<CompatKnown | null> {
    if (response.status === 404) {
        return { kind: 'none' };
    }
    if (response.status < 200 || response.status >= 300) {
        return null;
    }
    let body: unknown = null;
    try {
        body = JSON.parse(await readText(response, signal)) as unknown;
    } catch (error) {
        if (error instanceof SyntaxError) {
            return { kind: 'none' };
        }
        throw error;
    }
    const numbers = readPlatformCompat(body, platform);
    return numbers === null ? { kind: 'none' } : { kind: 'known', ...numbers };
}

/** The screens' state from what is known, a 426 since the last read, and the dismissed banner. */
export function compatState(
    known: CompatKnown,
    version: string | null,
    refused: boolean,
    dismissed: string | null,
): ClientCompatState {
    const minimum = known.kind === 'known' ? known.minimum : null;
    if (version === null) {
        return { required: refused, minimum, recommended: null, version };
    }
    const verdict = known.kind === 'known' ? appVerdict(version, known) : 'current';
    if (refused || verdict === 'required') {
        return { required: true, minimum, recommended: null, version };
    }
    const recommended =
        verdict === 'recommended' && known.kind === 'known' && dismissed !== known.recommended
            ? known.recommended
            : null;
    return { required: false, minimum, recommended, version };
}

const sameState = (a: ClientCompatState, b: ClientCompatState) =>
    a.required === b.required && a.minimum === b.minimum && a.recommended === b.recommended && a.version === b.version;

export function createClientCompat({
    fetch,
    userAgent,
    viewState,
    signal,
    onError = () => {},
}: ClientCompatOptions): ClientCompat {
    const app = appFromUserAgent(userAgent);
    let known: CompatKnown =
        app === null ? { kind: 'unknown' } : readKept(viewState.get(CLIENT_COMPAT_KEY), app.platform);
    let refusedSince = false;
    let disposed = false;
    const listeners = new Set<() => void>();
    let state = compatState(known, app?.version ?? null, false, viewState.get(CLIENT_COMPAT_DISMISSED_KEY));

    const update = () => {
        const next = compatState(known, app?.version ?? null, refusedSince, viewState.get(CLIENT_COMPAT_DISMISSED_KEY));
        if (sameState(next, state)) {
            return;
        }
        state = next;
        for (const listener of [...listeners]) {
            listener();
        }
    };

    let running: Promise<void> | null = null;
    let again = false;
    const readOnce = async () => {
        if (app === null) {
            return;
        }
        let answer: CompatKnown | null = null;
        try {
            const response = await fetch(CLIENT_COMPAT_PATH, { signal });
            answer = await compatFromAnswer(response, app.platform, signal);
        } catch (error) {
            // No answer: what was known stands.
            if ((error as { name?: unknown } | null)?.name !== 'AbortError' && !disposed) {
                onError(error);
            }
            return;
        }
        if (disposed || answer === null) {
            return;
        }
        known = answer;
        refusedSince = false;
        const kept = keep(answer);
        if (kept !== null) {
            viewState.set(CLIENT_COMPAT_KEY, kept);
        }
        update();
    };
    const check = (): Promise<void> => {
        if (disposed) {
            return Promise.resolve();
        }
        if (running !== null) {
            again = true;
            return running;
        }
        running = (async () => {
            do {
                again = false;
                await readOnce();
            } while (again && !disposed);
            running = null;
        })();
        return running;
    };

    return {
        state: () => state,
        known: () => known,
        check,
        refused() {
            // Once closed, the pulls' further 426s read nothing more: Check again and the foreground do.
            if (disposed || state.required) {
                return;
            }
            refusedSince = true;
            update();
            void check();
        },
        dismiss() {
            if (known.kind !== 'known' || state.recommended === null) {
                return;
            }
            viewState.set(CLIENT_COMPAT_DISMISSED_KEY, known.recommended);
            update();
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        dispose() {
            disposed = true;
            listeners.clear();
        },
    };
}
