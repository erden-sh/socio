import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigContext } from 'expo/config';
import { afterAll, describe, expect, it } from 'vitest';

import appConfig from '../../app.config.ts';
import {
    buildTheme,
    cssVariables,
    OUTPUT_DIR,
    ROLES,
    SCHEMES,
    SELECTED_ROW_CONTRAST,
    SOURCES,
    type SchemeTheme,
    staleFiles,
    TILE_SURFACES,
    type Theme,
} from '../../scripts/generate-theme.mts';
import { composite, oklchToRgb, parseColor, rgba, toHex, withContrast } from '../../scripts/theme/color.mts';
import { readBlock, readTones } from '../../scripts/theme/sources.mts';

// The generator (scripts/generate-theme.mts) and what it wrote: --check, the
// files' agreement with each other and with the web, and uniwind's rule that
// every theme declares the same variables.

const app = join(import.meta.dirname, '../..');
const script = join(app, 'scripts/generate-theme.mts');
const generated = (name: string) => readFileSync(join(OUTPUT_DIR, name), 'utf8');

/** The generator as a person runs it, with plain node (Node 26 strips the types). */
const run = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { cwd: app, encoding: 'utf8', env: { ...process.env } });

const scratch = mkdtempSync(join(tmpdir(), 'socio-theme-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('--check', () => {
    it('passes on the committed files', { timeout: 30_000 }, () => {
        const result = run('--check');
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        expect(staleFiles()).toEqual([]);
    });

    it('fails on a stale or missing file, and passes once it is written again', { timeout: 30_000 }, () => {
        const out = join(scratch, 'out');
        expect(run('--out', out).status).toBe(0);
        expect(run('--check', '--out', out).status).toBe(0);
        expect(readFileSync(join(out, 'theme.css'), 'utf8')).toBe(generated('theme.css'));
        expect(readFileSync(join(out, 'theme.json'), 'utf8')).toBe(generated('theme.json'));

        appendFileSync(join(out, 'theme.css'), '/* edited by hand */\n');
        const stale = run('--check', '--out', out);
        expect(stale.status).toBe(1);
        expect(stale.stderr).toMatch(/theme\.css is stale: run node apps\/mobile\/scripts\/generate-theme\.mts/);
        expect(stale.stderr).not.toMatch(/theme\.json/);

        rmSync(join(out, 'theme.json'));
        const missing = run('--check', '--out', out);
        expect(missing.status).toBe(1);
        expect(missing.stderr).toMatch(/theme\.css is stale/);
        expect(missing.stderr).toMatch(/theme\.json is stale/);

        expect(run('--out', out).status).toBe(0);
        expect(run('--check', '--out', out).status).toBe(0);
    });

    it('refuses arguments it doesn’t know', { timeout: 30_000 }, () => {
        expect(run('--chek').status).toBe(2);
        expect(run('--check', '--out').status).toBe(2);
    });
});

