/**
 * The web layers: they implement `contract.ts`'s `WebReader` and
 * `WebCapabilities`, and `WebIdentities`, the identity setting web's own routes
 * change. All three read `WebConfig` (the web reads' settings) and
 * `WebDatabase` (the workspace's connection). Only the composition root
 * (`composition/web.ts`, `composition/http/web.ts`) and tests import this file.
 *
 * The reader stays one per connection (`WebConfig.readerOn`, the
 * composition's `webReadsFor`), so rate limits, the
 * cache and host stops hold across turns, Dots and routes, and across the
 * callers that don't read the tag yet (`capabilities`, `dots`,
 * `notifications`, the web module's tools). Each tag reaches it at each
 * call, so it is made where it always was, by its first user, with the
 * same settings.
 *
 * Not here: `Research`. Its config is the task runner's research config,
 * which the process entry builds, and the runner and the state view call
 * `research.ts` directly.
 */
import type { DatabaseSync } from 'node:sqlite';

import { Context, Effect, Layer } from 'effect';

import {
    WebCapabilities,
    WebConfig,
    WebIdentities,
    WebReader,
    type WebCapabilitiesShape,
    type WebConnectionReader,
    type WebIdentitiesShape,
    type WebReaderShape,
} from './contract.js';
import { webCapabilities } from './web-tools.js';

// ── What the composition hands in ───────────────────────────────────────

/**
 * The workspace's connection, opened and migrated by the boot step, that the
 * web identities and the read audit live on. A stand-in for the app's
 * `Database` tag, which no feature offers yet: the composition root provides it
 * from the workspace store.
 */
export class WebDatabase extends Context.Service<WebDatabase, DatabaseSync>()('socio/web/WebDatabase') {}

// ── Over the connection's reader ────────────────────────────────────────

/** The connection's one reader (`WebConfig.readerOn`), reached at each call. */
type ReaderOf = () => WebConnectionReader;

/** `WebReader` over the connection's one reader, reached at each call. */
export const webReaderOver = (reads: ReaderOf): WebReaderShape => ({
    identity: (dotId) => reads().identity(dotId),
    status: (dotId, withAudit) => reads().status(dotId, withAudit),
    read: (request) => reads().read(request),
    activity: (dotId, before, limit) => reads().activity(dotId, before, limit),
});

/** `WebIdentities` over the same reader's store. */
export const webIdentitiesOver = (reads: ReaderOf): WebIdentitiesShape => ({
    setIdentity: (dotId, identity, userId) => reads().store.setIdentity(dotId, identity, userId),
});

/**
 * `WebReader`, `WebCapabilities` (over that reader) and `WebIdentities`,
 * from `WebDatabase` and `WebConfig`.
 */
export const webContext = Effect.gen(function* () {
    const db = yield* WebDatabase;
    const { readerOn } = yield* WebConfig;
    const reads = () => readerOn(db);
    const reader = WebReader.of(webReaderOver(reads));
    const capabilities: WebCapabilitiesShape = webCapabilities(reader);
    return Context.make(WebReader, reader).pipe(
        Context.add(WebCapabilities, capabilities),
        Context.add(WebIdentities, webIdentitiesOver(reads)),
    );
});

/** Web's tags; needs `WebDatabase` and `WebConfig`. Building it makes nothing: the reader is made on first use. */
export const WebLive = Layer.effectContext(webContext);
