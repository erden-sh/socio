import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { EDITOR_COMMANDS, type EditorState, LINK_HREF, toWeb } from '../../src/editor/bridge';
import {
    FORMAT_BUTTONS,
    HISTORY_BUTTONS,
    LINK_INVALID,
    linkInput,
    linkSaveEnabled,
    PASTE_IMAGE_BUTTON,
    toolbarButtons,
} from '../../src/editor/toolbar';

// The page editor's toolbar (src/editor/toolbar.ts): its buttons, each
// one's state from the WebView's `socio-state`, and the link prompt's rule,
// the web's (RichEditor.tsx's `addLink`), with the workspace's page links in
// the `/#/spaces/…` form.

const ORIGIN = 'https://brain.example.test';

const state = (patch: Partial<EditorState> = {}): EditorState => ({
    unsent: false,
    canUndo: true,
    canRedo: false,
    heading: 0,
    active: [],
    link: null,
    ...patch,
});

describe('the buttons', () => {
    it('are the web toolbar’s, with headings 1 to 3 and the task list, Undo and Redo last', () => {
        expect(FORMAT_BUTTONS.map((button) => button.label)).toEqual([
            'Bold',
            'Italic',
            'Heading 1',
            'Heading 2',
            'Heading 3',
            'Bullet list',
            'Numbered list',
            'Task list',
            'Quote',
            'Code block',
            'Add link',
        ]);
        expect(HISTORY_BUTTONS.map((button) => button.label)).toEqual(['Undo', 'Redo']);
        for (const button of [...FORMAT_BUTTONS, ...HISTORY_BUTTONS]) {
            expect(button.action === 'link' || (EDITOR_COMMANDS as readonly string[]).includes(button.action)).toBe(
                true,
            );
        }
    });

    it('carry the web toolbar’s labels', () => {
        const web = readFileSync(
            new URL('../../../../packages/client/src/modules/pages/editor/RichEditor.tsx', import.meta.url),
            'utf8',
        );
        // The web's words are its en-US dictionary's (pages.editor).
        const { toolbar } = JSON.parse(
            readFileSync(new URL('../../../../packages/i18n/locales/en-US/pages.editor.json', import.meta.url), 'utf8'),
        ) as { toolbar: Record<string, string> };
        for (const [key, label] of [
            ['bold', 'Bold'],
            ['italic', 'Italic'],
            ['bullet-list', 'Bullet list'],
            ['numbered-list', 'Numbered list'],
            ['quote', 'Quote'],
            ['code-block', 'Code block'],
            ['link', 'Add link'],
            ['undo', 'Undo'],
            ['redo', 'Redo'],
        ]) {
            expect(web).toContain(`label={t('pages.editor:toolbar.${key}')}`);
            expect(toolbar[key!]).toBe(label);
        }
    });

    it('are off and disabled before the WebView’s first state, or while the editor takes no command', () => {
        for (const view of [
            ...toolbarButtons(FORMAT_BUTTONS, null, true),
            ...toolbarButtons(FORMAT_BUTTONS, state(), false),
        ]) {
            expect(view).toMatchObject({ active: false, disabled: true });
        }
    });

    it('show what is on under the selection', () => {
        const views = toolbarButtons(FORMAT_BUTTONS, state({ heading: 2, active: ['bold', 'taskList', 'link'] }), true);
        const on = views.filter((view) => view.active).map((view) => view.action);
        expect(on).toEqual(['bold', 'heading2', 'taskList', 'link']);
        expect(views.every((view) => !view.disabled)).toBe(true);
    });

    it('disable Undo and Redo by what the history holds', () => {
        const views = toolbarButtons(HISTORY_BUTTONS, state({ canUndo: false, canRedo: true }), true);
        expect(views.map((view) => [view.action, view.disabled, view.active])).toEqual([
            ['undo', true, false],
            ['redo', false, false],
        ]);
    });

    it('turn Paste image on only while the clipboard holds an image and the editor takes it', () => {
        expect(PASTE_IMAGE_BUTTON).toEqual({ action: 'pasteImage', label: 'Paste image', toggle: false });
        const of = (ready: boolean, canPaste: boolean, current: EditorState | null = state()) =>
            toolbarButtons([PASTE_IMAGE_BUTTON], current, ready, canPaste)[0]!.disabled;
        expect(of(true, true)).toBe(false);
        expect(of(true, false)).toBe(true);
        expect(of(false, true)).toBe(true);
        expect(of(true, true, null)).toBe(true);
        // The other buttons never read it.
        expect(toolbarButtons(FORMAT_BUTTONS, state(), true, false).every((view) => !view.disabled)).toBe(true);
    });
});

