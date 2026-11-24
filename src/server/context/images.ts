import type { ContentPart, ModelMessage } from '@tanstack/ai';

import { DEFAULT_MAX_IMAGES } from '@socio/foundation/turns/media-parts';
import type { ToolImageSource } from '@socio/foundation/turns/tool-images';
import type { InferenceCapabilities } from '@socio/shared/inference';
import { TURN_IMAGE_BYTES } from '@socio/shared/media-types';
import { formatSize } from '@socio/shared/text/format-size';
import { IMAGE_TOOLS, toolImageOf, withoutInlineImages, type ToolImage } from '@socio/shared/tool-images';

import { toolNames } from './compact.js';

/**
 * Images in a prompt that tools returned (CB-157). A tool result names its
 * image (`toolImageOf`: a screenshot stored as an attachment of the
 * conversation), and each round's prompt gets the newest images as image
 * parts, in a message from Socio right after the round's results:
 * a tool result is text on the Chat Completions path, so an image can't be
 * in it. The images the person attached count too, so the prompt holds the
 * model's most at most (`maxImages`, none for a model without vision), each
 * within the image byte limit and all within 32 MB. An image left out keeps
 * its result, with a short note of why after it.
 *
 * It depends on the messages alone, newest first: the same conversation
 * gives the same prompt, byte for byte. Past the limit, a newer image turns
 * the oldest one shown into a note, which changes the prompt from that
 * image on: a model's prefix cache (CB-139) holds only up to it. A note
 * stays the same after that, until a fold takes its turn. Fitting
 * adds the images after it compacted and folded the conversation, where a
 * message of its own changes no turn, and before the roles' last pass
 * (CB-147), which keeps them taking turns.
 *
 * Older versions stored a screenshot's bytes as base64 text in its result.
 * That text is never an image to a model, and cut to an excerpt it meant
 * nothing: `withoutInlineToolImages` replaces it with a short note, in the
 * prompt only, before anything else is fitted.
 */

/** The most recent images a model takes in a prompt; 0 for one that sees none. */
export const imagesFor = (capabilities: InferenceCapabilities) =>
    capabilities.acceptsImages ? (capabilities.maxImages ?? DEFAULT_MAX_IMAGES) : 0;

const TYPE_LABELS: Record<string, string> = {
    'image/png': 'PNG',
    'image/jpeg': 'JPEG',
    'image/gif': 'GIF',
    'image/webp': 'WebP',
};

/** What a base64 image in an old result becomes (no quotes: it may be inside JSON). */
export const inlineImageNote = (mediaType: string, bytes: number) =>
    `[an image (${TYPE_LABELS[mediaType] ?? 'image'}, ${formatSize(bytes)}) stored as text by an older version, which no model can see; take a new screenshot to look again]`;

const stripped = new WeakMap<ModelMessage, ModelMessage>();

/** The only tool whose results older versions stored images in, as base64. */
export const INLINE_IMAGE_TOOL = 'computer_screenshot';

/**
 * The conversation with every base64 image in a screenshot's result
 * replaced by `inlineImageNote`. Other tools' results are theirs as they
 * are (a command's base64 output is what it printed). Stored history is
 * not changed.
 */
export function withoutInlineToolImages(messages: readonly ModelMessage[]): ModelMessage[] {
    const names = toolNames(messages);
    let changed = false;
    const out = messages.map((message) => {
        if (
            message.role !== 'tool' ||
            typeof message.content !== 'string' ||
            names.get(message.toolCallId ?? '') !== INLINE_IMAGE_TOOL
        ) {
            return message;
        }
        let next = stripped.get(message);
        if (!next) {
            const content = withoutInlineImages(message.content, inlineImageNote);
            next = content === message.content ? message : { ...message, content };
            stripped.set(message, next);
        }
        if (next !== message) {
            changed = true;
        }
        return next;
    });
    return changed ? out : (messages as ModelMessage[]);
}

