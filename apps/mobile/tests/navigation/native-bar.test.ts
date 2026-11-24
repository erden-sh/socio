import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
    barSearch,
    barSignature,
    introTile,
    iosBarItem,
    iosBarItems,
    MODULE_TONE_PLACE,
    TONE_PLACES,
    toneBarOptions,
} from '../../src/navigation/bar-items';
import { uikitInsets } from '../../src/ui/screen-insets';

// CB-420 (the owner, 2026-11-18: the web's brand in each platform's own
// components): a page's bar items, said once, as iOS's UIBarButtonItems and
// Android's Material actions take them; the module's tone in the bar;
// and the screens UIKit insets under the bar.

const src = (file: string) => readFileSync(join(import.meta.dirname, '../../src', file), 'utf8');
const noop = () => {};

describe('the bar items', () => {
    it('are UIBarButtonItems on iOS: an SF Symbol, or the label where there is none, in glass', () => {
        expect(iosBarItem({ id: 'board-new-issue', label: 'New issue', symbol: 'plus', onPress: noop })).toEqual({
            type: 'button',
            label: 'New issue',
            icon: { type: 'sfSymbol', name: 'plus' },
            onPress: noop,
            variant: 'plain',
            identifier: 'board-new-issue',
            accessibilityLabel: 'New issue',
        });
        const done = iosBarItem({
            id: 'board-select-done',
            label: 'Done',
            prominent: true,
            disabled: false,
            onPress: noop,
        });
        expect(done).toMatchObject({ type: 'button', label: 'Done', variant: 'prominent', disabled: false });
        expect(done).not.toHaveProperty('icon');
        expect(iosBarItem({ id: 'x', label: 'Edit', hint: 'Opens it', onPress: noop })).toMatchObject({
            accessibilityHint: 'Opens it',
        });
    });

    it('keep their order, the first at the bar’s edge, and hand a custom one to the screen', () => {
        const items = iosBarItems(
            [
                { id: 'a', label: 'A', symbol: 'plus', onPress: noop },
                { kind: 'custom', id: 'b', signature: 's' },
            ],
            (item) => ({ type: 'spacing', spacing: item.id.length }),
        );
        expect(items.map((item) => item.type)).toEqual(['button', 'spacing']);
    });

    it('set the bar again only when what it shows changes, never for a new handler', () => {
        const base = { title: 'Issues', items: [{ id: 'a', label: 'Select', onPress: noop }] };
        const same = barSignature({ title: 'Issues', items: [{ id: 'a', label: 'Select', onPress: () => {} }] });
        expect(barSignature(base)).toBe(same);
        expect(barSignature({ ...base, title: '3 selected' })).not.toBe(same);
        expect(
            barSignature({ title: 'Issues', items: [{ id: 'a', label: 'Select', disabled: true, onPress: noop }] }),
        ).not.toBe(same);
        expect(barSignature({ ...base, search: 'Search' })).not.toBe(same);
        expect(barSignature({ ...base, extra: 'dark' })).not.toBe(same);
        expect(barSignature({ title: 'x', items: [{ kind: 'custom', id: 'k', signature: '1' }] })).not.toBe(
            barSignature({ title: 'x', items: [{ kind: 'custom', id: 'k', signature: '2' }] }),
        );
    });

    it('put the search field in the bar on iOS only; Android keeps the page’s drawn one', () => {
        expect(barSearch('ios')).toBe(true);
        expect(barSearch('android')).toBe(false);
    });
});

