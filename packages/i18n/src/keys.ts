import { sha256Hex } from './sha256.js';

/**
 * What a dictionary's keys mean to i18next: nested objects flatten to
 * dotted keys, `_one`/`_other`… are plural forms of one key, and
 * `{{name}}` (or `{{value, number}}`) are its variables.
 */

/** A namespace's file: strings, nested. */
export interface Dictionary {
    [key: string]: string | Dictionary;
}

export const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;
export type PluralCategory = (typeof PLURAL_CATEGORIES)[number];

/** `key_one` → `{ base: 'key', category: 'one' }`, `key_ordinal_two` → ordinal; null for a plain key. */
export function pluralForm(key: string): { base: string; category: PluralCategory; ordinal: boolean } | null {
    const match = /^(.+?)(_ordinal)?_(zero|one|two|few|many|other)$/.exec(key);
    return match ? { base: match[1]!, ordinal: !!match[2], category: match[3] as PluralCategory } : null;
}

/** The dotted keys and their strings; throws on anything but a string or an object. */
export function flatten(dictionary: unknown, prefix = ''): Map<string, string> {
    const found = new Map<string, string>();
    if (typeof dictionary !== 'object' || dictionary === null || Array.isArray(dictionary)) {
        throw new Error(`${prefix || 'The file'} must be an object of strings.`);
    }
    for (const [key, value] of Object.entries(dictionary)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (typeof value === 'string') {
            found.set(path, value);
        } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            for (const [inner, text] of flatten(value, path)) {
                found.set(inner, text);
            }
        } else {
            throw new Error(`${path} must be a string or an object of strings.`);
        }
    }
    return found;
}

/** The variables a string interpolates (`{{name}}`, `{{- html}}`, `{{when, datetime}}`), sorted. */
export function variablesOf(text: string): string[] {
    const names = new Set<string>();
    for (const match of text.matchAll(/\{\{\s*(?:-\s*)?([^,}\s]+)\s*(?:,[^}]*)?\}\}/g)) {
        names.add(match[1]!);
    }
    return [...names].sort();
}

/**
 * The shape of a namespace's source: its keys (with their plural and
 * context suffixes) and each key's variables, hashed. Two builds with the
 * same keys and variables have the same `sourceHash`, whatever the
 * wording, so a client can tell whether a server's copy of a namespace
 * fits the code it runs (manifest.ts, `acceptsServerNamespace`).
 */
export function sourceHash(dictionary: Dictionary): string {
    const lines = [...flatten(dictionary)].map(([key, text]) => `${key}\t${variablesOf(text).join(',')}`).sort();
    return sha256Hex(lines.join('\n')).slice(0, 12);
}
