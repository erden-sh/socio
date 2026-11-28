// The app's theme, generated from the web's.
//
//   node apps/mobile/scripts/generate-theme.mts           writes the files
//   node apps/mobile/scripts/generate-theme.mts --check   exits 1 if either is stale
//
// It reads packages/ui/src/styles/tokens.css (its top-level `:root` and `.light`
// rules for light, `:root` and `.dark` for dark, in source order as the cascade
// takes them; `@theme inline` for the radius scale), shell/tones.ts
// against Tailwind's palette in the app's own tailwindcss/theme.css (which
// also holds the type scale), and writes src/theme/generated/:
//
// - theme.css, uniwind's `@variant light` and `@variant dark` blocks of colors,
//   plus a `@theme` block of the radius and type scales in px;
// - theme.json, the same values for native views that take no class names.
//
// Both are written as oxfmt formats them. The app's tests run --check.
//
// Based on T3 Code's apps/mobile/scripts/generate-uniwind-themes.mts
// (https://github.com/pingdotgg/t3code, commit 240446e2d9, MIT, Copyright (c)
// 2026 T3 Tools Inc.; the license is in THIRD_PARTY_NOTICES at the repository
// root): the `@layer theme { :root { @variant … } }` layout, the atomic write
// and the --check mode. The color math is in theme/color.mts.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';

import { composite, isColor, parseColor, rgba, toHex, withContrast } from './theme/color.mts';
import {
    type Declarations,
    evaluate,
    number,
    px,
    readBlock,
    readCascade,
    readTones,
    resolve,
    round,
} from './theme/sources.mts';

const APP = join(import.meta.dirname, '..');
const ROOT = join(APP, '../..');
const fromApp = createRequire(join(APP, 'package.json'));

/** What the generator reads. */
export interface Sources {
    globals: string;
    tones: string;
    tailwind: string;
}

export const SOURCES: Sources = {
    globals: join(ROOT, 'packages/ui/src/styles/tokens.css'),
    tones: join(ROOT, 'packages/client/src/shell/tones.ts'),
    tailwind: fromApp.resolve('tailwindcss/theme.css'),
};

/** Where it writes, unless told otherwise (--out). */
export const OUTPUT_DIR = join(APP, 'src/theme/generated');

export const SCHEMES = ['light', 'dark'] as const;
export type Scheme = (typeof SCHEMES)[number];

/** The web's `:root` lengths that aren't colors: `radius` feeds the radius scale, the rest are spacing. */
const SPACING = ['page-top', 'page-gap'];

/**
 * The roles the app has and the web doesn't, each a web token.
 * The web draws its sheets and dialogs on `background` (shadcn's Sheet and
 * Dialog) and its header on the page itself, so screen, sheet and header all
 * come from the page. The tab bar comes from the sidebar, the web's
 * navigation, and its quieter words from the sidebar's. A message still
 * pending reads in `foreground` on its tint (ChatTranscript.tsx); the rest of
 * the user bubble is the web's own tokens (`user-bubble`, `-foreground`,
 * `-pending`, `-pending-border`, `chat-link`).
 */
export const ROLES: Readonly<Record<string, string>> = {
    screen: 'background',
    'screen-foreground': 'foreground',
    sheet: 'background',
    'sheet-foreground': 'foreground',
    header: 'background',
    'header-foreground': 'foreground',
    'tab-bar': 'sidebar',
    'tab-bar-foreground': 'sidebar-foreground',
    'tab-bar-muted-foreground': 'sidebar-muted-foreground',
    'tab-bar-border': 'sidebar-border',
    'user-bubble-pending-foreground': 'foreground',
};

/**
 * How far a selected row stands off what it sits on. The web marks one with
 * `sidebar-accent`, which is 1.06:1 on the sidebar in light: too faint on a
 * phone. T3 Code's correction (withVisibleSelection in
 * apps/mobile/src/lib/mobileThemeVariables.ts) moves it until it reaches
 * 1.2:1, then keeps its words at 4.5:1 on it. The plan ports that correction
 * (10); no other role departs from the web.
 */
export const SELECTED_ROW_CONTRAST = 1.2;
const TEXT_CONTRAST = 4.5;

