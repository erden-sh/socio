import type { i18n } from 'i18next';

import { dateTimeFormat, listFormat, numberFormat, relativeTimeFormat } from '@socio/shared/locale';

/**
 * The formatters a string names after its variable: `{{n, number}}`,
 * `{{price, currency(currency: EUR)}}`, `{{when, datetime(dateStyle: medium)}}`,
 * `{{days, relativetime(range: day)}}`, `{{names, list}}`, `{{size, bytes}}`
 * and `{{ms, duration}}`. They build their Intl objects through
 * `@socio/shared/locale`, in the string's locale, so the `socio/locale`
 * lint rule keeps meaning something. Every Intl constructor and option
 * used is listed in docs/I18N.md, for the native app's engine.
 */
type Options = Record<string, unknown>;

const pick = (options: Options, names: readonly string[]) =>
    Object.fromEntries(names.filter((name) => options[name] !== undefined).map((name) => [name, options[name]]));

const NUMBER_OPTIONS = [
    'style',
    'currency',
    'currencyDisplay',
    'unit',
    'unitDisplay',
    'notation',
    'compactDisplay',
    'signDisplay',
    'minimumIntegerDigits',
    'minimumFractionDigits',
    'maximumFractionDigits',
    'minimumSignificantDigits',
    'maximumSignificantDigits',
    'useGrouping',
] as const;
const DATE_OPTIONS = [
    'dateStyle',
    'timeStyle',
    'timeZone',
    'hour12',
    'weekday',
    'era',
    'year',
    'month',
    'day',
    'hour',
    'minute',
    'second',
    'timeZoneName',
] as const;

const toDate = (value: unknown) => (value instanceof Date ? value : new Date(value as string | number));

/** `1.2 MB`: decimal units (1 kB is 1,000 bytes), one decimal from kB up. */
export function formatBytes(bytes: number, locale: string): string {
    const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;
    let value = Math.abs(bytes);
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000;
        unit++;
    }
    return numberFormat(
        {
            style: 'unit',
            unit: units[unit],
            unitDisplay: 'short',
            maximumFractionDigits: unit === 0 ? 0 : 1,
        },
        locale,
    ).format(Math.sign(bytes) * value);
}

/** `1 hr, 5 min` from milliseconds: hours, minutes and seconds, the zero ones left out. */
export function formatDuration(ms: number, locale: string): string {
    const total = Math.round(Math.abs(ms) / 1000);
    const parts = (
        [
            ['hour', Math.floor(total / 3600)],
            ['minute', Math.floor((total % 3600) / 60)],
            ['second', total % 60],
        ] as const
    ).filter(([, amount], index, all) => amount > 0 || (index === all.length - 1 && total === 0));
    const words = parts.map(([unit, amount]) =>
        numberFormat({ style: 'unit', unit, unitDisplay: 'short' }, locale).format(amount),
    );
    return listFormat({ type: 'unit', style: 'short' }, locale).format(words);
}

/** The formatters, by name: `(value, locale, options) => text`. */
export const FORMATTERS: Record<string, (value: unknown, locale: string, options: Options) => string> = {
    number: (value, locale, options) => numberFormat(pick(options, NUMBER_OPTIONS), locale).format(value as number),
    currency: (value, locale, options) =>
        numberFormat({ ...pick(options, NUMBER_OPTIONS), style: 'currency' }, locale).format(value as number),
    datetime: (value, locale, options) => dateTimeFormat(pick(options, DATE_OPTIONS), locale).format(toDate(value)),
    relativetime: (value, locale, options) =>
        relativeTimeFormat(
            { numeric: (options.numeric as 'auto' | 'always') ?? 'auto', style: (options.style as 'long') ?? 'long' },
            locale,
        ).format(value as number, (options.range as Intl.RelativeTimeFormatUnit) ?? 'day'),
    list: (value, locale, options) =>
        listFormat(
            {
                type: (options.type as Intl.ListFormatType) ?? 'conjunction',
                style: (options.style as Intl.ListFormatStyle) ?? 'long',
            },
            locale,
        ).format(value as string[]),
    bytes: (value, locale) => formatBytes(value as number, locale),
    duration: (value, locale) => formatDuration(value as number, locale),
};

/** Puts the formatters on an initialized instance, over i18next's own. */
export function addFormatters(instance: i18n) {
    const formatter = instance.services.formatter;
    if (!formatter) {
        return;
    }
    for (const [name, format] of Object.entries(FORMATTERS)) {
        formatter.add(name, (value, locale, options) => format(value, locale ?? 'en-US', options as Options));
    }
}
