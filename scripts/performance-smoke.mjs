// CB-299 production-build regression check. Starts nothing; loopback only.
// node scripts/performance-smoke.mjs http://127.0.0.1:4399
// Use a fresh mock-auth server with the built UI. No model is contacted.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { chromium, devices } from 'playwright';

const base = process.argv[2] ?? 'http://127.0.0.1:4399';
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname), 'Test server must be loopback');
const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage(devices['iPhone 13']);
    const errors = [];
    const runtimeRequests = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
        if (message.type() === 'error') {
            errors.push(message.text());
        }
    });
    page.on('request', (request) => {
        if (new URL(request.url()).pathname.startsWith('/api/copilotkit')) {
            runtimeRequests.push(request.url());
        }
    });
    await page.goto(base, { waitUntil: 'networkidle' });
    const cold = await page.evaluate(() => {
        const js = performance.getEntriesByType('resource').filter((entry) => entry.name.includes('.js'));
        return {
            jsRequests: js.length,
            transferred: js.reduce((sum, entry) => sum + entry.transferSize, 0),
            decoded: js.reduce((sum, entry) => sum + entry.decodedBodySize, 0),
            chatChunks: js.filter((entry) => /ChatRuntime|CodingSessionRenderer|PageReviewRenderer/.test(entry.name))
                .length,
            characters: js.filter((entry) => /\/(sebas|manny|mingo|rulo|iggy|flake|lino|rosy)-/.test(entry.name))
                .length,
        };
    });
    assert(cold.decoded < 1_800_000, `Cold JS budget exceeded: ${cold.decoded}`);
    assert(cold.transferred < 600_000, `Cold transfer budget exceeded: ${cold.transferred}`);
    assert.equal(cold.chatChunks, 0, 'Chat-only code loaded before sign-in');
    assert.equal(cold.characters, 1, 'Only the displayed character should load');
    assert.equal(runtimeRequests.length, 0, 'Chat runtime initialized before sign-in');
    assert.equal(await page.locator('[data-local] svg').count(), 1, 'SSR mascot failed to hydrate');
    const login = await page.request.post(`${base}/api/auth/mock/login`, {
        data: {
            userId: (await (await page.request.get(`${base}/api/auth/mock/users`)).json()).find(
                (u) => u.role === 'admin' || u.role === 'operator',
            )?.id,
        },
    });
    assert.equal(login.status(), 200, 'Requires a local mock-auth server with an admin');
    await page.goto(`${base}/settings/performance`, { waitUntil: 'networkidle' });
    const guide = page.getByRole('region', { name: 'Getting started guide' });
    if (await guide.isVisible()) {
        await guide.getByRole('button', { name: 'Skip', exact: true }).click();
    }
    assert.equal(runtimeRequests.length, 0, 'Ordinary signed-in pages must not initialize chat');
    await page.getByRole('button', { name: 'Start recording', exact: true }).click();
    await page.waitForFunction(() => sessionStorage.getItem('socio:performance-recording'));
    // Navigate through the SPA while recording, so route duration and shell
    // commits make it into the report. Then reload to verify cold recording.
    await page
        .getByRole('navigation', { name: 'Settings', exact: true })
        .getByRole('link', { name: 'Profile', exact: true })
        .click();
    await page.waitForURL('**/settings/account');
    await page
        .getByRole('navigation', { name: 'Settings', exact: true })
        .getByRole('link', { name: 'Performance', exact: true })
        .click();
    await page.waitForURL('**/settings/performance');
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.getByRole('button', { name: 'Start recording', exact: true }).isDisabled(), true);
    await page.evaluate(() => fetch('/api/state?diagnostic-secret=never-export'));
    // A visible main-thread pause should be observable even without Long Tasks.
    await page.waitForTimeout(100);
    await page.evaluate(() => {
        const until = performance.now() + 140;
        while (performance.now() < until) {
            /* diagnostic fixture */
        }
    });
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download report', exact: true }).click();
    const download = await downloading;
    const report = JSON.parse(await readFile(await download.path(), 'utf8'));
    assert(report.entries.some((entry) => entry.kind === 'navigation'));
    assert(
        report.entries.some(
            (entry) => entry.kind === 'resource' && entry.route.startsWith('/assets/') && entry.decoded > 0,
        ),
        'Reload recording must include startup asset sizes',
    );
    assert(report.entries.some((entry) => entry.kind === 'request' && typeof entry.serverMs === 'number'));
    assert(report.entries.some((entry) => entry.kind === 'frame-stall' && entry.ms >= 80));
    assert(!JSON.stringify(report).includes('diagnostic-secret'));
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Download report', exact: true }).isDisabled(), true);
    assert.deepEqual(errors, [], 'Browser or hydration errors');
    console.log(JSON.stringify({ cold, diagnosticEntries: report.entries.length, checks: 'passed' }, null, 2));
} finally {
    await browser.close();
}