/**
 * Increase Contrast: the accents and the tones take a stronger variant,
 * as the system's own colors do, iOS's DynamicColorIOS `highContrast…` (the
 * brand's teal and every tone keep their hue, blended toward black in Light and
 * white in Dark just far enough). 7:1 is WCAG's AAA for text, against the page
 * and a card (and each tone against its own tile).
 */
export const INCREASED_CONTRAST = 7;

/** The accents with an Increase Contrast variant: the brand's tint, red, a chat's links. */
export const CONTRAST_ACCENTS = ['primary', 'brand', 'destructive', 'chat-link'] as const;

/**
 * The surfaces a tone tile sits on, where the web puts them: the page (Home,
 * a page's heading), a card (Home's Apps card, the library), a sheet, the
 * sidebar (the drawer, on a phone) and a selected row in it.
 */
export const TILE_SURFACES = ['screen', 'card', 'sheet', 'sidebar', 'row-selected'] as const;

export interface Tone {
    /** The icon's and the words' color. */
    foreground: string;
    /** The tile, translucent, for anything that composites it itself. */
    tint: string;
    /** The tile over each surface, opaque. */
    tiles: Record<(typeof TILE_SURFACES)[number], string>;
}

export interface SchemeTheme {
    colors: Record<string, string>;
    tones: Record<string, Tone>;
    /** Increase Contrast's variants: each accent's, and each tone's words. */
    increasedContrast: { colors: Record<string, string>; tones: Record<string, string> };
}

export interface Theme {
    light: SchemeTheme;
    dark: SchemeTheme;
    radius: Record<string, number>;
    spacing: Record<string, number>;
    type: {
        sizes: Record<string, { fontSize: number; lineHeight: number }>;
        weights: Record<string, number>;
        leading: Record<string, number>;
        trackingEm: Record<string, number>;
    };
}

const read = (file: string) => readFileSync(file, 'utf8');

const tailwindVersion: string = JSON.parse(read(fromApp.resolve('tailwindcss/package.json'))).version;

/** The names in `tokens` that start with `prefix`, without it, in order. */
const named = (tokens: Declarations, prefix: string) =>
    Object.keys(tokens)
        .filter((name) => name.startsWith(prefix) && !name.includes('--'))
        .map((name) => name.slice(prefix.length));

