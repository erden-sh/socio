import type { ToWebMessage } from './bridge';
import { dataUriBytes } from './paste-image';

// The pictures of a page's `image` blocks in the editor (the WebView's CSP
// lets no request leave, and it holds no cookie): the WebView names the ids it
// lacks (`socio-images-wanted`, after each load and when an id appears), and
// native answers from the app's image cache (src/platform/editor-pictures.ts),
// one picture per `socio-images`, one at a time, each scaled to fit
// EDITOR_PICTURE_MAX_SIDE and at most EDITOR_PICTURE_MAX_BYTES. One the cache
// can't give (offline with none kept, gone, too large) goes back as
// `socio-images-unavailable`, so its block says so, and is asked again when
// the app is back online (`retry`). None of it touches the draft: drawing a
// picture is no edit. No React Native: tests/editor/pictures.test.ts runs it.

/** The longest side a picture reaches the WebView with (a phone's width at 3x, and some). */
export const EDITOR_PICTURE_MAX_SIDE = 1600;
/** The most bytes one picture reaches the WebView with (its data URI is about a third longer). */
export const EDITOR_PICTURE_MAX_BYTES = 2 * 1024 * 1024;
/** A picture at most this size, within the side, goes as it is kept (no re-encoding). */
export const EDITOR_PICTURE_AS_IS_BYTES = 1024 * 1024;

/** What the cache gave for a picture: its data URI, or nothing now. */
export type EditorPicture = { readonly kind: 'ready'; readonly dataUri: string } | { readonly kind: 'unavailable' };

/** A picture by its embed id, from the image cache, sized for the WebView. */
export type EditorPictureSource = (id: string) => Promise<EditorPicture>;

/** The image types the cache keeps, by their first bytes. */
export type PictureType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export function sniffPictureType(bytes: Uint8Array): PictureType | null {
    const at = (index: number, ...values: number[]) => values.every((value, offset) => bytes[index + offset] === value);
    if (at(0, 0x89, 0x50, 0x4e, 0x47)) {
        return 'image/png';
    }
    if (at(0, 0xff, 0xd8, 0xff)) {
        return 'image/jpeg';
    }
    if (at(0, 0x47, 0x49, 0x46, 0x38)) {
        return 'image/gif';
    }
    if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) {
        return 'image/webp';
    }
    return null;
}

/** How a kept picture reaches the WebView: as it is, or rendered again (scaled to fit, PNG keeps its alpha). */
export type PictureFit =
    | { readonly kind: 'as-is' }
    | {
          readonly kind: 'render';
          readonly resize: { readonly width: number } | { readonly height: number } | null;
          readonly format: 'png' | 'jpeg';
      };

export function pictureFit(picture: {
    readonly width: number;
    readonly height: number;
    readonly bytes: number;
    readonly type: PictureType | null;
}): PictureFit {
    const { width, height, bytes, type } = picture;
    const longest = Math.max(width, height);
    if (type !== null && longest <= EDITOR_PICTURE_MAX_SIDE && bytes <= EDITOR_PICTURE_AS_IS_BYTES) {
        return { kind: 'as-is' };
    }
    const resize =
        longest <= EDITOR_PICTURE_MAX_SIDE
            ? null
            : width >= height
              ? { width: EDITOR_PICTURE_MAX_SIDE }
              : { height: EDITOR_PICTURE_MAX_SIDE };
    return { kind: 'render', resize, format: type === 'image/png' ? 'png' : 'jpeg' };
}

export interface EditorPictures {
    /** The ids the WebView asked for; the ones already sent, or on the way, are skipped. */
    want(ids: readonly string[]): void;
    /** A new WebView: whatever was sent is gone with the old one, and what was being got is dropped. */
    reset(): void;
    /** Back online: the ones that weren't available are asked again. */
    retry(): void;
    /** The editor closed: nothing more is sent. */
    stop(): void;
}

export function createEditorPictures(options: {
    readonly source: EditorPictureSource;
    readonly send: (message: ToWebMessage) => void;
    readonly onError?: (error: unknown) => void;
}): EditorPictures {
    const { source, send, onError = (error: unknown) => console.warn('[editor] a picture', error) } = options;
    let queue: string[] = [];
    /** Queued, being got, or sent to this WebView. */
    const known = new Set<string>();
    const unavailable = new Set<string>();
    let generation = 0;
    let running = false;
    let stopped = false;

    const get = async (id: string): Promise<EditorPicture> => {
        try {
            const picture = await source(id);
            return picture.kind === 'ready' && dataUriBytes(picture.dataUri) > EDITOR_PICTURE_MAX_BYTES
                ? { kind: 'unavailable' }
                : picture;
        } catch (error) {
            onError(error);
            return { kind: 'unavailable' };
        }
    };

    const pump = async () => {
        if (running) {
            return;
        }
        running = true;
        try {
            while (!stopped && queue.length > 0) {
                const id = queue.shift()!;
                const at = generation;
                const picture = await get(id);
                if (stopped || at !== generation) {
                    continue;
                }
                try {
                    if (picture.kind === 'ready') {
                        send({ type: 'socio-images', payload: { [id]: picture.dataUri } });
                    } else {
                        known.delete(id);
                        unavailable.add(id);
                        send({ type: 'socio-images-unavailable', payload: { ids: [id] } });
                    }
                } catch (error) {
                    known.delete(id);
                    onError(error);
                }
            }
        } finally {
            running = false;
        }
    };

    const want = (ids: readonly string[]) => {
        if (stopped) {
            return;
        }
        for (const id of ids) {
            if (!known.has(id)) {
                known.add(id);
                unavailable.delete(id);
                queue.push(id);
            }
        }
        void pump();
    };

    return {
        want,
        reset() {
            generation += 1;
            queue = [];
            known.clear();
            unavailable.clear();
        },
        retry() {
            const again = [...unavailable];
            unavailable.clear();
            want(again);
        },
        stop() {
            stopped = true;
            queue = [];
        },
    };
}
