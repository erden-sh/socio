import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    MATERIAL_DIALOG,
    nativePrompt,
    PROMPT_AGAIN,
    promptButtons,
    promptSaveStep,
    refusalOf,
    tooLong,
} from '../../src/shell/text-prompt';

// The text prompts (the owner, 2026-11-19): iOS's own Alert.prompt, a Material 3
// dialog on Android; a refusal said in an alert, then the prompt again with the
// text kept (read as source where the screens draw it).

const src = (file: string) => readFileSync(join(import.meta.dirname, '../../src', file), 'utf8');

describe('the text prompt', () => {
    it('is the system’s on iOS and the drawn Material dialog on Android', () => {
        expect(nativePrompt('ios')).toBe(true);
        expect(nativePrompt('android')).toBe(false);
        const menu = src('screens/action-menu.tsx');
        expect(menu).toContain(
            'return nativePrompt(Platform.OS) ? <IosPrompt {...props} /> : <MaterialPrompt {...props} />;',
        );
        expect(menu).toMatch(/Alert\.prompt\(\s+current\.title,/);
        expect(menu).toContain("current.url === true ? 'url' : 'default'");
    });

    it('asks again with the text when iOS’s Save meets text it can’t take, and refuses text over the limit', () => {
        expect(promptSaveStep('  ', { maxLength: 80 })).toEqual({ kind: 'again' });
        expect(promptSaveStep('Plans', { maxLength: 80 })).toEqual({ kind: 'save' });
        expect(promptSaveStep('x'.repeat(81), { maxLength: 80 })).toEqual({ kind: 'refuse', reason: tooLong(80) });
        expect(promptSaveStep('Plans', { maxLength: 80, canSave: () => false })).toEqual({ kind: 'again' });
        expect(promptSaveStep('', { maxLength: 80, canSave: () => true })).toEqual({ kind: 'save' });
    });

    it('says a refusal in a follow-up alert whose OK opens the prompt again with what was typed', () => {
        expect(refusalOf('A title has 1 to 80 characters.')).toBe('A title has 1 to 80 characters.');
        expect(refusalOf(undefined)).toBeNull();
        expect(refusalOf('')).toBeNull();
        const menu = src('screens/action-menu.tsx');
        expect(menu).toContain('Alert.alert(reason, undefined, [{ text: PROMPT_AGAIN, onPress: () => ask(value) }]);');
        expect(menu).toMatch(
            /const reason = refusalOf\(outcome\);\s+if \(reason !== null\) \{\s+refuse\(reason, text\);/,
        );
        expect(PROMPT_AGAIN).toBe('OK');
    });

    it('puts Cancel first, the extra action destructive, and Save last on iOS', () => {
        expect(promptButtons().map((button) => [button.text, button.style])).toEqual([
            ['Cancel', 'cancel'],
            ['Save', 'default'],
        ]);
        expect(promptButtons('Remove link').map((button) => button.does)).toEqual(['cancel', 'extra', 'save']);
        expect(promptButtons('Remove link')[1]?.style).toBe('destructive');
    });

    it('is Material 3’s dialog on Android: a headline, an outlined field, text buttons at the end', () => {
        expect(MATERIAL_DIALOG).toMatchObject({ radius: 28, padding: 24, buttonHeight: 40, fieldHeight: 56 });
        const menu = src('screens/action-menu.tsx');
        const dialog = menu.slice(menu.indexOf('function MaterialPrompt'), menu.indexOf('function OutlinedField'));
        // Material's dialog headline is headlineSmall, Title 1's place on Material's scale.
        expect(dialog).toContain('<Text accessibilityRole="header" variant="title1">');
        expect(dialog).toContain('<OutlinedField');
        expect(dialog).toContain('className="flex-row flex-wrap items-center justify-end"');
        expect(dialog).toContain('<MaterialTextButton label={CANCEL} onPress={props.onCancel} />');
        expect(dialog).not.toContain('<Button');
        expect(dialog).not.toContain('<Field');
        // Maestro's ids stay: the dialog, its field and its Save.
        expect(dialog).toContain('testID: `${props.testID}-input`');
        expect(dialog).toContain('testID: `${props.testID}-save`');
        // A refusal shows under the field and keeps what was typed.
        expect(dialog).toContain('setError(reason);');
    });

    it('takes every prompt’s refusal from what its Save gives back, never a prop the screen sets', () => {
        const menu = src('screens/action-menu.tsx');
        expect(menu).not.toMatch(/\berror\?: string;\n\s+\/\*\* A web address/);
        expect(src('screens/chats.tsx')).toContain('return `A title has 1 to ${MAX_CHAT_TITLE} characters.`;');
        expect(src('screens/chat-header.tsx')).toContain('return SAVE_CHAT_PAGE_COPY.invalid;');
        expect(src('screens/page-menus.tsx')).toMatch(
            /if \(error instanceof PageWriteError\) \{\s+return error\.message;/,
        );
        expect(src('screens/page-editor-toolbar.tsx')).toContain('return input.error;');
        expect(src('screens/chat.tsx')).toMatch(/if \(action === 'customize'\) \{\s+return SUGGESTION_FAILED;/);
        for (const file of [
            'screens/chats.tsx',
            'screens/chat-header.tsx',
            'screens/page-menus.tsx',
            'screens/page-editor-toolbar.tsx',
            'screens/chat.tsx',
        ]) {
            const source = src(file);
            const prompt = source.slice(source.indexOf('<TextPrompt'));
            expect(prompt.slice(0, prompt.indexOf('/>'))).not.toMatch(/\berror=|\{ error[ :}]/);
        }
    });

    it('keeps the editor’s link prompt on the screen, outside the toolbar that only shows with the keyboard', () => {
        const editor = src('screens/page-editor.tsx');
        expect(editor).toContain('const linkPrompt = useLinkPrompt(session, scope.workspace.origin);');
        expect(editor).toContain('onLink={linkPrompt.open}');
        const toolbarMount = editor.slice(editor.indexOf('{source || !keyboardUp ? null : ('));
        expect(toolbarMount.indexOf('{linkPrompt.element}')).toBeGreaterThan(
            toolbarMount.indexOf('/>\n            )}'),
        );
        const toolbar = src('screens/page-editor-toolbar.tsx');
        const bar = toolbar.slice(
            toolbar.indexOf('export function EditorToolbar'),
            toolbar.indexOf('export function useLinkPrompt'),
        );
        expect(bar).not.toContain('<TextPrompt');
        expect(bar).toContain('onLink(existing);');
    });
});
