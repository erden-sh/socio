// The web's side of the Markdown round trip in real browser engines:
// the web's page editor path (tests/editor/web-path.ts), built with the
// root's Vite, runs every corpus document in Playwright's Chromium (and
// WebKit with --webkit, where the host has its libraries) and compares each
// answer with Node's goldens (src/editor/generated/editor-corpus.ts), and the
// live corpus's when SOCIO_PAGES_CORPUS holds a device-corpus.json. Offline:
// the page is served by the route and every other request is aborted. Local
// only: CI has no browsers. A live failure prints only its hashed name and a
// line number.
//
//   node apps/mobile/scripts/roundtrip-browsers.mts [--webkit]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium, webkit } from 'playwright';

import { bundle } from './build-editor.mts';

const PAGE_URL = 'http://corpus.invalid/';
const { js } = await bundle(join(import.meta.dirname, '../tests/editor/web-path-browser.ts'));
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>${js}</script></body></html>`;

const liveFolder = process.env.SOCIO_PAGES_CORPUS;
const live: unknown[] = liveFolder
    ? (JSON.parse(readFileSync(join(liveFolder, 'device-corpus.json'), 'utf8')) as unknown[])
    : [];

interface Run {
    synthetic: number;
    live: number;
    equal: number;
    failures: string[];
}

let failed = 0;
for (const engine of process.argv.includes('--webkit') ? [chromium, webkit] : [chromium]) {
    const browser = await engine.launch();
    const page = await browser.newPage();
    const requests: string[] = [];
    await page.route('**/*', (route) => {
        if (route.request().url() === PAGE_URL) {
            return route.fulfill({ contentType: 'text/html', body: html });
        }
        requests.push(route.request().url());
        return route.abort();
    });
    await page.goto(PAGE_URL);
    const run = await page.evaluate(
        (documents) => (window as unknown as { runCorpus: (live: unknown[]) => Run }).runCorpus(documents),
        live,
    );
    failed += run.failures.length + requests.length;
    console.log(
        `${engine.name()} ${browser.version()}: ${run.equal} of ${run.synthetic + run.live} equal (${run.synthetic} synthetic, ${run.live} live), ${requests.length} requests left`,
    );
    run.failures.forEach((line) => console.log(`  ${line}`));
    await browser.close();
}
process.exit(failed === 0 ? 0 : 1);