/** Why an image is left out. */
type Why = 'blind' | 'older' | 'large' | 'bytes' | 'gone' | 'failed';

interface Candidate {
    /** The message, and for a person's image its part. */
    index: number;
    part?: number;
    /** A tool's image, with the tool. */
    image?: ToolImage;
    tool?: string;
    why?: Why;
}

const imageBytes = (part: ContentPart) => {
    const source = (part as { source?: { type?: string; value?: unknown } }).source;
    return source?.type === 'data' && typeof source.value === 'string' ? Math.floor((source.value.length * 3) / 4) : 0;
};

/**
 * Every image of the prompt, tools' and the person's, newest first, with
 * whether it is shown: the newest `maxImages` that are within the limits.
 */
async function plan(
    messages: readonly ModelMessage[],
    maxImages: number,
    source: ToolImageSource | undefined,
): Promise<Candidate[]> {
    const maxBytes = source?.maxBytes ?? Infinity;
    const names = toolNames(messages);
    const candidates: Candidate[] = [];
    let shown = 0;
    let bytes = 0;
    const decide = (candidate: Candidate, size: number) => {
        candidate.why =
            maxImages <= 0
                ? 'blind'
                : shown >= maxImages
                  ? 'older'
                  : size > maxBytes
                    ? 'large'
                    : bytes + size > TURN_IMAGE_BYTES
                      ? 'bytes'
                      : undefined;
        if (!candidate.why) {
            shown += 1;
            bytes += size;
        }
        candidates.push(candidate);
    };
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message.role === 'tool' && typeof message.content === 'string') {
            const tool = names.get(message.toolCallId ?? '');
            const image = tool && IMAGE_TOOLS.has(tool) ? toolImageOf(message.content) : undefined;
            if (!image) {
                continue;
            }
            // Measured by what is stored: one gone takes no one's place.
            const size = await source?.size(image.id);
            if (size === undefined) {
                candidates.push({ index, image, tool, why: 'gone' });
            } else {
                decide({ index, image, tool }, size);
            }
        } else if (message.role === 'user' && Array.isArray(message.content)) {
            for (let part = message.content.length - 1; part >= 0; part--) {
                if (message.content[part].type === 'image') {
                    decide({ index, part }, imageBytes(message.content[part]));
                }
            }
        }
    }
    return candidates;
}

/** The tools' images a prompt will show: what fitting keeps room for. */
export async function shownToolImages(
    messages: readonly ModelMessage[],
    capabilities: InferenceCapabilities,
    source: ToolImageSource | undefined,
) {
    if (!source) {
        return 0;
    }
    return (await plan(messages, imagesFor(capabilities), source)).filter(
        (candidate) => candidate.image && !candidate.why,
    ).length;
}

/** The note after a tool's result whose image is left out. */
export function leftOutNote(why: Why, image: ToolImage, tool: string) {
    switch (why) {
        case 'blind':
            return `[Not shown: this model can't see images.${tool === 'computer_screenshot' ? ' computer_snapshot and computer_read give the page as text.' : ''}]`;
        case 'older':
            return `[Not shown: an older image; only the most recent ones are shown. attachments_view with id ${image.id} shows it again.]`;
        case 'large':
            return '[Not shown: too large to show this model.]';
        case 'bytes':
            return '[Not shown: too many image bytes in this prompt to show it too.]';
        case 'gone':
            return '[Not shown: the image is no longer available.]';
        case 'failed':
            return '[Not shown: the image could not be loaded right now.]';
    }
}

/** A person's image left out: the same words as the turn's own (media-parts.ts). */
const PERSON_NOTES: Record<Why, string> = {
    blind: '[An image this model can’t see.]',
    older: '[The user attached an image earlier; only the most recent images are shown to the model.]',
    large: '[An image too large to show this model.]',
    bytes: '[An image left out: too many image bytes in this prompt.]',
    gone: '[An image that is no longer available.]',
    failed: '[An image that could not be loaded.]',
};

