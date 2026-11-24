import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import { legacyDarkCss } from '../../scripts/lib/legacy-dark.js';
import { formatAs } from '../support/format.js';

const source = (name: string) => ({
    name,
    css: readFileSync(`packages/client/src/${name}`, 'utf8'),
});

it('keeps the generated dark stylesheet in step with the legacy stylesheet', async () => {
    // Only style.css: editor.css is on the tokens, in a layer above (CB-95).
    const css = legacyDarkCss([source('style.css')]);
    // Regenerate with `pnpm exec vitest run tests/integration/legacy-dark.test.ts -u`.
    await expect(await formatAs('legacy-dark.css', css)).toMatchFileSnapshot(
        '../../packages/client/src/styles/legacy-dark.css',
    );
});

it('only adds rules under .dark, so light mode is untouched', () => {
    const css = readFileSync('packages/client/src/styles/legacy-dark.css', 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/@media[^{]*\{/g, '');
    const selectors = [...css.matchAll(/([^{}]+)\{/g)].flatMap(([, list]) =>
        list!.split(/,\s*\n/).map((part) => part.trim()),
    );
    // The base element rules' dark copies (CB-98 left only those).
    expect(selectors.length).toBeGreaterThan(10);
    for (const selector of selectors) {
        expect(selector).toMatch(/^(\.dark |:root\.dark|html\.dark)/);
    }
    // The canvas and the shell neutrals come from the shadcn tokens.
    expect(css).toMatch(/:root\.dark \{[^}]*background: var\(--background\);[^}]*--ink: var\(--foreground\);/);
    // Imported after the legacy stylesheets, in their layer.
    const globals = readFileSync('packages/client/src/globals.css', 'utf8');
    expect(globals.indexOf("'./styles/legacy-dark.css' layer(legacy)")).toBeGreaterThan(
        globals.indexOf("'./style.css' layer(legacy)"),
    );
});

it('remaps colours by role and keeps accent surfaces', () => {
    const css = legacyDarkCss([
        {
            name: 'fixture.css',
            css: `
        .card { background: #fff; color: #333641; border: 1px solid #e7e7e7; }
        .bubble { background: #35766f; color: white; }
        .send { background: #292929; color: white; }
        .send:hover { background: #000; }
        .backdrop { background: #34394d30; }
        .hover { background: #20263418; }
        .ring:focus-visible { outline: 2px solid #476ba0; }
        .shadow { box-shadow: 0 2px 4px #00000010; }
        .layout { display: flex; }
        @keyframes spin { to { color: #fff; } }
        @media (max-width: 600px) { .card { background: #fafafa; } }
      `,
        },
    ]);
    const rule = (selector: string) =>
        css.match(new RegExp(`\\n\\s*${selector.replace(/[.:]/g, '\\$&')} \\{([^}]*)\\}`))?.[1];
    expect(rule('.dark .card')).toContain('background: var(--card);');
    expect(rule('.dark .card')).toContain('color: var(--foreground);');
    expect(rule('.dark .card')).toContain('border: 1px solid var(--border);');
    // The mint bubble keeps its colors and its white text.
    expect(rule('.dark .bubble')).toContain('background: #35766f;');
    expect(rule('.dark .bubble')).toContain('color: white;');
    // A near-black button with light text turns over, hover included.
    expect(rule('.dark .send')).toContain('color: var(--background);');
    expect(rule('.dark .send')).toMatch(/background: #e[0-9a-f]{5};/);
    expect(rule('.dark .send:hover')).toMatch(/background: #f[0-9a-f]{5};/);
    // A scrim stays dark and gets denser; a dark hover tint turns light.
    expect(rule('.dark .backdrop')).toMatch(/background: #34394d[0-9a-f]{2};/);
    expect(rule('.dark .hover')).toMatch(/background: #[a-f][0-9a-f]{5}[0-9a-f]{2};/);
    expect(rule('.dark .ring:focus-visible')).not.toContain('#476ba0');
    expect(rule('.dark .shadow')).toContain('#00000010');
    expect(css).not.toContain('.layout');
    expect(css).not.toContain('spin');
    expect(css).toMatch(/@media \(max-width: 600px\) \{\s*\.dark \.card \{/);
});
