// Derives dark-mode rules for the legacy stylesheet (style.css), which
// predates the theme toggle and is light-only. Every rule that sets a
// color property is restated under `.dark` (one class more specific, same
// order), so the cascade between legacy rules is what it was and light mode
// is untouched. Colors are remapped by role:
//   - the shell's own colors map to the shadcn tokens (--foreground,
//     --card, --border, …), so legacy surfaces match the new ones;
//   - other light surfaces and borders get darker, dark text gets lighter
//     (OKLab lightness, hue kept, pastel chroma toned down);
//   - accent and inverse surfaces (mint bubbles, the call view) keep their
//     colors, and so does the light text on them; near-black buttons with
//     light text turn near-white with dark text (shadcn's dark primary);
//   - focus rings keep their hue and get light enough to see; translucent
//     shadows stay, scrims get denser, dark tints become light tints.
// The output is packages/client/src/styles/legacy-dark.css, checked by
// tests/integration/legacy-dark.test.ts (`pnpm exec vitest run tests/integration/legacy-dark.test.ts -u`
// regenerates it after style.css changes).

type Role = 'fg' | 'bg' | 'line' | 'ring' | 'shadow';

interface Rule {
    selector: string;
    declarations: [string, string][];
}
type Block = { rule: Rule } | { at: string; children: Block[] };

/** Splits `text` at `separator` outside parentheses and quotes. */
function splitTop(text: string, separator: string) {
    const parts: string[] = [];
    let depth = 0;
    let quote = '';
    let start = 0;
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (quote) {
            if (char === quote) {
                quote = '';
            }
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === '(') {
            depth++;
        } else if (char === ')') {
            depth--;
        } else if (char === separator && depth === 0) {
            parts.push(text.slice(start, index));
            start = index + 1;
        }
    }
    parts.push(text.slice(start));
    return parts.map((part) => part.trim()).filter(Boolean);
}

/** The index of the brace closing the block that opens at `open`. */
function closing(css: string, open: number) {
    let depth = 0;
    let quote = '';
    for (let index = open; index < css.length; index++) {
        const char = css[index];
        if (quote) {
            if (char === quote) {
                quote = '';
            }
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === '{') {
            depth++;
        } else if (char === '}' && --depth === 0) {
            return index;
        }
    }
    throw new Error('Unbalanced braces in a legacy stylesheet');
}

/** Rules and conditional at-rules; keyframes and statements are skipped. */
function parse(css: string): Block[] {
    const blocks: Block[] = [];
    let index = 0;
    while (index < css.length) {
        const open = css.indexOf('{', index);
        const semicolon = css.indexOf(';', index);
        if (open < 0) {
            break;
        }
        // A statement at-rule (`@import …;`) before the next block.
        if (semicolon >= 0 && semicolon < open && /^\s*@/.test(css.slice(index))) {
            index = semicolon + 1;
            continue;
        }
        const header = css.slice(index, open).trim();
        const end = closing(css, open);
        const body = css.slice(open + 1, end);
        if (header.startsWith('@')) {
            if (/^@(media|supports|container|layer)\b/.test(header)) {
                blocks.push({ at: header, children: parse(body) });
            }
        } else {
            blocks.push({
                rule: {
                    selector: header,
                    declarations: splitTop(body, ';').map((declaration) => {
                        const colon = declaration.indexOf(':');
                        return [declaration.slice(0, colon).trim().toLowerCase(), declaration.slice(colon + 1).trim()];
                    }),
                },
            });
        }
        index = end + 1;
    }
    return blocks;
}

// Color maths: sRGB <-> OKLab.
type Rgba = [number, number, number, number];
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function toOklab([r, g, b]: Rgba) {
    const [lr, lg, lb] = [r, g, b].map(toLinear) as [number, number, number];
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    return {
        L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
        a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
        b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    };
}

function fromOklab(L: number, a: number, b: number) {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ].map(fromLinear);
}

/** The sRGB color at lightness L with the chroma scaled into gamut. */
function inGamut(L: number, a: number, b: number) {
    const fits = (scale: number) => fromOklab(L, a * scale, b * scale).every((c) => c >= -0.0005 && c <= 1.0005);
    let scale = 1;
    if (!fits(1)) {
        let low = 0;
        let high = 1;
        for (let step = 0; step < 20; step++) {
            const middle = (low + high) / 2;
            if (fits(middle)) {
                low = middle;
            } else {
                high = middle;
            }
        }
        scale = low;
    }
    return fromOklab(L, a * scale, b * scale).map((c) => Math.min(1, Math.max(0, c)));
}

const NAMED: Record<string, string> = { white: '#ffffff', black: '#000000' };
const COLOUR = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black)\b/gi;

