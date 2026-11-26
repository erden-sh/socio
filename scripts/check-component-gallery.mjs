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
    const desk = page.getByRole('region', { name: 'People Desk' });
    const deskToolbar = page.locator('.gallery-desk [data-slot="app-header"]');
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
    const savePreview = async (name, fullPage = true) => {
        if (screenshots) {
            await mkdir(screenshots, { recursive: true });
            await page.screenshot({ path: join(screenshots, name + '.png'), fullPage, animations: 'disabled' });
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
            if (id === 'erden-glass') {
                await page.evaluate(() => window.scrollTo(0, 0));
                await savePreview(`erden-glass-people-desk-${scheme}`, false);
            }
        }
    }
    await theme.selectOption('erden-glass');
    await mode.selectOption('system');
    await page.emulateMedia({ colorScheme: 'dark' });
    await waitAppearance('erden-glass', 'dark');
    assert.match(await deskToolbar.evaluate((element) => getComputedStyle(element).backdropFilter), /blur/);
    assert.equal(await deskToolbar.evaluate((element) => getComputedStyle(element).borderRadius), '22px');
    const invite = desk.getByRole('button', { name: 'Invite people' });
    assert.equal(await invite.evaluate((element) => getComputedStyle(element).borderRadius), '999px');
    const deskTabs = desk.getByRole('tablist');
    assert.equal(await deskTabs.evaluate((element) => getComputedStyle(element).borderRadius), '999px');
    for (const panel of await desk.locator('[data-slot="card"]').all()) {
        const panelStyle = await panel.evaluate((element) => {
            const { backdropFilter, borderRadius } = getComputedStyle(element);
            return { backdropFilter, borderRadius };
        });
        assert.deepEqual(panelStyle, { backdropFilter: 'none', borderRadius: '18px' });
    }
    const expired = desk.getByRole('button', { name: /Sofia Rivera/ }).getByText('Invite expired');
    assert.equal(await expired.evaluate((element) => getComputedStyle(element, '::before').width), '6px');
    const quick = desk.getByRole('button', { name: 'Quick actions' });
    await quick.focus();
    await page.keyboard.press('Enter');
    const command = page.getByRole('dialog', { name: 'Quick actions' });
    await command.waitFor();
    assert.match(await command.evaluate((element) => getComputedStyle(element).backdropFilter), /blur/);
    await savePreview('erden-glass-quick-actions-dark', false);
    await page.emulateMedia({ contrast: 'more' });
    assert.equal(await command.evaluate((element) => getComputedStyle(element).backdropFilter), 'none');
    assert.doesNotMatch(await command.evaluate((element) => getComputedStyle(element).backgroundColor), /\//);
    await page.emulateMedia({ contrast: 'no-preference' });
    await command.getByRole('combobox').fill('sofia');
    await page.keyboard.press('Enter');
    await command.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.textContent === 'Quick actions');
    assert.equal(await desk.getByRole('button', { name: /Sofia Rivera/ }).getAttribute('aria-pressed'), 'true');
    const review = desk.getByRole('button', { name: 'Access review' });
    await review.focus();
    await page.keyboard.press('Enter');
    const accessReview = page.getByRole('dialog', { name: 'Access review' });
    await accessReview.getByRole('button', { name: /Elena Morales/ }).click();
    await accessReview.waitFor({ state: 'hidden' });
    assert.equal(await desk.getByRole('button', { name: /Elena Morales/ }).getAttribute('aria-pressed'), 'true');
    await desk.getByRole('searchbox').fill('Avery');
    assert.equal(await desk.getByRole('button', { name: /Elena Morales/ }).count(), 0);
    await desk.getByRole('searchbox').fill('');

    const menuTrigger = page.getByRole('button', { name: 'Person actions' });
    const menu = page.getByRole('menu');
    await menuTrigger.click();
    await menu.waitFor();
    assert.match(await menu.evaluate((node) => getComputedStyle(node).backdropFilter), /blur/);
    await page.emulateMedia({ forcedColors: 'active' });
    assert.equal(await menu.evaluate((node) => getComputedStyle(node).backdropFilter), 'none');
    assert.equal(await deskToolbar.evaluate((element) => getComputedStyle(element).backdropFilter), 'none');
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    await page.emulateMedia({ forcedColors: 'none' });

    const primary = page.getByRole('button', { name: 'Confirm changes' });
    await page.keyboard.press('Tab');
    await primary.focus();
    assert.equal(await primary.evaluate((button) => button === document.activeElement), true);
    assert.equal(await primary.evaluate((button) => getComputedStyle(button).outlineWidth), '2px');
    assert.notEqual(await primary.evaluate((button) => getComputedStyle(button).transitionProperty), 'all');
    await page.waitForFunction(() => {
        const badge = document.querySelector('[data-sample="Badge"] [data-variant="destructive"]');
        return badge && getComputedStyle(badge).color === 'rgb(43, 21, 26)';
    });

    await theme.focus();
    await page.keyboard.press('Tab');
    assert.equal(await mode.evaluate((select) => getComputedStyle(select).outlineWidth), '2px');

    const textarea = page.getByRole('textbox', { name: 'Review note' });
    await textarea.focus();
    assert.equal(await textarea.evaluate((field) => getComputedStyle(field).outlineWidth), '2px');
    await page.keyboard.press('Tab');
    const roleSelect = page.getByRole('combobox', { name: 'Role', exact: true });
    assert.equal(await roleSelect.evaluate((select) => select === document.activeElement), true);
    assert.equal(await roleSelect.evaluate((select) => getComputedStyle(select).outlineWidth), '2px');
    await page.keyboard.press('Space');
    await page.getByRole('option', { name: 'Member' }).waitFor();
    await page.keyboard.press('Escape');
    await page.locator('[data-slot="select-content"]').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.id === 'role');

    const reviewSwitch = page.getByRole('switch', { name: 'Require review' });
    await reviewSwitch.focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(
        () => document.querySelector('[data-slot="switch"]')?.getAttribute('aria-checked') === 'false',
    );
    const thumb = reviewSwitch.locator('[data-slot="switch-thumb"]');
    assert.notEqual(
        await thumb.evaluate((node) => getComputedStyle(node).backgroundColor),
        await reviewSwitch.evaluate((node) => getComputedStyle(node).backgroundColor),
    );

    const email = page.getByRole('textbox', { name: 'Email', exact: true });
    assert.equal(await email.getAttribute('aria-invalid'), 'true');
    await email.fill('review@studio.example');
    assert.equal(await email.getAttribute('aria-invalid'), 'false');
    await theme.selectOption('erden');
    await waitAppearance('erden', 'dark');
    assert.notEqual(await invite.evaluate((element) => getComputedStyle(element).borderRadius), '999px');
    assert.equal(await email.inputValue(), 'review@studio.example');
    assert.equal(await page.getByRole('button', { name: 'Unavailable' }).isEnabled(), false);
    await page.getByRole('button', { name: 'Name', exact: true }).click();
    assert.equal(await page.getByRole('columnheader', { name: 'Name' }).getAttribute('aria-sort'), 'descending');

    await menuTrigger.focus();
    await page.keyboard.press('Enter');
    await menu.waitFor();
    // Radix suppresses animation while it calculates the popup's position.
    await page.waitForFunction(() => {
        const content = document.querySelector('[data-slot="dropdown-menu-content"][data-state="open"]');
        if (!content) {
            return false;
        }
        return getComputedStyle(content).animationDuration === '0.15s';
    });
    assert.equal(await menu.evaluate((node) => getComputedStyle(node).transitionDuration), '0s');
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await waitAppearance('erden', 'light');
    assert.equal(await menu.isVisible(), true);
    assert.equal(await menu.evaluate((node) => getComputedStyle(node).animationName), 'none');
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

    await page.setViewportSize({ width: 390, height: 844 });
    await theme.selectOption('erden-glass');
    await waitAppearance('erden-glass', 'light');
    const expiredRow = desk.getByRole('button', { name: /Sofia Rivera/ });
    const expiredBadgeBounds = await expired.boundingBox();
    const rowArrowBounds = await expiredRow.locator('.desk-row-arrow').boundingBox();
    assert.ok(
        expiredBadgeBounds && rowArrowBounds && expiredBadgeBounds.x + expiredBadgeBounds.width < rowArrowBounds.x,
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await savePreview('erden-glass-people-desk-mobile', false);
    for (const [action, role, name, slot] of [
        ['Open invitation form', 'dialog', 'Invite people', 'dialog-content'],
        ['Remove invitation', 'alertdialog', 'Remove this invitation?', 'alert-dialog-content'],
        ['Person details', 'dialog', 'Imani Brooks', 'sheet-content'],
        ['Activity filter', 'dialog', undefined, 'popover-content'],
    ]) {
        const trigger = page.getByRole('button', { name: action, exact: true });
        await trigger.focus();
        await page.keyboard.press('Enter');
        const overlay = page.getByRole(role, { name, exact: true });
        await overlay.waitFor();
        const content = page.locator(`[data-slot="${slot}"]`);
        assert.equal(await content.evaluate((node) => getComputedStyle(node).animationName), 'none');
        const bounds = await content.boundingBox();
        assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391, action + ' fits a 390px viewport');
        if (slot === 'dialog-content') {
            await savePreview('erden-glass-dialog-mobile', false);
        }
        await page.keyboard.press('Escape');
        await overlay.waitFor({ state: 'hidden' });
        await page.waitForFunction((label) => document.activeElement?.textContent === label, action);
    }

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
        'Component gallery passed: People Desk surfaces and actions, 25 families, 14 appearances, keyboard focus, 390px layout and solid fallback.',
    );
} finally {
    await browser.close();
}
