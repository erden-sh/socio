/**
 * What other features may know of the dictionaries (`@socio/i18n`'s build,
 * served from this server): the catalog's tag and shape, and plain types.
 * It imports only `effect` and `@socio/*`, and holds no logic.
 *
 * The catalog holds only UI strings: the files built from
 * packages/i18n/locales, never workspace data, so its routes are public
 * (signed-out pages and the native app read them before signing in) and
 * cacheable. Nothing here calls out: every dictionary comes with the build.
 *
 * Not here, on purpose:
 * - `loadI18nCatalog` (`catalog.ts`) and `i18nRoutes` (`routes.ts`): the
 *   composition's (`composition/i18n.ts`, `composition/http/i18n.ts`).
 */
import { Context } from 'effect';

import type { I18nManifest } from '@socio/i18n/manifest';
import type { LocaleSources } from '@socio/i18n/negotiate';
import type { PageI18n } from '@socio/shared/web/web';

/** One built namespace file, and its precompressed copies. */
export interface I18nFile {
    readonly body: Uint8Array;
    readonly gzip?: Uint8Array;
    readonly brotli?: Uint8Array;
}

export interface I18nCatalogShape {
    /** The whole manifest. */
    manifest(): I18nManifest;
    /** The manifest's body and strong ETag, narrowed to `locales` (and their fallbacks) when given. */
    manifestBody(locales?: readonly string[]): { readonly body: string; readonly etag: string };
    /** `/i18n/<locale>/<ns>.<hash>.json`'s file; undefined for a hash this build doesn't have. */
    file(locale: string, ns: string, hash: string): I18nFile | undefined;
    /**
     * A page's locale and dictionaries: the locale the request resolves to,
     * the namespaces' files for it and the locales it falls back to, the
     * manifest of those locales, and the locales Settings › Language offers.
     */
    page(sources: LocaleSources, namespaces: readonly string[]): PageI18n;
}

export class I18nCatalog extends Context.Service<I18nCatalog, I18nCatalogShape>()('socio/i18n/I18nCatalog') {}
