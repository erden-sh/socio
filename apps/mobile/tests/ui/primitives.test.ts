import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseImports } from '../../vendor/t3code/dependency-graph';

// How screens use the primitives (src/ui), read as source: the primitives draw
// on React Native, which the Node tests can't load.

const src = join(import.meta.dirname, '../../src');
const read = (file: string) => readFileSync(join(src, file), 'utf8');
const sources = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((file) => /\.tsx?$/.test(file));

describe('the primitives in the app', () => {
    it('take lucide’s icons one module each: the package’s root would bundle every icon', () => {
        const rootImports = sources.flatMap((file) =>
            parseImports(read(file), join(src, file))
                .filter(({ specifier }) => specifier === 'lucide-react-native')
                .map(() => file),
        );
        // parseImports leaves out type-only imports (LucideIcon), which load nothing.
        expect(rootImports).toEqual([]);
        expect(sources.some((file) => read(file).includes("from 'lucide-react-native/icons/"))).toBe(true);
    });

    it('build the placeholders and the error screen, which keep the testIDs the flows look for', () => {
        const placeholders = {
            'screens/add-workspace.tsx': 'add-workspace-screen',
            'screens/home.tsx': 'home-screen',
            'screens/lock.tsx': 'lock-screen',
        };
        for (const [file, testID] of Object.entries(placeholders)) {
            expect(read(file)).toContain(`testID="${testID}"`);
        }
        expect(read('screens/placeholder.tsx')).toMatch(/<Screen testID=\{props\.testID\}/);
        const boundary = read('navigation/screen-boundary.tsx');
        for (const testID of ['screen-error', 'screen-error-retry', 'screen-error-back']) {
            expect(boundary).toContain(`testID="${testID}"`);
        }
        // No plain React Native text or buttons left in them.
        for (const file of [
            ...Object.keys(placeholders),
            'screens/placeholder.tsx',
            'navigation/screen-boundary.tsx',
        ]) {
            expect(read(file), file).not.toMatch(/from 'react-native'|StyleSheet|SafeAreaView/);
        }
    });

    it('give screen readers one element per field, and say errors on both platforms', () => {
        const field = read('ui/field.tsx');
        // The label you see is hidden from them; the input carries it.
        expect(field).toMatch(
            /<Text variant="subheadline" weight="medium" accessibilityElementsHidden importantForAccessibility="no">\s*\{label\}/,
        );
        expect(field).toMatch(/<TextInput[^>]*accessibilityLabel=\{label\}/s);
        // Android's live region, and iOS's announcement (use-announcement.ts).
        expect(field).toMatch(/accessibilityLiveRegion="polite"/);
        expect(field).toContain('useAnnouncement(invalid ? error : undefined, { onAppear: true });');
        const banner = read('ui/banner.tsx');
        expect(banner).toMatch(/accessibilityLiveRegion=\{tone === 'error' \? 'assertive' : 'polite'\}/);
        expect(banner).toContain("useAnnouncement(children, { onAppear: tone === 'error' });");
        const hook = read('ui/use-announcement.ts');
        expect(hook).toMatch(
            /Platform\.OS === 'ios'\) \{\s*AccessibilityInfo\.announceForAccessibilityWithOptions\(text, \{ queue: true \}\)/,
        );
        // A message no view shows has no live region: Android is told it by the hook.
        expect(hook).toMatch(/!announcesHere\(Platform\.OS, \{ shown \}\)/);
        expect(hook).toMatch(/\} else \{\s*AccessibilityInfo\.announceForAccessibility\(text\)/);
        // The board's pending marks are such a message (no view shows the line).
        expect(read('screens/board.tsx')).toContain(
            'useAnnouncement(pendingAnnouncement(view.pendingCount), { onAppear: false, shown: false });',
        );
    });

    it('give every tap target 44 pt and every text the type scale', () => {
        expect(read('ui/button.tsx')).toMatch(/'min-h-11 flex-row/);
        expect(read('ui/button.tsx')).toMatch(/iconOnly \? 'min-w-11'/);
        // 42 pt inside the border's two points.
        expect(read('ui/field.tsx')).toMatch(/"min-h-\[42px\] px-3 py-2 text-foreground"/);
        expect(read('ui/field.tsx')).toMatch(/'rounded-md border bg-transparent/);
        // 44 pt by default, a squircle (owner, 2026-11-08); a page's first line takes a smaller one (CB-420).
        expect(read('ui/tone-tile.tsx')).toContain("surface = 'screen', size = 44, testID }");
        expect(read('ui/tone-tile.tsx')).toMatch(/<Squircle size=\{size\} /);
        expect(read('ui/text.tsx')).toContain("textLook(variant ?? 'body', Platform.OS, fontScale)");
        expect(read('ui/field.tsx')).toContain("textMetrics('body', fontScale, Platform.OS)");
    });
});
