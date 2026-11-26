import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { keyboardDismissMode, keyboardFollow, keyboardScroll } from '../../src/ui/keyboard-scroll';

// CB-418: a long downward swipe hides the keyboard on every scrolling screen
// with a text field (interactive on iOS, on drag on Android), a plain tap in the
// content never does, and on Android the shared Screen scrolls the focused field
// above the keyboard (keyboard-controller's KeyboardAwareScrollView). No React
// Native renderer under Node, so the .tsx files are read as text.

const src = join(import.meta.dirname, '../../src');
const read = (file: string) => readFileSync(join(src, file), 'utf8');

/** The page editor is another batch's; its toolbar's chips scroll sideways. */
const NOT_OURS = /^page-edit/;

/** A vertical scroll container that holds no text field of its own, or must keep the keyboard as it is. */
const EXEMPT: Readonly<Record<string, string>> = {
    // The @ picker scrolls inside the composer: a drag there picks, never hides the keyboard.
    'room-composer.tsx:room-mentions': 'mentions',
};

const SCROLLERS = /<(ScrollView|LegendList|KeyboardAwareLegendList|FlatList)\b/g;

/** Each opening tag's props: to the end of its line, or to its `>` or `/>` at the tag's indent. */
function scrollers(text: string): { tag: string; props: string }[] {
    return [...text.matchAll(SCROLLERS)].map((match) => {
        const start = match.index;
        const lineStart = text.lastIndexOf('\n', start) + 1;
        const indent = /^ */.exec(text.slice(lineStart))?.[0] ?? '';
        const lineEnd = text.indexOf('\n', start);
        const line = text.slice(start, lineEnd);
        if (/>\s*$/.test(line)) {
            return { tag: match[1] ?? '', props: line };
        }
        const close = /\n( *)\/?>/g;
        close.lastIndex = start;
        let end = text.length;
        for (let found = close.exec(text); found !== null; found = close.exec(text)) {
            if (found[1] === indent) {
                end = found.index;
                break;
            }
        }
        return { tag: match[1] ?? '', props: text.slice(start, end) };
    });
}
const HAS_FIELD = /<(TextInput|Field|SearchField|ChatComposer|RoomComposer|Composer)\b/;