/** The theme the web paints, as the app takes it (from other sources in the tests). */
export function buildTheme(sources: Sources = SOURCES): Theme {
    const globals = read(sources.globals);
    const root = readBlock(globals, ':root');
    // The dark tokens must still be where the generator looks for them.
    readBlock(globals, '.dark');
    const inline = readBlock(globals, '@theme inline');
    const tailwind = readBlock(read(sources.tailwind), '@theme default');
    const tones = readTones(read(sources.tones));

    // Each scheme's tokens as the browser computes them on <html>, which has
    // the `light` or `dark` class (shell/theme.tsx): every top-level `:root`
    // rule and every one for that class, in source order. They are equally
    // specific, so a later rule wins whichever it is, a `:root` after `.dark`
    // too.
    const tokens: Record<Scheme, Declarations> = {
        light: readCascade(globals, [':root', '.light']),
        dark: readCascade(globals, [':root', '.dark']),
    };
    for (const which of SCHEMES) {
        for (const name of Object.keys(tokens[which])) {
            if (root[name] === undefined) {
                throw new Error(
                    `.${which} sets --${name}, which :root doesn't: one scheme would have no value for it.`,
                );
            }
        }
    }
    for (const name of ['radius', ...SPACING]) {
        if (tokens.light[name] !== tokens.dark[name]) {
            throw new Error(`--${name} differs in light and dark: the app's lengths are the same in both schemes.`);
        }
    }

    // What a var() can reach in each scheme: Tailwind's theme, the web's
    // tokens and `@theme inline`, which maps Tailwind's names to them.
    const scopes: Record<Scheme, Declarations> = {
        light: { ...tailwind, ...tokens.light, ...inline },
        dark: { ...tailwind, ...tokens.dark, ...inline },
    };

    const scheme = (which: Scheme): SchemeTheme => {
        const scope = scopes[which];
        const colors: Record<string, string> = {};
        for (const name of Object.keys(root)) {
            const value = resolve(scope, name);
            if (isColor(value)) {
                colors[name] = toHex(parseColor(value));
            } else if (name !== 'radius' && !SPACING.includes(name)) {
                throw new Error(
                    `--${name} (${value}) is neither a color nor a known length: teach generate-theme.mts to carry it.`,
                );
            }
        }
        const token = (name: string) => {
            const color = colors[name];
            if (color === undefined) {
                throw new Error(`The app's roles need --${name}, which globals.css no longer sets as a color.`);
            }
            return color;
        };
        for (const [role, name] of Object.entries(ROLES)) {
            colors[role] = token(name);
        }
        const selected = withContrast(
            token('sidebar-accent'),
            [token('sidebar'), token('background')],
            SELECTED_ROW_CONTRAST,
        );
        colors['row-selected'] = selected;
        colors['row-selected-foreground'] = withContrast(token('sidebar-accent-foreground'), [selected], TEXT_CONTRAST);
        colors['row-selected-muted-foreground'] = withContrast(
            token('sidebar-muted-foreground'),
            [selected],
            TEXT_CONTRAST,
        );
        colors['tab-bar-active'] = selected;
        colors['tab-bar-active-foreground'] = colors['row-selected-foreground'];

        const paint = (color: string) => parseColor(resolve(scope, `color-${color}`));
        const schemeTones: Record<string, Tone> = {};
        for (const [tone, classes] of Object.entries(tones)) {
            const { background, foreground } = classes[which];
            if (foreground.alpha !== 1) {
                throw new Error(`The ${tone} tone's words are translucent (text-${foreground.color}/…).`);
            }
            const tile = paint(background.color);
            schemeTones[tone] = {
                foreground: toHex(paint(foreground.color)),
                tint: rgba(tile, background.alpha),
                tiles: Object.fromEntries(
                    TILE_SURFACES.map((surface) => [
                        surface,
                        toHex(composite(tile, background.alpha, parseColor(colors[surface]!))),
                    ]),
                ) as Tone['tiles'],
            };
        }
        const behind = [colors.screen!, colors.card!];
        const increasedContrast = {
            colors: Object.fromEntries(
                CONTRAST_ACCENTS.map((name) => [name, withContrast(token(name), behind, INCREASED_CONTRAST)]),
            ),
            tones: Object.fromEntries(
                Object.entries(schemeTones).map(([tone, { foreground, tiles }]) => [
                    tone,
                    withContrast(foreground, [...behind, tiles.screen, tiles.card], INCREASED_CONTRAST),
                ]),
            ),
        };
        return { colors, tones: schemeTones, increasedContrast };
    };

    // Lengths are the same in both schemes; light's scope reads them.
    const scope = scopes.light;
    const sizes = Object.fromEntries(
        named(scope, 'text-')
            .filter((size) => scope[`text-${size}--line-height`] !== undefined)
            .map((size) => {
                const fontSize = px(resolve(scope, `text-${size}`));
                // A ratio of the size (Tailwind's own), or a length.
                const leading = evaluate(resolve(scope, `text-${size}--line-height`));
                return [size, { fontSize, lineHeight: round(leading.px ? leading.value : leading.value * fontSize) }];
            }),
    );
    const em = (value: string) => {
        const match = /^(-?[\d.]+)em$/.exec(value);
        if (!match) {
            throw new Error(`Tracking "${value}" isn't in em.`);
        }
        return Number(match[1]);
    };
    return {
        light: scheme('light'),
        dark: scheme('dark'),
        radius: Object.fromEntries(named(scope, 'radius-').map((size) => [size, px(resolve(scope, `radius-${size}`))])),
        spacing: Object.fromEntries(SPACING.map((name) => [name, px(resolve(scope, name))])),
        type: {
            sizes,
            weights: Object.fromEntries(
                named(scope, 'font-weight-').map((weight) => [weight, number(resolve(scope, `font-weight-${weight}`))]),
            ),
            leading: Object.fromEntries(
                named(scope, 'leading-').map((name) => [name, number(resolve(scope, `leading-${name}`))]),
            ),
            trackingEm: Object.fromEntries(
                named(scope, 'tracking-').map((name) => [name, em(resolve(scope, `tracking-${name}`))]),
            ),
        },
    };
}

