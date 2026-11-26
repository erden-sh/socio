import { READS_AG_UI_MEDIA, READS_HEADER } from '@socio/shared/media/refs';
import { UNREADABLE_RESPONSE } from '@socio/shared/reconnect';

import { postWrite } from './change-channel';

/**
 * Every API request says the app reads AG-UI 1.0's attachment parts, so the
 * server sends them as it stores them (@socio/shared/media/legacy-media).
 */
const READS = { [READS_HEADER]: READS_AG_UI_MEDIA };

export class ApiError extends Error {
    constructor(
        message: string,
        public status: number,
        public code?: string,
    ) {
        super(message);
    }
}
export async function api<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`/api${path}`, {
        method,
        signal,
        headers: {
            ...READS,
            ...(['GET', 'HEAD'].includes(method) ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await answer<T>(response);
    // A write that worked: the other tabs refetch what it changed (ids
    // from the path only, never the body: change-channel.ts).
    if (!['GET', 'HEAD'].includes(method)) {
        postWrite(path);
    }
    return data;
}

/** What a failed request says when the answer isn't the API's JSON (shared with the native app). */
export { UNREADABLE_RESPONSE };

async function answer<T>(response: Response): Promise<T> {
    const data = (await response.json().catch(() => ({ error: UNREADABLE_RESPONSE }))) as {
        error?: string;
        code?: string;
    };
    if (!response.ok) {
        throw new ApiError(data.error ?? `Request failed (${response.status}).`, response.status, data.code);
    }
    return data as T;
}

/** What `apiIfChanged` gives on a `304`: the copy the caller holds is current. */
export const UNCHANGED = Symbol('unchanged');

/**
 * A poll asks without its tag at least this often, and the first time
 * after the tab comes back into view: a version that missed a change can't
 * keep a tab stale.
 */
export const FULL_POLL_MS = 5 * 60_000;

// Counts the times this tab came back into view.
let shown = 0;
if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            shown++;
        }
    });
}

/**
 * The last `ETag` per path, for one poller (a hook, the shell). Each keeps
 * its own: a tag says what that poller holds. Dropped on sign-out and a
 * user switch (`forget`), when the tab comes back into view, and five
 * minutes after the last full answer.
 */
export class PollTags {
    private tags = new Map<string, { tag: string; at: number; shown: number }>();
    /** The tag to send for `path`, if it may be sent now. */
    get(path: string, now = Date.now()) {
        const entry = this.tags.get(path);
        return entry && entry.shown === shown && now - entry.at < FULL_POLL_MS ? entry.tag : undefined;
    }
    set(path: string, tag: string | null, now = Date.now()) {
        if (tag) {
            this.tags.set(path, { tag, at: now, shown });
        } else {
            this.tags.delete(path);
        }
    }
    forget() {
        this.tags.clear();
    }
}

/** A full answer to a conditional poll, with the tag to keep for it. */
export interface Fresh<T> {
    data: T;
    tag: string | null;
}

/**
 * A conditional poll: a `GET` that sends `tag` (from the caller's
 * `PollTags`) as `If-None-Match`, and answers `UNCHANGED` on a `304`, so
 * the caller keeps its copy and doesn't render. The caller keeps the new
 * tag only once it shows the data (`tags.set`): a tag says what the caller
 * holds, so an answer it drops (signed out meanwhile, an older poll) must
 * not leave its tag. Responses are `no-store`, so the browser neither
 * keeps them nor adds the header itself; a request that carries it skips
 * the browser's cache (Fetch: conditional headers switch the cache mode to
 * `no-store`). Errors are thrown as `api()` throws them. `headers` go
 * along (the shell's `/state` poll sends the tab's presence, presence.ts).
 */
export async function apiIfChanged<T>(
    path: string,
    tag: string | undefined,
    signal?: AbortSignal,
    headers: Record<string, string> = {},
): Promise<Fresh<T> | typeof UNCHANGED> {
    const response = await fetch(`/api${path}`, {
        signal,
        headers: { ...READS, ...headers, ...(tag ? { 'If-None-Match': tag } : {}) },
    });
    if (response.status === 304) {
        return UNCHANGED;
    }
    const data = await answer<T>(response);
    return { data, tag: response.headers.get('ETag') };
}
/** A failed request as the error notices see it (`poll-notice.ts`). */
export function describeFailure(error: unknown, fallback: string) {
    return {
        ok: false as const,
        status: error instanceof ApiError ? error.status : undefined,
        code: error instanceof ApiError ? error.code : undefined,
        message: error instanceof Error ? error.message : fallback,
        offline: browserOffline(),
    };
}

/**
 * Whether the browser says it has no network. Never during a server
 * render, which has no browser to ask.
 */
export function browserOffline() {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
}