describe('the keyboard on scrolling screens (CB-418)', () => {
    it('follows the finger down on iOS and goes on drag on Android', () => {
        expect(keyboardDismissMode('ios')).toBe('interactive');
        expect(keyboardDismissMode('android')).toBe('on-drag');
        expect(keyboardScroll('ios')).toEqual({
            keyboardDismissMode: 'interactive',
            keyboardShouldPersistTaps: 'always',
        });
        expect(keyboardScroll('android')).toEqual({
            keyboardDismissMode: 'on-drag',
            keyboardShouldPersistTaps: 'always',
        });
    });

    it('never dismisses it on a plain tap: taps are always kept, never only the handled ones', () => {
        // 'handled' hides the keyboard on a tap that lands on no button.
        expect(keyboardScroll('ios').keyboardShouldPersistTaps).toBe('always');
        expect(keyboardScroll('android').keyboardShouldPersistTaps).toBe('always');
    });

    it('is the Screen’s: a KeyboardAwareScrollView on Android, UIKit’s insets on iOS', () => {
        const screen = read('ui/screen.tsx');
        expect(screen).toContain("import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';");
        expect(screen).toMatch(/<KeyboardAwareScrollView[\s\S]*\{\.\.\.keyboardScroll\(Platform\.OS\)\}/);
        expect(screen).toContain(
            'const follow = keyboardFollow(Platform.OS, keyboardAware, useScreenFocused(), keyboardInset !== undefined);',
        );
        expect(screen).toContain('enabled={follow.controller}');
        expect(screen).toContain('automaticallyAdjustKeyboardInsets={follow.uikit}');
        expect(screen).toMatch(/bottomOffset=\{KEYBOARD_GAP\}/);
        expect(screen).not.toMatch(/<ScrollView\b/);
    });

    it('is only the focused screen’s: a list under a pushed page never takes its keyboard (CB-461)', () => {
        expect(keyboardFollow('ios', true, true)).toEqual({ controller: false, uikit: true, inset: false });
        expect(keyboardFollow('android', true, true)).toEqual({ controller: true, uikit: false, inset: false });
        for (const os of ['ios', 'android']) {
            expect(keyboardFollow(os, true, false)).toEqual({ controller: false, uikit: false, inset: false });
            expect(keyboardFollow(os, false, true)).toEqual({ controller: false, uikit: false, inset: false });
        }
        // The focus is the navigator's, which leaves on the push, before the page's keyboard shows,
        // and is always on outside a navigator (sign-in, lock).
        const focus = read('navigation/screen-focus.ts');
        expect(focus).toContain('useContext(NavigationContext)');
        expect(focus).toContain('navigation?.isFocused() ?? true');
        expect(focus).toMatch(/addListener\('blur', \(\) => setFocused\(false\)\)/);
        expect(focus).toMatch(/addListener\('focus', \(\) => setFocused\(true\)\)/);
    });

    it('is off only under a KeyboardAvoidingView of the screen’s own (the first run’s composer)', () => {
        const users = readdirSync(join(src, 'screens')).filter((file) =>
            read(`screens/${file}`).includes('keyboardAware={false}'),
        );
        expect(users).toEqual(['first-run.tsx']);
        // Its Screen is laid out first, then placed in the KeyboardAvoidingView (CB-466).
        const firstRun = read('screens/first-run.tsx');
        expect(firstRun).toContain('keyboardAware={false}');
        expect(firstRun).toMatch(/<KeyboardAvoidingView behavior="padding" automaticOffset[\s\S]*\{content\}/);
    });

    it('is never a tab root’s without a field: Search’s keyboard shows before the tab hears it lost focus (CB-462)', async () => {
        const { TAB_ROOT_KEYBOARD } = await import('../../src/screens/tab-edges');
        expect(TAB_ROOT_KEYBOARD).toBe(false);
        const tabs = read('navigation/shell-tabs.tsx');
        const roots = [...tabs.matchAll(/tabStack\('(\w+)', [^,]+, (\w+)Screen\b/g)].map((match) => match[2] ?? '');
        expect(roots).toEqual(['Home', 'Chats', 'Spaces', 'More', 'Search']);
        for (const root of ['home', 'spaces', 'more']) {
            const text = read(`screens/${root}.tsx`);
            // Nothing to lift: no field of its own.
            expect(text, root).not.toMatch(HAS_FIELD);
            expect(text, root).toMatch(/<Screen\s+testID="[\w-]+-screen"[^>]*keyboardAware=\{TAB_ROOT_KEYBOARD\}/);
        }
        // Search follows its own keyboard; Chats' list sets no keyboard insets.
        expect(read('screens/search.tsx')).not.toContain('TAB_ROOT_KEYBOARD');
        expect(read('screens/chats.tsx')).not.toContain('automaticallyAdjustKeyboardInsets');
    });

    it('is on every vertical scroll container of a screen with a text field', () => {
        const missing: string[] = [];
        let checked = 0;
        for (const file of readdirSync(join(src, 'screens'))) {
            if (NOT_OURS.test(file) || !file.endsWith('.tsx')) {
                continue;
            }
            const text = read(`screens/${file}`);
            if (!HAS_FIELD.test(text)) {
                continue;
            }
            for (const { tag, props } of scrollers(text)) {
                if (/\bhorizontal\b/.test(props)) {
                    continue;
                }
                const testID = /testID="([^"]+)"/.exec(props)?.[1];
                if (testID !== undefined && EXEMPT[`${file}:${testID}`] !== undefined) {
                    continue;
                }
                checked += 1;
                if (!props.includes('{...keyboardScroll(Platform.OS)}')) {
                    missing.push(`${file}: <${tag}${testID === undefined ? '' : ` ${testID}`}>`);
                }
                expect(props, file).not.toMatch(/keyboardDismissMode=|keyboardShouldPersistTaps="handled"/);
            }
        }
        expect(missing).toEqual([]);
        expect(checked).toBeGreaterThan(5);
    });

    it('reaches the chat transcript, which isn’t inverted, so a swipe down is the same gesture there', () => {
        const chat = read('screens/chat.tsx');
        const list = scrollers(chat).find((scroller) => scroller.tag === 'KeyboardAwareLegendList')?.props ?? '';
        expect(list).toContain('{...keyboardScroll(Platform.OS)}');
        expect(list).not.toMatch(/^\s*inverted\b/m);
    });
});
