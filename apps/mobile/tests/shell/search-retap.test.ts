import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { staticTabs, TAB_NAMES } from '../../src/navigation/tabs';

// CB-418: tapping Search's tab (iOS's glass Search button, Android's fifth tab)
// again while Search shows puts the focus in its field, as iOS's own apps do.
// No React Native renderer under Node, so the .tsx files are read as text.

const src = join(import.meta.dirname, '../../src');
const read = (file: string) => readFileSync(join(src, file), 'utf8');

describe('Search tapped again (CB-418)', () => {
    const search = read('screens/search.tsx');

    it('listens to its own tab’s presses and focuses the field only while Search already shows', () => {
        const hook = /function useRetapFocus\([\s\S]*?\n}\n/.exec(search)?.[0] ?? '';
        expect(hook).toContain('useNavigation().getParent<NativeBottomTabNavigationProp<ParamListBase>>()');
        // The native tabs emit tabPress before they switch, so the first tap finds Search unfocused.
        expect(hook).toMatch(
            /addListener\('tabPress', \(\) => \{\s*if \(tab\.isFocused\(\)\) \{\s*field\.current\?\.focus\(\);/,
        );
        // The effect returns addListener's unsubscribe.
        expect(hook).toMatch(/useEffect\(\s*\(\) =>\s*tab\?\.addListener/);
    });

    it('hands the hook the field Search draws', () => {
        expect(search).toContain('const field = useRef<TextInputInstance>(null);');
        expect(search).toContain('useRetapFocus(field);');
        expect(search).toMatch(/<SearchField\s+ref=\{field\}\s+label="Search Socio"/);
    });

    it('has a SearchField that passes its ref to the input', () => {
        const field = read('ui/search-field.tsx');
        expect(field).toContain('readonly ref?: Ref<TextInputInstance>;');
        expect(field).toMatch(/<TextInput\s+\{\.\.\.props\}\s+ref=\{ref\}/);
    });

    it('is Search’s tab on both platforms, which repeats its presses (scroll to top stays the default)', () => {
        for (const os of ['ios', 'android'] as const) {
            const tabs = staticTabs(Object.fromEntries(TAB_NAMES.map((name) => [name, () => null])) as never, os);
            expect(tabs.Search.screen).toBeTypeOf('function');
            expect(
                (tabs.Search.options as { tabBarRepeatedPressBehavior?: unknown }).tabBarRepeatedPressBehavior,
            ).toBeUndefined();
        }
    });
});
