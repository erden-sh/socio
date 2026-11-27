import { SOURCE_LOCALE, isSupportedLocale, localeInfo, type SupportedLocale } from './registry.js';

/**
 * Each locale's language, named in English for the model: a fixed table,
 * not `Intl.DisplayNames`, whose words can change with the runtime's ICU
 * data, so a locale's line is the same, byte for byte, on every server.
 * A new locale in `LOCALES` needs its name here (the type says so).
 */
export const LANGUAGE_NAMES = {
    'en-US': 'English',
    'es-419': 'Spanish',
    'es-US': 'Spanish',
    'pt-BR': 'Portuguese',
    'en-XA': 'English',
} as const satisfies Record<SupportedLocale, string>;

/**
 * The line a socio's turn note gets for a person's app language
 * (`user_preferences.locale`): reply in it unless they write in another
 * language or ask otherwise. None for no preference, en-US, the
 * pseudo-locale or a tag that isn't registered, so the note of a person
 * who never chose a language stays as it was, byte for byte. The caller
 * leaves it out when the note already gives the person's profile with a
 * language, which wins.
 */
export function replyLanguageLine(locale: string | null | undefined): string | undefined {
    if (!isSupportedLocale(locale) || locale === SOURCE_LOCALE || localeInfo(locale).pseudo) {
        return undefined;
    }
    return `Language: reply in ${LANGUAGE_NAMES[locale]} (${locale}, the person's app language) unless they write in another language or ask otherwise.`;
}