function parseColour(text: string): Rgba | undefined {
    const value = NAMED[text.toLowerCase()] ?? text.toLowerCase();
    if (value.startsWith('#')) {
        let hex = value.slice(1);
        if (hex.length === 3 || hex.length === 4) {
            hex = [...hex].map((c) => c + c).join('');
        }
        if (hex.length !== 6 && hex.length !== 8) {
            return undefined;
        }
        const channel = (at: number) => parseInt(hex.slice(at, at + 2), 16) / 255;
        return [channel(0), channel(2), channel(4), hex.length === 8 ? channel(6) : 1];
    }
    const parts = value
        .replace(/^rgba?\(|\)$/g, '')
        .split(/[\s,/]+/)
        .filter(Boolean);
    if (parts.length < 3) {
        return undefined;
    }
    const channel = (part: string) => (part.endsWith('%') ? parseFloat(part) / 100 : parseFloat(part) / 255);
    const alpha = parts[3] ? (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1;
    return [channel(parts[0]!), channel(parts[1]!), channel(parts[2]!), alpha];
}

const hex = (rgb: number[], alpha = 1) =>
    '#' +
    [...rgb, ...(alpha < 1 ? [alpha] : [])]
        .map((c) =>
            Math.round(c * 255)
                .toString(16)
                .padStart(2, '0'),
        )
        .join('');

const normal = (text: string) => {
    const rgba = parseColour(text);
    return rgba ? hex(rgba.slice(0, 3), rgba[3]) : text.toLowerCase();
};

/**
 * Light-mode colors of the workspace chrome (style.css's second :root and
 * the views' common neutrals) and their tokens, per role.
 */
const TOKENS: Record<Role, Record<string, string>> = {
    fg: {
        '#242424': 'var(--foreground)',
        '#333641': 'var(--foreground)',
        '#282b2a': 'var(--foreground)',
        '#707070': 'var(--muted-foreground)',
    },
    bg: {
        '#ffffff': 'var(--card)',
        '#f1f1f1': 'var(--accent)',
    },
    line: {
        '#e7e7e7': 'var(--border)',
        '#e9e8e6': 'var(--border)',
    },
    ring: {},
    shadow: {},
};

/** Legacy custom properties and the token each one stands for in dark. */
const VARIABLES: Record<string, string> = {
    '--ink': 'var(--foreground)',
    '--muted-text': 'var(--muted-foreground)',
    '--line': 'var(--border)',
    '--lavender': 'var(--accent)',
    '--blue': 'var(--foreground)',
    '--blue-dark': 'var(--foreground)',
};

/** Lightness of text on a dark surface, from its lightness on a light one. */
function textLightness(L: number) {
    if (L <= 0.25) {
        return 0.95;
    }
    if (L <= 0.57) {
        return 0.95 - ((L - 0.25) / 0.32) * 0.23;
    }
    return 0.72 - ((L - 0.57) / 0.23) * 0.02;
}

/** The dark counterpart of one color; undefined keeps it. */
function remap(rgba: Rgba, role: Role, inverse: boolean): string | undefined {
    const { L, a, b } = toOklab(rgba);
    const alpha = rgba[3];
    const chroma = Math.hypot(a, b);
    const out = (lightness: number, chromaScale = 1, newAlpha = alpha) =>
        hex(inGamut(lightness, a * chromaScale, b * chromaScale), newAlpha);
    // An inverse button (near-black with light text) becomes near-white with
    // dark text, like shadcn's dark primary.
    if (inverse) {
        if ((role === 'bg' || role === 'line') && L < 0.4 && chroma < 0.03) {
            return out(1 - L * 0.25);
        }
        if (role === 'fg' && L > 0.8) {
            return 'var(--background)';
        }
    }
    if (role === 'shadow') {
        // Real shadows (translucent) stay; opaque ones draw rings and borders.
        if (alpha < 1) {
            return undefined;
        }
        role = 'line';
    }
    if (alpha < 1) {
        // Light veils sit on dark or colored surfaces: keep them.
        if (L > 0.85) {
            return undefined;
        }
        // Scrims behind dialogs stay dark, and get denser over a dark page.
        if (role === 'bg' && alpha >= 0.15 && L < 0.4) {
            return out(L, 1, Math.min(0.7, alpha * 2.5));
        }
        // Tints (hover, selection) on light surfaces become light tints.
        return out(Math.min(0.97, Math.max(0.6, 1 - L)), 1, Math.min(1, alpha * 1.4));
    }
    // Focus rings stay in their hue, light enough to see on a dark page.
    if (role === 'ring') {
        return L >= 0.72 ? undefined : out(0.72);
    }
    if (role === 'fg') {
        return L > 0.8 ? undefined : out(textLightness(L));
    }
    if (role === 'bg') {
        return L >= 0.75 ? out(0.235 + (1 - L) * 0.9, 0.6) : undefined;
    }
    return L >= 0.7 ? out(0.24 + (1 - L) * 1.1, 0.6) : undefined;
}

function roleOf(property: string): Role | undefined {
    if (
        /^(color|caret-color|fill|stroke|-webkit-text-fill-color|text-decoration(-color)?|accent-color)$/.test(property)
    ) {
        return 'fg';
    }
    if (/^background(-color|-image)?$/.test(property)) {
        return 'bg';
    }
    if (
        /^(border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?|column-rule(-color)?|scrollbar-color)$/.test(
            property,
        )
    ) {
        return 'line';
    }
    if (property === 'outline' || property === 'outline-color') {
        return 'ring';
    }
    if (property === 'box-shadow' || property === 'text-shadow') {
        return 'shadow';
    }
    return undefined;
}

const isLight = (value: string) => {
    const colours = value.match(COLOUR) ?? [];
    return (
        colours.length > 0 &&
        colours.every((colour) => {
            const rgba = parseColour(colour);
            return rgba ? toOklab(rgba).L > 0.8 : false;
        })
    );
};
const isDarkNeutral = (value: string) => {
    const colours = value.match(COLOUR) ?? [];
    return (
        colours.length === 1 &&
        (() => {
            const rgba = parseColour(colours[0]!);
            if (!rgba || rgba[3] < 1) {
                return false;
            }
            const { L, a, b } = toOklab(rgba);
            return L < 0.4 && Math.hypot(a, b) < 0.03;
        })()
    );
};

/** The selector without states, so `.send:hover` finds `.send`. */
const base = (selector: string) =>
    selector.replace(/:(hover|focus|focus-visible|focus-within|active|disabled|not\([^)]*\))/g, '').trim();

