import { Node, mergeAttributes } from '@tiptap/core';

import { EMBED_CARD_LANG, embedCard, embedCardBody, embedCardMarkdown, embedToken } from '@socio/shared/embed-card';

/**
 * The link card block (CB-230): a static snapshot of a linked post, video
 * or article that `/unfurl` saved (`packages/shared/src/embed-card.ts`). In Markdown it
 * is a ```embed fenced block with the card as JSON; a fence with that name
 * whose JSON doesn't parse stays an ordinary code block, so nothing is
 * lost. The schema node lives here, without a view, so the Markdown checks
 * (`markdown.ts`) need no React; RichEditor adds the card's view
 * (`EmbedCardBlock.tsx`).
 */
export const EmbedCardNode = Node.create({
    name: 'embedCard',
    group: 'block',
    atom: true,
    selectable: true,
    draggable: true,
    addAttributes() {
        return { card: { default: null } };
    },
    parseHTML() {
        return [
            {
                tag: 'div[data-embed-card]',
                getAttrs: (element) => {
                    try {
                        const card = embedCard(JSON.parse(element.getAttribute('data-embed-card') ?? ''));
                        return card ? { card } : false;
                    } catch {
                        return false;
                    }
                },
            },
        ];
    },
    renderHTML({ node, HTMLAttributes }) {
        const card = embedCard(node.attrs.card);
        return [
            'div',
            mergeAttributes(HTMLAttributes, {
                'data-embed-card': card ? embedCardBody(card) : '',
            }),
            card?.title || card?.url || 'Link card',
        ];
    },
    markdownTokenName: 'code',
    parseMarkdown: (token, helpers) => {
        const card = embedToken(token);
        // Not a card: the code block (or a dataset view) handles it.
        if (!card) {
            return [];
        }
        return helpers.createNode('embedCard', { card });
    },
    renderMarkdown: (node) => {
        const card = embedCard(node.attrs?.card);
        return card
            ? embedCardMarkdown(card)
            : `\`\`\`${EMBED_CARD_LANG}\n${JSON.stringify(node.attrs?.card ?? null)}\n\`\`\``;
    },
});
