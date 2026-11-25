// The page editor's TipTap setup inside the WebView: the web's
// document, read and written the web's way. Both the bundle (index.ts) and
// the app's tests (tests/editor/) use it.
//
// documentExtensions() is the web's own (packages/client's pages editor,
// imported from source, never copied): StarterKit, tables, task lists and the
// `dataset-view`, `embed` and `image` atoms, each writing back its exact
// fence. The web swaps those atoms for live React views; here they draw
// their plain HTML, and the native screen shows what they hold.
import type { AnyExtension, Editor } from '@tiptap/core';
import Placeholder from '@tiptap/extension-placeholder';
import { Markdown } from '@tiptap/markdown';
import { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { simpleHtmlToMarkdown } from '@socio/shared/text/simple-html';

import { documentExtensions, rememberLoadedMarkdown } from '../../../packages/client/src/modules/pages/editor/markdown';

import { type PageImages, pageImageWithView } from './page-images';

/** The empty page's hint. The web's adds "or type / for blocks", which the app has no menu for. */
export const PLACEHOLDER = 'Start writing…';

/** The web's paste rule (RichEditor.tsx): HTML holding a picture, a frame or a script is refused whole. */
export const REFUSED_PASTE = /<(img|iframe|script)\b/i;

/** What the web says when it refuses a paste. The bridge carries it to the native side (`socio-notice`). */
export const REFUSED_PASTE_NOTICE =
    'Images and embedded content are not supported here. Use Markdown source to keep their original markup.';

/** The editor element's attributes, the web's ARIA: a multi-line text box named "Page content". */
export const EDITOR_ATTRIBUTES = {
    role: 'textbox',
    'aria-multiline': 'true',
    'aria-label': 'Page content',
} as const;

/**
 * The document's extensions with Markdown and the placeholder. With `images`
 * (the WebView's), the picture block draws the pictures native sent;
 * its schema and Markdown stay the web's.
 */
export const editorExtensions = (images?: PageImages): AnyExtension[] => [
    ...documentExtensions().map((extension) =>
        images && extension.name === 'pageImage' ? pageImageWithView(images) : extension,
    ),
    Markdown,
    Placeholder.configure({ placeholder: PLACEHOLDER }),
];

/** Only what a paste handler reads of the event: a test passes a plain object. */
export type PasteEvent = Pick<ClipboardEvent, 'clipboardData' | 'preventDefault'>;

/**
 * ProseMirror's `editorProps`: the ARIA and the paste rule. `onRefusedPaste`
 * hears each refusal. With `onPasteImage`, a paste holding picture files
 * hands each one over instead (the bridge's `socio-paste-image`; native
 * inserts it after the upload) and puts nothing in the page.
 */
export function editorProps(onRefusedPaste: (notice: string) => void, onPasteImage?: (file: File) => void) {
    return {
        attributes: { ...EDITOR_ATTRIBUTES },
        handlePaste: (_view: EditorView, event: PasteEvent) => {
            const images = Array.from(event.clipboardData?.files ?? []).filter((file) =>
                file.type.startsWith('image/'),
            );
            if (onPasteImage && images.length > 0) {
                event.preventDefault();
                images.forEach(onPasteImage);
                return true;
            }
            const html = event.clipboardData?.getData('text/html') ?? '';
            if (!REFUSED_PASTE.test(html)) {
                return false;
            }
            event.preventDefault();
            onRefusedPaste(REFUSED_PASTE_NOTICE);
            return true;
        },
    };
}

/** Marks the bridge's own transactions (a load, a replace), which are no edit of the person's. */
export const BRIDGE_META = 'socioBridge';

/**
 * Loads a stored page the web's way (RichEditor.tsx: simple HTML read as its
 * Markdown, then set as Markdown) and gives back its text the way an edit
 * writes it: the source itself, as nothing changed (`preservedMarkdown` keeps
 * every untouched block; it reads the source when idle, not now). Opening
 * sends no update, and it isn't an edit: Undo never goes back past it.
 *
 * `addToHistory: false` only keeps the load itself out of the history; the
 * steps from before it (another page, in the same editor) would still be
 * there, and Undo would put them over this page. So the load ends with a
 * fresh state on the same plugins: an empty undo and redo history.
 */
export function loadMarkdown(editor: Editor, stored: string) {
    const source = simpleHtmlToMarkdown(stored);
    editor
        .chain()
        .setMeta('addToHistory', false)
        .setMeta(BRIDGE_META, 'load')
        .setContent(source, { contentType: 'markdown', emitUpdate: false })
        .run();
    const { doc, selection, plugins } = editor.state;
    editor.view.updateState(EditorState.create({ doc, selection, plugins }));
    rememberLoadedMarkdown(editor, source);
    return source;
}

/**
 * The options the bundle hands tentap's `useTenTap` (index.ts). tentap starts
 * its editor with `content: config.initialContent`, which TipTap reads as
 * HTML, then spreads these over it: `content: ''` wins, so whatever a boot
 * config carries never reaches the page. The page comes only through the
 * bridge's `socio-load`, as Markdown.
 */
export function pageEditorOptions(options: {
    images: PageImages;
    onNotice: (notice: string) => void;
    onPasteImage: (file: File) => void;
    onCreate: (editor: Editor) => void;
}) {
    return {
        content: '',
        extensions: editorExtensions(options.images),
        editorProps: editorProps(options.onNotice, options.onPasteImage),
        onCreate: ({ editor }: { editor: Editor }) => options.onCreate(editor),
        // TipTap's stylesheet is already in the page's one <style>
        // (styles.ts); its own would be a <style> the CSP refuses.
        injectCSS: false,
    };
}
