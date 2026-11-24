// Renders each Local's still art to public/locals/<local>.png: the icon a
// notification shows (packages/shared/src/mascot.ts dotAvatarPath), for every
// Local in LOCALS. A Local whose rig isn't drawn yet uses Mingo's, as the app
// does (locals/characters).
//   node --import tsx scripts/locals/pngs.mjs
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { LOCALS } from '../../packages/shared/src/mascot.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const art = (id) => join(root, 'packages/client/src/locals/art', `${id}.svg`);
const out = join(root, 'public/locals');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
for (const id of LOCALS) {
    const svg = readFileSync(existsSync(art(id)) ? art(id) : art('mingo'), 'utf8');
    await page.setContent(
        `<body style="margin:0;background:transparent">${svg.replace('<svg ', '<svg width="256" height="256" ')}</body>`,
    );
    await page.locator('svg').screenshot({ path: join(out, `${id}.png`), omitBackground: true });
}
await browser.close();
console.log('wrote', out);
