import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MATERIAL_NAVIGATION_BAR } from '../../src/navigation/presets';
import { ANY_SCHEDULE, schedulesEmpty } from '../../src/shell/schedules';
import { keyboardFollow } from '../../src/ui/keyboard-scroll';
import {
    emptyFill,
    fillCovers,
    IOS_SEARCH_ROW_ON_KEYBOARD,
    keyboardInset,
    SCREEN_BOTTOM_PAD,
} from '../../src/ui/screen-insets';
import {
    CLEAR_FILTERS,
    CLEAR_SEARCH,
    NO_RESULTS,
    QUOTED_QUERY_MAX,
    quotedQuery,
    searchEmpty,
} from '../../src/ui/search-empty';

// CB-552 (TestFlight): a search that matched nothing showed a blank screen on
// iOS, its one line "Nothing matches …" under the status bar. Now it is an
// empty state with Clear search, centered in what shows of the screen, and
// the screen no longer jumps under the bar when the keyboard moves. The
// screens draw on React Native, which the Node tests can't load, so the .tsx
// files are read as text.

const src = join(import.meta.dirname, '../../src');
const read = (file: string) => readFileSync(join(src, file), 'utf8');

/** A function's source, from its declaration to the next top-level declaration. */
function body(source: string, start: string): string {
    const from = source.indexOf(start);
    expect(from, start).toBeGreaterThanOrEqual(0);
    const next = source.slice(from + start.length).search(/\n(?:export )?(?:function|const) /);
    return next < 0 ? source.slice(from) : source.slice(from, from + start.length + next);
}

describe('the empty state for a search (CB-552)', () => {
    it('names the query, says one line and offers Clear search', () => {
        expect(searchEmpty({ query: '  blue  whale ', line: 'Try again.' })).toEqual({
            title: 'No results for “blue whale”',
            line: 'Try again.',
            accessibilityLabel: 'No results for “blue whale”. Try again.',
            announcement: NO_RESULTS,
            clearSearch: true,
            clearFilters: false,
        });
    });

    it('is announced once: the same words whatever more is typed', () => {
        const words = ['b', 'bl', 'blu', 'blue whale'].map((query) => searchEmpty({ query, line: 'x' }).announcement);
        expect(new Set(words)).toEqual(new Set([NO_RESULTS]));
        // A screen's own title is what it says.
        expect(searchEmpty({ query: 'q', title: 'No matching pages', line: 'x' }).announcement).toBe(
            'No matching pages',
        );
    });

    it('cuts a long query with an ellipsis, so the title stays a title', () => {
        const long = 'a'.repeat(QUOTED_QUERY_MAX + 10);
        expect(Array.from(quotedQuery(long))).toHaveLength(QUOTED_QUERY_MAX);
        expect(quotedQuery(long).endsWith('…')).toBe(true);
        expect(quotedQuery('short one')).toBe('short one');
    });

    it('offers Clear filters only where filters are on, and Clear search only where words are typed', () => {
        expect(searchEmpty({ query: '', line: 'x', filtered: true })).toMatchObject({
            title: NO_RESULTS,
            clearSearch: false,
            clearFilters: true,
        });
        expect(schedulesEmpty({ ...ANY_SCHEDULE, status: 'scheduled' })).toMatchObject({
            title: 'No schedules match',
            clearSearch: false,
            clearFilters: true,
        });
        expect(schedulesEmpty({ ...ANY_SCHEDULE, query: 'nightly' })).toMatchObject({
            title: 'No results for “nightly”',
            clearSearch: true,
            clearFilters: false,
        });
    });

    it('is one element for screen readers, announced as it appears, with real buttons', () => {
        const state = body(read('ui/empty-state.tsx'), 'export function SearchEmptyState');
        expect(state).toContain('useAnnouncement(view.announcement, { onAppear: true, shown: false });');
        expect(state).toMatch(
            /accessible\s+accessibilityRole="summary"\s+accessibilityLabel=\{view\.accessibilityLabel\}/,
        );
        expect(state).toContain('<AppSymbol name={SEARCH_EMPTY_SYMBOL}');
        expect(state).toMatch(/<Button\s+label=\{CLEAR_SEARCH\}\s+variant="tinted"\s+onPress=\{onClearSearch\}/);
        expect(state).toMatch(/<Button\s+label=\{CLEAR_FILTERS\}\s+variant="tinted"\s+onPress=\{onClearFilters\}/);
        // Its words scale with Dynamic Type: the type scale's roles, no fixed font sizes.
        expect(state).toContain('<Text variant="title2" weight="bold"');
        expect(state).not.toMatch(/fontSize/);
        expect([CLEAR_SEARCH, CLEAR_FILTERS]).toEqual(['Clear search', 'Clear filters']);
    });
});

