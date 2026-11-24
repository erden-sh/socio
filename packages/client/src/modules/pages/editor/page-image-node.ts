import { Node, mergeAttributes } from '@tiptap/core';

import { PAGE_IMAGE_LANG, pageImage, pageImageBody, pageImageMarkdown, pageImageToken } from '@socio/shared/page-image';

/** The node's attributes as a picture, or undefined when they don't make one. */
const imageOf = (attrs: Record<string, unknown> | undefined) =>
    pageImage({
        id: attrs?.id ?? undefined,
        alt: attrs?.alt || undefined,
        width: attrs?.width ?? undefined,
        height: attrs?.height ?? undefined,
    });

/**
 * The picture block (CB-358): an image made from a person's file the way a
 * cover is (`packages/shared/src/page-image.ts`). In Markdown it is a
 * ```image fenced block holding the embed's id, never `![](url)`; a fence
 * with that name whose JSON doesn't parse stays an ordinary code block.
 *
 * Its attributes are named as TipTap's Image extension names them (`alt`,
 * `width`, `height`), with the embed's `id` in place of `src`, so the node
 * can move onto that extension (its resize) once the dependency is added,
 * without changing what pages store. Selecting and dragging are the atom's
 * own. The schema node lives here, without a view, so the Markdown checks
 * (`markdown.ts`) need no React; RichEditor adds the view
 * (`PageImageBlock.tsx`).
 */
export const PageImageNode = Node.create({
    name: 'pageImage',
    group: 'block',
    atom: true,
    selectable: true,
    draggable: true,
    addAttributes() {
        // No attribute reads the HTML itself: TipTap's default would read
        // each one off the element and coerce it (an alt of "2026" becoming
        // a number), overriding `getAttrs` below, whose validated JSON is
        // the only source.
        const fromJsonOnly = { default: null, parseHTML: () => null };
        return {
            id: { ...fromJsonOnly },
            alt: { ...fromJsonOnly },
            width: { ...fromJsonOnly },
            height: { ...fromJsonOnly },
        };
    },
    parseHTML() {
        return [
            {
                // Only this app's own blocks (copied or cut from a page),
                // written as a div like a link card's, so the paste guard,
                // which refuses any <img>, lets them through; a pasted <img>
                // from elsewhere is never a picture.
                tag: 'div[data-page-image]',
                getAttrs: (element) => {
                    try {
                        const image = pageImage(JSON.parse(element.getAttribute('data-page-image') ?? ''));
                        return image
                            ? {
                                  id: image.id,
                                  alt: image.alt || null,
                                  width: image.width ?? null,
                                  height: image.height ?? null,
                              }
                            : false;
                    } catch {
                        return false;
                    }
                },
            },
        ];
    },
    renderHTML({ node, HTMLAttributes }) {
        // The HTML form is for the clipboard only (the editor draws the
        // block with PageImageBlock), so it holds the picture's JSON, not an
        // <img>, which the paste guard would refuse.
        const image = imageOf(node.attrs);
        return [
            'div',
            mergeAttributes(HTMLAttributes, { 'data-page-image': image ? pageImageBody(image) : '' }),
            image?.alt || 'Image',
        ];
    },
    markdownTokenName: 'code',
    parseMarkdown: (token, helpers) => {
        const image = pageImageToken(token);
        // Not a picture: the code block (or another fence's node) handles it.
        if (!image) {
            return [];
        }
        return helpers.createNode('pageImage', {
            id: image.id,
            alt: image.alt || null,
            width: image.width ?? null,
            height: image.height ?? null,
        });
    },
    renderMarkdown: (node) => {
        const image = imageOf(node.attrs);
        return image
            ? pageImageMarkdown(image)
            : `\`\`\`${PAGE_IMAGE_LANG}\n${JSON.stringify(node.attrs ?? null)}\n\`\`\``;
    },
});
