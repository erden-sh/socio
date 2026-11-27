import { LOCALES, SOURCE_LOCALE, isSupportedLocale, resolutionChain } from './registry.js';

/**
 * The dictionaries a build holds (`dist/i18n/manifest.json`), as
 * `GET /i18n/manifest.json` serves it. Each namespace file is at
 * `/i18n/<locale>/<ns>.<hash>.json` and never changes.
 */
export interface NamespaceEntry {
    /** The file's content hash: its URL and ETag. */
    readonly hash: string;
    /** The en-US source's shape (keys, suffixes, variables): `sourceHash` in keys.ts. */
    readonly sourceHash: string;
}

export interface LocaleEntry {
    /** The share of en-US's strings this locale translates, through its fallback chain: 0 to 1. */
    readonly coverage: number;
    readonly ns: Readonly<Record<string, NamespaceEntry>>;
}

export interface I18nManifest {
    /** The Socio release the files were built for. */
    readonly release: string;
    readonly locales: Readonly<Record<string, LocaleEntry>>;
}

/** A locale is offered in Settings › Language once it translates this share of en-US. */
export const COVERAGE_GATE = 0.95;

/** The path of one namespace file. */
export const namespacePath = (locale: string, ns: string, hash: string) => `/i18n/${locale}/${ns}.${hash}.json`;

/** The manifest's path; `?locales=a,b` narrows it. */
export const MANIFEST_PATH = '/i18n/manifest.json';

/** The file for a namespace in a locale, or undefined when the build has none (a sparse locale). */
export function namespaceUrl(manifest: I18nManifest, locale: string, ns: string): string | undefined {
    const entry = manifest.locales[locale]?.ns[ns];
    return entry && namespacePath(locale, ns, entry.hash);
}

/**
 * Whether a client should take a server's copy of a namespace over its own
 * bundled one: only when both were built from the same en-US keys and
 * variables, so every key the code asks for is there with the variables it
 * passes. A different hash means another release's strings: keep the
 * bundled copy.
 */
export function acceptsServerNamespace(server: NamespaceEntry | undefined, bundledSourceHash: string): boolean {
    return !!server && server.sourceHash === bundledSourceHash;
}

/**
 * The locales Settings › Language offers: registered, not pseudo, and at or
 * over the coverage gate in this manifest. en-US always.
 */
export function offeredLocales(manifest: I18nManifest | undefined): string[] {
    const offered = Object.entries(manifest?.locales ?? {})
        .filter(([locale, entry]) => {
            if (!isSupportedLocale(locale)) {
                return false;
            }
            const info = LOCALES[locale];
            return !('pseudo' in info) && entry.coverage >= COVERAGE_GATE;
        })
        .map(([locale]) => locale);
    return offered.includes(SOURCE_LOCALE) ? offered : [SOURCE_LOCALE, ...offered];
}

/** Whether there is a language to choose: two offered locales or more (`offeredLocales`). */
export const hasLanguageChoice = (offered: readonly string[]) => offered.length >= 2;

/**
 * Settings › Language shows only when there is a choice. With en-US alone
 * (today's build) it doesn't render; the preference API works regardless.
 */
export const languageSettingVisible = (manifest: I18nManifest | undefined) =>
    hasLanguageChoice(offeredLocales(manifest));

/**
 * The locales a request may resolve to: those with any strings in this
 * manifest (a locale with none would only render en-US under another
 * `lang`), and en-US.
 */
export function availableLocales(manifest: I18nManifest | undefined): string[] {
    const found = Object.entries(manifest?.locales ?? {})
        .filter(([locale, entry]) => isSupportedLocale(locale) && entry.coverage > 0)
        .map(([locale]) => locale);
    return found.includes(SOURCE_LOCALE) ? found : [SOURCE_LOCALE, ...found];
}

/** The manifest with only `locales` and the locales their keys fall back to kept (es-US brings es-419 and en-US). */
export function narrowManifest(manifest: I18nManifest, locales: readonly string[] | undefined): I18nManifest {
    if (!locales) {
        return manifest;
    }
    const wanted = new Set([SOURCE_LOCALE, ...locales.flatMap(resolutionChain)]);
    return {
        release: manifest.release,
        locales: Object.fromEntries(Object.entries(manifest.locales).filter(([locale]) => wanted.has(locale))),
    };
}
