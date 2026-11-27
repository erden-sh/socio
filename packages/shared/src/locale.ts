/**
 * The one place that picks the locale for text the app sorts and formats.
 *
 * `APP_LOCALE` (en-US) is the default and the source language. The web
 * client sets the active locale to the UI's (`setActiveLocale`, called by
 * `@socio/i18n` when the language changes), so every helper here follows
 * the UI. A server-rendered page renders in the request's locale through a
 * reader scoped to that request (`scopeActiveLocale`), so it sorts and
 * formats the same way as the browser that hydrates it, whatever the
 * browser's or the server's own language (Node follows `LANG`; a Swedish
 * browser puts Ä after Z). Nothing else sets it, so the server's own text
 * stays en-US.
 *
 * A formatter made once at module load keeps the locale active then: make
 * it where it is used, or through these helpers at the call.
 *
 * Times are separate: `<LocalTime>` renders UTC on the server and the
 * reader's own words after hydration.
 */
export const APP_LOCALE = 'en-US';

let active = APP_LOCALE;
let scoped: (() => string | undefined) | undefined;

/** The UI's locale: the request's while a page renders on the server, else the one set last (en-US by default). */
export const activeLocale = (): string => scoped?.() ?? active;

/** Sets the UI's locale (the web client, when its language changes). */
export function setActiveLocale(locale: string) {
    active = locale;
}

/**
 * Reads the active locale from somewhere scoped to one request (the page
 * renderer's async context); undefined there means the default. Pass
 * undefined to remove it.
 */
export function scopeActiveLocale(read: (() => string | undefined) | undefined) {
    scoped = read;
}

/** One instance per locale: building an Intl object is slow, and the set of locales is small. */
const perLocale = <T>(make: (locale: string) => T) => {
    const made = new Map<string, T>();
    return (locale: string): T => {
        let found = made.get(locale);
        if (found === undefined) {
            found = make(locale);
            made.set(locale, found);
        }
        return found;
    };
};

const collator = perLocale((locale) => new Intl.Collator(locale));

/** Orders display text (names, titles) for `Array.prototype.sort`. */
export const compareText = (a: string, b: string) => collator(activeLocale()).compare(a, b);

/** Lower-cases text for matching a search, the same everywhere. */
export const lowerText = (text: string) => text.toLocaleLowerCase(activeLocale());

/** A number formatter in the active locale (`1,234.5` in en-US), or in `locale`. */
export const numberFormat = (options?: Intl.NumberFormatOptions, locale: string = activeLocale()) =>
    new Intl.NumberFormat(locale, options);

const plain = perLocale((locale) => numberFormat(undefined, locale));

/** A count or amount in the active locale: `12,345`. */
export const formatNumber = (value: number) => plain(activeLocale()).format(value);

/**
 * A date and time formatter in the active locale (`Oct 15, 3:04 PM` in
 * en-US), or in `locale`. In the reader's time zone: render it through
 * `<LocalTime>`.
 */
export const dateTimeFormat = (options?: Intl.DateTimeFormatOptions, locale: string = activeLocale()) =>
    new Intl.DateTimeFormat(locale, options);

/** A relative time formatter (`in 3 days`, `yesterday`) in the active locale, or in `locale`. */
export const relativeTimeFormat = (options?: Intl.RelativeTimeFormatOptions, locale: string = activeLocale()) =>
    new Intl.RelativeTimeFormat(locale, options);

/** A list formatter (`Ada, Alice, and Bob`) in the active locale, or in `locale`. */
export const listFormat = (options?: Intl.ListFormatOptions, locale: string = activeLocale()) =>
    new Intl.ListFormat(locale, options);

/** The plural rules (`one`, `few`, `other`…) of the active locale, or of `locale`. */
export const pluralRules = (options?: Intl.PluralRulesOptions, locale: string = activeLocale()) =>
    new Intl.PluralRules(locale, options);

/**
 * A language's name (`es-US` → `español (Estados Unidos)` in `es-US`,
 * `Spanish (United States)` in `en-US`), in `inLocale` (the active locale by
 * default); the tag itself where the engine can't name it.
 */
export function languageName(tag: string, inLocale: string = activeLocale()): string {
    try {
        return new Intl.DisplayNames([inLocale], { type: 'language' }).of(tag) ?? tag;
    } catch {
        return tag;
    }
}
