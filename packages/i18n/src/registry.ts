/**
 * The locales Socio knows. A locale here can be saved as a preference and
 * gets a manifest entry; whether it is offered in Settings › Language is
 * decided by its coverage (`offeredLocales` in manifest.ts), so a locale
 * with no strings yet stays out of the picker.
 *
 * `fallback` is the chain a missing key falls through, ending in en-US. A
 * locale's files hold only the keys that differ from the next one in its
 * chain (es-US over es-419), so they may be sparse. Tags in a chain that
 * aren't registered (`es`, `pt`) are skipped.
 */
export const SOURCE_LOCALE = 'en-US';

/** The pseudo-locale: en-US accented and lengthened, for tests and smoke checks; never offered. */
export const PSEUDO_LOCALE = 'en-XA';

export interface LocaleInfo {
    /** Writing direction, for `<html dir>`. */
    readonly dir: 'ltr' | 'rtl';
    /** Where a missing key comes from, nearest first; en-US is always last. */
    readonly fallback: readonly string[];
    /** Generated from en-US (`pseudo.ts`), not translated. */
    readonly pseudo?: true;
}

export const LOCALES = {
    'en-US': { dir: 'ltr', fallback: [] },
    'es-419': { dir: 'ltr', fallback: ['es', 'en-US'] },
    'es-US': { dir: 'ltr', fallback: ['es-419', 'es', 'en-US'] },
    'pt-BR': { dir: 'ltr', fallback: ['pt', 'en-US'] },
    'en-XA': { dir: 'ltr', fallback: ['en-US'], pseudo: true },
} as const satisfies Record<string, LocaleInfo>;

export type SupportedLocale = keyof typeof LOCALES;

export const SUPPORTED_LOCALES = Object.keys(LOCALES) as SupportedLocale[];

/** Whether `tag` is a registered locale, exactly as written (`es-US`, not `es-us`). */
export const isSupportedLocale = (tag: unknown): tag is SupportedLocale =>
    typeof tag === 'string' && Object.prototype.hasOwnProperty.call(LOCALES, tag);

/** The locale's registry entry; en-US's for one that isn't registered. */
export const localeInfo = (tag: string): LocaleInfo => (isSupportedLocale(tag) ? LOCALES[tag] : LOCALES[SOURCE_LOCALE]);

/** `<html dir>` for a locale. */
export const localeDir = (tag: string) => localeInfo(tag).dir;

/** The registered locales a key falls through for `tag`, the locale itself first and en-US last. */
export const resolutionChain = (tag: string): SupportedLocale[] => {
    const chain = [tag, ...localeInfo(tag).fallback, SOURCE_LOCALE].filter(isSupportedLocale);
    return chain.filter((locale, index) => chain.indexOf(locale) === index);
};

/** i18next's `fallbackLng`: each locale's chain without itself, and en-US for anything else. */
export const fallbackLanguages = (): Record<string, string[]> => {
    const chains: Record<string, string[]> = { default: [SOURCE_LOCALE] };
    for (const locale of SUPPORTED_LOCALES) {
        chains[locale] = resolutionChain(locale).slice(1);
    }
    return chains;
};
