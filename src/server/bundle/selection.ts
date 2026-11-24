/**
 * What an export takes (CB-380): explicit lists of issue numbers, Space ids
 * and page ids, and the Spaces it must never read (the deny-list).
 */
import { readFileSync } from 'node:fs';

import { BundleError } from './files.js';

/** What an export copies. `issues: 'all'` is every live issue. */
export interface BundleSelection {
    issues: 'all' | number[];
    spaces: string[];
    pages: string[];
}

const ID = /^[A-Za-z0-9_:.-]{1,200}$/;
const MAX_NUMBER = 999_999_999;

/** The entries of a list: commas and newlines split it; `@path` reads a file (# starts a comment). */
function entries(value: string, read: (path: string) => string): string[] {
    return value
        .split(',')
        .flatMap((part) => {
            const trimmed = part.trim();
            return trimmed.startsWith('@') ? read(trimmed.slice(1)).split('\n') : [trimmed];
        })
        .map((line) => line.replace(/#.*$/, '').trim())
        .filter(Boolean);
}

const readList = (path: string) => readFileSync(path, 'utf8');

/**
 * `--issues`: `all`, or numbers and ranges (`12,15-18`, `CB-12` too), or
 * `@file` with one per line. Sorted, each once.
 */
export function parseIssueList(value: string | undefined, read = readList): 'all' | number[] {
    if (!value) {
        return [];
    }
    if (value.trim() === 'all') {
        return 'all';
    }
    const out = new Set<number>();
    for (const entry of entries(value, read)) {
        const match = /^(?:[A-Z]+-)?(\d+)(?:\s*-\s*(?:[A-Z]+-)?(\d+))?$/i.exec(entry);
        if (!match) {
            throw new BundleError(`Not an issue number or range: ${entry.slice(0, 40)}`);
        }
        const from = Number(match[1]);
        const to = match[2] ? Number(match[2]) : from;
        if (from < 1 || to < from || to > MAX_NUMBER || to - from > 100_000) {
            throw new BundleError(`Not a usable range: ${entry.slice(0, 40)}`);
        }
        for (let n = from; n <= to; n++) {
            out.add(n);
        }
    }
    return [...out].sort((a, b) => a - b);
}

/** `--spaces`, `--pages`, `--deny-space`: ids, comma-separated or `@file`, each once. */
export function parseIdList(values: readonly string[] | string | undefined, read = readList): string[] {
    const list = typeof values === 'string' ? [values] : (values ?? []);
    const out = new Set<string>();
    for (const value of list) {
        for (const entry of entries(value, read)) {
            if (!ID.test(entry)) {
                throw new BundleError(`Not an id: ${entry.slice(0, 40)}`);
            }
            out.add(entry);
        }
    }
    return [...out];
}

/**
 * The Spaces an export must never read: `--deny-space` and
 * `BUNDLE_DENY_SPACES`, together. Required: an export with none refuses
 * unless `--no-deny-list` says so on purpose.
 */
export function denyList(
    flags: readonly string[] | undefined,
    env: string | undefined,
    none: boolean,
    read = readList,
): Set<string> {
    const ids = new Set([...parseIdList(flags, read), ...parseIdList(env ? [env] : [], read)]);
    if (!ids.size && !none) {
        throw new BundleError(
            'Name the Spaces an export must never read: --deny-space <id> (repeatable, or @file) or BUNDLE_DENY_SPACES. Use --no-deny-list only if there are none.',
        );
    }
    if (ids.size && none) {
        throw new BundleError('--no-deny-list was given with a deny-list. Use one or the other.');
    }
    return ids;
}

/** An origin as https://host, from a URL or APP_ORIGIN (its first entry). */
export function originOf(value: string | undefined) {
    const first = value?.split(',')[0]?.trim();
    if (!first) {
        throw new BundleError('Name the source’s origin: --origin https://host (or set APP_ORIGIN).');
    }
    const url = new URL(first);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new BundleError('The origin must be an http(s) URL.');
    }
    return `${url.protocol}//${url.host}`;
}
