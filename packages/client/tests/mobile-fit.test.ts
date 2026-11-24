// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(import.meta.dirname, '../src', path), 'utf8');

// The touch-screen field rule in globals.css (CB-96): its layer, media
// query, selector and size.
const fieldRule = () => {
    const globals = read('globals.css');
    const match = globals.match(
        /@layer utilities \{\s*@media \(pointer: coarse\) \{\s*([^{]+?)\s*\{\s*font-size: 16px;\s*\}\s*\}\s*\}/,
    );
    expect(match, 'the touch-screen field rule').toBeTruthy();
    return match![1]!;
};

it('makes every editable field 16px on touch screens, so iOS does not zoom in on focus (CB-96)', () => {
    const selector = fieldRule();
    document.body.innerHTML = `
    <input data-field>
    <input type="text" data-field>
    <input type="search" class="text-sm" data-field>
    <input type="email" data-field>
    <input type="number" data-field>
    <textarea data-field></textarea>
    <select data-field><option>One</option></select>
    <div contenteditable="true" data-field></div>
    <div contenteditable data-field></div>
    <input type="checkbox">
    <input type="radio">
    <input type="range">
    <input type="file">
    <input type="hidden">
    <input type="submit">
    <button>Send</button>
    <div contenteditable="false"></div>
    <input class="document-title">
  `;
    for (const element of document.body.children) {
        expect(element.matches(selector), element.outerHTML).toBe(element.hasAttribute('data-field'));
    }
});

it('keeps the shadcn fields and the page editor at 16px on phones', () => {
    // Already 16px below md, so the rule changes nothing for them.
    for (const file of ['components/ui/input.tsx', 'components/ui/textarea.tsx']) {
        expect(read(file), file).toMatch(/ text-base .*md:text-sm/);
    }
    expect(read('modules/pages/editor.css')).toMatch(/\.document-prose \{[^}]*font-size: 16px;/);
});

it('leaves pinch-zoom alone in the viewport', () => {
    const viewport = read('root.tsx').match(/<meta\s+name="viewport"\s+content="([^"]+)"/);
    expect(viewport?.[1]).toMatch(/width=device-width/);
    // Android's keyboard resizes the page, as useVisibleHeight does on iOS.
    expect(viewport?.[1]).toMatch(/interactive-widget=resizes-content/);
    expect(viewport?.[1]).not.toMatch(/maximum-scale|user-scalable/);
});
