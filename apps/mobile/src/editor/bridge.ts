// The page editor's bridge: every message between the native screen
// and the editor's WebView (editor/), checked with zod on both sides. Both the
// app and the WebView's bundle import this file, so it holds only zod and
// plain values: no React Native, no theme, nothing the bundle can't carry.
//
// Each message rides tentap's own envelope (`{ type, payload }`) through its
// bridges: native → web reaches editor/page-bridge.ts through the bundle's
// `onBridgeMessage`, web → native reaches the screen's bridge through
// `onEditorMessage`. Every type starts with `socio-`, apart from tentap's.
//
// Versions: the WebView counts the document's versions. Every own edit, load
// and applied replace moves it on by one, and every message that carries
// Markdown says which version it is. A `replace` names the version its merge
// was made from (`ifVersion`); if the person typed since, the WebView doesn't
// apply it and answers with what it holds now, so the native side merges again.
import { z } from 'zod';

import { EMBED_MEDIA_ID } from '@socio/shared/embed-card';
import { pageImageSchema } from '@socio/shared/page-image';
import { PAGE_TITLE_MAX } from '@socio/shared/pages/page-draft';

/** At most one `change` per this many milliseconds. */
export const CHANGE_THROTTLE_MS = 400;

/** The largest pasted picture the WebView passes on (its bytes; the data URI is about a third longer). */
export const PASTE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/** At most this many picture ids in one `socio-images-wanted` or `socio-images-unavailable`. */
export const IMAGES_WANTED_MAX = 200;

/** The web's rule for a link's target (`LinkDialog`): a web address or a page of this workspace. */
export const LINK_HREF = /^(https?:\/\/|\/#\/spaces\/)/i;

/** The title's words in the document (CB-417): its placeholder and its name for screen readers. */
export const TITLE_PLACEHOLDER = 'Untitled page';
export const TITLE_LABEL = 'Page title';

/** The toolbar's commands, each a TipTap command run on the selection. */
export const EDITOR_COMMANDS = [
    'bold',
    'italic',
    'strike',
    'code',
    'paragraph',
    'heading1',
    'heading2',
    'heading3',
    'bulletList',
    'orderedList',
    'taskList',
    'blockquote',
    'codeBlock',
    'undo',
    'redo',
] as const;

export type EditorCommand = (typeof EDITOR_COMMANDS)[number];

/** The marks and blocks `state` reports as active under the selection. */
export const ACTIVE_NAMES = [
    'bold',
    'italic',
    'strike',
    'code',
    'link',
    'bulletList',
    'orderedList',
    'taskList',
    'blockquote',
    'codeBlock',
] as const;

const version = z.number().int().nonnegative();
/** Picture ids (media embeds), a bounded batch. */
const embedIds = z.array(z.string().regex(EMBED_MEDIA_ID)).min(1).max(IMAGES_WANTED_MAX);
const markdown = z.string().max(1_000_000);
/** The page's title, as the title field takes it (the web's 160 characters). */
const title = z.string().max(PAGE_TITLE_MAX);
/** A layout inset in points. */
const inset = z.number().nonnegative().max(2000);
/** A picture as a data URI: base64, and an image type. */
const imageDataUri = z.string().regex(/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]*={0,2}$/);
/** A theme token's name and its color, as the generated theme writes them. */
const tokenName = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
const tokenColor = z.string().regex(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);

/** A message with no payload. */
const bare = <T extends string>(type: T) => z.strictObject({ type: z.literal(type) });
/** A message with its payload. */
const message = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
    z.strictObject({ type: z.literal(type), payload });

/** Native → web. */
export const toWebSchema = z.discriminatedUnion('type', [
    /** Opens a stored page (the web's path in, the bundle's `loadMarkdown`). Sends no `change`. */
    message('socio-load', z.strictObject({ markdown })),
    /** Puts a merge in place as one minimal transaction if the document is still at `ifVersion`. */
    message('socio-replace', z.strictObject({ markdown, ifVersion: version })),
    /** Runs a toolbar command on the selection. */
    message('socio-command', z.strictObject({ name: z.enum(EDITOR_COMMANDS) })),
    /** Links the selection to `href`, or unlinks it when `href` is null. */
    message('socio-link', z.strictObject({ href: z.string().max(2048).regex(LINK_HREF).nullable() })),
    /**
     * The type size and the theme's colors; the page's background stays
     * transparent. `insets` (CB-417): the room the native bar takes over the
     * document's top (iOS's translucent bar) and what stays clear at its foot,
     * which the document pads so its text scrolls under the bar.
     */
    message(
        'socio-appearance',
        z.strictObject({
            fontScale: z.number().positive().max(5),
            tokens: z.record(tokenName, tokenColor),
            insets: z.strictObject({ top: inset, bottom: inset }).optional(),
        }),
    ),
    /**
     * The page's title, at the top of the document (CB-417): sent after each
     * `loaded` and whenever the draft's title differs from what the WebView
     * last held (a merge). Never an edit: nothing comes back.
     */
    message('socio-title', z.strictObject({ title })),
    /** The pictures of the page's `image` blocks, by embed id, from the native cache. */
    message('socio-images', z.record(z.string().regex(EMBED_MEDIA_ID), imageDataUri)),
    /** Pictures the native cache can't give now (offline with none kept, or gone): the blocks say so. */
    message('socio-images-unavailable', z.strictObject({ ids: embedIds })),
    /**
     * A pasted picture, uploaded and made an image of the Space: its
     * `image` block goes in at the selection, as the person's own edit (a
     * `change`, and Undo takes it back). Its picture comes first in `socio-images`.
     */
    message('socio-insert-image', pageImageSchema),
    /** Sends the latest own edit now, throttle or not (leaving, Android Back). */
    bare('socio-flush'),
]);