describe('--check against a web that changed', () => {
    const committed = buildTheme();
    /** The sources with tokens.css or tones.ts replaced by an edited copy in the scratch folder. */
    let copies = 0;
    const edited = (name: 'globals' | 'tones', edit: (text: string) => string) => {
        copies += 1;
        const file = join(scratch, `${name}-${copies}`);
        writeFileSync(file, edit(readFileSync(SOURCES[name], 'utf8')));
        return { ...SOURCES, [name]: file };
    };
    const both = [join(OUTPUT_DIR, 'theme.css'), join(OUTPUT_DIR, 'theme.json')];

    it('sees a second .dark block, as the browser does', () => {
        const sources = edited('globals', (css) => `${css}\n.dark {\n    --background: #000000;\n}\n`);
        const theme = buildTheme(sources);
        expect(theme.dark.colors.background).toBe('#000000');
        expect(theme.dark.colors.screen).toBe('#000000');
        expect(theme.light.colors.background).toBe(committed.light.colors.background);
        expect(staleFiles(OUTPUT_DIR, sources)).toEqual(both);
    });

    it('sees a second :root block, which wins over the earlier .dark too', () => {
        const sources = edited('globals', (css) => `${css}\n:root {\n    --muted-foreground: #999999;\n}\n`);
        const theme = buildTheme(sources);
        expect(theme.light.colors['muted-foreground']).toBe('#999999');
        expect(theme.dark.colors['muted-foreground']).toBe('#999999');
        expect(staleFiles(OUTPUT_DIR, sources)).toEqual(both);
    });

    it('stops on a .dark or .light block that sets a token :root doesn’t, or a length', () => {
        expect(() => buildTheme(edited('globals', (css) => `${css}\n.dark {\n    --new-thing: #000000;\n}\n`))).toThrow(
            /\.dark sets --new-thing, which :root doesn't/,
        );
        expect(() => buildTheme(edited('globals', (css) => `${css}\n.light {\n    --radius: 1rem;\n}\n`))).toThrow(
            /--radius differs in light and dark/,
        );
    });

    it('stops when the dark tokens leave .dark', () => {
        const sources = edited('globals', (css) => css.replace(/\n\.dark \{/, '\nhtml.dark {'));
        expect(() => buildTheme(sources)).toThrow(/No top-level ".dark \{" block/);
    });

    it('sees a tone in a form it reads, and stops on one it can’t', () => {
        const quoted = edited('tones', (ts) =>
            ts.replace(/\n\};/, "\n    'sky-blue': 'bg-sky-500/12 text-sky-800 dark:text-sky-200',\n};"),
        );
        expect(Object.keys(buildTheme(quoted).light.tones)).toContain('sky-blue');
        expect(staleFiles(OUTPUT_DIR, quoted)).toEqual(both);
        const template = edited('tones', (ts) =>
            ts.replace(/\n\};/, '\n    teal: `bg-teal-500/12 text-teal-700`,\n};'),
        );
        expect(() => buildTheme(template)).toThrow(/toneTile entry the generator can't read: "teal:/);
    });
});

