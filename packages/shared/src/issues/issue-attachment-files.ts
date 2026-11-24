/**
 * Which files an issue or comment can take, checked before upload so a
 * doomed one is refused at pick time with words. Moved from the web's
 * `modules/issues/attachments.ts`, over `{name, size, mediaType}`
 * so the web's `File`s and the app's picked files both fit.
 */
import { ISSUE_ATTACHMENT_MAX_BYTES, ISSUE_ATTACHMENTS_PER_ISSUE } from './issue-types.js';

/**
 * What the server accepts (`src/server/issues/attachments.ts`), by
 * extension: the type is detected from the content there, and the
 * extension must match it. These checks only spare a doomed upload; the
 * server decides.
 */
export const ATTACHMENT_EXTENSIONS: Readonly<Record<string, string>> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/plain',
    log: 'text/plain',
    csv: 'text/plain',
    json: 'text/plain',
    diff: 'text/plain',
    patch: 'text/plain',
};
export const ATTACHMENT_HINT = 'Images (PNG, JPEG, GIF, WebP), PDFs or plain text, up to 5 MB each.';

/** A file about to be attached: its name (with the extension), size in bytes and type when known. */
export interface AttachmentCandidate {
    name: string;
    size: number;
    mediaType?: string;
}

/** Why a file can't be attached, or undefined when it can be tried. */
export function fileProblem(file: AttachmentCandidate): string | undefined {
    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!(extension in ATTACHMENT_EXTENSIONS)) {
        return `${file.name}: only images, PDFs and plain text can be attached.`;
    }
    if (file.size > ISSUE_ATTACHMENT_MAX_BYTES) {
        return `${file.name} is larger than 5 MB.`;
    }
    if (!file.size) {
        return `${file.name} is empty.`;
    }
    return undefined;
}

/**
 * Splits picked or pasted files into those to upload and the reasons for
 * the rest, given how many the issue already has (the server caps it).
 */
export function acceptFiles<T extends AttachmentCandidate>(files: readonly T[], existing: number) {
    const accepted: T[] = [];
    const refused: string[] = [];
    for (const file of files) {
        const problem = fileProblem(file);
        if (problem) {
            refused.push(problem);
        } else if (existing + accepted.length >= ISSUE_ATTACHMENTS_PER_ISSUE) {
            refused.push(`${file.name}: an issue can have at most ${ISSUE_ATTACHMENTS_PER_ISSUE} attachments.`);
        } else {
            accepted.push(file);
        }
    }
    return { accepted, refused };
}
