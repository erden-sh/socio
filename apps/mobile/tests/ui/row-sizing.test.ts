import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { classNamesIn } from '../helpers/class-names';

// Rows and cards grow with their text (CB-373). Gap 4 (#461) gave the app the
// web's line heights, and every row that had been given a fixed height, or a
// minimum treated as one, was outgrown by its own text: a page's two-line
// excerpt and its "Edited Nov 3" meta were cut at the row's bottom and the next
// row's title drew over them, at the default text size, on every screen built
// from ListRow. These read the source, as the other primitives' tests do, since
// the Node tests can't lay React Native out:
// - no fixed height where the app draws (src/ui, src/screens, src/navigation)
//   unless it is listed below with its reason (a bar, a picture, a rule: never
//   a box of wrapping text);
// - ListRow sets only a minimum, and caps each of its lines;
// - no list pins its items' sizes, except the attachment viewer's pager.

const src = join(import.meta.dirname, '../../src');
const sources = readdirSync(src, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.tsx?$/.test(file))
    .sort();
const read = (file: string) => readFileSync(join(src, file), 'utf8');
/** Where the app draws: its primitives, screens and headers. */
const drawn = sources.filter((file) => /^(ui|screens|navigation)\//.test(file));

interface AstNode {
    readonly type: string;
    readonly start?: number;
    readonly end?: number;
    readonly [key: string]: unknown;
}

const babel: { parseSync: (source: string, options: Record<string, unknown>) => AstNode | null } = createRequire(
    join(import.meta.dirname, '../../package.json'),
)('@babel/core');

/**
 * Every `height` an object literal sets in `source` (a style, or what a helper
 * returns for one), as the source of its value: `{ height: 68 }` gives '68',
 * `{ height }` gives 'height'. minHeight, maxHeight, lineHeight, types and
 * comments aren't object properties named height, so they don't count.
 */
function heightsIn(source: string, file: string): string[] {
    const ast = babel.parseSync(source, {
        babelrc: false,
        configFile: false,
        filename: file,
        sourceType: 'module',
        parserOpts: { plugins: file.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'] },
    });
    const found: string[] = [];
    const walk = (value: unknown): void => {
        if (Array.isArray(value)) {
            value.forEach(walk);
            return;
        }
        if (value === null || typeof value !== 'object' || typeof (value as AstNode).type !== 'string') {
            return;
        }
        const node = value as AstNode;
        if (node.type === 'ObjectPattern') {
            // `const { height } = useWindowDimensions()` reads a height; it sets none.
            return;
        }
        const key = node.key as AstNode | undefined;
        if (
            node.type === 'ObjectProperty' &&
            node.computed !== true &&
            ((key?.type === 'Identifier' && key.name === 'height') ||
                (key?.type === 'StringLiteral' && key.value === 'height'))
        ) {
            const target = node.value as AstNode;
            found.push(source.slice(target.start, target.end));
        }
        for (const [name, child] of Object.entries(node)) {
            if (name !== 'loc' && name !== 'leadingComments' && name !== 'trailingComments') {
                walk(child);
            }
        }
    };
    walk(ast);
    return found;
}

/**
 * The fixed heights the app may set, each with its reason: `file: [the value
 * after "height:"]`. None holds wrapping text.
 */
const FIXED_HEIGHTS: Record<string, readonly string[]> = {
    // A square picture or mark: its width and height together.
    'ui/squircle.tsx': ['size', 'outer'],
    'ui/local-avatar.tsx': ['size'],
    // An SF Symbol's square (CB-431).
    'screens/attachments.tsx': ['TRAY_TILE', 'TRAY_TILE', 'BUBBLE_PICTURE', 'BUBBLE_PICTURE', "'100%'"],
    'screens/confirm-workspace.tsx': ['96'],
    'screens/board.tsx': ['STATUS_RING.size'],
    // The header's Back: a chevron alone, a 44 pt target.
    'navigation/header-bar.tsx': ['BACK.height'],
    'navigation/header-layout.ts': ['TOUCH_TARGET'],
    // A thematic break's rule and an SVG's own measured box.
    'screens/chat-markdown.tsx': ['1'],
    // The composer's box, measured from its text (src/chat/composer.ts).
    'screens/chat-composer.tsx': ['composerInputHeight(Platform.OS, props.text)'],
    // The attachment viewer's full-screen pager: a page is the window.
    'screens/attachment-viewer.tsx': ["'100%'"],
    // Media (CB-558): a file's picture in its page, and the grid's and the list's square pictures.
    'screens/media-file.tsx': ['320'],
    'screens/media.tsx': ['size', 'cell', 'ROW_TILE'],
    // The QR scanner's viewfinder (CB-566): a square mark over the camera, its width and height together.
    'screens/scan-qr.tsx': ['FRAME'],
    // Swipe actions: the panes are the row's own height, whatever its text.
    // and an iOS action's circle, a square mark (iOS 26's).
    'screens/swipe-row.tsx': ["'100%'", 'look.circle'],
    // The system's hairline between grouped rows.
    'ui/grouped.tsx': ['StyleSheet.hairlineWidth'],
    // A dataset table's rows (CB-469): its sticky column and the scrolled cells share one height,
    // scaled with the text size, one line a cell; and the calendar's time grid, an hour a band, an
    // entry as tall as its time (at least a line of its title, cut short).
    'screens/dataset-layouts.tsx': [
        'rowHeight',
        'rowHeight',
        'HOUR',
        'hours.length * HOUR',
        'HOUR',
        `Math.max(
                                            22,
                                            (((entry.endMinute ?? 0) - (entry.startMinute ?? 0)) / 60) * HOUR,
                                        )`,
    ],
};

/** The fixed-height class names the app may write (Tailwind's h-*), each with its reason. */
const FIXED_HEIGHT_CLASSES: Record<string, readonly string[]> = {
    // Material's top app bar action (CB-420): a 48 dp icon or text button, one line.
    'navigation/native-bar.tsx': ['h-12'],
    // File an issue's, New Space's and New room's own bars, single-line titles beside buttons (the web's AppHeader).
    'screens/file-issue.tsx': ['h-16'],
    'screens/new-space.tsx': ['h-16'],
    'screens/new-room.tsx': ['h-16'],
    // A page's cover picture (the web's h-50).
    'screens/page.tsx': ['h-50'],
    // A dataset gallery card's cover picture (CB-469).
    'screens/dataset-layouts.tsx': ['h-28'],
    // The editor's hidden WebView while the source shows.
    'screens/page-editor.tsx': ['h-0'],
    // A divider in the editor's toolbar.
    'screens/page-editor-toolbar.tsx': ['h-6'],
    // An upload's progress bar and its fill.
    'screens/attachments.tsx': ['h-1', 'h-1'],
    // Media's usage bar and its fill (CB-558, the web's h-2).
    'screens/media.tsx': ['h-2', 'h-2'],
    // Add a device's countdown bar and its fill (CB-568).
    'screens/add-device.tsx': ['h-1.5', 'h-full'],
    // An empty spacer between the transcript's rows.
    'screens/chat.tsx': ['h-4'],
};

const isFixedHeightClass = (name: string) => /^h-(\d|\[|px$|full$|screen$)/.test(name.replace(/^.*:/, ''));

describe('rows and cards', () => {
    it('set no fixed height the list above doesn’t give a reason for', () => {
        const found: Record<string, string[]> = {};
        for (const file of drawn) {
            const heights = heightsIn(read(file), file);
            if (heights.length > 0) {
                found[file] = heights;
            }
        }
        expect(found).toEqual(Object.fromEntries(Object.entries(FIXED_HEIGHTS).map(([f, v]) => [f, [...v]])));
    });

    it('write no fixed-height class name the list above doesn’t give a reason for', () => {
        const found: Record<string, string[]> = {};
        for (const file of sources.filter((name) => name.endsWith('.tsx'))) {
            for (const use of classNamesIn(read(file), `src/${file}`)) {
                if (isFixedHeightClass(use.name)) {
                    (found[file] ??= []).push(use.name);
                }
            }
        }
        expect(found).toEqual(Object.fromEntries(Object.entries(FIXED_HEIGHT_CLASSES).map(([f, v]) => [f, [...v]])));
    });

    it('would catch the fixed heights that cut CB-373’s rows', () => {
        // type-scale.ts's rowHeight before the fix, and a style written by hand.
        const before = `export function rowHeight(height: number, fontScale: number): { height: number } | { minHeight: number } {
            return isLargeText(fontScale) ? { minHeight: height } : { height };
        }`;
        expect(heightsIn(before, 'ui/type-scale.ts')).toEqual(['height']);
        expect(heightsIn('const row = <View style={{ height: 68 }} />;', 'a.tsx')).toEqual(['68']);
        expect(heightsIn('// height: 4\nconst a = { minHeight: 68, lineHeight: 20, maxHeight: 9 };', 'a.ts')).toEqual(
            [],
        );
        expect(isFixedHeightClass('h-17')).toBe(true);
        expect(isFixedHeightClass('h-[68px]')).toBe(true);
        expect(isFixedHeightClass('min-h-11')).toBe(false);
        expect(isFixedHeightClass('max-h-36')).toBe(false);
    });
});

describe('ListRow', () => {
    const shell = read('screens/shell-parts.tsx');
    const start = shell.indexOf('export function ListRow(');
    const end = shell.indexOf('\nexport function ', start + 1);
    const listRow = shell.slice(start, end);

    it('takes only a minimum height, with even padding above and below', () => {
        expect(start).toBeGreaterThan(-1);
        expect(listRow).toMatch(/rowMinHeight\(Math\.max\(44, \(props\.leadingSize \?\? 40\) \+ 24\)\)/);
        expect(listRow).not.toMatch(/(?<![A-Za-z])height\s*:/);
        // The font scale moves only the trailing accessory under the text (stacksAccessory), never a height.
        expect(listRow).not.toMatch(/isLargeText/);
        expect([...listRow.matchAll(/fontScale/g)].length).toBe(1);
        expect(listRow).toContain('stacksAccessory(useWindowDimensions().fontScale)');
        // p-3: 12 pt on every side, and no py-*/pt-*/pb-* that would make it uneven.
        expect(listRow).toMatch(/'flex-row items-center gap-3 p-3'/);
        expect(listRow).not.toMatch(/\b(py|pt|pb)-/);
    });

    it('caps its title at one line and its subtitle at the lines it’s given, one by default', () => {
        const texts = [...listRow.matchAll(/<Text\b[^>]*>/g)].map((match) => match[0]);
        expect(texts.length).toBeGreaterThanOrEqual(2);
        for (const text of texts) {
            expect(text, text).toMatch(/numberOfLines=/);
        }
        expect(texts[0]).toMatch(/numberOfLines=\{1\}/);
        expect(listRow).toMatch(/numberOfLines=\{props\.subtitleLines \?\? 1\}/);
    });

    it('is given at most two lines of subtitle, as the web’s cards clamp their excerpts', () => {
        const lines = sources.flatMap((file) =>
            [...read(file).matchAll(/subtitleLines=\{(\d+)\}/g)].map((match) => ({ file, lines: Number(match[1]) })),
        );
        expect(lines.length).toBeGreaterThan(0);
        expect(lines.filter((use) => use.lines > 2)).toEqual([]);
    });

    it('is given a meta line capped at one line', () => {
        const metas = sources.flatMap((file) =>
            [...read(file).matchAll(/\bmeta=\{\s*(?:\/\/[^\n]*\n\s*)?(<Text\b[^>]*>)/g)].map(
                (match) => `${file}: ${match[1]}`,
            ),
        );
        expect(metas.length).toBeGreaterThan(0);
        expect(metas.filter((meta) => !meta.includes('numberOfLines={1}'))).toEqual([]);
    });
});

describe('lists', () => {
    it('measure their items: none pins an item’s size, but the attachment viewer’s full-width pager', () => {
        const pinned = sources.flatMap((file) =>
            [...read(file).matchAll(/\b(getFixedItemSize|getItemLayout|itemHeight)\b/g)].map(
                (match) => `${file}: ${match[1]}`,
            ),
        );
        // Each page is the window's width, sideways, and holds a picture, not text.
        expect(pinned).toEqual(['screens/attachment-viewer.tsx: getItemLayout']);
    });
});
