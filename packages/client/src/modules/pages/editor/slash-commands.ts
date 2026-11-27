import { Extension, type Editor, type Range } from '@tiptap/core';
import { ReactRenderer } from '@tiptap/react';
import Suggestion, { exitSuggestion, type SuggestionProps } from '@tiptap/suggestion';
import type { ComponentProps } from 'react';

import { lowerText } from '@socio/shared/locale';

import { SlashMenu, type SlashMenuItem } from './SlashMenu';

type SlashMenuProps = ComponentProps<typeof SlashMenu>;
/** A block's words: its title and description (pages.editor:blocks), in the page's language. */
export type BlockWords = (id: BlockId) => { title: string; description: string };
export type BlockId =
    | 'text'
    | 'heading-1'
    | 'heading-2'
    | 'heading-3'
    | 'bullet-list'
    | 'numbered-list'
    | 'checklist'
    | 'quote'
    | 'code'
    | 'divider'
    | 'table'
    | 'dataset-view';
interface Block {
    id: BlockId;
    run: (editor: Editor, range: Range) => void;
}
/** A block as the menu shows it: with its words. */
type ShownBlock = Block & SlashMenuItem;
const command = (action: (editor: Editor) => void) => (editor: Editor, range: Range) => {
    editor.chain().focus().deleteRange(range).run();
    action(editor);
};
export const blocks: Block[] = [
    { id: 'text', run: command((e) => e.chain().setParagraph().run()) },
    ...([1, 2, 3] as const).map((level) => ({
        id: `heading-${level}` as const,
        run: command((e) => e.chain().setHeading({ level }).run()),
    })),
    { id: 'bullet-list', run: command((e) => e.chain().toggleBulletList().run()) },
    { id: 'numbered-list', run: command((e) => e.chain().toggleOrderedList().run()) },
    { id: 'checklist', run: command((e) => e.chain().toggleTaskList().run()) },
    { id: 'quote', run: command((e) => e.chain().toggleBlockquote().run()) },
    { id: 'code', run: command((e) => e.chain().toggleCodeBlock().run()) },
    { id: 'divider', run: command((e) => e.chain().setHorizontalRule().run()) },
    {
        id: 'table',
        run: command((e) => e.chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()),
    },
    { id: 'dataset-view', run: command((e) => e.chain().insertDatasetView().run()) },
];
/**
 * The "/" menu. `words` names each block in the page's language
 * (RichEditor passes its translations), so the menu shows and filters
 * by the words the person reads.
 */
export const SlashCommands = Extension.create<{ words: BlockWords }>({
    name: 'slashCommands',
    addOptions() {
        return { words: (id: BlockId) => ({ title: id, description: '' }) };
    },
    addProseMirrorPlugins() {
        const words = this.options.words;
        return [
            Suggestion<ShownBlock>({
                editor: this.editor,
                char: '/',
                startOfLine: true,
                allowedPrefixes: null,
                items: ({ query }) =>
                    blocks
                        .map((block) => ({ ...block, ...words(block.id) }))
                        .filter((block) => lowerText(`${block.title} ${block.description}`).includes(lowerText(query))),
                command: ({ editor, range, props }) => props.run(editor, range),
                render: () => {
                    // The menu (SlashMenu.tsx), in a popup on <body> under the "/".
                    let menu: ReactRenderer<unknown, SlashMenuProps> | undefined;
                    let current: SuggestionProps<ShownBlock> | undefined;
                    let index = 0;
                    const close = () => {
                        menu?.element.remove();
                        menu?.destroy();
                        menu = undefined;
                        const dom = current?.editor.view.dom;
                        dom?.removeAttribute('aria-controls');
                        dom?.removeAttribute('aria-activedescendant');
                        dom?.removeAttribute('aria-autocomplete');
                        document.removeEventListener('pointerdown', outside);
                    };
                    const outside = (event: PointerEvent) => {
                        if (menu && !menu.element.contains(event.target as Node)) {
                            if (current) {
                                exitSuggestion(current.editor.view);
                            }
                            close();
                        }
                    };
                    const paint = () => {
                        if (!menu || !current) {
                            return;
                        }
                        const props = current;
                        menu.updateProps({
                            items: props.items,
                            index,
                            dom: props.editor.view.dom,
                            onChoose: (item: SlashMenuItem) => props.command(item as ShownBlock),
                        });
                        const rect = props.clientRect?.();
                        const style = (menu.element as HTMLElement).style;
                        if (rect) {
                            style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - 332))}px`;
                            style.top = `${Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 360))}px`;
                        }
                    };
                    return {
                        onStart: (props) => {
                            current = props;
                            index = 0;
                            menu = new ReactRenderer(SlashMenu, {
                                editor: props.editor,
                                props: {
                                    items: props.items,
                                    index,
                                    dom: props.editor.view.dom,
                                    onChoose: (item: SlashMenuItem) => props.command(item as ShownBlock),
                                },
                            });
                            const element = menu.element as HTMLElement;
                            element.id = 'document-block-menu';
                            element.style.position = 'fixed';
                            element.style.zIndex = '100';
                            document.body.append(element);
                            props.editor.view.dom.setAttribute('aria-autocomplete', 'list');
                            document.addEventListener('pointerdown', outside);
                            paint();
                        },
                        onUpdate: (props) => {
                            current = props;
                            index = 0;
                            paint();
                        },
                        onExit: close,
                        onKeyDown: ({ event, view }) => {
                            if (event.isComposing || view.composing || event.keyCode === 229) {
                                return false;
                            }
                            if (event.key === 'Escape') {
                                exitSuggestion(view);
                                close();
                                return true;
                            }
                            if (!current?.items.length) {
                                return false;
                            }
                            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                                index =
                                    (index + (event.key === 'ArrowDown' ? 1 : -1) + current.items.length) %
                                    current.items.length;
                                paint();
                                return true;
                            }
                            if (event.key === 'Enter') {
                                current.command(current.items[index]);
                                return true;
                            }
                            return false;
                        },
                    };
                },
            }),
        ];
    },
});
