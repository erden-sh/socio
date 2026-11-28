import { readFileSync } from 'node:fs';

import { expect } from 'vitest';

// The theme's tokens as the UI package sets them: `:root` for light, and
// `.dark` laid over it for dark, as the browser resolves them.

const css = readFileSync(new URL(import.meta.resolve('@socio/ui/tokens.css')), 'utf8');

/** A block's custom properties: `:root { … }` or `.dark { … }`. */
function block(selector: string): Record<string, string> {
    const start = css.indexOf(`\n${selector} {`);
    expect(start, selector).toBeGreaterThanOrEqual(0);
    const body = css.slice(start, css.indexOf('\n}', start));
    return Object.fromEntries(
        [...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((match) => [match[1]!, match[2]!.trim()]),
    );
}

export type Theme = Record<string, string>;

/** Only what `.dark` itself sets, without what it inherits from `:root`. */
export const darkBlock: Theme = block('.dark');
export const light: Theme = block(':root');
export const dark: Theme = { ...light, ...darkBlock };
export const themes = { light, dark };

/** A token's color in a theme, its var() references followed. */
export function color(theme: Theme, name: string): string {
    const value = theme[name];
    expect(value, name).toBeDefined();
    const ref = value!.match(/^var\(--([\w-]+)\)$/);
    return ref ? color(theme, ref[1]!) : value!;
}

const luminance = (hex: string) => {
    const channels = hex
        .replace('#', '')
        .match(/../g)!
        .map((pair) => parseInt(pair, 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
};

/** WCAG contrast of two 6-digit hex colors. */
export const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
};

/** The `@theme inline` block, where a token becomes a Tailwind color. */
export const themeInline = (() => {
    const start = css.indexOf('\n@theme inline {');
    expect(start, '@theme inline').toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf('\n}', start));
})();
