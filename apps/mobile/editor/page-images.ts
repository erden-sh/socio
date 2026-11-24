// The pictures of a page's `image` blocks inside the WebView. The
// page's CSP lets no request leave (`img-src data:` only), so the native side
// sends each picture from its image cache as a data URI (bridge `socio-images`),
// and the block draws it once it has come; until then, its alt text. A page's
// own pictures are asked for (`socio-images-wanted`, page-bridge.ts); one the
// cache can't give (offline with none kept) says so, in the reader's words.
import type { AnyExtension } from '@tiptap/core';

import { PageImageNode } from '../../../packages/client/src/modules/pages/editor/page-image-node';

/** A block's words while its picture hasn't come and has no alt. */
export const PICTURE_PLACEHOLDER = 'Image';
/** A picture native can't give now (the reader's words, page-blocks.tsx). */
export const PICTURE_UNAVAILABLE = 'Picture not available here';
export const pictureUnavailable = (alt: string) => (alt ? `${alt} isn’t available here` : PICTURE_UNAVAILABLE);

/** The pictures the native side has sent, by embed id, and the ones it can't give now (null). */
export class PageImages {
    private readonly uris = new Map<string, string | null>();
    private readonly listeners = new Set<() => void>();

    get(id: string) {
        return this.uris.get(id) ?? undefined;
    }

    /** The picture is here: nothing to ask for. */
    has(id: string) {
        return typeof this.uris.get(id) === 'string';
    }

    /** Native said it can't give it now. */
    isUnavailable(id: string) {
        return this.uris.get(id) === null;
    }

    /** Pictures native can't give now; a picture already here stays. */
    markUnavailable(ids: readonly string[]) {
        let changed = false;
        for (const id of ids) {
            if (!this.uris.has(id)) {
                this.uris.set(id, null);
                changed = true;
            }
        }
        if (changed) {
            this.listeners.forEach((listener) => listener());
        }
    }

    /** Adds or replaces pictures; the blocks showing them draw again. */
    set(entries: Record<string, string>) {
        let changed = false;
        for (const [id, uri] of Object.entries(entries)) {
            if (this.uris.get(id) !== uri) {
                this.uris.set(id, uri);
                changed = true;
            }
        }
        if (changed) {
            this.listeners.forEach((listener) => listener());
        }
    }

    subscribe(listener: () => void) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
}

/**
 * The web's picture node with a plain DOM view: the picture from `images`,
 * else its alt text. Same name, attributes and Markdown, so the schema and
 * the fence it writes back are the web's; only the drawing differs.
 */
export function pageImageWithView(images: PageImages): AnyExtension {
    return PageImageNode.extend({
        addNodeView() {
            return ({ node }) => {
                const dom = document.createElement('div');
                dom.setAttribute('data-page-image', '');
                dom.contentEditable = 'false';
                let current = node;
                const draw = () => {
                    const id = typeof current.attrs.id === 'string' ? current.attrs.id : '';
                    const alt = typeof current.attrs.alt === 'string' ? current.attrs.alt : '';
                    const uri = images.get(id);
                    dom.replaceChildren();
                    if (uri) {
                        const img = document.createElement('img');
                        img.src = uri;
                        img.alt = alt;
                        dom.append(img);
                    } else if (images.isUnavailable(id)) {
                        dom.setAttribute('data-unavailable', '');
                        dom.textContent = pictureUnavailable(alt);
                    } else {
                        dom.textContent = alt || PICTURE_PLACEHOLDER;
                    }
                    if (uri || !images.isUnavailable(id)) {
                        dom.removeAttribute('data-unavailable');
                    }
                };
                draw();
                const unsubscribe = images.subscribe(draw);
                return {
                    dom,
                    update: (next) => {
                        if (next.type !== current.type) {
                            return false;
                        }
                        current = next;
                        draw();
                        return true;
                    },
                    ignoreMutation: () => true,
                    destroy: unsubscribe,
                };
            };
        },
    });
}
