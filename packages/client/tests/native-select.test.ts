import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { dialogSelect, nativeSelect } from '../src/components/form-fields';
import { nativeSelect as settingsSelect } from '../src/modules/settings/AccountSettings';

const classes = (value: string) => value.split(/\s+/);

it('gives native selects one look whose fixed height can’t clip the chosen value (CB-258)', () => {
    // Settings sections import it from AccountSettings: the same class.
    expect(settingsSelect).toBe(nativeSelect);
    for (const select of [nativeSelect, dialogSelect]) {
        const list = classes(select);
        // No block padding of its own, a line height that fits the height.
        expect(list).toContain('py-0');
        expect(list).toContain('leading-normal');
        expect(list.some((name) => /^h-\d+$/.test(name))).toBe(true);
        expect(list.some((name) => /^p[ty]?-(?!0$)/.test(name))).toBe(false);
        // 16 px on phones, so iOS doesn't zoom in (CB-96); smaller from md.
        expect(list).toContain('text-base');
        expect(list.some((name) => name.startsWith('md:text-'))).toBe(true);
        // The shared keyboard focus indicator is solid and offset.
        expect(list).toEqual(
            expect.arrayContaining([
                'focus-visible:outline-2',
                'focus-visible:outline-offset-2',
                'focus-visible:outline-solid',
                'focus-visible:outline-ring',
            ]),
        );
    }
    expect(classes(dialogSelect)).toContain('w-full');
});

it('leaves selects out of the legacy element box (CB-258)', () => {
    // The legacy rule's 12 px block padding under a utility height (h-9:
    // 36 px less 24 px and the border) left a 10 px box for 14 to 16 px text.
    for (const file of ['style.css', 'styles/legacy-dark.css']) {
        const css = readFileSync(join(import.meta.dirname, '../src', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
            if (!/(^|[\s,])select\b/.test(selectors!)) {
                continue;
            }
            expect(body, `${file}: ${selectors!.trim()}`).not.toMatch(
                /(^|[\s;])(padding|height|width|border|outline|background)\s*:/,
            );
        }
    }
});
