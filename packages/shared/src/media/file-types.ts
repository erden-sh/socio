/**
 * What a file is, from its bytes: shared by issue attachments (which take
 * a few types) and chat attachments (which take any file and only decide
 * how to show and serve it). Moved from `issues/attachments.ts` (CB-54),
 * then from `src/server/media/file-types.ts`, which re-exports it. Pure and
 * browser-safe.
 */

/** Raster images a model can take, and PDFs: sniffed, never declared. */
export type SniffedType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'application/pdf';

// Markup a browser could render if it ever ignored the served type.
const MARKUP = /<\s*(?:!doctype|html|head|body|script|iframe|object|embed|svg|math|\?xml|meta|link|style)\b/i;

const starts = (data: Uint8Array, bytes: number[], offset = 0) =>
    data.length >= offset + bytes.length && bytes.every((byte, i) => data[offset + i] === byte);
const ascii = (value: string) => [...value].map((ch) => ch.charCodeAt(0));

/** The image or PDF type the first bytes say, if any. */
export function sniffType(data: Uint8Array): SniffedType | undefined {
    if (starts(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
        return 'image/png';
    }
    if (starts(data, [0xff, 0xd8, 0xff])) {
        return 'image/jpeg';
    }
    if (starts(data, ascii('GIF87a')) || starts(data, ascii('GIF89a'))) {
        return 'image/gif';
    }
    if (starts(data, ascii('RIFF')) && starts(data, ascii('WEBP'), 8)) {
        return 'image/webp';
    }
    if (starts(data, ascii('%PDF-'))) {
        return 'application/pdf';
    }
    return undefined;
}

/**
 * The text of strict UTF-8 without control characters (tab, newlines and
 * form feed aside), else undefined.
 */
export function textOf(data: Uint8Array): string | undefined {
    let decoded: string;
    try {
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
        return undefined;
    }
    // oxlint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(decoded)) {
        return undefined;
    }
    return decoded;
}

/** Text with HTML, SVG or XML markup in it. */
export const hasMarkup = (text: string) => MARKUP.test(text);

/**
 * The type of a file from its first bytes, for issue attachments: an
 * image, a PDF, or plain text without markup; undefined for anything else.
 */
export function detectType(data: Uint8Array): SniffedType | 'text/plain' | undefined {
    const sniffed = sniffType(data);
    if (sniffed) {
        return sniffed;
    }
    const text = textOf(data);
    if (text === undefined || hasMarkup(text)) {
        return undefined;
    }
    return 'text/plain';
}

/** A file name safe for a Content-Disposition header and a download. */
export function cleanName(name: string, fallback = 'attachment') {
    return (
        name
            .split(/[\\/]/)
            .pop()!
            // oxlint-disable-next-line no-control-regex
            .replace(/[\u0000-\u001f\u007f"]/g, '')
            .trim()
            .slice(-200) || fallback
    );
}