/** The label before a tool's image in Socio's message. */
export function imageLabel(image: ToolImage, tool: string) {
    const size = image.width ? `, ${image.width}×${image.height}` : '';
    return `[From Socio: the image ${tool} returned (${image.id}, ${image.mediaType}${size}, ${formatSize(image.size)}).]`;
}

/** Socio's message with a round's images: marked, never a person's. */
export const TOOL_IMAGES = { toolImages: true } as const;
export const isToolImagesMessage = (message: ModelMessage) =>
    (message.metadata as typeof TOOL_IMAGES | undefined)?.toolImages === true;

/** An image's part, kept for the turn: the same bytes give the same part. */
export type ImageParts = Map<string, Promise<ContentPart | 'gone' | 'large' | 'failed'>>;

/**
 * The prompt with its tools' images: the shown ones as image parts in a
 * message after their round's results, the others as notes after their
 * results, and the person's images past the limits as notes.
 */
export async function withToolImages(
    messages: readonly ModelMessage[],
    capabilities: InferenceCapabilities,
    source: ToolImageSource | undefined,
    parts: ImageParts = new Map(),
): Promise<ModelMessage[]> {
    const candidates = await plan(messages, imagesFor(capabilities), source);
    if (!candidates.length) {
        return messages as ModelMessage[];
    }
    const load = (id: string) => {
        let part = parts.get(id);
        if (!part) {
            part = source!.load(id).then(
                (found): ContentPart | 'gone' | 'large' =>
                    // Replaced since it was measured: the bytes decide.
                    found && found.data.length > source!.maxBytes
                        ? 'large'
                        : found
                          ? {
                                type: 'image',
                                source: {
                                    type: 'data',
                                    value: Buffer.from(found.data).toString('base64'),
                                    mimeType: found.mediaType,
                                },
                            }
                          : 'gone',
                () => {
                    // Tried again next round.
                    parts.delete(id);
                    return 'failed' as const;
                },
            );
            parts.set(id, part);
        }
        return part;
    };
    // The shown tools' images, loaded (each once a turn).
    const loaded = new Map<number, ContentPart>();
    await Promise.all(
        candidates.map(async (candidate) => {
            if (!candidate.image || candidate.why) {
                return;
            }
            if (!source) {
                candidate.why = 'gone';
                return;
            }
            const found = await load(candidate.image.id);
            if (typeof found === 'string') {
                candidate.why = found;
            } else {
                loaded.set(candidate.index, found);
            }
        }),
    );
    const byIndex = new Map<number, Candidate[]>();
    for (const candidate of candidates) {
        byIndex.set(candidate.index, [...(byIndex.get(candidate.index) ?? []), candidate]);
    }
    const out: ModelMessage[] = [];
    let pending: ContentPart[] = [];
    const flush = () => {
        if (!pending.length) {
            return;
        }
        out.push({ role: 'user', content: pending, metadata: TOOL_IMAGES });
        pending = [];
    };
    messages.forEach((message, index) => {
        if (message.role !== 'tool') {
            flush();
        }
        const found = byIndex.get(index);
        if (!found) {
            out.push(message);
            return;
        }
        if (message.role === 'tool') {
            const [{ image, tool, why }] = found;
            if (why) {
                out.push({
                    ...message,
                    content: `${message.content as string}\n${leftOutNote(why, image!, tool!)}`,
                });
                return;
            }
            out.push(message);
            pending.push({ type: 'text', content: imageLabel(image!, tool!) }, loaded.get(index)!);
            return;
        }
        const left = new Map(
            found.flatMap((candidate) => (candidate.why ? [[candidate.part!, candidate.why] as const] : [])),
        );
        out.push(
            left.size
                ? {
                      ...message,
                      content: (message.content as ContentPart[]).map((part, at) =>
                          left.has(at) ? { type: 'text', content: PERSON_NOTES[left.get(at)!] } : part,
                      ),
                  }
                : message,
        );
    });
    flush();
    return out;
}
