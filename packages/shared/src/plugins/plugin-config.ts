/**
 * Typed plugin settings (CB-395): what a manifest's `config` entry may
 * declare, and the one check the settings form and the server share.
 * Values stay strings (the plugin reads them from `PLUGIN_CONFIG`); a type
 * says how to show and check one. A field without a type is a string, as
 * every field was before. This is about usability, not secrecy: credentials
 * belong in the manifest's `secrets`.
 */
export const PLUGIN_CONFIG_TYPES = ['string', 'boolean', 'number', 'integer', 'enum', 'cron', 'url'] as const;
export type PluginConfigType = (typeof PLUGIN_CONFIG_TYPES)[number];

export interface PluginConfigField {
    description: string;
    default?: string;
    /** How the value is shown and checked; `string` when absent. */
    type?: PluginConfigType;
    /** The choices of an `enum`, in order. */
    options?: string[];
    /** An empty value is refused. */
    required?: boolean;
    /** The least and the most a `number` or `integer` may be. */
    min?: number;
    max?: number;
    /** A regular expression a `string` must match in full. */
    pattern?: string;
}

/** The most characters a value may have. */
export const PLUGIN_CONFIG_VALUE_MAX = 2000;

export const configType = (field: Pick<PluginConfigField, 'type'>): PluginConfigType => field.type ?? 'string';

/** The value a field starts at when nothing is saved: its default, else empty (off for a switch). */
export const BOOLEAN_VALUES = ['true', 'false'] as const;

const CRON_MACROS = new Set(['@yearly', '@annually', '@monthly', '@weekly', '@daily', '@midnight', '@hourly']);
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function cronPart(part: string, min: number, max: number, names?: string[]): boolean {
    const value = (text: string) => {
        const named = names?.indexOf(text.toLowerCase()) ?? -1;
        if (named >= 0) {
            return named + min;
        }
        return /^\d{1,2}$/.test(text) ? Number(text) : NaN;
    };
    return part.split(',').every((item) => {
        const [range, step, extra] = item.split('/');
        if (extra !== undefined || range === undefined || range === '') {
            return false;
        }
        if (step !== undefined && !/^[1-9]\d{0,1}$/.test(step)) {
            return false;
        }
        if (range === '*') {
            return true;
        }
        const [from, to, more] = range.split('-');
        if (more !== undefined) {
            return false;
        }
        const start = value(from!);
        const end = to === undefined ? start : value(to);
        // Sunday may be 7 as well as 0.
        const top = names === WEEKDAYS ? 7 : max;
        return start >= min && start <= top && end >= start && end <= top;
    });
}

/**
 * A cron expression: five fields (minute hour day-of-month month
 * day-of-week), or six with seconds first, or one of `@hourly`, `@daily`,
 * `@weekly`, `@monthly`, `@yearly`, `@annually`, `@midnight`. Lists, ranges,
 * steps and month and weekday names (`jan`, `mon`) are allowed.
 */
export function validCron(text: string): boolean {
    const trimmed = text.trim();
    if (CRON_MACROS.has(trimmed.toLowerCase())) {
        return true;
    }
    const fields = trimmed.split(/\s+/);
    if (fields.length !== 5 && fields.length !== 6) {
        return false;
    }
    const parts = fields.length === 6 ? fields : ['0', ...fields];
    return (
        cronPart(parts[0]!, 0, 59) &&
        cronPart(parts[1]!, 0, 59) &&
        cronPart(parts[2]!, 0, 23) &&
        cronPart(parts[3]!, 1, 31) &&
        cronPart(parts[4]!, 1, 12, MONTHS) &&
        cronPart(parts[5]!, 0, 6, WEEKDAYS)
    );
}

/** An absolute http or https URL. */
export function validUrl(text: string): boolean {
    try {
        const url = new URL(text);
        return (url.protocol === 'https:' || url.protocol === 'http:') && !!url.hostname;
    } catch {
        return false;
    }
}

const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/**
 * Why `value` doesn't fit `field`, in a sentence, or undefined when it
 * does. `value` is what is stored: trimmed, and empty when unset (the plugin
 * then uses its default). The settings form shows this under the field and
 * the server refuses a save with it.
 */
