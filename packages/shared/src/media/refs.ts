import type { Message } from '@ag-ui/core';

import { ATTACHMENT_ID, MEDIA_LIMITS } from '../media-types.js';

/*
 * Attachment references in message content (CB-54): moved from
 * `src/server/media/refs.ts`, which re-exports it. Pure and browser-safe.
 *
 * Two shapes refer to an attachment. Since AG-UI 1.0 Socio writes a media
 * part (`image`, `audio`, `video` or `document`, by the file's type) whose
 * `source` is a `file` handle Socio issued: the attachment's id, with
 * `provider: 'socio'`; its file name is in the part's `metadata`. Before 1.0
 * it wrote `{ type: 'binary', id, mimeType, filename }`, which 1.0 retired
 * (CopilotKit's request parser drops it). That shape is read forever, from
 * stored history and from the native app builds already shipped, and never
 * written: the run endpoint upgrades it on the way in.
 */

type Part = { type?: unknown } & Record<string, unknown>;

/** The `provider` of a media part's `file` source that is a Socio attachment's id. */
export const ATTACHMENT_PROVIDER = 'socio';

/** An attachment as a message refers to it, whichever shape it came in. */
export interface AttachmentRef {
    id: string;
    mimeType: string;
    filename?: string;
}

/** The media part kinds of AG-UI 1.0. */
export type MediaPartType = 'image' | 'audio' | 'video' | 'document';

/** A message part that refers to an attachment, as Socio writes it (AG-UI 1.0). */
export interface AttachmentPart {
    type: MediaPartType;
    source: { type: 'file'; value: string; provider: typeof ATTACHMENT_PROVIDER; mimeType: string };
    metadata?: { filename?: string };
}

/** The reference Socio wrote before AG-UI 1.0: read, never written. */
export interface LegacyAttachmentPart {
    type: 'binary';
    id: string;
    mimeType: string;
    filename?: string;
}

const MEDIA_PART_TYPES: ReadonlySet<string> = new Set(['image', 'audio', 'video', 'document']);

/** The media part a file of `mimeType` goes in, as AG-UI and CopilotKit pick it. */
export function mediaPartType(mimeType: string): MediaPartType {
    return mimeType.startsWith('image/')
        ? 'image'
        : mimeType.startsWith('audio/')
          ? 'audio'
          : mimeType.startsWith('video/')
            ? 'video'
            : 'document';
}

/** The reference a part makes to an attachment, in either shape; undefined for any other part. */
export function attachmentRef(part: unknown): AttachmentRef | undefined {
    if (!part || typeof part !== 'object') {
        return undefined;
    }
    const value = part as Part;
    if (value.type === 'binary') {
        // The pre-1.0 shape: an id only, never bytes or a URL.
        if (typeof value.id !== 'string' || !ATTACHMENT_ID.test(value.id) || value.data || value.url) {
            return undefined;
        }
        return {
            id: value.id,
            mimeType: typeof value.mimeType === 'string' ? value.mimeType : 'application/octet-stream',
            ...(typeof value.filename === 'string' && value.filename ? { filename: value.filename } : {}),
        };
    }
    if (!MEDIA_PART_TYPES.has(String(value.type))) {
        return undefined;
    }
    const source = value.source as Part | undefined;
    if (
        !source ||
        typeof source !== 'object' ||
        source.type !== 'file' ||
        source.provider !== ATTACHMENT_PROVIDER ||
        typeof source.value !== 'string' ||
        !ATTACHMENT_ID.test(source.value)
    ) {
        return undefined;
    }
    const metadata = value.metadata as Part | undefined;
    const filename = metadata && typeof metadata === 'object' ? metadata.filename : undefined;
    return {
        id: source.value,
        mimeType: typeof source.mimeType === 'string' ? source.mimeType : 'application/octet-stream',
        ...(typeof filename === 'string' && filename ? { filename } : {}),
    };
}

export const isAttachmentPart = (part: unknown): part is AttachmentPart | LegacyAttachmentPart =>
    attachmentRef(part) !== undefined;

/** The part Socio writes for an attachment. */
export function attachmentPart({ id, mimeType, filename }: AttachmentRef): AttachmentPart {
    return {
        type: mediaPartType(mimeType),
        source: { type: 'file', value: id, provider: ATTACHMENT_PROVIDER, mimeType },
        ...(filename ? { metadata: { filename } } : {}),
    };
}

/** The attachments a message's content refers to, in order. */
export function attachmentRefs(content: unknown): AttachmentRef[] {
    return Array.isArray(content) ? content.flatMap((part) => attachmentRef(part) ?? []) : [];
}