describe('the generated files', () => {
    const theme: Theme = JSON.parse(generated('theme.json'));
    const css = generated('theme.css');

    /** A `@variant` block's declarations, as uniwind reads them. */
    const variant = (scheme: string) => {
        const body = new RegExp(`@variant ${scheme} \\{([^}]*)\\}`).exec(css)?.[1];
        expect(body, scheme).toBeDefined();
        return Object.fromEntries([...body!.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2]]));
    };

    it('are what the generator gives', () => {
        expect(theme).toEqual(buildTheme());
    });

    it('declare the same variables in light and dark, as uniwind requires', () => {
        expect(Object.keys(variant('dark'))).toEqual(Object.keys(variant('light')));
        expect(Object.keys(theme.dark.colors)).toEqual(Object.keys(theme.light.colors));
        expect(Object.keys(theme.dark.tones)).toEqual(Object.keys(theme.light.tones));
    });

    it('agree with each other: the CSS variants hold the JSON’s colors and tones', () => {
        for (const scheme of SCHEMES) {
            expect(variant(scheme)).toEqual(cssVariables(theme[scheme]));
        }
        expect(css).toMatch(/@layer theme \{\n {4}:root \{\n {8}@variant light \{/);
        for (const [size, value] of Object.entries(theme.radius)) {
            expect(css).toContain(`--radius-${size}: ${value}px;`);
        }
        for (const [size, { fontSize, lineHeight }] of Object.entries(theme.type.sizes)) {
            expect(css).toContain(`--text-${size}: ${fontSize}px;\n    --text-${size}--line-height: ${lineHeight}px;`);
        }
    });

    it('hold only colors React Native takes: hex, or rgba() for a tint', () => {
        expect(css).not.toMatch(/oklch|var\(|calc\(/);
        for (const scheme of SCHEMES) {
            for (const value of Object.values(variant(scheme))) {
                expect(value).toMatch(/^(?:#[\da-f]{6}|rgba\(\d+, \d+, \d+, (?:0|1|0\.\d+)\))$/);
            }
        }
    });

    it('name the tailwindcss whose palette they read: the app’s own', () => {
        const { version } = JSON.parse(readFileSync(join(SOURCES.tailwind, '../package.json'), 'utf8'));
        const declared = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')).devDependencies.tailwindcss;
        expect(version).toBe(declared);
        expect(css).toContain(`tailwindcss ${version}'s theme.css`);
    });
});

describe('what the theme takes from the web', () => {
    const theme = buildTheme();
    const globals = readFileSync(SOURCES.globals, 'utf8');
    const root = readBlock(globals, ':root');
    const tailwind = readBlock(readFileSync(SOURCES.tailwind, 'utf8'), '@theme default');
    const tones = readTones(readFileSync(SOURCES.tones, 'utf8'));

    it('carries every color token :root sets, in both schemes', () => {
        const colors = Object.keys(root).filter((name) => !['radius', 'page-top', 'page-gap'].includes(name));
        for (const scheme of SCHEMES) {
            expect(Object.keys(theme[scheme].colors).slice(0, colors.length)).toEqual(colors);
        }
        // The chat and paused-line tokens among them.
        for (const name of ['user-bubble', 'user-bubble-foreground', 'user-bubble-pending', 'chat-link']) {
            expect(colors).toContain(name);
        }
    });

    it('derives each mobile role from one web token, unchanged', () => {
        for (const scheme of SCHEMES) {
            const { colors } = theme[scheme];
            for (const [role, token] of Object.entries(ROLES)) {
                expect(colors[role], `${scheme} ${role}`).toBe(colors[token]);
            }
        }
    });

    it('departs from the web only for the selected row, by T3 Code’s correction', () => {
        for (const scheme of SCHEMES) {
            const { colors } = theme[scheme];
            const selected = withContrast(
                colors['sidebar-accent']!,
                [colors.sidebar!, colors.background!],
                SELECTED_ROW_CONTRAST,
            );
            expect(colors['row-selected']).toBe(selected);
            expect(colors['tab-bar-active']).toBe(selected);
            expect(colors['row-selected-foreground']).toBe(
                withContrast(colors['sidebar-accent-foreground']!, [selected], 4.5),
            );
            expect(colors['row-selected-muted-foreground']).toBe(
                withContrast(colors['sidebar-muted-foreground']!, [selected], 4.5),
            );
            expect(colors['tab-bar-active-foreground']).toBe(colors['row-selected-foreground']);
        }
    });

    it('takes the radius scale from @theme inline’s calc()s over Tailwind’s', () => {
        // --radius 0.6rem at 16 px: lg is the radius, sm/md/xl 4 px and 2 px off it.
        expect(root.radius).toBe('0.6rem');
        expect(theme.radius).toMatchObject({ sm: 5.6, md: 7.6, lg: 9.6, xl: 13.6 });
        // The rest are Tailwind's own.
        expect(tailwind['radius-2xl']).toBe('1rem');
        expect(theme.radius['2xl']).toBe(16);
        expect(theme.spacing).toEqual({ 'page-top': 16, 'page-gap': 20 });
    });

    it('takes the type scale from Tailwind’s, line heights in px', () => {
        expect(theme.type.sizes.xs).toEqual({ fontSize: 12, lineHeight: 16 });
        expect(theme.type.sizes.sm).toEqual({ fontSize: 14, lineHeight: 20 });
        expect(theme.type.sizes.base).toEqual({ fontSize: 16, lineHeight: 24 });
        expect(theme.type.sizes['2xl']).toEqual({ fontSize: 24, lineHeight: 32 });
        expect(theme.type.sizes['5xl']).toEqual({ fontSize: 48, lineHeight: 48 });
        expect(Object.keys(theme.type.sizes)).not.toContain('shadow-xs');
        expect(theme.type.weights).toMatchObject({ normal: 400, medium: 500, semibold: 600, bold: 700 });
        expect(theme.type.leading.tight).toBe(1.25);
        expect(theme.type.trackingEm.tight).toBe(-0.025);
    });

    it('paints each tone from tones.ts against Tailwind’s palette, the tint composited over each surface', () => {
        for (const scheme of SCHEMES) {
            const { colors, tones: generatedTones } = theme[scheme];
            expect(Object.keys(generatedTones)).toEqual(Object.keys(tones));
            for (const [tone, classes] of Object.entries(tones)) {
                const { background, foreground } = classes[scheme];
                const paint = (color: string) =>
                    tailwind[`color-${color}`] === undefined
                        ? parseColor(colors[color]!)
                        : oklchToRgb(tailwind[`color-${color}`]!);
                const tile = paint(background.color);
                const generatedTone = generatedTones[tone]!;
                expect(generatedTone.foreground, `${scheme} ${tone}`).toBe(toHex(paint(foreground.color)));
                expect(generatedTone.tint).toBe(rgba(tile, background.alpha));
                expect(Object.keys(generatedTone.tiles)).toEqual([...TILE_SURFACES]);
                for (const surface of TILE_SURFACES) {
                    expect(generatedTone.tiles[surface]).toBe(
                        toHex(composite(tile, background.alpha, parseColor(colors[surface]!))),
                    );
                }
            }
        }
        // mint is the theme's primary, a heavier tint in dark.
        expect(theme.light.tones.mint!.tint).toBe(rgba(parseColor(theme.light.colors.primary!), 0.12));
        expect(theme.dark.tones.mint!.tint).toBe(rgba(parseColor(theme.dark.colors.primary!), 0.2));
    });
});

describe('what the native config takes from it', () => {
    const theme: Theme = JSON.parse(generated('theme.json'));
    const config = appConfig({ config: {} } as ConfigContext);
    const plugin = (suffix: string) =>
        config.plugins?.find((entry) => Array.isArray(entry) && String(entry[0]).endsWith(suffix)) as
            | [string, Record<string, unknown>]
            | undefined;

    it('gives Android’s alert dialogs the card, foreground, muted-foreground and primary', () => {
        const dialog = plugin('/withAndroidModernAlertDialog.cjs');
        expect(dialog).toBeDefined();
        const props = dialog![1] as Record<'light' | 'night', Record<string, string>>;
        const palette = ({ colors }: SchemeTheme) => ({
            background: colors.card,
            text: colors.foreground,
            secondaryText: colors['muted-foreground'],
            buttonText: colors.primary,
        });
        expect({ light: props.light, night: props.night }).toEqual({
            light: palette(theme.light),
            night: palette(theme.dark),
        });
    });

    it('puts the splash on the screen color of the phone’s scheme, light or dark', () => {
        const splash = plugin('expo-splash-screen');
        expect(splash).toBeDefined();
        const props = splash![1] as { backgroundColor: string; image: string; dark: Record<string, string> };
        expect(props.backgroundColor).toBe(theme.light.colors.screen);
        expect(props.dark.backgroundColor).toBe(theme.dark.colors.screen);
        expect(props.dark.image).toBe(props.image);
    });

    it('starts the root view on light’s screen color, which the app changes with the scheme', () => {
        expect(config.backgroundColor).toBe(theme.light.colors.screen);
        expect(config.userInterfaceStyle).toBe('automatic');
        expect(config.plugins).toContain('expo-system-ui');
        const bars = readFileSync(join(app, 'src/theme/system-bars.tsx'), 'utf8');
        expect(bars).toMatch(/SystemUI\.setBackgroundColorAsync\(background\)/);
        expect(bars).toMatch(/colorsOf\(scheme\)\.screen/);
    });
});
