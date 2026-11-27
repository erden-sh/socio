/**
 * The dictionaries' construction: one catalog per process, over the
 * build's dist/i18n (`I18N_BUILD_DIR`), or, outside production, the source
 * in packages/i18n/locales built in memory, so development and tests need
 * no build. Read once; nothing is fetched from anywhere.
 */
import { loadI18nCatalog } from '../i18n/catalog.js';
import type { I18nCatalogShape } from '../i18n/contract.js';

let catalog: I18nCatalogShape | undefined;

/** The process's catalog, loaded on first use. */
export function processI18nCatalog(env: NodeJS.ProcessEnv = process.env): I18nCatalogShape {
    catalog ??= loadI18nCatalog({
        buildDir: env.I18N_BUILD_DIR?.trim() || 'dist/i18n',
        sourceDir: 'packages/i18n/locales',
        preferSources: env.NODE_ENV !== 'production',
        release: env.npm_package_version ?? 'development',
    });
    return catalog;
}
