/**
 * A conversation's messages as a model can read them (attachments it can't
 * take become notes), and a message's display text.
 */
import type { Message } from '@ag-ui/client';

const MEDIA_TYPES = new Set(['image', 'audio', 'video', 'document', 'binary']);

/** TensorFold's default `--vision-max-images`. */
export const DEFAULT_MAX_IMAGES = 4;

const EMPTY_NOTE = '[The user sent a message with no text the model can read, such as a sticker.]';

type Part = { type?: unknown; text?: unknown } & Record<string, unknown>;

function mimeOf(part: Part) {
    const source = part.source as { mimeType?: unknown } | undefined;
    const mime = source?.mimeType ?? part.mimeType;
    return typeof mime === 'string' ? mime : String(part.type);
}

/** A short stand-in for an attachment the model can't take. */
export function attachmentNote(part: Part) {
    return `[The user attached a file (${mimeOf(part)}). This model can't open attachments, so say so if the user asks about it.]`;
}

const OLDER_IMAGE_NOTE = '[The user attached an image earlier; only the most recent images are shown to the model.]';

/**
 * Replaces attachments the model can't take with a text note, so one photo
 * from Telegram can't fail every later turn of its conversation. The most
 * recent `maxImages` images stay (none for a text-only model, 0); older
 * images and other media become notes.
 */
export function modelReadableMessages(messages: Message[], maxImages: number): Message[] {
    let images = 0;
    return messages
        .slice()
        .reverse()
        .map((message) => {
            if (message.role !== 'user') {
                return message;
            }
            // A sticker or a dropped attachment can arrive with no content at all,
            // which a model rejects.
            if (
                !message.content ||
                (typeof message.content === 'string' && !message.content.trim()) ||
                (Array.isArray(message.content) && message.content.length === 0)
            ) {
                return { ...message, content: EMPTY_NOTE } as Message;
            }
            if (!Array.isArray(message.content)) {
                return message;
            }
            const parts = message.content as unknown as Part[];
            if (!parts.some((part) => MEDIA_TYPES.has(String(part.type)))) {
                return message;
            }
            const content = parts
                .slice()
                .reverse()
                .map((part) => {
                    if (!MEDIA_TYPES.has(String(part.type))) {
                        return part;
                    }
                    if (part.type === 'image' && maxImages > 0) {
                        images += 1;
                        if (images <= maxImages) {
                            return part;
                        }
                        return { type: 'text', text: OLDER_IMAGE_NOTE };
                    }
                    return { type: 'text', text: attachmentNote(part) };
                })
                .reverse();
            return content.every((part, index) => part === parts[index])
                ? message
                : ({ ...message, content } as Message);
        })
        .reverse();
}

/**
 * Display text of a message: its text parts, with a marker per attachment
 * (a reference by its file name, CB-54).
 */
export function messageText(content: unknown): string {
    if (typeof content === 'string') {
        return content;
    }
    if (!Array.isArray(content)) {
        return '';
    }
    return (content as Part[])
        .map((part) =>
            part?.type === 'text' && typeof part.text === 'string'
                ? part.text
                : part?.type === 'binary' && typeof part.id === 'string'
                  ? `[attachment: ${typeof part.filename === 'string' && part.filename ? part.filename : mimeOf(part)}]`
                  : MEDIA_TYPES.has(String(part?.type))
                    ? `[${part.type === 'image' ? 'image' : 'attachment'}: ${mimeOf(part)}]`
                    : '',
        )
        .filter(Boolean)
        .join('\n');
}