describe('Search with no results (CB-552)', () => {
    const search = read('screens/search.tsx');

    it('draws the empty state, not a bare line', () => {
        expect(search).not.toContain('Nothing matches');
        expect(search).toMatch(
            /<SearchEmptyState\s+view=\{searchEmpty\(\{ query, line: SEARCH_EMPTY_LINE \}\)\}\s+onClearSearch=\{clearSearch\}\s+fill=\{fill\}\s+testID="search-no-matches"/,
        );
    });

    it('clears the system field (which sends no change for it), the query, and keeps the focus in the field', () => {
        const clear = /const clearSearch = \(\) => \{[\s\S]*?\n {4}\};/.exec(search)?.[0] ?? '';
        expect(clear).toContain('barField.current?.clearText();');
        expect(clear).toContain("setQuery('');");
        expect(clear).toContain('(inBar ? barField : field).current?.focus();');
        expect(search).toContain('onChange: setQuery, ref: barField');
        // native-bar.tsx hands the ref to the system's search bar.
        expect(read('navigation/native-bar.tsx')).toContain(
            '...(current.search.ref === undefined ? {} : { ref: current.search.ref }),',
        );
    });

    it('pads by the keyboard itself on iOS, whose field is the bar’s, and centers the empty state', () => {
        expect(search).toContain('{...(inBar ? { barKeyboard: fill } : {})}');
        // Its own safe area on iOS, measured by UIKit: the home indicator and the bottom search row.
        expect(search).toContain(
            "return Platform.OS === 'ios' ? <SafeAreaProvider>{props.children}</SafeAreaProvider> : props.children;",
        );
        expect(search).toMatch(/<SearchTabInsets>\s*<Screen/);
        expect(search).toContain('const fill = useEmptyFill(true);');
    });

    it('is what the other searches and filters that match nothing draw', () => {
        for (const [file, id] of [
            ['screens/space.tsx', 'space-search-empty'],
            ['screens/board.tsx', 'board-empty'],
            ['screens/schedules.tsx', 'schedules-no-match'],
        ] as const) {
            const source = read(file);
            expect(source, file).toMatch(new RegExp(`<SearchEmptyState\\s[^<]*?testID="${id}"`));
            expect(source, file).not.toContain('Nothing matches');
        }
        expect(read('screens/board.tsx')).toContain('setPrefs({ ...prefs, filters: NO_FILTERS, components: [] })');
        expect(read('screens/space.tsx')).toContain('{...(inBar && searches ? { barKeyboard: fill } : {})}');
    });
});

describe('the keyboard on a screen whose field is the bar’s (CB-552)', () => {
    it('never lets UIKit’s keyboard insets move it on iOS: the Screen pads its bottom instead', () => {
        // React Native's keyboard insets scrollTo an offset clamped to contentInset, which put
        // Search's content under the bar and the status bar.
        expect(keyboardFollow('ios', true, true, true)).toEqual({ controller: false, uikit: false, inset: true });
        expect(keyboardFollow('ios', true, false, true)).toEqual({ controller: false, uikit: false, inset: false });
        // Android draws its field in the content, so keyboard-controller follows it as before.
        expect(keyboardFollow('android', true, true, true)).toEqual({ controller: true, uikit: false, inset: false });
        const screen = read('ui/screen.tsx');
        expect(screen).toContain('automaticallyAdjustKeyboardInsets={follow.uikit}');
        expect(screen).toMatch(
            /follow\.inset && barKeyboard !== undefined\s*\? \{ contentInset: \{ bottom: barKeyboardInset\(barKeyboard, insets\.bottom\) \} \}/,
        );
    });
});

