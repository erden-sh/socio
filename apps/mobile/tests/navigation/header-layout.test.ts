import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    BACK_ICON_SIZE,
    backButtonLayout,
    CHEVRON_INSET_RATIO,
    CONTENT_INSET,
    HEADER_HEIGHT,
    TOUCH_TARGET,
} from '../../src/navigation/header-layout';

// The HeaderBar's edges (src/navigation/header-layout.ts; the PWA comparison's
// 2.6, its priority 10): the chevron on the content's 16 pt edge, the title
// right after it, no divider, and a 44 pt target. The numbers run under Node;
// how the headers use them is read as source.

const src = (file: string) => readFileSync(join(import.meta.dirname, '../../src', file), 'utf8');

describe('the header’s back button', () => {
    const back = backButtonLayout();

    it('puts the chevron’s stroke on the content’s 16 pt edge', () => {
        expect(CONTENT_INSET).toBe(16);
        expect(HEADER_HEIGHT).toBe(64);
        expect(BACK_ICON_SIZE).toBe(20);
        expect(CHEVRON_INSET_RATIO).toBe(8 / 24);
        expect(back.chevronStart).toBe(16);
        // Its box starts at the screen's edge, inside the row's 16 pt padding.
        expect(back.marginLeft).toBe(-16);
        expect(back.paddingLeft).toBe(9.33);
    });

    it('starts the title right after the chevron, not 85 pt in behind a divider', () => {
        expect(back.titleStart).toBe(34.67);
        expect(back.titleStart).toBeLessThan(40);
        expect(back.width).toBe(back.titleStart);
    });

    it('keeps a 44 pt target, extended past its box without moving the title', () => {
        expect(TOUCH_TARGET).toBe(44);
        expect(back.height).toBe(44);
        expect(back.width + back.hitSlop.right).toBeCloseTo(44, 1);
        expect(back.hitSlop).toEqual({ top: 0, bottom: 0, left: 0, right: 9.33 });
    });
});

describe('the headers', () => {
    it('are the system’s bar (CB-420): the drawn HeaderBar is gone, Back stays only on New chat’s own row', () => {
        const bar = src('navigation/header-bar.tsx');
        expect(bar).not.toContain('export function HeaderBar');
        expect(bar).not.toContain('stackHeader');
        expect(bar).toContain('const BACK = backButtonLayout();');
        expect(bar).toContain('hitSlop={BACK.hitSlop}');
        expect(bar).toMatch(/marginLeft: BACK\.marginLeft,\s+paddingLeft: BACK\.paddingLeft,\s+width: BACK\.width,/);
        expect(src('screens/new-chat.tsx')).toContain('<BackButton onPress={navigation.goBack} />');
        expect(src('screens/room-parts.tsx')).not.toContain('BackButton');
        expect(src('screens/new-chat.tsx')).not.toContain('h-4 w-px bg-border');
    });
});

describe('the primary actions', () => {
    it('sit in the bar as native items: New issue and New page as SF Symbols; an issue’s Comment send stays teal', () => {
        expect(src('screens/board.tsx')).toMatch(/id: 'board-new-issue',\s+label: 'New issue',\s+symbol: 'plus',/);
        expect(src('screens/space.tsx')).toMatch(/id: 'space-new-page',\s+label: NEW_PAGE,\s+symbol: 'plus',/);
        expect(src('screens/issue.tsx')).toMatch(/placeholder="Add a comment"\s+send="primary"/);
        // The composer's round send writes out the primary's classes (uniwind reads only literal names);
        // Button fills its primary capsule by style, Increase Contrast's teal on iOS.
        const primary = 'bg-primary active:bg-primary-hover';
        expect(src('ui/button.tsx')).toContain(
            "primary: { box: 'disabled:bg-primary-disabled', padding: 'px-5 py-2' },",
        );
        expect(src('screens/chat-composer.tsx')).toContain(`'${primary}'`);
        expect(src('screens/chat-composer.tsx')).toContain("primary ? 'primary-foreground' : 'white'");
    });
});
