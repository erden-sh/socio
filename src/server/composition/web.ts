/**
 * The web's construction: web's tags through its layer (`web/layer.ts`) on the
 * workspace's connection, and `WebConfig` built here from the supplied startup
 * configuration (the `PlatformConfig` the boot step built, not the environment
 * again; moving env parsing here is a later change). The web has nothing to
 * start or stop, so there is no `composition/lifecycle/web.ts`.
 */
import type { DatabaseSync } from 'node:sqlite';

import { Effect, Layer } from 'effect';

import { WebConfig, type WebConfigShape, type WebSettings } from '../web/contract.js';
import { WebDatabase, WebLive } from '../web/layer.js';
import { WebReads, webSettingsFromEnv } from '../web/web-reads.js';

import { LegacyConfig, LegacyWorkspace } from './base.js';
import type { PlatformConfig } from './config.js';
import { webStoreOn } from './integration-stores.js';

const readers = new WeakMap<DatabaseSync, WebReads>();
/**
 * The workspace's web reader: one per database, so rate limits, the cache
 * and host stops hold across turns, Dots and routes. Its first user makes
 * it, with its settings, over the connection's `WebStore`.
 */
export function webReadsFor(
    db: DatabaseSync,
    settings?: WebSettings,
    options?: ConstructorParameters<typeof WebReads>[2],
) {
    let reader = readers.get(db);
    if (!reader) {
        reader = new WebReads(webStoreOn(db), settings ?? webSettingsFromEnv({}), options);
        readers.set(db, reader);
    }
    return reader;
}

/**
 * What the web reads of the startup configuration: `config.web`, the web
 * reads' settings (`WEB_*`, `APP_ORIGIN`, `AGENTS_CONTACT`), and the
 * connection's one reader with those settings (`webReadsFor`).
 */
export function webConfigOf(config: Pick<PlatformConfig, 'web'>): WebConfigShape {
    return { web: config.web, readerOn: (db) => webReadsFor(db, config.web) };
}

/**
 * The web's step of the graph: `WebReader`, `WebCapabilities` and
 * `WebIdentities` over the connection's one reader (made by its first
 * user, as it always was), with `WebConfig` and `WebDatabase`. It builds
 * nothing and takes no listener, so its place in the chain changes no
 * order.
 */
export const webLayers = {
    bridges: Layer.unwrap(
        Effect.gen(function* () {
            const { db } = yield* LegacyWorkspace;
            const config = WebConfig.of(webConfigOf(yield* LegacyConfig));
            return WebLive.pipe(
                Layer.provideMerge(Layer.mergeAll(Layer.succeed(WebConfig, config), Layer.succeed(WebDatabase, db))),
            );
        }),
    ),
};
