// The app's icon is a Local on the brand's paper tile: this crops one's rest
// pose to a square, writes it as public/favicon.svg (rounded, the browser
// tab's icon) and renders the installed app's icons into public/icons
// (CB-113): 192 and 512 as the favicon is; a maskable 512 and Apple's 180
// full-bleed, the Local smaller so the system's mask never cuts it. It also
// renders the native app's App Store icon (apps/mobile/assets): 1024 px,
// full-bleed and opaque, as App Store Connect requires. The files are
// committed; run it again when the art changes.
//
//   node scripts/locals/app-icon.mjs [character]   (default sebas)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const character = process.argv[2] ?? 'sebas';
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const art = readFileSync(join(root, 'packages/client/src/locals/art', `${character}.svg`), 'utf8');

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(art.replace('<svg ', '<svg id="art" '));
// The Local's extent: every part but the tile and its shadow.
const { box, fill } = await page.evaluate(() => {
    const svg = document.getElementById('art');
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const part of svg.querySelectorAll(':scope > g[data-rig]')) {
        if (['tile', 'shadow'].includes(part.dataset.rig)) {
            continue;
        }
        const r = part.getBBox();
        if (!r.width) {
            continue;
        }
        x0 = Math.min(x0, r.x);
        y0 = Math.min(y0, r.y);
        x1 = Math.max(x1, r.x + r.width);
        y1 = Math.max(y1, r.y + r.height);
    }
    const tile = svg.querySelector('[data-rig="tile"] rect');
    return { box: [x0, y0, x1, y1], fill: tile.getAttribute('fill') };
});
const round = (n) => +n.toFixed(2);
/** The Local filling `fit` of a square tile, its corners rounded or not. */
function icon(fit, rounded) {
    const [x0, y0, x1, y1] = box;
    const side = Math.max(x1 - x0, y1 - y0) / fit;
    const [x, y] = [(x0 + x1 - side) / 2, (y0 + y1 - side) / 2];
    const tile =
        `<rect x="${round(x)}" y="${round(y)}" width="${round(side)}" height="${round(side)}"` +
        `${rounded ? ` rx="${round(side * 0.18)}"` : ''} fill="${fill}"/>`;
    return art
        .replace(/viewBox="[^"]+"/, `viewBox="${round(x)} ${round(y)} ${round(side)} ${round(side)}"`)
        .replace(/<g data-rig="tile">.*?<\/g>/, tile);
}

const favicon = icon(0.84, true);
writeFileSync(join(root, 'public/favicon.svg'), favicon);
const icons = [
    ['icon-192.png', 192, favicon],
    ['icon-512.png', 512, favicon],
    // Android crops a maskable icon to as little as the middle 80% circle.
    ['icon-maskable-512.png', 512, icon(0.62, false)],
    // iOS only rounds the corners.
    ['apple-touch-icon.png', 180, icon(0.72, false)],
    // The native app's iOS icon, framed as Apple's 180 is. Its tile fills it, so it has no alpha.
    ['../../apps/mobile/assets/icon-ios-1024.png', 1024, icon(0.72, false)],
];
for (const [name, size, source] of icons) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
        `<body style="margin:0">${source.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`,
    );
    await page.locator('svg').screenshot({
        path: join(root, 'public/icons', name),
        omitBackground: true,
    });
}
await browser.close();
console.log(`${character}: public/favicon.svg and ${icons.length} icons`);
