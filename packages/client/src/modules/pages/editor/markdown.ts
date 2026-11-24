import { getSchema, type JSONContent } from '@tiptap/core';
import { TableKit } from '@tiptap/extension-table';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import { MarkdownManager } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';

import { simpleHtmlToMarkdown } from '@socio/shared/text/simple-html';

import { DatasetViewNode } from './dataset-view-node';
import { EmbedCardNode } from './embed-card-node';
import { PageImageNode } from './page-image-node';

export const documentExtensions = () => [
    // Before StarterKit: their ```dataset-view, ```embed and ```image fences
    // win over the code block.
    DatasetViewNode,
    EmbedCardNode,
    PageImageNode,
    StarterKit.configure({
        underline: false,
        link: { openOnClick: false, autolink: false },
        heading: { levels: [1, 2, 3] },
    }),
    TableKit.configure({ table: { resizable: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
];
export const markdownManager = new MarkdownManager({
    extensions: documentExtensions(),
});
const schema = getSchema(documentExtensions());
/**
 * Whether two parsed documents are the same document as the editor holds
 * them. Compared as ProseMirror nodes, not JSON: the parser lists a text's
 * marks in the order the Markdown nested them (`**[a](b)**` is link, then
 * bold), while the schema keeps one order, so the same marks written the
 * other way round (`[**a**](b)`, as the editor saves them) are equal (CB-230).
 */
const sameDocument = (a: JSONContent, b: JSONContent) => schema.nodeFromJSON(a).eq(schema.nodeFromJSON(b));
const allowed = new Set([
    'space',
    'code',
    'heading',
    'table',
    'hr',
    'blockquote',
    'list',
    'list_item',
    'paragraph',
    'text',
    'escape',
    'strong',
    'em',
    'codespan',
    'br',
    'del',
    'link',
    'taskList',
    'taskItem',
]);
/**
 * Whether the rich editor can open this page. Simple HTML (a <blockquote>)
 * is read as its Markdown equivalent; the stored text is not rewritten
 * until the person edits (CB-201).
 */
export function inspectMarkdown(stored: string): {
    supported: boolean;
    reason?: string;
} {
    const source = simpleHtmlToMarkdown(stored);
    try {
        if (
            /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(source) ||
            /^\[\^[^\]]+\]:/m.test(source) ||
            /^\s*(\$\$|:::)/m.test(source)
        ) {
            return {
                supported: false,
                reason: 'This document contains extended Markdown. Source mode preserves it exactly.',
            };
        }
        const tokens = markdownManager.instance.lexer(source);
        let unsupported = false;
        const pending: unknown[] = [tokens];
        while (pending.length) {
            const value = pending.pop();
            if (!value || typeof value !== 'object') {
                continue;
            }
            if (
                'type' in value &&
                typeof value.type === 'string' &&
                (!allowed.has(value.type) ||
                    (value.type === 'heading' &&
                        'depth' in value &&
                        typeof value.depth === 'number' &&
                        value.depth > 3))
            ) {
                unsupported = true;
            }
            pending.push(...Object.values(value));
        }
        if (unsupported) {
            return {
                supported: false,
                reason: 'This document contains images, HTML, or formatting that needs Markdown source mode. Nothing has been changed.',
            };
        }
        const parsed = markdownManager.parse(source);
        const restored = markdownManager.parse(markdownManager.serialize(parsed));
        if (!sameDocument(parsed, restored)) {
            return {
                supported: false,
                reason: 'Some formatting cannot be safely round-tripped. Source mode keeps the original document intact.',
            };
        }
        return { supported: true };
    } catch {
        return {
            supported: false,
            reason: 'This Markdown needs source mode to preserve its contents.',
        };
    }
}
