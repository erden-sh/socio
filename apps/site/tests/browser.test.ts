import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { dist } from './helpers.ts';

// The built site in Playwright's Chromium (the one the mockups and the screenshots use), served
// from the test build through a route on a made-up origin. Every other request is aborted, so the
// check stays offline.

const ORIGIN = 'http://site.invalid';
const TYPES: Record<string, string> = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
};

let browser: Browser;
beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
    await browser?.close();
});

async function open(viewport: { width: number; height: number }, path: string) {
    const context = await browser.newContext({ viewport });
    const outside: string[] = [];
    await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== ORIGIN) {
            outside.push(url.href);
            return route.abort();
        }
        let file = decodeURIComponent(url.pathname);
        if (file.endsWith('/')) {
            file += 'index.html';
        }
        if (!extname(file)) {
            file += '.html';
        }
        const full = join(dist(), file);
        if (!existsSync(full)) {
            return route.fulfill({ status: 404, body: '' });
        }
        return route.fulfill({
            body: readFileSync(full),
            contentType: TYPES[extname(full)] ?? 'application/octet-stream',
        });
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${ORIGIN}${path}`, { waitUntil: 'load' });
    return { context, page, errors, outside };
}

describe('the cookie settings dialog', () => {
    // Phones, a phone on its side, a short laptop, a desktop.
    const VIEWPORTS = [
        { width: 320, height: 568 },
        { width: 844, height: 390 },
        { width: 390, height: 844 },
        { width: 1280, height: 600 },
        { width: 1440, height: 900 },
    ];

    for (const viewport of VIEWPORTS) {
        it(`keeps Reject all, Accept all and Save choices reachable at ${viewport.width}×${viewport.height}`, async () => {
            const { context, page, errors, outside } = await open(viewport, '/cookies');
            try {
                await page.click('.footer-bottom [data-open-cookie-settings]');
                const dialog = page.locator('#consent-settings');
                await expect.poll(() => dialog.evaluate((node) => (node as HTMLDialogElement).open)).toBe(true);
                for (const action of ['reject', 'accept', 'save']) {
                    const button = dialog.locator(`footer [data-consent="${action}"]`);
                    // As it opens, with no scrolling done for the person (a script can scroll even an
                    // overflow: hidden box, so that would prove nothing): inside the window and the
                    // dialog's visible box, with nothing drawn over its middle.
                    const reachable = await button.evaluate((node) => {
                        const box = node.getBoundingClientRect();
                        const frame = (node.closest('dialog') as HTMLElement).getBoundingClientRect();
                        const x = box.left + box.width / 2;
                        const y = box.top + box.height / 2;
                        const inside = (r: DOMRect) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
                        const hit = document.elementFromPoint(x, y);
                        return (
                            box.height > 0 &&
                            y >= 0 &&
                            y <= window.innerHeight &&
                            inside(frame) &&
                            (hit === node || node.contains(hit))
                        );
                    });
                    expect(reachable, action).toBe(true);
                }
                // Whatever doesn't fit, the person can scroll to.
                const scroll = await dialog.evaluate((node) => ({
                    overflows: node.scrollHeight > node.clientHeight,
                    overflowY: getComputedStyle(node).overflowY,
                }));
                if (scroll.overflows) {
                    expect(['auto', 'scroll']).toContain(scroll.overflowY);
                }
                // And the last one works: the choice is saved and the dialog closes.
                await dialog.locator('footer [data-consent="save"]').click();
                await expect.poll(() => dialog.evaluate((node) => (node as HTMLDialogElement).open)).toBe(false);
                expect(await page.evaluate(() => localStorage.getItem('socio_consent'))).toContain('"analytics":false');
                expect(errors).toEqual([]);
                expect(outside).toEqual([]);
            } finally {
                await context.close();
            }
        });
    }
});

describe('icons beside their text in the forms', () => {
    // A broad `.field label` rule once outranked the chips' own layout: the icon sat jammed against
    // the text, above its middle. Measured as drawn: the icon's middle against the first line of
    // text's middle, and the space between them against the control's CSS gap.
    const VIEWPORTS = [
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
    ];
    const CONTROLS = [
        // The waitlist's "I'm interested in" chips: icon, then a bare text node.
        { path: '/hosted', selector: '.chips .chip', icon: 'svg', count: 3 },
        // The consent boxes: the box, then the text in a span.
        { path: '/hosted', selector: 'form .field label.check', icon: '.box', count: 1 },
        { path: '/self-host', selector: 'form .field label.check', icon: '.box', count: 1 },
    ];

    for (const viewport of VIEWPORTS) {
        for (const control of CONTROLS) {
            it(`lines up ${control.selector} on ${control.path} at ${viewport.width}×${viewport.height}`, async () => {
                const { context, page, errors, outside } = await open(viewport, control.path);
                try {
                    const items = page.locator(control.selector);
                    expect(await items.count()).toBe(control.count);
                    const measured = await items.evaluateAll(
                        (nodes, iconSelector) =>
                            nodes.map((node) => {
                                const icon = (node.querySelector(iconSelector) as Element).getBoundingClientRect();
                                // The text after the icon: a text node (chips) or an element (the box).
                                const after = [...node.childNodes].filter(
                                    (child) =>
                                        (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) ||
                                        (child instanceof Element &&
                                            child.tagName === 'SPAN' &&
                                            !child.matches(iconSelector)),
                                );
                                const text = after[after.length - 1] as ChildNode;
                                const range = document.createRange();
                                range.selectNodeContents(text);
                                const line = range.getClientRects()[0] as DOMRect;
                                return {
                                    label: node.textContent?.trim().slice(0, 30),
                                    iconMiddle: icon.top + icon.height / 2,
                                    textMiddle: line.top + line.height / 2,
                                    space: line.left - icon.right,
                                    gap: parseFloat(getComputedStyle(node).columnGap),
                                };
                            }),
                        control.icon,
                    );
                    for (const item of measured) {
                        expect(
                            Math.abs(item.iconMiddle - item.textMiddle),
                            `${item.label}: middles`,
                        ).toBeLessThanOrEqual(1.5);
                        expect(item.gap, `${item.label}: a gap is set`).toBeGreaterThan(0);
                        expect(
                            Math.abs(item.space - item.gap),
                            `${item.label}: space ${item.space}, gap ${item.gap}`,
                        ).toBeLessThanOrEqual(1);
                    }
                    expect(errors).toEqual([]);
                    expect(outside).toEqual([]);
                } finally {
                    await context.close();
                }
            });
        }
    }
});