describe('the module’s tone in the bar', () => {
    const colors = { tone: '#bb4d00', bar: '#242424' };

    it('has one switch, set to the owner’s pick (2026-11-19): the tile leading the first line, the bar neutral', () => {
        expect(TONE_PLACES).toContain(MODULE_TONE_PLACE);
        expect(MODULE_TONE_PLACE).toBe('intro');
        expect(introTile(MODULE_TONE_PLACE)).toBe(true);
        expect(toneBarOptions(MODULE_TONE_PLACE, colors, 'ios')).toEqual({});
        expect(toneBarOptions(MODULE_TONE_PLACE, colors, 'android')).toEqual({});
    });

    it('colors the large title (title), Back and the buttons (tint), or leads the first line with the tile (intro)', () => {
        expect(toneBarOptions('title', colors, 'ios')).toEqual({ headerLargeTitleStyle: { color: '#bb4d00' } });
        // Android's top app bar has one size of title: that one.
        expect(toneBarOptions('title', colors, 'android')).toEqual({ headerTitleStyle: { color: '#bb4d00' } });
        expect(toneBarOptions('tint', colors, 'ios')).toEqual({
            headerTintColor: '#bb4d00',
            headerTitleStyle: { color: '#242424' },
            headerLargeTitleStyle: { color: '#242424' },
        });
        expect(toneBarOptions('intro', colors, 'android')).toEqual({});
        expect(TONE_PLACES.filter(introTile)).toEqual(['intro']);
    });

    it('is set by every module page through the bar, and reset on a page with none', () => {
        const bar = src('navigation/native-bar.tsx');
        expect(bar).toMatch(/toneBarOptions\(\s+MODULE_TONE_PLACE,/);
        expect(bar).toContain("headerTintColor: colors['header-foreground'],");
        expect(bar).toContain('headerLargeTitleStyle: undefined,');
        // Every key each time: setOptions merges, so a search field or a button never outlives its page's mode.
        expect(bar).toContain('headerSearchBarOptions: undefined,');
        expect(bar).toContain('unstable_headerRightItems: undefined,');
    });
});

describe('a screen under the bar', () => {
    it('is inset by UIKit on iOS (no top edge), and keeps its own edges on Android', () => {
        expect(uikitInsets(['right', 'bottom', 'left'], 'ios')).toBe(true);
        expect(uikitInsets(['right', 'left'], 'ios')).toBe(true);
        expect(uikitInsets(['top', 'right', 'left'], 'ios')).toBe(false);
        expect(uikitInsets(['right', 'bottom', 'left'], 'android')).toBe(false);
        const screen = src('ui/screen.tsx');
        expect(screen).toContain(
            "contentInsetAdjustmentBehavior={uikit || !edges.includes('bottom') ? 'automatic' : 'never'}",
        );
        expect(screen).toContain("paddingBottom: edges.includes('bottom') && !(uikit && scroll) ? insets.bottom : 0,");
    });

    it('is the root of every list that scrolls under a large title, which UIKit insets', () => {
        for (const file of ['screens/board.tsx', 'screens/chats.tsx', 'screens/memories.tsx', 'screens/issue.tsx']) {
            expect(src(file), file).toContain('contentInsetAdjustmentBehavior="automatic"');
        }
        // The transcript keeps its end in view itself, so it pads by the bar instead.
        expect(src('screens/chat.tsx')).toContain('contentInsetAdjustmentBehavior="never"');
    });

    it('draws no header of its own anywhere but New chat’s row', () => {
        for (const file of [
            'board',
            'chat',
            'issue',
            'page',
            'space',
            'spaces',
            'memories',
            'runs',
            'schedules',
            'activity',
            'learning',
            'more-item',
        ]) {
            expect(src(`screens/${file}.tsx`), file).not.toMatch(/HeaderBar|PageHeader /);
        }
    });
});

describe("a page's root View", () => {
    // A View with only a background forms no stacking context, so Fabric mounts its children
    // beside it, after an empty view, and UIKit's walk down the first subviews never meets the
    // scroll view: the large title stays open and the content runs under it (iOS pass, CB-420).
    it('keeps its children inside it, so the scroll view is first in the chain', () => {
        const dir = join(import.meta.dirname, '../../src/screens');
        const roots = readdirSync(dir)
            .filter((file) => file.endsWith('.tsx'))
            .flatMap((file) =>
                [...src(`screens/${file}`).matchAll(/<View\b[^<>]*className="flex-1 bg-screen"[^<>]*>/g)]
                    .map((match) => match[0])
                    .filter((tag) => !tag.endsWith('/>'))
                    .map((tag) => ({ file, tag })),
            );
        expect(roots.length).toBeGreaterThan(20);
        expect(roots.filter(({ tag }) => !tag.includes('collapsable={false}'))).toEqual([]);
        expect(src('ui/screen.tsx')).toMatch(/className="flex-1 bg-screen"\s+collapsable=\{false\}/);
    });
});

describe('the transcripts under their bar', () => {
    it("take iOS 26's hard edge, so the bubbles don't show through the two-line title", () => {
        expect(src('navigation/native-bar.tsx')).toContain(
            "scrollEdgeEffects: current.edge === 'hard' ? { top: 'hard' } : undefined",
        );
        for (const file of ['screens/chat.tsx', 'screens/room-parts.tsx']) {
            expect(src(file)).toContain("edge: 'hard'");
        }
    });
});

// CB-421: a bar's ⋯ opens the system's menu from the button, its items useActionMenu's.
describe('a bar button with a menu', () => {
    const menu = {
        actions: [
            { name: 'save-page', label: 'Save as page' },
            { name: 'schedule', label: 'Schedule a task', disabled: true },
            { name: 'delete', label: 'Delete', destructive: true },
        ],
        onAction: vi.fn(),
    };
    const item = { id: 'chat-menu', label: 'Chat menu', symbol: 'ellipsis', onPress: () => {}, menu };

    it('is a UIMenu bar item on iOS, with SF Symbols, red destructive items and dimmed disabled ones', () => {
        const ios = iosBarItem(item);
        expect(ios).toMatchObject({ type: 'menu', identifier: 'chat-menu', accessibilityLabel: 'Chat menu' });
        if (ios.type !== 'menu') {
            throw new Error('not a menu');
        }
        expect(ios.menu.items).toMatchObject([
            { type: 'action', label: 'Save as page', icon: { type: 'sfSymbol', name: 'doc.badge.plus' } },
            { type: 'action', label: 'Schedule a task', disabled: true },
            { type: 'action', label: 'Delete', destructive: true, icon: { name: 'trash' } },
        ]);
        const first = ios.menu.items[0];
        if (first?.type === 'action') {
            first.onPress();
        }
        expect(menu.onAction).toHaveBeenCalledWith('save-page');
    });

    it('sets the bar again when its items change', () => {
        const other = { ...item, menu: { ...menu, actions: menu.actions.slice(0, 1) } };
        expect(barSignature({ items: [item] })).not.toBe(barSignature({ items: [other] }));
    });

    it('is the chat bar’s ⋯, and a Material popup from the icon button on Android', () => {
        const chat = readFileSync(join(import.meta.dirname, '../../src/screens/chat.tsx'), 'utf8');
        expect(chat).toContain('onPress: MENU_TAKES_TAP,\n                          menu,');
        const bar = readFileSync(join(import.meta.dirname, '../../src/navigation/native-bar.tsx'), 'utf8');
        expect(bar).toContain('<ActionMenu request={item.menu} trigger="press" label={item.label} testID={item.id}');
    });
});
