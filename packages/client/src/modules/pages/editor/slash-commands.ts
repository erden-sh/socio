import { Extension, type Editor, type Range } from '@tiptap/core';
import { ReactRenderer } from '@tiptap/react';
import Suggestion, { exitSuggestion, type SuggestionProps } from '@tiptap/suggestion';
import type { ComponentProps } from 'react';

import { SlashMenu, type SlashMenuItem } from './SlashMenu';

type SlashMenuProps = ComponentProps<typeof SlashMenu>;
interface Block {
    title: string;
    description: string;
    run: (editor: Editor, range: Range) => void;
}
const command = (action: (editor: Editor) => void) => (editor: Editor, range: Range) => {
    editor.chain().focus().deleteRange(range).run();
    action(editor);
};
export const blocks: Block[] = [
    {
        title: 'Text',
        description: 'Start with a plain paragraph',
        run: command((e) => e.chain().setParagraph().run()),
    },
    ...([1, 2, 3] as const).map((level) => ({
        title: `Heading ${level}`,
        description:
            level === 1
                ? 'A large section heading'
                : level === 2
                  ? 'A medium section heading'
                  : 'A small section heading',
        run: command((e) => e.chain().setHeading({ level }).run()),
    })),
    {
        title: 'Bullet list',
        description: 'A simple unordered list',
        run: command((e) => e.chain().toggleBulletList().run()),
    },
    {
        title: 'Numbered list',
        description: 'An ordered sequence',
        run: command((e) => e.chain().toggleOrderedList().run()),
    },
    {
        title: 'Checklist',
        description: 'Track things to do',
        run: command((e) => e.chain().toggleTaskList().run()),
    },
    {
        title: 'Quote',
        description: 'Highlight a passage',
        run: command((e) => e.chain().toggleBlockquote().run()),
    },
    {
        title: 'Code',
        description: 'A code block',
        run: command((e) => e.chain().toggleCodeBlock().run()),
    },
    {
        title: 'Divider',
        description: 'Separate sections',
        run: command((e) => e.chain().setHorizontalRule().run()),
    },
    {
        title: 'Table',
        description: 'Three columns with a header',
        run: command((e) => e.chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()),
    },
    {
        title: 'Dataset view',
        description: 'A live table or chart of a dataset',
        run: command((e) => e.chain().insertDatasetView().run()),
    },
];
export const SlashCommands = Extension.create({
    name: 'slashCommands',
    addProseMirrorPlugins() {
        return [
            Suggestion<Block>({
                editor: this.editor,
                char: '/',
                startOfLine: true,
                allowedPrefixes: null,
                items: ({ query }) =>
                    blocks.filter((block) =>
                        `${block.title} ${block.description}`.toLowerCase().includes(query.toLowerCase()),
                    ),
                command: ({ editor, range, props }) => props.run(editor, range),
                render: () => {
                    // The menu (SlashMenu.tsx), in a popup on <body> under the "/".
                    let menu: ReactRenderer<unknown, SlashMenuProps> | undefined;
                    let current: SuggestionProps<Block> | undefined;
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
                            onChoose: (item: SlashMenuItem) => props.command(item as Block),
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
                                    onChoose: (item: SlashMenuItem) => props.command(item as Block),
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