const activeState = z.strictObject({
    /** An own edit the throttle hasn't sent yet: leaving waits for it (`socio-flush`). */
    unsent: z.boolean(),
    canUndo: z.boolean(),
    canRedo: z.boolean(),
    /** 0 for no heading. */
    heading: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    active: z.array(z.enum(ACTIVE_NAMES)),
    /** The link under the selection, for the link prompt. */
    link: z.string().nullable(),
});

/** Web → native. */
export const toNativeSchema = z.discriminatedUnion('type', [
    /**
     * The page as the editor read it back after `load`, with the web's
     * `inspectMarkdown` verdict on what was loaded: when `supported` is false
     * the rich editor can't keep it, so native shows Markdown source
     * with `reason`, the web's words.
     */
    message(
        'socio-loaded',
        z.strictObject({ markdown, version, supported: z.boolean(), reason: z.string().max(500).nullable() }),
    ),
    /** The person's own edits, at most every CHANGE_THROTTLE_MS. Never for a load or a replace. */
    message('socio-change', z.strictObject({ markdown, version })),
    /**
     * The answer to a `replace`: `applied`, or not because the document moved
     * past `ifVersion`. Either way `markdown` is what the editor holds now.
     */
    message('socio-replaced', z.strictObject({ ifVersion: version, applied: z.boolean(), markdown, version })),
    /** What the toolbar shows, when it changes. */
    message('socio-state', activeState),
    /**
     * A picture pasted into the editor (its DOM paste event). Nothing is
     * inserted here: native uploads it and answers `socio-insert-image`.
     */
    message(
        'socio-paste-image',
        z.strictObject({ mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/), dataUri: imageDataUri }),
    ),
    /**
     * The `image` blocks whose pictures the WebView doesn't hold: all of them
     * after each load, then each id that appears (a merge, an undo). Native
     * answers from its image cache, one `socio-images` at a time; asking is
     * never an edit.
     */
    message('socio-images-wanted', z.strictObject({ ids: embedIds })),
    /** The person typed in the document's title field (CB-417): every input, no throttle. */
    message('socio-title-change', z.strictObject({ title })),
    /**
     * Whether the document's title is still in view below the native bar,
     * posted when that changes: once it has scrolled away, the bar shows it
     * on one line (CB-417).
     */
    message('socio-title-shown', z.strictObject({ shown: z.boolean() })),
    /** Words for the person: a paste the editor refused. */
    message('socio-notice', z.strictObject({ text: z.string().min(1).max(500) })),
    /** A `socio-` message the WebView refused (bad payload or unknown type). */
    message('socio-refused', z.strictObject({ type: z.string().max(100) })),
]);

export type ToWebMessage = z.infer<typeof toWebSchema>;
export type ToNativeMessage = z.infer<typeof toNativeSchema>;
export type EditorState = z.infer<typeof activeState>;
export type EditorAppearance = Extract<ToWebMessage, { type: 'socio-appearance' }>['payload'];

const isOurs = (value: unknown): value is { type: string } =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string' &&
    (value as { type: string }).type.startsWith('socio-');

/** What a side makes of a message: ours and valid, ours and refused, or someone else's (tentap's). */
export type Parsed<M> = { kind: 'ok'; message: M } | { kind: 'refused'; type: string } | { kind: 'other' };

function parseWith<M>(schema: z.ZodType<M>, value: unknown): Parsed<M> {
    if (!isOurs(value)) {
        return { kind: 'other' };
    }
    const result = schema.safeParse(value);
    return result.success ? { kind: 'ok', message: result.data } : { kind: 'refused', type: value.type.slice(0, 100) };
}

/** The WebView's check of what native sends. */
export const parseToWeb = (value: unknown) => parseWith(toWebSchema, value);

/** The native side's check of what the WebView sends. */
export const parseToNative = (value: unknown) => parseWith(toNativeSchema, value);

/**
 * Native: the message to send, checked first, so a bad one fails where it is
 * made and never reaches the WebView.
 */
export const toWeb = (message: ToWebMessage): ToWebMessage => toWebSchema.parse(message);
