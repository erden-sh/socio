import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SOURCES } from '../../scripts/generate-theme.mts';
import {
    evaluate,
    number,
    px,
    readBlock,
    readCascade,
    readTones,
    resolve,
    substitute,
} from '../../scripts/theme/sources.mts';

// How the theme generator reads the web: a block's custom properties (every
// top-level rule for it, merged as the cascade merges them), var() references
// followed the way the browser follows them (`.dark` laid over `:root`), the
// radius and type calc()s, and the tone tiles' classes.

const globals = readFileSync(SOURCES.globals, 'utf8');
const root = readBlock(globals, ':root');
const darkBlock = readBlock(globals, '.dark');
const scopes = { light: readCascade(globals, [':root', '.light']), dark: readCascade(globals, [':root', '.dark']) };

describe('var() resolution', () => {
    const tokens = {
        ink: '#111111',
        alias: 'var(--ink)',
        chain: 'var(--alias)',
        padded: 'var( --ink )',
        fallback: 'var(--missing, #222222)',
        'fallback-ref': 'var(--missing, var(--chain))',
        'fallback-list': 'var(--missing, a, b)',
        'fallback-unused': 'var(--ink, #999999)',
        radius: '0.6rem',
        calc: 'calc(var(--radius) - 4px)',
        pair: 'var(--ink) var(--alias)',
        loop: 'var(--loop-back)',
        'loop-back': 'var(--loop)',
        dangling: 'var(--nowhere)',
    };

    it.each([
        ['alias', '#111111'],
        ['chain', '#111111'],
        ['padded', '#111111'],
        ['fallback', '#222222'],
        ['fallback-ref', '#111111'],
        ['fallback-list', 'a, b'],
        ['fallback-unused', '#111111'],
        ['calc', 'calc(0.6rem - 4px)'],
        ['pair', '#111111 #111111'],
    ])('resolves --%s to %s', (name, value) => {
        expect(resolve(tokens, name)).toBe(value);
    });

    it('refuses a cycle and a reference to nothing', () => {
        expect(() => resolve(tokens, 'loop')).toThrow(/cycle: --loop → --loop-back → --loop/);
        expect(() => resolve(tokens, 'dangling')).toThrow(/--nowhere isn't set \(from --dangling\)/);
        expect(() => resolve(tokens, 'absent')).toThrow(/--absent isn't set/);
        expect(() => substitute(tokens, 'var(ink)')).toThrow(/Bad var\(\)/);
    });

    it('lays .dark over :root, so a light reference reaches the dark value', () => {
        // :root sets --sidebar-primary: var(--primary); .dark sets --primary:
        // var(--brand) and its own --brand. Two hops, each through the dark block.
        expect(root['sidebar-primary']).toBe('var(--primary)');
        expect(darkBlock['sidebar-primary']).toBeUndefined();
        expect(darkBlock.primary).toBe('var(--brand)');
        expect(resolve(scopes.dark, 'sidebar-primary')).toBe(darkBlock.brand);
        expect(resolve(scopes.light, 'sidebar-primary')).toBe(root.primary);
        // :root's --primary-foreground follows --brand-foreground, which .dark overrides.
        expect(resolve(scopes.dark, 'primary-foreground')).toBe(darkBlock['brand-foreground']);
        expect(resolve(scopes.light, 'primary-foreground')).toBe(root['brand-foreground']);
        expect(resolve(scopes.dark, 'ring')).not.toBe(resolve(scopes.light, 'ring'));
    });
});

describe('the blocks the generator reads', () => {
    it('takes the top-level :root, not the one inside @media', () => {
        expect(globals).toMatch(/@media \(min-width: 48rem\) \{\s*:root \{\s*--page-top: 1\.5rem;/);
        expect(root['page-top']).toBe('1rem');
    });

    it('skips rules nested in a block, and comments, even with a ; in them', () => {
        const inline = readBlock(globals, '@theme inline');
        expect(inline['radius-sm']).toBe('calc(var(--radius) - 4px)');
        expect(inline['animate-shimmer']).toBe('shimmer 2.4s linear infinite');
        expect(Object.keys(inline).some((name) => name.includes('transform'))).toBe(false);
        const css =
            '.x {\n  /* a; --fake: 1; */\n  --a: 1;\n  @keyframes k { 50% { --b: 2; } }\n  --c:\n    one,\n    two;\n}\n';
        expect(readBlock(css, '.x')).toEqual({ a: '1', c: 'one, two' });
    });

    it('reads Tailwind’s default theme from the app’s own tailwindcss', () => {
        expect(SOURCES.tailwind).toContain(join('tailwindcss', 'theme.css'));
        const tailwind = readBlock(readFileSync(SOURCES.tailwind, 'utf8'), '@theme default');
        expect(tailwind['color-sky-500']).toMatch(/^oklch\(/);
        expect(tailwind['text-xs--line-height']).toBe('calc(1 / 0.75)');
        // The deprecated block after it isn't read.
        expect(tailwind.radius).toBeUndefined();
    });

    it('throws for a block that isn’t there', () => {
        expect(() => readBlock(globals, '.light')).toThrow(/No top-level ".light \{" block/);
        expect(() => readCascade('.x { --a: 1; }', [':root', '.dark'])).toThrow(
            /No top-level ":root \{" or ".dark \{" block/,
        );
    });

    it('throws for a stylesheet whose braces or strings don’t close', () => {
        expect(() => readBlock('.x {\n  --a: 1;\n', '.x')).toThrow(/".x \{" never closes/);
        expect(() => readBlock('.x { --a: 1; } }', '.x')).toThrow(/closes nothing/);
        expect(() => readBlock('.x { --a: "1; }', '.x')).toThrow(/Unclosed string/);
        expect(() => readBlock('.x { --a: 1; } /* open', '.x')).toThrow(/Unclosed comment/);
    });

    it('takes strings whole: a ; { } or /* in one is no syntax', () => {
        const css = `.x {\n  --font: "a;b}{/* c";\n  --quote: 'it\\'s';\n  --b: 1;\n}\n.y { --c: 2; }\n`;
        expect(readBlock(css, '.x')).toEqual({ font: '"a;b}{/* c"', quote: "'it\\'s'", b: '1' });
        expect(readBlock(css, '.y')).toEqual({ c: '2' });
    });
});

describe('a block the web sets more than once, as the cascade merges it', () => {
    // The browser applies every top-level :root and .dark rule, in source
    // order: a later one adds to the earlier ones and wins where they differ.
    const css = [
        ':root {\n  --a: 1;\n  --b: 2;\n  --c: 3;\n}',
        '@media (min-width: 48rem) {\n  :root {\n    --a: 10;\n  }\n  .dark {\n    --a: 11;\n  }\n}',
        '.dark {\n  --a: 4;\n  --b: 5;\n}',
        '@theme inline {\n  --radius-sm: 1px;\n}',
        '.dark {\n  --b: 6;\n  --c: 7\n}',
        ':root, :host {\n  --c: 8;\n}',
        '@theme inline {\n  --radius-lg: 2px;\n}',
    ].join('\n');

    it('merges a second .dark block over the first, its last declaration without a ; too', () => {
        expect(readBlock(css, '.dark')).toEqual({ a: '4', b: '6', c: '7' });
    });

    it('merges a second :root block, one in a selector list too', () => {
        expect(readBlock(css, ':root')).toEqual({ a: '1', b: '2', c: '8' });
    });

    it('lets a :root after .dark win in dark as well: both are on <html>, equally specific', () => {
        expect(readCascade(css, [':root', '.dark'])).toEqual({ a: '4', b: '6', c: '8' });
        expect(readCascade(css, [':root', '.light'])).toEqual({ a: '1', b: '2', c: '8' });
    });

    it('merges @theme inline blocks, and leaves the rules inside @media alone', () => {
        expect(readBlock(css, '@theme inline')).toEqual({ 'radius-sm': '1px', 'radius-lg': '2px' });
        expect(readCascade(css, ['@media (min-width: 48rem)'])).toEqual({});
    });

    it('doesn’t take a rule that only names the class in a longer selector', () => {
        const other = '.dark {\n  --a: 1;\n}\nhtml.dark {\n  --a: 2;\n}\n.dark .card {\n  --a: 3;\n}\n';
        expect(readBlock(other, '.dark')).toEqual({ a: '1' });
    });
});

describe('calc()', () => {
    it.each([
        ['0.6rem', 9.6],
        ['calc(0.6rem - 4px)', 5.6],
        ['calc(0.6rem + 4px)', 13.6],
        ['calc((1rem + 2px) * 2)', 36],
        ['calc(2 * -3px)', -6],
    ])('computes %s as %d px', (text, value) => {
        expect(px(text)).toBe(value);
    });

    it.each([
        ['calc(1 / 0.75)', 1.3333],
        ['calc(1.5 / 1)', 1.5],
        ['1', 1],
    ])('computes %s as the number %d', (text, value) => {
        expect(number(text)).toBe(value);
    });

    it.each(['calc(1rem + 2)', 'calc(1px * 2px)', 'calc(4 / 2px)', 'calc(1em)', 'calc(1px', 'min(1px, 2px)'])(
        'refuses %s',
        (text) => {
            expect(() => evaluate(text)).toThrow();
        },
    );

    it('tells a length from a number', () => {
        expect(() => px('1.5')).toThrow(/isn't a length/);
        expect(() => number('2px')).toThrow(/is a length/);
    });
});

describe('the tone tiles', () => {
    const tones = readTones(readFileSync(SOURCES.tones, 'utf8'));
    const source = (...entries: string[]) => `export const toneTile = {\n${entries.join('\n')}\n};\n`;

    it('reads every tone the web’s Tone type names, in light and dark', () => {
        // tones.ts is a Record<Tone, string>, so TypeScript holds it to the type.
        const types = readFileSync(join(SOURCES.tones, '../../modules/types.ts'), 'utf8');
        const union = /export type Tone = ([^;]+);/.exec(types)?.[1];
        expect(union).toBeDefined();
        const names = [...union!.matchAll(/'([\w-]+)'/g)].map((match) => match[1]);
        expect(names.length).toBeGreaterThan(0);
        expect([...Object.keys(tones)].sort()).toEqual([...names].sort());
        expect(Object.keys(tones)[0]).toBe('mint');
    });

    it('reads a quoted key, comments and a value on the line after its key', () => {
        const read = readTones(
            source(
                '    // The brand.',
                "    mint: 'bg-primary/12 text-primary', // trailing",
                '    /* a block comment */',
                "    'sky-blue':",
                "        'bg-sky-500/12 text-sky-700 dark:text-sky-300',",
                '    rose: "bg-rose-500/12 text-rose-700"',
            ),
        );
        expect(Object.keys(read)).toEqual(['mint', 'sky-blue', 'rose']);
        expect(read['sky-blue']!.dark.foreground).toEqual({ color: 'sky-300', alpha: 1 });
    });

    it('refuses an entry it can’t read instead of dropping the tone', () => {
        const mint = "    mint: 'bg-primary/12 text-primary',";
        expect(() => readTones(source(mint, '    sky: `bg-sky-500/12 text-sky-700`,'))).toThrow(
            /can't read: "sky: `bg-sky-500\/12/,
        );
        expect(() => readTones(source(mint, '    ...extra,'))).toThrow(/can't read: "...extra,"/);
        expect(() => readTones(source(mint, "    [key]: 'bg-sky-500/12 text-sky-700',"))).toThrow(/can't read/);
        // Two entries with no comma between them: the first is where it stops.
        expect(() =>
            readTones(source("    mint: 'bg-primary/12 text-primary'", "    sky: 'bg-sky-500/12 text-sky-700',")),
        ).toThrow(/can't read: "mint: 'bg-primary\/12 text-primary'"/);
        expect(() => readTones(source(mint, mint))).toThrow(/sets the mint tone twice/);
    });

    it('lets a dark: class override its kind in dark only', () => {
        expect(tones.mint).toEqual({
            light: { background: { color: 'primary', alpha: 0.12 }, foreground: { color: 'primary', alpha: 1 } },
            dark: { background: { color: 'primary', alpha: 0.2 }, foreground: { color: 'primary', alpha: 1 } },
        });
        expect(tones.sky).toEqual({
            light: { background: { color: 'sky-500', alpha: 0.12 }, foreground: { color: 'sky-700', alpha: 1 } },
            dark: { background: { color: 'sky-500', alpha: 0.12 }, foreground: { color: 'sky-300', alpha: 1 } },
        });
    });

    it('refuses a class it can’t place', () => {
        const entry = (classes: string) => source(`    mint: '${classes}',`);
        expect(() => readTones(entry('bg-primary/12 text-primary hover:bg-primary'))).toThrow(/Unexpected class/);
        expect(() => readTones(entry('text-primary'))).toThrow(/needs a bg- and a text- class/);
        expect(() => readTones('export const other = {};')).toThrow(/No `toneTile`/);
    });
});
