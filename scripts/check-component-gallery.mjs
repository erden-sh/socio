#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { chromium } from 'playwright';

const address = process.argv[2] ?? 'http://127.0.0.1:4400';
const screenshots = process.argv[3];

const browser = await chromium.launch();
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1040 }, colorScheme: 'light' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(address);
    await page.getByRole('heading', { name: 'Component gallery' }).waitFor();

    const families = await page
        .locator('[data-sample]')
        .evaluateAll((samples) => samples.map((sample) => sample.dataset.sample));
    assert.equal(new Set(families).size, 25);
    const theme = page.getByRole('combobox', { name: 'Theme', exact: true });
    const mode = page.getByRole('combobox', { name: 'Color mode', exact: true });
    const themes = await theme.locator('option').evaluateAll((options) => options.map((option) => option.value));
    assert.equal(themes.length, 7);
    assert.equal(await theme.inputValue(), 'erden-glass');

    const waitAppearance = (palette, scheme) =>
        page.waitForFunction(
            ({ palette, scheme }) => {
                const { dataset, classList } = document.documentElement;
                return dataset.theme === palette && dataset.scheme === scheme && classList.contains(scheme);
            },
            { palette, scheme },
        );
    const savePreview = async (name) => {
        if (screenshots) {
            await mkdir(screenshots, { recursive: true });
            await page.screenshot({ path: join(screenshots, name + '.png'), fullPage: true, animations: 'disabled' });
        }
    };

    for (const id of themes) {
        await theme.selectOption(id);
        for (const scheme of ['light', 'dark']) {
            await mode.selectOption(scheme);
            await waitAppearance(id, scheme);
            if (id === 'socio' || id === 'erden-glass') {
                await savePreview(`${id}-${scheme}`);
            }
        }
    }
    await theme.selectOption('erden-glass');
    await mode.selectOption('system');
    await page.emulateMedia({ colorScheme: 'dark' });
    await waitAppearance('erden-glass', 'dark');
    assert.match(
        await page.locator('.gallery-header').evaluate((element) => getComputedStyle(element).backdropFilter),
        /blur/,
    );

    await page.emulateMedia({ forcedColors: 'active' });
    assert.equal(
        await page.locator('.gallery-header').evaluate((element) => getComputedStyle(element).backdropFilter),
        'none',
    );
    await page.emulateMedia({ forcedColors: 'none' });

    await mode.focus();
    await page.keyboard.press('Tab');
    const primary = page.getByRole('button', { name: 'Confirm changes' });
    assert.equal(await primary.evaluate((button) => button === document.activeElement), true);
    assert.equal(await primary.evaluate((button) => getComputedStyle(button).outlineWidth), '2px');
    assert.notEqual(await primary.evaluate((button) => getComputedStyle(button).transitionProperty), 'all');
    await page.waitForFunction(() => {
        const badge = document.querySelector('[data-sample="Badge"] [data-variant="destructive"]');
        return badge && getComputedStyle(badge).color === 'rgb(43, 21, 26)';
    });

    const email = page.getByRole('textbox', { name: 'Email', exact: true });
    assert.equal(await email.getAttribute('aria-invalid'), 'true');
    await email.fill('review@studio.example');
    assert.equal(await email.getAttribute('aria-invalid'), 'false');
    await theme.selectOption('erden');
    await waitAppearance('erden', 'dark');
    assert.equal(await email.inputValue(), 'review@studio.example');
    assert.equal(await page.getByRole('button', { name: 'Unavailable' }).isEnabled(), false);
    await page.getByRole('button', { name: 'Name', exact: true }).click();
    assert.equal(await page.getByRole('columnheader', { name: 'Name' }).getAttribute('aria-sort'), 'descending');

    const menuTrigger = page.getByRole('button', { name: 'Person actions' });
    await menuTrigger.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu');
    await menu.waitFor();
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await waitAppearance('erden', 'light');
    assert.equal(await menu.isVisible(), true);
    assert.equal(
        await page
            .locator('[data-slot="skeleton"]')
            .first()
            .evaluate((skeleton) => getComputedStyle(skeleton).animationName),
        'none',
    );
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.textContent === 'Person actions');

    const dialogTrigger = page.getByRole('button', { name: 'Invite people' });
    await dialogTrigger.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('dialog', { name: 'Invite people' }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.textContent === 'Invite people');

    await page.setViewportSize({ width: 390, height: 844 });
    for (const id of themes) {
        await theme.selectOption(id);
        assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth),
            390,
            id + ' fits a 390px viewport',
        );
    }
    await theme.selectOption('erden-glass');
    await mode.selectOption('dark');
    await savePreview('erden-glass-mobile');
    assert.deepEqual(errors, []);
    console.log(
        'Component gallery passed: 25 families, 14 appearances, form states, keyboard focus, open overlay, 390px layout and solid fallback.',
    );
} finally {
    await browser.close();
}
