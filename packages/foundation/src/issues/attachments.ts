/**
 * The checks an issue attachment passes before it is stored. Moved from
 * `issues/attachments.ts`, which keeps `checkAttachment` and throws its
 * `IssueError` from the refusal here.
 */
import {
    ISSUE_ATTACHMENT_MAX_BYTES,
    ISSUE_ATTACHMENT_TYPES,
    type IssueAttachmentType,
} from '@socio/shared/issues/issue-types';
// Type detection and name cleaning are shared with chat attachments.
import { cleanName, detectType } from '@socio/shared/media/file-types';

/** File name extensions accepted for each detected type. */
const EXTENSIONS: Record<IssueAttachmentType, string[]> = {
    'image/png': ['png'],
    'image/jpeg': ['jpg', 'jpeg'],
    'image/gif': ['gif'],
    'image/webp': ['webp'],
    'application/pdf': ['pdf'],
    'text/plain': ['txt', 'md', 'log', 'csv', 'json', 'diff', 'patch'],
};

/** Why an upload was refused, with the HTTP status the routes answer with. */
export interface AttachmentRefusal {
    readonly refused: true;
    readonly message: string;
    readonly status: 400 | 413 | 415;
}

/** An accepted upload: its cleaned name and the type detected from its content. */
export interface AcceptedAttachment {
    readonly refused: false;
    readonly name: string;
    readonly mediaType: IssueAttachmentType;
}

/**
 * Validates an upload: size, a type detected from the content (the client's
 * declared type must agree when given), and an extension that matches it.
 * Refuses with 413 for size, 400 for an empty file and 415 for anything else.
 */
export function inspectAttachment(
    name: string,
    declared: string | undefined,
    data: Uint8Array,
): AcceptedAttachment | AttachmentRefusal {
    if (data.byteLength > ISSUE_ATTACHMENT_MAX_BYTES) {
        return { refused: true, message: 'Attachments can be at most 5 MB.', status: 413 };
    }
    if (!data.byteLength) {
        return { refused: true, message: 'The file is empty.', status: 400 };
    }
    const refused: AttachmentRefusal = {
        refused: true,
        message: 'Attach a PNG, JPEG, GIF or WebP image, a PDF or a plain text file.',
        status: 415,
    };
    const mediaType = detectType(data);
    if (!mediaType) {
        return refused;
    }
    const claimed = declared?.split(';')[0].trim().toLowerCase();
    if (claimed && claimed !== mediaType && !(mediaType === 'text/plain' && claimed === 'text/markdown')) {
        return refused;
    }
    if (!ISSUE_ATTACHMENT_TYPES.includes(mediaType)) {
        return refused;
    }
    const clean = cleanName(name);
    const extension = clean.includes('.') ? clean.split('.').pop()!.toLowerCase() : '';
    if (!EXTENSIONS[mediaType].includes(extension)) {
        return refused;
    }
    return { refused: false, name: clean, mediaType };
}
