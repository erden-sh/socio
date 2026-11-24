import type { Message } from '@ag-ui/core';

import { ATTACHMENT_ID, MEDIA_LIMITS } from '../media-types.js';

/*
 * Attachment references in message content (CB-54): moved from
 * `src/server/media/refs.ts`, which re-exports it. Pure and browser-safe.
 */

type Part = { type?: unknown } & Record<string, unknown>;

/** A message part that refers to an attachment: `binary` with an id only. */
export interface AttachmentPart {
    type: 'binary';
    id: string;
    mimeType: string;
    filename?: string;
}

export const isAttachmentPart = (part: unknown): part is AttachmentPart =>
    !!part &&
    typeof part === 'object' &&
    (part as Part).type === 'binary' &&
    typeof (part as Part).id === 'string' &&
    ATTACHMENT_ID.test((part as Part).id as string) &&
    !(part as Part).data &&
    !(part as Part).url;

/** The attachment ids a message's content refers to, in order. */
export function attachmentIds(content: unknown): string[] {
    return Array.isArray(content) ? content.filter(isAttachmentPart).map((part) => part.id) : [];
}

/**
 * A message's content for a read-only transcript: plain text, or (with
 * attachments) its text and the references, which the client renders as
 * thumbnails and chips. Inline bytes never leave as they are.
 */
export function displayContent(content: unknown, text: string) {
    const refs = Array.isArray(content) ? content.filter(isAttachmentPart) : [];
    if (!refs.length) {
        return text;
    }
    const prose = (content as Part[])
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text as string)
        .join('\n');
    return [
        ...(prose.trim() ? [{ type: 'text' as const, text: prose }] : []),
        ...refs.map(({ id, mimeType, filename }) => ({
            type: 'binary' as const,
            id,
            mimeType,
            ...(filename ? { filename } : {}),
        })),
    ];
}

/** Why the run endpoint refuses a message's content (a 400). */
export class ContentError extends Error {}

/**
 * The run endpoint's check of the user messages a request introduces (ids
 * not in the thread's stored history): plain text, or text parts plus
 * attachment references, at most 10 of them. Inline bytes (`data`, `url`,
 * image and other media parts) are refused, so run history never stores
 * them (CB-7); messages already stored are left as they are.
 */
export function checkNewUserContent(messages: unknown, known: ReadonlySet<string>) {
    if (!Array.isArray(messages)) {
        return;
    }
    for (const message of messages as Array<Partial<Message>>) {
        if (!message || message.role !== 'user') {
            continue;
        }
        if (typeof message.id === 'string' && known.has(message.id)) {
            continue;
        }
        const content = message.content as unknown;
        if (content === undefined || typeof content === 'string') {
            continue;
        }
        if (!Array.isArray(content)) {
            throw new ContentError('A message must be text.');
        }
        let refs = 0;
        for (const part of content as Part[]) {
            if (part?.type === 'text' && typeof part.text === 'string') {
                continue;
            }
            if (!isAttachmentPart(part)) {
                throw new ContentError('Attach files with the attach button.');
            }
            refs += 1;
        }
        if (refs > MEDIA_LIMITS.perMessage) {
            throw new ContentError(`A message can carry at most ${MEDIA_LIMITS.perMessage} attachments.`);
        }
    }
}