describe('the link prompt', () => {
    it('lets Save take a blank field when the selection has a link, which it then removes', () => {
        expect(linkSaveEnabled('', 'https://example.com')).toBe(true);
        expect(linkSaveEnabled('   ', '/#/spaces/s1')).toBe(true);
        expect(linkInput('   ', ORIGIN)).toEqual({ kind: 'unlink' });
        // With no link, blank does nothing: Save stays off.
        expect(linkSaveEnabled('  ', null)).toBe(false);
        expect(linkSaveEnabled('https://example.com', null)).toBe(true);
    });

    it('takes a web address as typed, in any case, trimmed', () => {
        expect(linkInput('  https://example.com/a?b=c ', ORIGIN)).toEqual({
            kind: 'link',
            href: 'https://example.com/a?b=c',
        });
        expect(linkInput('HTTP://EXAMPLE.COM', ORIGIN)).toEqual({ kind: 'link', href: 'HTTP://EXAMPLE.COM' });
    });

    it('unlinks when emptied, as the web does', () => {
        expect(linkInput('   ', ORIGIN)).toEqual({ kind: 'unlink' });
    });

    it('writes the workspace’s page and Space links in the /#/spaces/ form, from any form the reader opens', () => {
        const page = { kind: 'link', href: '/#/spaces/s%201/pages/p1' };
        expect(linkInput('/#/spaces/s%201/pages/p1', ORIGIN)).toEqual(page);
        expect(linkInput('/spaces/s%201/pages/p1', ORIGIN)).toEqual(page);
        expect(linkInput(`${ORIGIN}/spaces/s%201/pages/p1`, ORIGIN)).toEqual(page);
        expect(linkInput(`${ORIGIN}/#/spaces/s%201/pages/p1`, ORIGIN)).toEqual(page);
        expect(linkInput('/spaces/s1', ORIGIN)).toEqual({ kind: 'link', href: '/#/spaces/s1' });
    });

    it('refuses anything else with the web’s words', () => {
        for (const text of [
            'javascript:alert(1)',
            'mailto:someone@example.com',
            'example.com',
            '/settings',
            '//evil.example',
            'https://exa mple.com',
            `https://example.com/${'a'.repeat(2048)}`,
        ]) {
            expect(linkInput(text, ORIGIN)).toEqual({ kind: 'invalid', error: LINK_INVALID });
        }
    });

    it('gives only what the bridge takes', () => {
        for (const text of ['https://example.com', '/spaces/s1/pages/p1', `${ORIGIN}/spaces/s1`]) {
            const input = linkInput(text, ORIGIN);
            expect(input.kind).toBe('link');
            if (input.kind === 'link') {
                expect(LINK_HREF.test(input.href)).toBe(true);
                expect(() => toWeb({ type: 'socio-link', payload: { href: input.href } })).not.toThrow();
            }
        }
    });

    it('is the web’s rule', () => {
        const web = readFileSync(
            new URL('../../../../packages/client/src/modules/pages/editor/RichEditor.tsx', import.meta.url),
            'utf8',
        );
        expect(web).toContain(`if (!${LINK_HREF.toString()}.test(url))`);
        expect(web).toContain("onNotice(t('pages.editor:link-invalid'))");
        const words = JSON.parse(
            readFileSync(new URL('../../../../packages/i18n/locales/en-US/pages.editor.json', import.meta.url), 'utf8'),
        ) as { 'link-invalid': string };
        expect(words['link-invalid']).toBe(LINK_INVALID);
    });
});
