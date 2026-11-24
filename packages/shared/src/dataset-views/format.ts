/**
 * One cell as text (CB-451): a raw value formatted by its
 * field's kind and settings, in the viewer's locale and zone. Rows carry
 * raw values only (person ids, file ids, option ids, numbers, ISO dates),
 * so the web and Socio Mobile format them here, the same way.
 *
 * - Numbers by `decimals` and `unit`; currencies by ISO 4217 code,
 *   integers in minor units divided by the currency's digits; percents
 *   stored as fractions.
 * - A `date` is a calendar day, shown without a zone. A `datetime` is an
 *   instant shown in the viewer's zone: an integer is ms since the epoch,
 *   text with an offset is that instant, and text without one is UTC, as
 *   SQLite writes it (`datetime('now')`).
 * - Options by label ("Unknown option" for an id the field no longer has),
 *   people by name from the page's `users` map, files by name from `files`
 *   ("File not available" outside the dataset's attachments).
 * - An unknown kind through the field's `fallback`; `hidden`
 *   and blobs show nothing.
 *
 * Text from `Intl` may differ in its spaces between engines (ICU puts a
 * narrow no-break space before "PM"); compare with `sameText`.
 */
import { APP_LOCALE } from '../locale.js';

import type { Cell, FieldDisplay, ViewFile, ViewUser } from './contract.js';
import { fieldShowsAs } from './fallback.js';

export const UNKNOWN_OPTION = 'Unknown option';
export const UNKNOWN_PERSON = 'Unknown person';
export const FILE_NOT_AVAILABLE = 'File not available';

export interface FormatContext {
    /** A BCP 47 locale; the app's (`en-US`) by default. */
    locale?: string;
    /** The viewer's IANA zone, for `datetime` values. */
    timeZone: string;
    users?: Record<string, ViewUser>;
    files?: Record<string, ViewFile>;
}

type FormatField = Pick<FieldDisplay, 'kind' | 'fallback' | 'settings'>;

const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();
const numbers = (locale: string, options: Intl.NumberFormatOptions) => {
    const key = `${locale}|${JSON.stringify(options)}`;
    let format = numberFormats.get(key);
    if (!format) {
        format = new Intl.NumberFormat(locale, options);
        numberFormats.set(key, format);
    }
    return format;
};
const dates = (locale: string, options: Intl.DateTimeFormatOptions) => {
    const key = `${locale}|${JSON.stringify(options)}`;
    let format = dateFormats.get(key);
    if (!format) {
        format = new Intl.DateTimeFormat(locale, options);
        dateFormats.set(key, format);
    }
    return format;
};

const isEmpty = (value: unknown) =>
    value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
const isBlob = (value: unknown) =>
    !!value && typeof value === 'object' && (value as { $blob?: unknown }).$blob === true;

/** A list cell's items: an array, or JSON text of one (a `multi_select` stored as `TEXT`). */
export function cellItems(value: unknown): Array<string | number> {
    if (Array.isArray(value)) {
        return value.filter((v): v is string | number => typeof v === 'string' || typeof v === 'number');
    }
    if (typeof value === 'string') {
        if (value.trimStart().startsWith('[')) {
            try {
                const parsed: unknown = JSON.parse(value);
                if (Array.isArray(parsed)) {
                    return cellItems(parsed);
                }
            } catch {
                // Not JSON: one item.
            }
        }
        return value ? [value] : [];
    }
    return typeof value === 'number' ? [value] : [];
}

/** The largest distance from the epoch a JavaScript date holds, in ms. */
const MAX_DATE_MS = 8.64e15;
const inDateRange = (ms: number) => Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS;

/**
 * A stored date and time: `YYYY-MM-DD`, or `YYYY-MM-DD[T ]HH:MM`
 * with optional seconds and fraction and an optional `Z`, `+HH:MM` or
 * `+HHMM`. Spaces around it are ignored; anything else is no instant.
 */
const STORED_DATETIME = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)([Zz]|[+-]\d{2}:?\d{2})?)?$/;

/**
 * The instant a `datetime` value names, in ms; undefined when it names
 * none a date can hold. A number is ms since the epoch; a stored text
 * without an offset is UTC. The compiler reads cells the same way
 * (`src/server/dataspace/query-spec/sqlite.ts`, `instantOf`).
 */
export function cellInstant(value: unknown): number | undefined {
    if (typeof value === 'number') {
        return inDateRange(value) ? value : undefined;
    }
    if (typeof value !== 'string') {
        return undefined;
    }
    const match = STORED_DATETIME.exec(value.trim());
    if (!match) {
        return undefined;
    }
    const [, day, time, zone] = match;
    if (time === undefined) {
        const at = Date.parse(`${day}T00:00:00Z`);
        return inDateRange(at) ? at : undefined;
    }
    const offset =
        zone === undefined || zone === 'Z' || zone === 'z'
            ? 'Z'
            : zone.length === 5
              ? `${zone.slice(0, 3)}:${zone.slice(3)}`
              : zone;
    const at = Date.parse(`${day}T${time}${offset}`);
    return inDateRange(at) ? at : undefined;
}

/** A `date` value's calendar day (`YYYY-MM-DD`); undefined when it isn't one. */
export function cellDay(value: unknown): string | undefined {
    if (typeof value === 'number') {
        return inDateRange(value) ? new Date(value).toISOString().slice(0, 10) : undefined;
    }
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) {
        return undefined;
    }
    const day = value.slice(0, 10);
    const [y, m, d] = day.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? day : undefined;
}

