import type { FormatterModule } from 'i18next';

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

/**
 * Splits `number(minimumFractionDigits: 2)` into its name and options the
 * way i18next 27 does: `currency(EUR)` and `relativetime(hour)` take a bare
 * value, `true`, `false` and numbers are read as such.
 */
export function parseFormat(text: string): { name: string; options: Options } {
    const open = text.indexOf('(');
    if (open === -1) {
        return { name: text.toLowerCase().trim(), options: {} };
    }
    const name = text.slice(0, open).toLowerCase().trim();
    const body = text
        .slice(open + 1)
        .split('(')[0]!
        .slice(0, -1);
    const options: Options = {};
    if (!body.includes(':') && (name === 'currency' || name === 'relativetime')) {
        options[name === 'currency' ? 'currency' : 'range'] = body.trim();
        return { name, options };
    }
    for (const pair of body.split(';')) {
        if (!pair) {
            continue;
        }
        const [rawKey = '', ...rest] = pair.split(':');
        const key = rawKey.trim();
        const value = rest
            .join(':')
            .trim()
            .replace(/^'+|'+$/g, '');
        if (value === 'true' || value === 'false') {
            options[key] = value === 'true';
        } else if (!Number.isNaN(Number(value))) {
            options[key] = Number.parseInt(value, 10);
        } else if (!options[key]) {
            options[key] = value;
        }
    }
    return { name, options };
}

type Format = (value: unknown, locale: string, options: Options) => string;

/**
 * i18next's formatter module with Socio's formatters. i18next's own one
 * hands a formatter the format string's options merged with every
 * variable of the `t()` call, so `t('x', { n: 5, unit: 'files' })` gave
 * `{{n, number}}` a `unit` it never asked for. This one gives a formatter
 * only the format string's options and the call's `formatParams` for that
 * variable (i18next's way to set them per call). The locale is picked as
 * i18next picks it.
 */
export function createFormatter(): FormatterModule {
    const formats = new Map<string, Format>(Object.entries(FORMATTERS));
    let separator = ',';
    let warn: (message: unknown) => void = () => {};
    return {
        type: 'formatter',
        init(services, options) {
            separator = options.interpolation?.formatSeparator || ',';
            const logger = services.logger?.create?.('formatter');
            if (logger) {
                warn = (message) => logger.warn(message);
            }
        },
        add(name, format) {
            formats.set(name.toLowerCase().trim(), (value, locale, options) => format(value, locale, options));
        },
        addCached(name, make) {
            formats.set(name.toLowerCase().trim(), (value, locale, options) => make(locale, options)(value));
        },
        format(value, format, lng, call = {}) {
            if (!format || value == null) {
                return value;
            }
            // A separator inside a format's parentheses belongs to that format.
            const raw = format.split(separator);
            const names: string[] = [];
            for (let index = 0; index < raw.length; index++) {
                let part = raw[index]!;
                while (part.includes('(') && !part.includes(')') && index + 1 < raw.length) {
                    part = `${part}${separator}${raw[++index]}`;
                }
                names.push(part);
            }
            const params = (call as Options).formatParams as Record<string, Options> | undefined;
            const perCall = params?.[(call as Options).interpolationkey as string] ?? {};
            const locale = (perCall.locale ??
                perCall.lng ??
                (call as Options).locale ??
                (call as Options).lng ??
                lng ??
                'en-US') as string;
            return names.reduce((text, part) => {
                const { name, options } = parseFormat(part);
                const run = formats.get(name);
                if (!run) {
                    warn(`there was no format function for ${name}`);
                    return text;
                }
                try {
                    return run(text, locale, { ...options, ...perCall });
                } catch (error) {
                    warn(error);
                    return text;
                }
            }, value);
        },
    };
}
