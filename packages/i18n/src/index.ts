/**
 * `@socio/i18n`: what the server, the web client and the native app share.
 * No React here: the native app runs this under plain Node too, and the
 * React binding is `@socio/i18n/react`.
 */
export { buildCatalog, CatalogError, NAMESPACE_NAME, type BuiltFile, type Catalog, type Sources } from './catalog.js';
export { createI18n, DEFAULT_NAMESPACE, type CreateI18nOptions } from './create.js';
export { addFormatters, formatBytes, formatDuration, FORMATTERS } from './format.js';
export {
    flatten,
    pluralForm,
    sourceHash,
    variablesOf,
    PLURAL_CATEGORIES,
    type Dictionary,
    type PluralCategory,
} from './keys.js';
export {
    fallbackLanguages,
    isSupportedLocale,
    localeDir,
    localeInfo,
    resolutionChain,
    LOCALES,
    PSEUDO_LOCALE,
    SOURCE_LOCALE,
    SUPPORTED_LOCALES,
    type LocaleInfo,
    type SupportedLocale,
} from './registry.js';
export {
    acceptsServerNamespace,
    availableLocales,
    hasLanguageChoice,
    languageSettingVisible,
    namespacePath,
    namespaceUrl,
    narrowManifest,
    offeredLocales,
    COVERAGE_GATE,
    MANIFEST_PATH,
    type I18nManifest,
    type LocaleEntry,
    type NamespaceEntry,
} from './manifest.js';
export {
    negotiateLocale,
    normalizeTag,
    parseAcceptLanguage,
    resolveRequestLocale,
    LOCALE_COOKIE,
    type LocaleSources,
} from './negotiate.js';
export { pseudoDictionary, pseudoText } from './pseudo.js';
export { sha256Hex } from './sha256.js';