function prefix(selector: string) {
    return splitTop(selector, ',')
        .map((part) => {
            if (part.startsWith(':root')) {
                return `:root.dark${part.slice(5)}`;
            }
            if (/^html\b/.test(part)) {
                return `html.dark${part.slice(4)}`;
            }
            return `.dark ${part}`;
        })
        .join(',\n');
}

const canvas = (selector: string) => splitTop(selector, ',').every((part) => /^(:root|html|body)$/.test(part));

function darkDeclarations(rule: Rule, inverseSelectors: Set<string>) {
    const inverse = splitTop(rule.selector, ',').some((part) => inverseSelectors.has(base(part)));
    const result: [string, string][] = [];
    for (const [property, value] of rule.declarations) {
        if (property.startsWith('--')) {
            if (VARIABLES[property]) {
                result.push([property, VARIABLES[property]]);
            } else if (new RegExp(COLOUR.source, 'i').test(value)) {
                throw new Error(`No dark value for the legacy variable ${property}`);
            }
            continue;
        }
        const role = roleOf(property);
        if (!role) {
            continue;
        }
        if (canvas(rule.selector) && (role === 'bg' || role === 'fg')) {
            const token = role === 'bg' ? 'var(--background)' : 'var(--foreground)';
            result.push([property, value.replace(COLOUR, token)]);
            continue;
        }
        result.push([
            property,
            value.replace(COLOUR, (colour) => {
                const rgba = parseColour(colour);
                if (!rgba) {
                    return colour;
                }
                const token = !inverse && rgba[3] === 1 && TOKENS[role][normal(colour)];
                return token || remap(rgba, role, inverse) || colour;
            }),
        ]);
    }
    return result;
}

/** Rules that pair a near-black background with light text. */
function inverseSurfaces(blocks: Block[], found = new Set<string>()) {
    for (const block of blocks) {
        if ('at' in block) {
            inverseSurfaces(block.children, found);
        } else {
            const get = (name: RegExp) => block.rule.declarations.find(([property]) => name.test(property))?.[1];
            const background = get(/^background(-color)?$/);
            const color = get(/^color$/);
            if (background && color && isDarkNeutral(background) && isLight(color)) {
                for (const part of splitTop(block.rule.selector, ',')) {
                    found.add(base(part));
                }
            }
        }
    }
    return found;
}

function render(blocks: Block[], inverse: Set<string>, indent = ''): string[] {
    const out: string[] = [];
    for (const block of blocks) {
        if ('at' in block) {
            const inner = render(block.children, inverse, indent + '  ');
            if (inner.length) {
                out.push(`${indent}${block.at} {\n${inner.join('\n')}\n${indent}}`);
            }
            continue;
        }
        const declarations = darkDeclarations(block.rule, inverse);
        if (!declarations.length) {
            continue;
        }
        const selector = prefix(block.rule.selector)
            .split('\n')
            .map((line) => indent + line)
            .join('\n');
        out.push(
            `${selector} {\n${declarations
                .map(([property, value]) => `${indent}  ${property}: ${value};`)
                .join('\n')}\n${indent}}`,
        );
    }
    return out;
}

/** The dark stylesheet for the given legacy stylesheets, in their order. */
export function legacyDarkCss(sources: { name: string; css: string }[]) {
    const parsed = sources.map(({ name, css }) => ({
        name,
        blocks: parse(css.replace(/\/\*[\s\S]*?\*\//g, '')),
    }));
    const inverse = new Set<string>();
    for (const { blocks } of parsed) {
        inverseSurfaces(blocks, inverse);
    }
    return [
        '/*',
        ' * Generated from ' + sources.map(({ name }) => name).join(' and '),
        ' * by scripts/lib/legacy-dark.ts: dark mode for the legacy views. Do not',
        ' * edit; after changing a legacy stylesheet, regenerate with',
        ' *   pnpm exec vitest run tests/integration/legacy-dark.test.ts -u',
        ' */',
        ...parsed.flatMap(({ name, blocks }) => [`\n/* ${name} */`, ...render(blocks, inverse)]),
    ].join('\n');
}