/** The CSS variables of one scheme, as uniwind reads them. */
export function cssVariables(scheme: SchemeTheme): Record<string, string> {
    const variables: Record<string, string> = {};
    for (const [name, value] of Object.entries(scheme.colors)) {
        variables[`--color-${name}`] = value;
    }
    for (const [tone, { foreground, tint }] of Object.entries(scheme.tones)) {
        variables[`--color-tone-${tone}`] = foreground;
        variables[`--color-tone-${tone}-tint`] = tint;
    }
    return variables;
}

const HEADER = [
    '/*',
    ' * Generated by apps/mobile/scripts/generate-theme.mts from packages/ui/src/styles/tokens.css,',
    ` * packages/client/src/shell/tones.ts and tailwindcss ${tailwindVersion}'s theme.css. Don't edit it: run`,
    " * `node apps/mobile/scripts/generate-theme.mts`. The app's tests fail while it is stale.",
    ' */',
];

/** theme.css, as oxfmt formats it. */
export function renderCss(theme: Theme): string {
    const block = (indent: string, declarations: Record<string, string | number>) =>
        Object.entries(declarations).map(([name, value]) => `${indent}${name}: ${value};`);
    const lengths: Record<string, string> = {};
    for (const [size, value] of Object.entries(theme.radius)) {
        lengths[`--radius-${size}`] = `${value}px`;
    }
    for (const [size, { fontSize, lineHeight }] of Object.entries(theme.type.sizes)) {
        lengths[`--text-${size}`] = `${fontSize}px`;
        lengths[`--text-${size}--line-height`] = `${lineHeight}px`;
    }
    const variants = SCHEMES.map((scheme) =>
        [`        @variant ${scheme} {`, ...block('            ', cssVariables(theme[scheme])), '        }'].join('\n'),
    );
    return [
        ...HEADER,
        '',
        "/* The web's radius and type scales, in px for React Native. */",
        '@theme {',
        ...block('    ', lengths),
        '}',
        '',
        "/* Colors: light, and dark (the web's graphite ramp). */",
        '@layer theme {',
        '    :root {',
        variants.join('\n\n'),
        '    }',
        '}',
        '',
    ].join('\n');
}

/** theme.json, as oxfmt formats it. */
export const renderJson = (theme: Theme) => `${JSON.stringify(theme, null, 4)}\n`;

/** Each output file and what it should hold. */
export function outputs(
    dir: string = OUTPUT_DIR,
    sources: Sources = SOURCES,
): ReadonlyArray<readonly [file: string, contents: string]> {
    const theme = buildTheme(sources);
    return [
        [join(dir, 'theme.css'), renderCss(theme)],
        [join(dir, 'theme.json'), renderJson(theme)],
    ];
}

/** The output files that are missing or differ from what the sources give. */
export const staleFiles = (dir: string = OUTPUT_DIR, sources: Sources = SOURCES) =>
    outputs(dir, sources)
        .filter(([file, contents]) => !existsSync(file) || read(file) !== contents)
        .map(([file]) => file);

/** Writes through a temporary file and a rename, so Metro never reads half a file. */
function writeAtomically(file: string, contents: string) {
    if (existsSync(file) && read(file) === contents) {
        return;
    }
    const temporary = `${file}.${process.pid}.tmp`;
    try {
        writeFileSync(temporary, contents);
        renameSync(temporary, file);
    } finally {
        rmSync(temporary, { force: true });
    }
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    const at = args.indexOf('--out');
    const dir = at >= 0 ? args[at + 1] : OUTPUT_DIR;
    const unknown = args.filter((arg, index) => arg !== '--check' && index !== at && (at < 0 || index !== at + 1));
    if (dir === undefined || unknown.length > 0) {
        console.error('Usage: node apps/mobile/scripts/generate-theme.mts [--check] [--out <dir>]');
        process.exit(2);
    }
    if (args.includes('--check')) {
        const stale = staleFiles(dir);
        for (const file of stale) {
            console.error(`${relative(process.cwd(), file)} is stale: run node apps/mobile/scripts/generate-theme.mts`);
        }
        process.exitCode = stale.length > 0 ? 1 : 0;
    } else {
        mkdirSync(dir, { recursive: true });
        for (const [file, contents] of outputs(dir)) {
            writeAtomically(file, contents);
        }
    }
}
