// The Locals' still pictures for the app's avatars (small sizes use
// rasterized images): each Local's art from the web
// (packages/client/src/locals/art), at rest and without its paper tile, as the
// web's RigAvatar shows it in the app, rendered in Playwright's Chromium to
// assets/locals/<local>.png at 64 px, with @2x and @3x beside it, so Metro
// gives each screen its density. 64 pt is the largest an avatar is drawn
// (src/ui/local-art.ts). The files are committed; run it again when the art
// changes. Offline: the page loads nothing.
//
//   node apps/mobile/scripts/locals.mts
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from 'playwright';

import { LOCALS } from '../../../packages/shared/src/mascot.ts';

const BASE = 64;
const SCALES = [1, 2, 3] as const;
const art = join(import.meta.dirname, '../../../packages/client/src/locals/art');
const out = join(import.meta.dirname, '../assets/locals');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();
await page.route('**/*', (route) => route.abort());
for (const local of LOCALS) {
    const svg = readFileSync(join(art, `${local}.svg`), 'utf8');
    for (const scale of SCALES) {
        const size = BASE * scale;
        await page.setViewportSize({ width: size, height: size });
        await page.setContent(
            `<!DOCTYPE html><html><head><style>html,body{margin:0;background:transparent}svg{display:block}[data-rig=tile]{display:none}</style></head><body>${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`,
        );
        const name = scale === 1 ? `${local}.png` : `${local}@${scale}x.png`;
        await page.locator('svg').screenshot({ path: join(out, name), omitBackground: true });
    }
}
await browser.close();
console.log(`wrote ${LOCALS.length * SCALES.length} pictures to ${out}`);
