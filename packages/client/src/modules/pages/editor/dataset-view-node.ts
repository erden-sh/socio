import { Node, mergeAttributes } from '@tiptap/core';

import { DATASET_VIEW_LANG, viewDraft, viewSpecBody, type ViewDraft } from '@socio/shared/dataset-view';

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        datasetView: {
            /** Inserts a dataset view block (empty: its editor opens). */
            insertDatasetView: (spec?: Partial<ViewDraft>) => ReturnType;
        };
    }
}

/** The node's attributes, from a draft spec: one attribute per field. */
export const viewAttrs = (draft: ViewDraft) => ({
    datasetId: draft.datasetId,
    query: draft.query,
    params: draft.params ?? null,
    display: draft.display,
    x: draft.x ?? null,
    y: draft.y ?? null,
    title: draft.title ?? null,
    refresh: draft.refresh ?? null,
});
/** The spec a node stands for (attributes back to a draft). */
export const nodeDraft = (attrs: Record<string, unknown>): ViewDraft =>
    viewDraft(attrs) ?? { datasetId: '', query: '', display: 'table' };

/** Whether a fenced code token is a view block, and its spec if so. */
export function viewToken(token: { lang?: string; text?: string }) {
    if (token.lang?.trim().split(/\s+/)[0] !== DATASET_VIEW_LANG) {
        return;
    }
    try {
        return viewDraft(JSON.parse(token.text ?? ''));
    } catch {
        return undefined;
    }
}

/**
 * The "Dataset view" block. In Markdown it is a ```dataset-view fenced
 * block with the spec as JSON (`packages/shared/src/dataset-view.ts`); a fence with
 * that name whose JSON doesn't parse stays an ordinary code block, so
 * nothing is lost. The schema node lives here, without a view, so the
 * Markdown checks (`markdown.ts`) need no React; RichEditor adds the live
 * view (`DatasetViewBlock.tsx`).
 */
export const DatasetViewNode = Node.create({
    name: 'datasetView',
    group: 'block',
    atom: true,
    selectable: true,
    draggable: true,
    addAttributes() {
        return {
            datasetId: { default: '' },
            query: { default: '' },
            params: { default: null },
            display: { default: 'table' },
            x: { default: null },
            y: { default: null },
            title: { default: null },
            refresh: { default: null },
        };
    },
    parseHTML() {
        return [
            {
                tag: 'div[data-dataset-view]',
                getAttrs: (element) => {
                    try {
                        const draft = viewDraft(JSON.parse(element.getAttribute('data-dataset-view') ?? ''));
                        return draft ? viewAttrs(draft) : false;
                    } catch {
                        return false;
                    }
                },
            },
        ];
    },
    renderHTML({ node, HTMLAttributes }) {
        const draft = nodeDraft(node.attrs);
        return [
            'div',
            mergeAttributes(HTMLAttributes, {
                'data-dataset-view': JSON.stringify(draft),
            }),
            draft.title || 'Dataset view',
        ];
    },
    markdownTokenName: 'code',
    parseMarkdown: (token, helpers) => {
        const draft = viewToken(token);
        // Not a view: the code block handles it.
        if (!draft) {
            return [];
        }
        return helpers.createNode('datasetView', viewAttrs(draft));
    },
    renderMarkdown: (node) => `\`\`\`${DATASET_VIEW_LANG}\n${viewSpecBody(nodeDraft(node.attrs ?? {}))}\n\`\`\``,
    addCommands() {
        return {
            insertDatasetView:
                (spec = {}) =>
                ({ commands }) =>
                    commands.insertContent({
                        type: this.name,
                        attrs: viewAttrs(nodeDraft({ datasetId: '', query: '', ...spec }) as ViewDraft),
                    }),
        };
    },
});
