import type { AnyExtension } from '@tiptap/core';
import Placeholder from '@tiptap/extension-placeholder';
import { Markdown } from '@tiptap/markdown';
import { EditorContent, ReactNodeViewRenderer, useEditor, useEditorState } from '@tiptap/react';
import { Bold, Italic, List, ListOrdered, Quote, Code2, Undo2, Redo2, Link2 } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';

import { simpleHtmlToMarkdown } from '@socio/shared/text/simple-html';

import { followLink } from '../page-navigation';

import { DatasetViewContext, type DatasetViewPage } from './dataset-view-context';
import { DatasetViewNode } from './dataset-view-node';
import { DatasetViewBlock } from './DatasetViewBlock';
import { EditorLoading } from './EditorLoading';
import { EmbedCardNode } from './embed-card-node';
import { EmbedCardBlock } from './EmbedCardBlock';
import { documentExtensions } from './markdown';
import { PageImageNode } from './page-image-node';
import { PageImageBlock } from './PageImageBlock';
import { SlashCommands } from './slash-commands';

import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

/** The href of the editor link an event landed on, if any. */
function linkHref(root: HTMLElement, target: EventTarget | null) {
    const link = target instanceof Element ? target.closest('a[href]') : null;
    return link && root.contains(link) ? link.getAttribute('href') : null;
}
/** The view block with its live React view (the schema is in markdown.ts). */
const LiveDatasetView = DatasetViewNode.extend({
    addNodeView() {
        return ReactNodeViewRenderer(DatasetViewBlock);
    },
});
/**
 * The link card with its view (CB-230). Its links are the browser's own: a
 * click on one is not the editor's, so it opens in a new tab rather than
 * selecting the card or being followed twice.
 */