/** The attachment ids a message's content refers to, in order. */
export function attachmentIds(content: unknown): string[] {
    return attachmentRefs(content).map((ref) => ref.id);
}

/**
 * `content` with each pre-1.0 reference rewritten as the part Socio writes
 * now; the same array when it holds none. Every other part is left as it is.
 */
export function upgradeAttachmentParts<T>(content: T): T {
    if (!Array.isArray(content) || !content.some((part) => (part as Part | undefined)?.type === 'binary')) {
        return content;
    }
    return content.map((part) => {
        if ((part as Part | undefined)?.type !== 'binary') {
            return part;
        }
        const ref = attachmentRef(part);
        return ref ? attachmentPart(ref) : part;
    }) as T;
}

/** A message with its pre-1.0 references upgraded; the same object when it has none. */
export function upgradeMessageAttachments<M extends { content?: unknown }>(message: M): M {
    const content = upgradeAttachmentParts(message.content);
    return content === message.content ? message : { ...message, content };
}

/**
 * A message's content for a read-only transcript: plain text, or (with
 * attachments) its text and the references, which the client renders as
 * thumbnails and chips. Inline bytes never leave as they are.
 */
export function displayContent(content: unknown, text: string) {
    const refs = attachmentRefs(content);
    if (!refs.length) {
        return text;
    }
    const prose = (content as Part[])
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text as string)
        .join('\n');
    return [...(prose.trim() ? [{ type: 'text' as const, text: prose }] : []), ...refs.map(attachmentPart)];
}

/** Why the run endpoint refuses a message's content (a 400). */
export class ContentError extends Error {}

/**
 * The run endpoint's check of the user messages a request introduces (ids
 * not in the thread's stored history): plain text, or text parts plus
 * attachment references (either shape: the native app builds already
 * shipped send the pre-1.0 one), at most 10 of them. Inline bytes (`data`,
 * `url`, media parts with any other source) are refused, so run history
 * never stores them (CB-7); messages already stored are left as they are.
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

/**
 * The header a client sends to say it reads AG-UI 1.0's media parts:
 * `X-Socio-Reads: ag-ui-media` (a comma-separated list of what it reads).
 * The web app and the native app send it on every request since AG-UI 1.0.
 */
export const READS_HEADER = 'X-Socio-Reads';
/** `READS_HEADER`'s token for AG-UI 1.0 media parts. */
export const READS_AG_UI_MEDIA = 'ag-ui-media';

/** Whether a `READS_HEADER` value says its client reads AG-UI 1.0 media parts. */
export const readsAgUiMedia = (value: string | null | undefined) =>
    !!value &&
    value
        .split(',')
        .map((token) => token.trim().toLowerCase())
        .includes(READS_AG_UI_MEDIA);

/** The pre-1.0 reference for an attachment, for a client that reads only that. */
export function legacyAttachmentPart({ id, mimeType, filename }: AttachmentRef): LegacyAttachmentPart {
    return { type: 'binary', id, mimeType, ...(filename ? { filename } : {}) };
}

/**
 * `value` (a response body, an event, anything JSON) with every attachment
 * part Socio writes, at any depth, as the pre-1.0 `binary` reference; the
 * same value when it holds none. Other media parts are left as they are.
 *
 * COMPAT(ag-ui-1.0): for the native app builds already shipped (0.2.6 and
 * earlier), which read only the pre-1.0 shape, in history, transcripts and
 * the live stream: without it they show no attachment and their steering
 * recovery, which finds a delivered message by its attachment ids, sends it
 * again. Remove once no supported build is 0.2.6 or older.
 */
export function downgradeAttachmentParts<T>(value: T): T {
    if (!value || typeof value !== 'object') {
        return value;
    }
    if (Array.isArray(value)) {
        const parts = value.map((entry) => downgradeAttachmentParts(entry));
        return (parts.every((entry, index) => entry === value[index]) ? value : parts) as T;
    }
    if ((value as Part).type !== 'binary' && MEDIA_PART_TYPES.has(String((value as Part).type))) {
        const ref = attachmentRef(value);
        if (ref) {
            return legacyAttachmentPart(ref) as T;
        }
    }
    let changed = false;
    const entries = Object.entries(value).map(([key, entry]) => {
        const next = downgradeAttachmentParts(entry);
        changed ||= next !== entry;
        return [key, next] as const;
    });
    return (changed ? Object.fromEntries(entries) : value) as T;
}
