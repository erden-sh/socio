import { pageLink } from '../shell/page-reader';

import { type EditorCommand, type EditorState, LINK_HREF } from './bridge';

// The page editor's toolbar, with no React Native, so
// tests/editor runs it under Node: its buttons in order, each one's state from
// the WebView's `socio-state`, and the link prompt's rule. The screen
// (screens/page-editor-toolbar.tsx) draws them over the keyboard.
//
// The buttons are the web's toolbar (RichEditor.tsx: Bold, Italic, the lists,
// Quote, Code block, Add link, Undo, Redo) with the slash menu's headings 1 to
// 3 and task list, which a phone has no `/` for. Undo and Redo stay at the end,
// outside the row that scrolls.
//
// Links take the web's rule (`^(https?:\/\/|\/#\/spaces\/)`, any case): a web
// address or a page of this workspace. A link to one of the workspace's pages
// or Spaces, in any form the reader opens (`pageLink`: the path, the old hash
// route, or the full address on the workspace's origin), is written as
// `/#/spaces/…`, the web's form for page links. Empty unlinks, as on the web.

export type ToolbarAction = EditorCommand | 'link' | 'pasteImage';

export interface ToolbarButton {
    readonly action: ToolbarAction;
    /** What a screen reader says, and the long-press hint. */
    readonly label: string;
    /** A toggle (a mark or block that is on or off under the selection). */
    readonly toggle: boolean;
}

/** The scrolling row, in order. */
export const FORMAT_BUTTONS: readonly ToolbarButton[] = [
    { action: 'bold', label: 'Bold', toggle: true },
    { action: 'italic', label: 'Italic', toggle: true },
    { action: 'heading1', label: 'Heading 1', toggle: true },
    { action: 'heading2', label: 'Heading 2', toggle: true },
    { action: 'heading3', label: 'Heading 3', toggle: true },
    { action: 'bulletList', label: 'Bullet list', toggle: true },
    { action: 'orderedList', label: 'Numbered list', toggle: true },
    { action: 'taskList', label: 'Task list', toggle: true },
    { action: 'blockquote', label: 'Quote', toggle: true },
    { action: 'codeBlock', label: 'Code block', toggle: true },
    { action: 'link', label: 'Add link', toggle: true },
];

/**
 * Paste image, after the formatting buttons, on a page's editor only:
 * on while the clipboard holds an image (`hasImageAsync`, which never
 * prompts; read again as the screen shows, on each return and on the
 * clipboard's change, never on a timer) and no paste is going. The clipboard
 * is read (`getImageAsync`) only on the tap.
 */
export const PASTE_IMAGE_BUTTON: ToolbarButton = { action: 'pasteImage', label: 'Paste image', toggle: false };

/** At the row's end, always in view. */
export const HISTORY_BUTTONS: readonly ToolbarButton[] = [
    { action: 'undo', label: 'Undo', toggle: false },
    { action: 'redo', label: 'Redo', toggle: false },
];

export interface ToolbarButtonView extends ToolbarButton {
    /** On under the selection (a toggle). */
    readonly active: boolean;
    readonly disabled: boolean;
}

function isActive(action: ToolbarAction, state: EditorState): boolean {
    switch (action) {
        case 'heading1':
            return state.heading === 1;
        case 'heading2':
            return state.heading === 2;
        case 'heading3':
            return state.heading === 3;
        case 'bold':
        case 'italic':
        case 'link':
        case 'bulletList':
        case 'orderedList':
        case 'taskList':
        case 'blockquote':
        case 'codeBlock':
            return state.active.includes(action);
        default:
            return false;
    }
}

/**
 * Each button as the selection has it. Before the WebView's first state (or
 * with the editor not taking commands), every button is off and disabled.
 */
export function toolbarButtons(
    buttons: readonly ToolbarButton[],
    state: EditorState | null,
    ready: boolean,
    /** Paste image's: the clipboard holds an image and no paste is going. */
    canPasteImage = false,
): ToolbarButtonView[] {
    return buttons.map((button) => {
        if (state === null || !ready) {
            return { ...button, active: false, disabled: true };
        }
        const disabled =
            (button.action === 'undo' && !state.canUndo) ||
            (button.action === 'redo' && !state.canRedo) ||
            (button.action === 'pasteImage' && !canPasteImage);
        return { ...button, active: button.toggle && isActive(button.action, state), disabled };
    });
}

/** The link prompt's words (the web's `window.prompt` and its notice). */
export const LINK_PROMPT_TITLE = 'Add link';
export const LINK_PROMPT_EDIT_TITLE = 'Edit link';
export const LINK_PROMPT_LABEL = 'Link URL (https:// or an internal page link)';
export const LINK_INVALID = 'Use a public http(s) URL or an internal page link.';
export const LINK_REMOVE = 'Remove link';

/** What the link prompt's text does: link to `href`, unlink, or nothing with the web's words. */
export type LinkInput =
    | { readonly kind: 'link'; readonly href: string }
    | { readonly kind: 'unlink' }
    | { readonly kind: 'invalid'; readonly error: string };

/**
 * Whether the link prompt's Save takes `text`: anything but blank, and blank
 * too when the selection has a link (`existing`), which Save then removes, as
 * the web's prompt does. Blank with no link would do nothing.
 */
export const linkSaveEnabled = (text: string, existing: string | null) => text.trim() !== '' || existing !== null;

const pathPart = (value: string) => encodeURIComponent(value);

/** The prompt's text, by the web's rule, with the workspace's page links in the `/#/spaces/…` form. */
export function linkInput(text: string, origin: string): LinkInput {
    const value = text.trim();
    if (value === '') {
        return { kind: 'unlink' };
    }
    const page = pageLink(value, origin);
    if (page !== null) {
        const space = `/#/spaces/${pathPart(page.spaceId)}`;
        return { kind: 'link', href: page.kind === 'page' ? `${space}/pages/${pathPart(page.pageId)}` : space };
    }
    if (value.length > 2048 || /\s/.test(value) || !LINK_HREF.test(value)) {
        return { kind: 'invalid', error: LINK_INVALID };
    }
    return { kind: 'link', href: value };
}
