/**
 * A data space file path (moved from `src/server/dataspace/space.ts`,
 * which re-exports it): media and the data space both check paths with it.
 */
import { DataError } from './data-error.js';

const FILE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;

/** A file path in the data space: relative segments, no traversal. */
export function normalizePath(raw: string, folder = false) {
    const trimmed = raw.trim().replace(/^\/+/, '').replace(/\/+$/, '');
    if (!trimmed) {
        if (folder) {
            return '';
        }
        throw new DataError('Give a file path, e.g. reports/summary.md.');
    }
    const segments = trimmed.split('/');
    if (
        trimmed.length > 512 ||
        segments.length > 12 ||
        segments.some((segment) => !FILE_SEGMENT.test(segment) || /^\.+$/.test(segment))
    ) {
        throw new DataError('Use a relative path of letters, digits, spaces, . _ and - (no .. or empty parts).');
    }
    return folder ? `${segments.join('/')}/` : segments.join('/');
}
