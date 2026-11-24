import type { AttachmentKind } from '@socio/shared/media-types';
import { hasMarkup, sniffType, textOf } from '@socio/shared/media/file-types';

import { MODEL_IMAGE_TYPES } from './contract.js';

// Text by extension; code is text/x-<language>, anything else text/plain.
const TEXT_TYPES: Record<string, string> = {
    md: 'text/markdown',
    markdown: 'text/markdown',
    csv: 'text/csv',
    tsv: 'text/tab-separated-values',
    json: 'application/json',
    ndjson: 'application/x-ndjson',
    xml: 'application/xml',
    html: 'text/html',
    htm: 'text/html',
    yaml: 'text/yaml',
    yml: 'text/yaml',
};
const CODE: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    c: 'c',
    h: 'c',
    cc: 'c++',
    cpp: 'c++',
    hpp: 'c++',
    cs: 'csharp',
    php: 'php',
    sh: 'shellscript',
    bash: 'shellscript',
    zsh: 'shellscript',
    sql: 'sql',
    css: 'css',
    scss: 'scss',
    lua: 'lua',
    toml: 'toml',
    ini: 'ini',
};
const SAFE_TYPE = /^[a-z]+\/[a-z0-9.+-]+$/;

const extensionOf = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '');

/**
 * What an uploaded file is, from its bytes first: a model image (kind
 * `image`), strict UTF-8 text (kind `text`, its type from the extension),
 * else kind `file` with the declared type when it looks like one. Any file
 * is accepted for storage; only serving is restricted (`servedAs`).
 */
export function classify(
    name: string,
    declared: string | undefined,
    data: Uint8Array,
): { mediaType: string; kind: AttachmentKind } {
    const sniffed = sniffType(data);
    if (sniffed && MODEL_IMAGE_TYPES.has(sniffed)) {
        return { mediaType: sniffed, kind: 'image' };
    }
    if (sniffed) {
        return { mediaType: sniffed, kind: 'file' };
    }
    const extension = extensionOf(name);
    // SVG is text, but an image a browser runs: always a plain file.
    if (extension !== 'svg' && textOf(data) !== undefined) {
        return {
            mediaType: TEXT_TYPES[extension] ?? (CODE[extension] ? `text/x-${CODE[extension]}` : 'text/plain'),
            kind: 'text',
        };
    }
    const claimed = declared?.split(';')[0].trim().toLowerCase() ?? '';
    // A declared model image or PDF that the bytes don't bear out is just bytes.
    return {
        mediaType:
            SAFE_TYPE.test(claimed) && !MODEL_IMAGE_TYPES.has(claimed) && claimed !== 'application/pdf'
                ? claimed
                : extension === 'svg'
                  ? 'image/svg+xml'
                  : 'application/octet-stream',
        kind: 'file',
    };
}

/**
 * How stored bytes are served: raster images inline with their sniffed
 * type, text without markup inline as plain text, everything else (SVG,
 * HTML and XML included) as a download of opaque bytes.
 */
export function servedAs(data: Uint8Array): {
    contentType: string;
    inline: boolean;
} {
    const sniffed = sniffType(data);
    if (sniffed && MODEL_IMAGE_TYPES.has(sniffed)) {
        return { contentType: sniffed, inline: true };
    }
    const text = sniffed ? undefined : textOf(data);
    if (text !== undefined && !hasMarkup(text)) {
        return { contentType: 'text/plain; charset=utf-8', inline: true };
    }
    return { contentType: 'application/octet-stream', inline: false };
}

/** The Media page's kinds: PDFs apart from other files. */
export const itemKind = (kind: AttachmentKind, mediaType: string) =>
    kind === 'file' && mediaType === 'application/pdf' ? 'pdf' : kind;

const MAX_SAFE = 100;

/**
 * A file name as a data space path segment (`FILE_SEGMENT`): diacritics
 * dropped, other characters outside `[A-Za-z0-9._ -]` as `-`, starting
 * with a letter or digit, at most 100 characters with the extension kept;
 * `file` when nothing is left. The original name is kept apart.
 */
export function safeName(name: string) {
    const ascii = name
        .split(/[\\/]/)
        .pop()!
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .replace(/[^A-Za-z0-9._ -]/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^[^A-Za-z0-9]+/, '')
        .trim();
    if (!ascii || /^\.+$/.test(ascii)) {
        return 'file';
    }
    if (ascii.length <= MAX_SAFE) {
        return ascii;
    }
    const dot = ascii.lastIndexOf('.');
    const extension = dot > 0 && ascii.length - dot <= 16 ? ascii.slice(dot) : '';
    return ascii.slice(0, MAX_SAFE - extension.length).replace(/[ .-]+$/, '') + extension;
}

/** `name` with `-<suffix>` before its extension: `shot.png` → `shot-2.png`. */
export function suffixed(name: string, suffix: string) {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? `${name.slice(0, dot)}-${suffix}${name.slice(dot)}` : `${name}-${suffix}`;
}
