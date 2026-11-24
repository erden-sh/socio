import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// The site's tokens (src/styles/tokens.css) are a copy of the web client's: its light :root and
// its .dark set (packages/client/src/globals.css), the dark set under prefers-color-scheme here.
// The tone shades are Tailwind 4's, used as the client's shell/tones.ts uses them. This fails when
// either side changes alone.

const root = join(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const site = read('apps/site/src/styles/tokens.css');
const client = read('packages/client/src/globals.css');

/** The custom properties declared directly in the first block opened by `opener`. */
function block(css: string, opener: RegExp): Map<string, string> {
    const start = css.search(opener);
    expect(start, String(opener)).toBeGreaterThanOrEqual(0);
    const open = css.indexOf('{', start);
    let depth = 0;
    let end = open;
    for (let i = open; i < css.length; i++) {
        if (css[i] === '{') {
            depth++;
        }
        if (css[i] === '}' && --depth === 0) {
            end = i;
            break;
        }
    }
    const body = css.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, '');
    return new Map(
        [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1] ?? '', (match[2] ?? '').trim()]),
    );
}

const siteLight = block(site, /^:root \{/m);
const siteDark = block(site, /@media \(prefers-color-scheme: dark\) \{\s*:root \{/);
const clientLight = block(client, /^:root \{/m);
const clientDark = block(client, /^\.dark \{/m);

/** The site's own tokens, which the client doesn't have. */
const SITE_ONLY = new Set(['--canvas', '--shadow-sm', '--shadow-md', '--shadow-lg', '--ink-strong']);
const TONE = /^--(orange|amber|emerald|sky|indigo|violet|rose|slate)-(300|500|700)$/;
/** The tokens the site's look rests on: it must carry each. */
const REQUIRED = [
    '--radius',
    '--brand',
    '--brand-foreground',
    '--background',
    '--foreground',
    '--card',
    '--primary',
    '--primary-foreground',
    '--primary-hover',
    '--secondary',
    '--muted',
    '--muted-foreground',
    '--border',
    '--input',
    '--ring',
    '--chat-link',
    '--destructive',
];

describe('the tokens copied from the client', () => {
    it('carry every token the site relies on', () => {
        for (const name of REQUIRED) {
            expect(siteLight.has(name), name).toBe(true);
        }
        expect(siteDark.size).toBeGreaterThan(15);
    });

    it('match the client’s light values', () => {
        for (const [name, value] of siteLight) {
            if (SITE_ONLY.has(name) || TONE.test(name)) {
                continue;
            }
            expect(clientLight.get(name), `light ${name}`).toBe(value);
        }
    });

    it('match the client’s dark values', () => {
        for (const [name, value] of siteDark) {
            if (SITE_ONLY.has(name)) {
                continue;
            }
            expect(clientDark.get(name), `dark ${name}`).toBe(value);
        }
        // Every dark token the client sets for a token the site copies, the site sets too.
        for (const name of siteLight.keys()) {
            if (clientDark.has(name)) {
                expect(siteDark.get(name), `dark ${name}`).toBe(clientDark.get(name));
            }
        }
    });

    it('use the client’s font stack', () => {
        const stack = /^:root \{[^}]*font-family: ([^;]+);/m.exec(read('packages/client/src/style.css'))?.[1];
        expect(stack).toBeTruthy();
        expect(read('apps/site/src/styles/components.css')).toContain(`font-family: ${stack};`);
    });
});

describe('the module tones', () => {
    const require = createRequire(import.meta.url);
    const theme = readFileSync(require.resolve('tailwindcss/theme.css'), 'utf8');

    it('are Tailwind 4’s palette values', () => {
        const tones = [...siteLight].filter(([name]) => TONE.test(name));
        expect(tones).toHaveLength(24);
        for (const [name, value] of tones) {
            const tailwind = new RegExp(`--color${name.slice(1)}: ([^;]+);`).exec(theme)?.[1];
            expect(tailwind, name).toBe(value);
        }
    });

    it('use the shades the client’s tiles use: the 500 tint, the 700 ink, and 300 in dark', () => {
        const tones = read('packages/client/src/shell/tones.ts');
        // Whitespace-free of the formatter's line breaks.
        const css = read('apps/site/src/styles/components.css').replace(/\s+/g, ' ');
        for (const tone of ['sky', 'amber', 'violet', 'emerald', 'orange', 'indigo', 'rose', 'slate']) {
            expect(tones, tone).toContain(`'bg-${tone}-500/12 text-${tone}-700 dark:text-${tone}-300'`);
            expect(css, tone).toContain(`.t-${tone} { --tone: var(--${tone}-500); --tone-ink: var(--${tone}-700); }`);
            expect(css, tone).toContain(`.t-${tone} { --tone-ink: var(--${tone}-300); }`);
        }
        expect(tones).toContain("mint: 'bg-primary/12 text-primary dark:bg-primary/20'");
        expect(css).toContain(
            '.t-mint { --tone: var(--brand); --tone-ink: var(--primary); --tone-tint: color-mix(in oklab, var(--primary) 12%, transparent); }',
        );
    });
});
