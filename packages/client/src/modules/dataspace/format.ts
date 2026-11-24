import type { CellValue } from '@socio/shared/data-types';

/** 1.2 MB, 340 KB, 12 B. */
export function formatBytes(bytes: number) {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${Math.round(bytes / 102.4) / 10} KB`;
    }
    if (bytes < 1024 ** 3) {
        return `${Math.round(bytes / 104857.6) / 10} MB`;
    }
    return `${Math.round(bytes / 107374182.4) / 10} GB`;
}

/** A cell as the table browser shows it. */
export function formatCell(value: CellValue) {
    if (value === null) {
        return '';
    }
    if (typeof value === 'object') {
        return `BLOB (${Math.floor((value.$blob.length * 3) / 4)} bytes)`;
    }
    return String(value);
}

export const formatTime = (at: number) =>
    new Date(at).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
    });

/** Native selects; `data-slot` keeps the legacy element styles off them. */
export const fieldClass = 'h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs dark:bg-input/30';