describe('where the empty state centers (CB-552)', () => {
    it('leaves out what covers the bottom: the safe area (home indicator, bottom row, tab bar) or the keyboard', () => {
        // iOS: Search's own safe area holds the home indicator and the bottom search row (84 pt).
        expect(fillCovers('ios', { safeBottom: 84, keyboard: 0, searchTab: true })).toEqual({
            bottom: 84,
            keyboard: 0,
        });
        // Up, the row rides on the keyboard.
        expect(fillCovers('ios', { safeBottom: 84, keyboard: 336, searchTab: true })).toEqual({
            bottom: 84,
            keyboard: 336 + IOS_SEARCH_ROW_ON_KEYBOARD,
        });
        // A page with its field at the top (a Space): no row on the keyboard.
        expect(fillCovers('ios', { safeBottom: 83, keyboard: 336, searchTab: false }).keyboard).toBe(336);
        // Android: Search's frame runs under the bottom navigation, which the keyboard covers.
        expect(fillCovers('android', { safeBottom: 24, keyboard: 0, searchTab: true })).toEqual({
            bottom: 24 + MATERIAL_NAVIGATION_BAR,
            keyboard: 0,
        });
        expect(fillCovers('android', { safeBottom: 24, keyboard: 300, searchTab: true }).keyboard).toBe(300);
    });

    it('fills from its own top on the screen, which counts the bar once, to what covers the bottom', () => {
        // The coordinator's iPhone 17 Pro numbers: 874 pt tall, the box at 68, the row's top at 790.
        const covers = fillCovers('ios', { safeBottom: 84, keyboard: 0, searchTab: true });
        const fill = emptyFill({ screen: 874, top: 68, covers });
        expect(fill).toBe(874 - 84 - 68 - SCREEN_BOTTOM_PAD);
        // The box and the bottom padding end exactly at the row's top: centered, and nothing scrolls.
        expect(68 + fill + SCREEN_BOTTOM_PAD).toBe(874 - 84);
        expect(emptyFill({ screen: 874, top: 68, covers: { bottom: 84, keyboard: 398 } })).toBe(
            874 - 398 - 68 - SCREEN_BOTTOM_PAD,
        );
        expect(emptyFill({ screen: 300, top: 68, covers: { bottom: 84, keyboard: 398 } })).toBe(0);
        // Whole points, rounded down, so it never pushes the content a fraction past the screen.
        expect(emptyFill({ screen: 874.6, top: 68.2, covers })).toBe(Math.floor(874.6 - 84 - 68.2 - SCREEN_BOTTOM_PAD));
    });

    it('keeps the content ending where the keyboard’s row starts, so an empty state that fits never scrolls', () => {
        const up = fillCovers('ios', { safeBottom: 84, keyboard: 336, searchTab: true });
        // UIKit insets by the safe area already; the Screen adds only what the keyboard covers past it.
        expect(keyboardInset(up, 84)).toBe(336 + IOS_SEARCH_ROW_ON_KEYBOARD - 84);
        expect(keyboardInset(fillCovers('ios', { safeBottom: 84, keyboard: 0, searchTab: true }), 84)).toBe(0);
    });

    it('lets Search’s content be as tall as it is, so an empty state that fits never scrolls', () => {
        // Grown to the frame, the content was taller than what shows by the bars: it scrolled, and
        // VoiceOver said "2 pages" over an empty screen.
        const screen = read('ui/screen.tsx');
        expect(screen).toContain("const content = cx(!fit && 'grow', 'gap-5 px-4 pt-4 pb-4'");
        expect(read('screens/search.tsx')).toContain('fit={inBar}');
    });

    it('measures itself on the screen, again as the keyboard moves, which it hears as the keyboard starts', () => {
        const state = read('ui/empty-state.tsx');
        const component = body(state, 'export function SearchEmptyState');
        expect(component).toContain('box.current?.measureInWindow((_x, y) => setTop(y))');
        expect(component).toContain('const later = setTimeout(place, KEYBOARD_SETTLE_MS);');
        expect(component).toContain('}, [fill, keyboard]);');
        const hook = body(state, 'export function useEmptyFill');
        expect(hook).toContain("KeyboardEvents.addListener('keyboardWillShow', (event) => setKeyboard(event.height))");
        expect(hook).toContain("KeyboardEvents.addListener('keyboardWillHide', () => setKeyboard(0))");
        expect(state).not.toContain('FILL_DEBUG');
    });
});