/** A JSON number, the only text a number field reads as a number. */
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/**
 * A number field's value as a number: a number, or text that is a
 * JSON number with optional spaces around it (`" 12.5"`), as the
 * compiler reads it; anything else (`"abc"`, `"0x10"`, `""`) is none.
 */
export function cellNumber(value: unknown): number | undefined {
    if (typeof value === 'number') {
        return Number.isNaN(value) ? undefined : value;
    }
    if (typeof value !== 'string') {
        return undefined;
    }
    const text = value.replace(/^ +| +$/g, '');
    return JSON_NUMBER.test(text) ? Number(text) : undefined;
}

/** Whether a checkbox value is checked: `true`, `1`, `"1"` or `"true"`. */
export const isChecked = (value: unknown) => value === true || value === 1 || value === '1' || value === 'true';

function formatNumber(value: number, field: FormatField, locale: string): string {
    const s = field.settings;
    const digits =
        s.decimals !== undefined ? { minimumFractionDigits: s.decimals, maximumFractionDigits: s.decimals } : {};
    const text = numbers(locale, digits).format(value);
    return s.unit ? `${text} ${s.unit}` : text;
}

function formatCurrency(value: number, field: FormatField, locale: string): string {
    const s = field.settings;
    if (!s.currency) {
        return formatNumber(value, field, locale);
    }
    let format: Intl.NumberFormat;
    try {
        format = numbers(locale, { style: 'currency', currency: s.currency });
    } catch {
        return `${formatNumber(value, field, locale)} ${s.currency}`;
    }
    const minor = format.resolvedOptions().maximumFractionDigits ?? 2;
    const amount = s.minorUnits ? value / 10 ** minor : value;
    if (s.decimals === undefined) {
        return format.format(amount);
    }
    return numbers(locale, {
        style: 'currency',
        currency: s.currency,
        minimumFractionDigits: s.decimals,
        maximumFractionDigits: s.decimals,
    }).format(amount);
}

function formatDay(value: unknown, locale: string): string {
    const day = cellDay(value);
    if (!day) {
        return String(value);
    }
    return dates(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(Date.parse(`${day}T00:00:00Z`));
}

function formatInstant(value: unknown, field: FormatField, ctx: FormatContext, locale: string): string {
    const at = cellInstant(value);
    if (at === undefined) {
        return String(value);
    }
    // A date-only text in a datetime column is a day, not midnight UTC somewhere else.
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
        return formatDay(value, locale);
    }
    const options: Intl.DateTimeFormatOptions =
        field.settings.dateFormat === 'date'
            ? { dateStyle: 'medium', timeZone: ctx.timeZone }
            : { dateStyle: 'medium', timeStyle: 'short', timeZone: ctx.timeZone };
    return dates(locale, options).format(at);
}

const json = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

/** A cell as the viewer reads it. An empty value is `''`, except an unchecked checkbox, which is "No". */
export function formatCell(value: Cell | unknown, field: FormatField, ctx: FormatContext): string {
    const locale = ctx.locale ?? APP_LOCALE;
    const shows = fieldShowsAs(field);
    if (isBlob(value)) {
        return '';
    }
    if (!shows.known) {
        if (isEmpty(value) || shows.fallback === 'hidden') {
            return '';
        }
        if (shows.fallback === 'number' && typeof value === 'number') {
            return formatNumber(value, field, locale);
        }
        return shows.fallback === 'json' ? json(value) : typeof value === 'string' ? value : JSON.stringify(value);
    }
    if (shows.kind === 'checkbox') {
        return isChecked(value) ? 'Yes' : 'No';
    }
    if (isEmpty(value)) {
        return '';
    }
    switch (shows.kind) {
        case 'number':
            return typeof value === 'number' ? formatNumber(value, field, locale) : String(value);
        case 'currency':
            return typeof value === 'number' ? formatCurrency(value, field, locale) : String(value);
        case 'percent': {
            if (typeof value !== 'number') {
                return String(value);
            }
            const d = field.settings.decimals;
            return numbers(
                locale,
                d !== undefined
                    ? { style: 'percent', minimumFractionDigits: d, maximumFractionDigits: d }
                    : { style: 'percent' },
            ).format(value);
        }
        case 'date':
            return formatDay(value, locale);
        case 'datetime':
            return formatInstant(value, field, ctx, locale);
        case 'select': {
            const options = field.settings.options ?? [];
            return options.find((o) => o.id === value)?.label ?? UNKNOWN_OPTION;
        }
        case 'multi_select': {
            const options = field.settings.options ?? [];
            return cellItems(value)
                .map((id) => options.find((o) => o.id === id)?.label ?? UNKNOWN_OPTION)
                .join(', ');
        }
        case 'person':
        case 'people':
            return cellItems(value)
                .map((id) => ctx.users?.[String(id)]?.name ?? UNKNOWN_PERSON)
                .join(', ');
        case 'file':
            return cellItems(value)
                .map((id) => ctx.files?.[String(id)]?.name ?? FILE_NOT_AVAILABLE)
                .join(', ');
        case 'json':
            return json(value);
        case 'blob':
            return '';
        default:
            // Text kinds and keys.
            return Array.isArray(value)
                ? value.join(', ')
                : typeof value === 'object'
                  ? JSON.stringify(value)
                  : String(value);
    }
}

/** Whether two formatted texts read the same, whatever spaces an engine's `Intl` put in them. */
export const sameText = (a: string, b: string) => a.replace(/\s/gu, ' ') === b.replace(/\s/gu, ' ');
