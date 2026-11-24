import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { keyboardFooterInset } from '../../src/ui/keyboard-scroll';

// CB-466: on an iPhone, New chat with the keyboard up showed its composer cut
// off (no attach or send) with a blank band, the tab bar's height, between it
// and the keyboard. New chat was a page over the tab bar, so its bottom safe area
// counted it (TabPageInsets; since CB-491 it hides the bar and keeps the window's
// inset, the home indicator); its Screen kept that padding while the
// KeyboardAvoidingView lifted it by the whole keyboard, and the composer sat in
// the scroll view, whose end the padding cut off. The composer is now pinned
// under the scrolling part and gives the inset up as the keyboard comes. No
// React Native renderer under Node, so the .tsx files are read as text.

const src = join(import.meta.dirname, '../../src');
const read = (file: string) => readFileSync(join(src, file), 'utf8');

/** New chat's bottom safe area on an iPhone: the home indicator (no tab bar under it, CB-491). */
const PAGE_BOTTOM = 34;

describe('the new chat composer on the keyboard (CB-466)', () => {
    it('keeps the bottom safe area with the keyboard down and none of it with the keyboard up', () => {
        expect(keyboardFooterInset(PAGE_BOTTOM, 0)).toBe(PAGE_BOTTOM);
        expect(keyboardFooterInset(PAGE_BOTTOM, 1)).toBe(0);
        expect(keyboardFooterInset(PAGE_BOTTOM, 0.5)).toBeCloseTo(PAGE_BOTTOM / 2);
        // keyboard-controller's progress can overshoot with a spring; the inset never goes negative.
        expect(keyboardFooterInset(PAGE_BOTTOM, 1.2)).toBe(0);
        expect(keyboardFooterInset(PAGE_BOTTOM, -0.1)).toBe(PAGE_BOTTOM);
    });

    it('is pinned under the scrolling part on a page with the bottom edge (New chat)', () => {
        const firstRun = read('screens/first-run.tsx');
        // The composer is laid out once, then placed in the scroll view (Home) or pinned (New chat).
        expect(firstRun).toContain("const pinned = edges.includes('bottom');");
        expect(firstRun).toContain('{pinned ? null : composer}');
        expect(firstRun).toContain('<PinnedComposer>{composer}</PinnedComposer>');
        // The Screen keeps no bottom padding of its own under a pinned composer.
        expect(firstRun).toContain("edges={pinned ? edges.filter((edge) => edge !== 'bottom') : edges}");
        // The pinned composer gives the inset up with the keyboard's progress, on the UI thread.
        expect(firstRun).toMatch(/paddingBottom: keyboardFooterInset\(insets\.bottom, progress\.value\)/);
        // New chat is such a page.
        expect(read('screens/new-chat.tsx')).toContain(
            "const PAGE_EDGES: readonly Edge[] = ['top', 'right', 'bottom', 'left'];",
        );
    });

    it('grows with its text: the box inside the paste wrapper never shares a height (flex-1)', () => {
        // flex-1 on the box inside the wrapper is its height there, not its width: pinned, it stayed
        // one line tall and scrolled its text.
        const composer = read('screens/chat-composer.tsx');
        expect(composer).toContain(
            "cx('max-h-36 min-h-10 px-2 py-2 text-base text-foreground', tray === undefined && 'flex-1')",
        );
        expect(composer).not.toContain("'max-h-36 min-h-10 flex-1 px-2 py-2 text-base text-foreground'");
    });

    it('keeps the chat’s composer on the keyboard the same way: its inset hides behind it', () => {
        // The chat's composer pads by the bottom inset, and its sticky view lifts it by the
        // keyboard less that inset, so the padding lies under the keyboard.
        const chat = read('screens/chat.tsx');
        expect(chat).toContain('<KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }}>');
        expect(read('screens/chat-composer.tsx')).toContain(
            'style={{ paddingBottom: 8 + (props.bottomInset === false ? 0 : insets.bottom) }}',
        );
    });
});
