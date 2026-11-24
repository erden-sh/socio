import type { AuthedFetch } from '../net/authed-fetch';
import { AbortedError } from '../net/errors';
import { readText } from '../net/read-body';

import { httpError, SnapshotShapeError } from './errors';
import type { PullResult, SnapshotCache, SnapshotDefinition } from './snapshot-cache';

// A snapshot source: `pull(scope, cursor)`
// is a conditional GET of its exact path, through the workspace's authedFetch
// (so a 304's Set-Cookie still slides the session), applied to the cache
// as soon as it reads.
// - The cursor is the ETag as received, `W/` included (the app's gzip makes
//   the 200's tag weak, and the server reads either form), sent back as
//   If-None-Match untouched; null sends none, which is the full poll the
//   scheduler makes every 5 minutes and on return to the foreground.
// - A source whose rows weren't read at open (a module's kind, read after the
//   first frame, or a scoped kind's scope) reads them before it asks, so an
//   answer always meets them.
// - A scoped kind (`scopedPath`, a Space's pages) asks its scope's path; a
//   whole kind only scope ''.
// - A 304 is never parsed: it has no body, and changes no row.
// - A path with no ETag (`hashBody`, `/api/learning/skills`) is asked with no
//   If-None-Match. Its 200's body is hashed (`bodyTag`), and the hash is kept
//   as the source's ETag: a body whose hash the cache holds applies as a 304
//   (no parse, no row changed), so only a change applies. The cache drops it
//   as it drops any ETag (a confirmed write), and the next body applies whole.
// - A 200 is read whole, split and checked before anything applies, then
//   diffed against the scope's rows and applied with its ETag (snapshot-cache.ts).
// - Either is applied with its Date header, the server's clock for the version
//   rules (versions.ts).
// - Any other status rejects with an HttpError, which `serverAway` reads; a
//   401 has already gone to authedFetch's `onUnauthorized`.

export interface SyncSource {
    /** The source's name (its meta row's). */
    readonly id: string;
    /** The cursor the cache holds for `scope`, to pass to `pull`. */
    cursor(scope?: string): string | null;
    /** Whether `scope` was last pulled under another server version than the highest: due one pull. */
    stale(scope?: string): boolean;
    /**
     * Asks the server for `scope` with `cursor` and applies the answer. Rejects
     * with src/net's errors, HttpError or SnapshotShapeError, having applied nothing.
     */
    pull(scope: string, cursor: string | null): Promise<PullResult>;
}

export interface SnapshotSourceOptions {
    readonly definition: SnapshotDefinition;
    readonly cache: SnapshotCache;
    /** The workspace's authedFetch. */
    readonly fetch: AuthedFetch;
    /** The workspace scope's signal, which authedFetch has too: a body read after it aborts rejects. */
    readonly signal?: AbortSignal;
    /** Headers every pull carries besides If-None-Match: /api/state's presence (presence.ts). */
    readonly headers?: () => Record<string, string>;
}

export function createSnapshotSource({
    definition,
    cache,
    fetch,
    signal,
    headers: extra,
}: SnapshotSourceOptions): SyncSource {
    return {
        id: definition.id,
        cursor: (scope = '') => cache.cursor(definition, scope),
        stale: (scope = '') => cache.stale(definition, scope),
        async pull(scope, cursor) {
            // A whole kind's scope is ''; a scoped kind (a Space's pages) names one.
            const { scopedPath } = definition;
            if (scopedPath === undefined ? scope !== '' : scope === '') {
                throw new TypeError(`${definition.id} can't be pulled for scope "${scope}".`);
            }
            const path = scopedPath === undefined ? definition.path : scopedPath(scope);
            // A module's kind may not be read from cache.db yet (it loads after the first frame), nor a scope.
            if (!cache.loaded(definition, scope)) {
                await cache.load([definition], scope);
            }
            const startedAt = cache.beginPull();
            const sent = {
                ...extra?.(),
                ...(cursor === null || definition.hashBody ? {} : { 'if-none-match': cursor }),
            };
            const response = await fetch(path, Object.keys(sent).length === 0 ? undefined : { headers: sent });
            const { headers } = response;
            if (response.status === 304) {
                return cache.applyNotModified(
                    definition,
                    scope,
                    startedAt,
                    cursor,
                    headers.get('etag'),
                    headers.get('date'),
                );
            }
            if (!response.ok) {
                throw await httpError(response, signal);
            }
            const text = await readText(response, signal);
            let etag = headers.get('etag');
            if (definition.hashBody) {
                etag = bodyTag(text);
                // The body the rows came from: nothing to apply. The held tag is read now, as the cache's 304 checks it.
                const held = cache.cursor(definition, scope);
                if (held === etag) {
                    if (signal?.aborted) {
                        throw new AbortedError(response.url, signal.reason);
                    }
                    return cache.applyNotModified(definition, scope, startedAt, held, etag, headers.get('date'));
                }
            }
            let body: unknown;
            try {
                body = JSON.parse(text) as unknown;
            } catch {
                throw new SnapshotShapeError(path, 'the body is not JSON.');
            }
            const parts = definition.split(body);
            if (signal?.aborted) {
                throw new AbortedError(response.url, signal.reason);
            }
            return cache.applySnapshot(definition, scope, startedAt, parts, etag, headers.get('date'));
        },
    };
}

/**
 * The tag a `hashBody` source keeps for a body: its length and a 53-bit hash
 * of its text (cyrb53), quoted as an ETag is. Not a security measure: it only
 * tells one answer of the same path from the next.
 */
export function bodyTag(text: string): string {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        h1 = Math.imul(h1 ^ code, 2654435761);
        h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const hash = 4294967296 * (2097151 & h2) + (h1 >>> 0);
    return `"body.${text.length.toString(36)}.${hash.toString(36)}"`;
}
