/**
 * The one place that picks the locale for text the app sorts and formats.
 *
 * There is no i18n yet, so it is `en-US` on the server and in every
 * browser. A server-rendered page then sorts and formats the same way as
 * the browser that hydrates it, whatever the browser's or the server's
 * own language (Node follows `LANG`; a Swedish browser puts Ä after Z).
 * When i18n arrives, this module switches to the session's locale,
 * falling back to the user's.
 *
 * Times are separate: `<LocalTime>` renders UTC on the server and the
 * reader's own words after hydration.
 */
export const APP_LOCALE = 'en-US';

const collator = new Intl.Collator(APP_LOCALE);

/** Orders display text (names, titles) for `Array.prototype.sort`. */
export const compareText = (a: string, b: string) => collator.compare(a, b);

/** Lower-cases text for matching a search, the same everywhere. */
export const lowerText = (text: string) => text.toLocaleLowerCase(APP_LOCALE);

/** A number formatter in the app's locale (`1,234.5`). */
export const numberFormat = (options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(APP_LOCALE, options);

const plain = numberFormat();

/** A count or amount in the app's locale: `12,345`. */
export const formatNumber = (value: number) => plain.format(value);

/**
 * A date and time formatter in the app's locale (`Oct 15, 3:04 PM`). In
 * the reader's time zone: render it through `<LocalTime>`.
 */
export const dateTimeFormat = (options?: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(APP_LOCALE, options);