const LiveEmbedCard = EmbedCardNode.extend({
    addNodeView() {
        return ReactNodeViewRenderer(EmbedCardBlock, {
            stopEvent: ({ event }) => event.target instanceof Element && !!event.target.closest('a[href]'),
        });
    },
});
/** The picture block with its view (CB-358). */
const LivePageImage = PageImageNode.extend({
    addNodeView() {
        return ReactNodeViewRenderer(PageImageBlock);
    },
});
/** The document's nodes that RichEditor shows with a view of their own. */
const LIVE_NODES: Record<string, AnyExtension> = {
    [DatasetViewNode.name]: LiveDatasetView,
    [EmbedCardNode.name]: LiveEmbedCard,
    [PageImageNode.name]: LivePageImage,
};
export default function RichEditor({
    value,
    onChange,
    onNotice,
    page,
}: {
    value: string;
    onChange: (value: string) => void;
    onNotice: (message: string) => void;
    /** The page being edited: dataset views read through its Space. */
    page?: DatasetViewPage;
}) {
    const change = useRef(onChange);
    change.current = onChange;
    const notice = useRef(onNotice);
    notice.current = onNotice;
    const emitted = useRef(value);
    const editor = useEditor({
        extensions: [
            ...documentExtensions().map((extension) => LIVE_NODES[extension.name] ?? extension),
            Markdown,
            Placeholder.configure({
                placeholder: 'Start writing, or type / for blocks…',
            }),
            SlashCommands,
        ],
        // Simple HTML reads as its Markdown; the page keeps its text until an edit.
        content: simpleHtmlToMarkdown(value),
        contentType: 'markdown',
        immediatelyRender: false,
        editorProps: {
            attributes: {
                class: 'document-prose',
                'aria-label': 'Page content',
                role: 'textbox',
                'aria-multiline': 'true',
            },
            // Browsers don't follow links inside contentEditable, so the editor
            // does. A plain click follows the link (a page in this tab, an external
            // URL in a new one); Cmd/Ctrl+click and middle-click open a new tab.
            // Shift+click, Alt+click and drags select text instead; ProseMirror
            // doesn't call handleClick after a drag or a Shift+click.
            handleClick: (view, _pos, event) => {
                if (event.button !== 0 || event.altKey || event.shiftKey) {
                    return false;
                }
                const href = linkHref(view.dom, event.target);
                if (!followLink(href, { newTab: event.metaKey || event.ctrlKey })) {
                    return false;
                }
                event.preventDefault();
                return true;
            },
            handleDOMEvents: {
                // Middle-click: no autoscroll or primary-selection paste on a link.
                mousedown: (view, event) => {
                    if (event.button !== 1 || !linkHref(view.dom, event.target)) {
                        return false;
                    }
                    event.preventDefault();
                    return true;
                },
                auxclick: (view, event) => {
                    if (event.button !== 1) {
                        return false;
                    }
                    if (!followLink(linkHref(view.dom, event.target), { newTab: true })) {
                        return false;
                    }
                    event.preventDefault();
                    return true;
                },
            },
            handlePaste: (_view, event) => {
                const html = event.clipboardData?.getData('text/html') ?? '';
                if (/<(img|iframe|script)\b/i.test(html)) {
                    event.preventDefault();
                    notice.current(
                        'Images and embedded content are not supported here. Use Markdown source to keep their original markup.',
                    );
                    return true;
                }
                return false;
            },
        },
        onUpdate: ({ editor }) => {
            const markdown = editor.getMarkdown();
            emitted.current = markdown;
            change.current(markdown);
        },
    });
    const state = useEditorState({
        editor,
        selector: ({ editor }) =>
            editor
                ? {
                      bold: editor.isActive('bold'),
                      italic: editor.isActive('italic'),
                      bullet: editor.isActive('bulletList'),
                      ordered: editor.isActive('orderedList'),
                      quote: editor.isActive('blockquote'),
                      code: editor.isActive('codeBlock'),
                      undo: editor.can().undo(),
                      redo: editor.can().redo(),
                  }
                : null,
    });
    useEffect(() => {
        if (editor && value !== emitted.current) {
            emitted.current = value;
            editor.commands.setContent(simpleHtmlToMarkdown(value), {
                contentType: 'markdown',
                emitUpdate: false,
            });
        }
    }, [editor, value]);
    if (!editor) {
        return <EditorLoading />;
    }
    const addLink = () => {
        const url = window.prompt(
            'Link URL (https:// or an internal page link)',
            editor.getAttributes('link').href ?? '',
        );
        if (url === null) {
            return;
        }
        if (!url) {
            editor.chain().focus().unsetLink().run();
            return;
        }
        if (!/^(https?:\/\/|\/#\/spaces\/)/i.test(url)) {
            onNotice('Use a public http(s) URL or an internal page link.');
            return;
        }
        editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    };
    const divider = (
        <Separator orientation="vertical" className="mx-1.5 data-[orientation=vertical]:h-[17px] max-[700px]:mx-1" />
    );
    return (
        <>
            <TooltipProvider delayDuration={500}>
                <div
                    data-slot="format-toolbar"
                    className="mb-[27px] flex flex-wrap items-center gap-0.5 border-b border-border/70 py-1 max-[700px]:gap-0"
                    role="toolbar"
                    aria-label="Text formatting"
                >
                    <ToolbarButton
                        label="Bold"
                        hint="Bold (⌘/Ctrl B)"
                        pressed={state?.bold}
                        onClick={() => editor.chain().focus().toggleBold().run()}
                    >
                        <Bold size={16} />
                    </ToolbarButton>
                    <ToolbarButton
                        label="Italic"
                        hint="Italic (⌘/Ctrl I)"
                        pressed={state?.italic}
                        onClick={() => editor.chain().focus().toggleItalic().run()}
                    >
                        <Italic size={16} />
                    </ToolbarButton>
                    {divider}
                    <ToolbarButton
                        label="Bullet list"
                        pressed={state?.bullet}
                        onClick={() => editor.chain().focus().toggleBulletList().run()}
                    >
                        <List size={17} />
                    </ToolbarButton>
                    <ToolbarButton
                        label="Numbered list"
                        pressed={state?.ordered}
                        onClick={() => editor.chain().focus().toggleOrderedList().run()}
                    >
                        <ListOrdered size={17} />
                    </ToolbarButton>
                    <ToolbarButton
                        label="Quote"
                        pressed={state?.quote}
                        onClick={() => editor.chain().focus().toggleBlockquote().run()}
                    >
                        <Quote size={15} />
                    </ToolbarButton>
                    <ToolbarButton
                        label="Code block"
                        pressed={state?.code}
                        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
                    >
                        <Code2 size={17} />
                    </ToolbarButton>
                    <ToolbarButton label="Add link" onClick={addLink}>
                        <Link2 size={16} />
                    </ToolbarButton>
                    {divider}
                    <ToolbarButton
                        label="Undo"
                        disabled={!state?.undo}
                        onClick={() => editor.chain().focus().undo().run()}
                    >
                        <Undo2 size={16} />
                    </ToolbarButton>
                    <ToolbarButton
                        label="Redo"
                        disabled={!state?.redo}
                        onClick={() => editor.chain().focus().redo().run()}
                    >
                        <Redo2 size={16} />
                    </ToolbarButton>
                </div>
            </TooltipProvider>
            <DatasetViewContext.Provider value={page ?? null}>
                <EditorContent editor={editor} />
            </DatasetViewContext.Provider>
            <p data-slot="editor-hint" className="mt-9 mb-[1em] text-[11px] text-muted-foreground">
                Type <kbd className="rounded-[3px] border bg-muted/40 px-1 [font:inherit]">/</kbd> for blocks · ⌘/Ctrl +
                S to save
            </p>
        </>
    );
}

/**
 * A toolbar button: a toggle when it has `pressed`, named by `label`, with
 * its tooltip (`hint`, or the label).
 */
function ToolbarButton({
    label,
    hint = label,
    pressed,
    disabled,
    onClick,
    children,
}: {
    label: string;
    hint?: string;
    pressed?: boolean;
    disabled?: boolean;
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    variant="ghost"
                    aria-label={label}
                    aria-pressed={pressed}
                    disabled={disabled}
                    className="size-8.5 min-w-0 rounded-md p-0 text-muted-foreground hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground max-[700px]:h-11 max-[700px]:w-9"
                    onClick={onClick}
                >
                    {children}
                </Button>
            </TooltipTrigger>
            <TooltipContent>{hint}</TooltipContent>
        </Tooltip>
    );
}