export function configValueError(field: PluginConfigField, value: string): string | undefined {
    if (value.length > PLUGIN_CONFIG_VALUE_MAX) {
        return `Use at most ${PLUGIN_CONFIG_VALUE_MAX} characters.`;
    }
    if (value === '') {
        return field.required && !field.default ? 'This setting is required.' : undefined;
    }
    switch (configType(field)) {
        case 'boolean':
            return value === 'true' || value === 'false' ? undefined : 'Use true or false.';
        case 'number':
        case 'integer': {
            const integer = configType(field) === 'integer';
            if (!NUMBER.test(value) || !Number.isFinite(Number(value))) {
                return integer ? 'Enter a whole number.' : 'Enter a number.';
            }
            const number = Number(value);
            if (integer && !Number.isInteger(number)) {
                return 'Enter a whole number.';
            }
            if (field.min !== undefined && number < field.min) {
                return field.max !== undefined
                    ? `Use a number from ${field.min} to ${field.max}.`
                    : `Use ${field.min} or more.`;
            }
            if (field.max !== undefined && number > field.max) {
                return field.min !== undefined
                    ? `Use a number from ${field.min} to ${field.max}.`
                    : `Use ${field.max} or less.`;
            }
            return undefined;
        }
        case 'enum':
            return field.options?.includes(value) ? undefined : `Choose one of: ${(field.options ?? []).join(', ')}.`;
        case 'cron':
            return validCron(value)
                ? undefined
                : 'Enter a cron expression, such as 0 9 * * 1-5 (minute hour day month weekday).';
        case 'url':
            return validUrl(value) ? undefined : 'Enter a full http or https address, such as https://example.com.';
        case 'string':
            if (field.pattern !== undefined && !fullMatch(field.pattern, value)) {
                return 'This value doesn’t have the expected format.';
            }
            return undefined;
    }
}

function fullMatch(pattern: string, value: string) {
    try {
        return new RegExp(`^(?:${pattern})$`, 'u').test(value);
    } catch {
        return false;
    }
}

/** Each setting's error, by key, for a whole config; empty when all fit. */
export function configErrors(fields: Record<string, PluginConfigField>, config: Record<string, string>) {
    const errors: Record<string, string> = {};
    for (const [key, field] of Object.entries(fields)) {
        const problem = configValueError(field, config[key] ?? '');
        if (problem) {
            errors[key] = problem;
        }
    }
    return errors;
}

/**
 * What is wrong with a manifest's `config` entry, or undefined when it is
 * well formed (the catalog refuses the manifest with it).
 */
export function pluginConfigFieldError(field: Record<string, unknown>): string | undefined {
    if (typeof field.description !== 'string') {
        return 'description must be a string.';
    }
    if (field.default !== undefined && typeof field.default !== 'string') {
        return 'default must be a string (every value is stored as one).';
    }
    const type = field.type ?? 'string';
    if (!(PLUGIN_CONFIG_TYPES as readonly unknown[]).includes(type)) {
        return `type must be one of ${PLUGIN_CONFIG_TYPES.join(', ')}.`;
    }
    if (field.required !== undefined && typeof field.required !== 'boolean') {
        return 'required must be true or false.';
    }
    if (type === 'enum') {
        const options = field.options;
        if (
            !Array.isArray(options) ||
            options.length === 0 ||
            options.length > 100 ||
            !options.every(
                (option) =>
                    typeof option === 'string' && option !== '' && option.trim() === option && option.length <= 200,
            ) ||
            new Set(options).size !== options.length
        ) {
            return 'an enum lists its options: 1 to 100 distinct, non-empty strings.';
        }
    } else if (field.options !== undefined) {
        return 'options is for an enum only.';
    }
    const numeric = type === 'number' || type === 'integer';
    for (const bound of ['min', 'max'] as const) {
        if (field[bound] === undefined) {
            continue;
        }
        if (!numeric) {
            return `${bound} is for a number or an integer only.`;
        }
        if (typeof field[bound] !== 'number' || !Number.isFinite(field[bound])) {
            return `${bound} must be a number.`;
        }
    }
    if (typeof field.min === 'number' && typeof field.max === 'number' && field.min > field.max) {
        return 'min is above max.';
    }
    if (field.pattern !== undefined) {
        if (type !== 'string') {
            return 'pattern is for a string only.';
        }
        if (typeof field.pattern !== 'string' || field.pattern.length > 500) {
            return 'pattern must be a regular expression of at most 500 characters.';
        }
        try {
            new RegExp(field.pattern, 'u');
        } catch {
            return 'pattern is not a valid regular expression.';
        }
    }
    if (typeof field.default === 'string' && field.default !== '') {
        const problem = configValueError(field as unknown as PluginConfigField, field.default);
        if (problem) {
            return `default does not fit: ${problem}`;
        }
    }
    return undefined;
}
