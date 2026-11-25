import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8')) as {
    name: string;
    short_name: string;
    start_url: string;
    scope: string;
    display: string;
    background_color: string;
    theme_color: string;
    icons: { src: string; sizes: string; type: string; purpose?: string }[];
};

/** A PNG's width and height, from its IHDR chunk. */
function pngSize(path: string) {
    const bytes = readFileSync(path);
    expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
    return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}
const file = (src: string) => join('public', src);

it('is installable: a name, a start address in scope, standalone, and 192 and 512 icons (CB-113)', () => {
    expect(manifest.name).toBe('Socio');
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
    expect(manifest.start_url.startsWith(manifest.scope)).toBe(true);
    expect(manifest.display).toBe('standalone');
    const sizes = manifest.icons.filter((icon) => (icon.purpose ?? 'any') === 'any').map((icon) => icon.sizes);
    expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(manifest.icons.some((icon) => icon.purpose === 'maskable')).toBe(true);
});

it('lists each icon at the size its file is', () => {
    for (const icon of manifest.icons) {
        expect(icon.type).toBe('image/png');
        expect(pngSize(file(icon.src)), icon.src).toBe(icon.sizes);
    }
    expect(pngSize(file('/icons/apple-touch-icon.png'))).toBe('180x180');
});

it("matches the page's light theme colour", () => {
    const root = readFileSync('packages/client/src/root.tsx', 'utf8');
    const css = readFileSync('packages/client/src/styles/themes/erden-glass.css', 'utf8');
    for (const colour of [manifest.theme_color, manifest.background_color]) {
        expect(root).toContain(`content="${colour}"`);
        expect(css).toContain(`--background: ${colour};`);
    }
});
