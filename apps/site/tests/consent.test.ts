// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    ASK_ON_ARRIVAL,
    type Choice,
    CONSENT_DAYS,
    pickStorage,
    readChoice,
    startConsent,
    STORAGE_KEY,
    writeChoice,
} from '../src/client/consent.ts';

import { pageHtml } from './helpers.ts';

// The cookie choice: kept in localStorage as socio_consent for 12 months, asked again after.
// Nothing is sent: analytics arrive in a later change, and until then the banner doesn't open by itself.

const NOW = new Date('2026-11-16T12:00:00Z');
const DAY = 86_400_000;

function memoryStore(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => void data.set(key, value),
        data,
    };
}

/** A built page's body, loaded into jsdom's document (the script itself is not run). */
function loadPage() {
    const html = pageHtml('cookies');
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? '';
}

describe('the stored choice', () => {
    it('round-trips, and stands for 12 months', () => {
        const store = memoryStore();
        writeChoice(store, true, NOW);
        expect(JSON.parse(store.data.get(STORAGE_KEY) ?? '')).toEqual({ v: 1, analytics: true, at: NOW.toISOString() });
        expect(readChoice(store, new Date(NOW.getTime() + (CONSENT_DAYS - 1) * DAY))?.analytics).toBe(true);
        expect(readChoice(store, new Date(NOW.getTime() + CONSENT_DAYS * DAY))).toBeNull();
        expect(CONSENT_DAYS).toBe(365);
    });

    it('ignores anything unreadable, from another version, or from the future', () => {
        const at = NOW.toISOString();
        for (const raw of [
            'nope',
            '{}',
            JSON.stringify({ v: 2, analytics: true, at }),
            JSON.stringify({ v: 1, analytics: 'yes', at }),
            JSON.stringify({ v: 1, analytics: true, at: 'x' }),
        ]) {
            expect(readChoice(memoryStore({ [STORAGE_KEY]: raw }), NOW), raw).toBeNull();
        }
        const future = JSON.stringify({ v: 1, analytics: true, at: new Date(NOW.getTime() + DAY).toISOString() });
        expect(readChoice(memoryStore({ [STORAGE_KEY]: future }), NOW)).toBeNull();
    });

    it('survives storage that throws', () => {
        const broken = {
            getItem: () => {
                throw new Error('denied');
            },
            setItem: () => {
                throw new Error('denied');
            },
        };
        expect(readChoice(broken, NOW)).toBeNull();
        expect(writeChoice(broken, false, NOW).analytics).toBe(false);
    });
});

describe('the banner and the dialog', () => {
    let stop = () => {};
    beforeEach(loadPage);
    afterEach(() => stop());
    const banner = () => document.getElementById('consent-banner') as HTMLElement;
    const dialog = () => document.getElementById('consent-settings') as HTMLDialogElement;
    const toggle = () => document.getElementById('consent-analytics') as HTMLInputElement;
    const click = (selector: string) => (document.querySelector(selector) as HTMLElement).click();

    it('stays closed by itself until analytics exist (which turn ASK_ON_ARRIVAL on)', () => {
        expect(ASK_ON_ARRIVAL).toBe(false);
        stop = startConsent(document, memoryStore(), NOW);
        expect(banner().hidden).toBe(true);
    });

    it('opens when asked and no choice stands, and Reject and Accept each store and report the choice', () => {
        const store = memoryStore();
        const choices: Choice[] = [];
        stop = startConsent(document, store, NOW, (choice) => choices.push(choice), true);
        expect(banner().hidden).toBe(false);
        click('#consent-banner [data-consent="reject"]');
        expect(banner().hidden).toBe(true);
        expect(choices.map((choice) => choice.analytics)).toEqual([false]);
        expect(JSON.parse(store.data.get(STORAGE_KEY) ?? '').analytics).toBe(false);
    });

    it('does not ask again while a choice stands, and reports the standing one', () => {
        const store = memoryStore();
        writeChoice(store, true, NOW);
        const onChoice = vi.fn();
        stop = startConsent(document, store, NOW, onChoice, true);
        expect(banner().hidden).toBe(true);
        expect(onChoice).toHaveBeenCalledWith(expect.objectContaining({ analytics: true }));
    });

    it('opens the dialog from the footer, shows the standing choice, and saves the toggle', () => {
        const store = memoryStore();
        writeChoice(store, true, NOW);
        const choices: boolean[] = [];
        stop = startConsent(document, store, NOW, (choice) => choices.push(choice.analytics));
        click('.footer-bottom [data-open-cookie-settings]');
        expect(dialog().open).toBe(true);
        expect(toggle().checked).toBe(true);
        toggle().checked = false;
        click('#consent-settings [data-consent="save"]');
        expect(dialog().open).toBe(false);
        expect(choices).toEqual([true, false]);
        expect(JSON.parse(store.data.get(STORAGE_KEY) ?? '').analytics).toBe(false);
    });

    it('offers Reject all and Accept all side by side, styled the same (no dark pattern)', () => {
        for (const scope of ['#consent-banner', '#consent-settings']) {
            const reject = document.querySelector(`${scope} [data-consent="reject"]`) as HTMLElement;
            const accept = document.querySelector(`${scope} [data-consent="accept"]`) as HTMLElement;
            expect(reject.className, scope).toBe(accept.className);
        }
        expect((document.querySelector('[data-open-cookie-settings].btn') as HTMLElement).textContent).toContain(
            'Open cookie settings',
        );
    });
});

describe('starting up when the browser denies storage', () => {
    afterEach(() => {
        vi.resetModules();
        vi.restoreAllMocks();
    });

    it('falls back to memory when reading localStorage throws', () => {
        const store = pickStorage(() => {
            throw new DOMException('The operation is insecure.', 'SecurityError');
        });
        store.setItem(STORAGE_KEY, 'x');
        expect(store.getItem(STORAGE_KEY)).toBe('x');
        expect(pickStorage(() => null).getItem(STORAGE_KEY)).toBeNull();
    });

    it('still wires Cookie settings through the real entry (main.ts)', async () => {
        loadPage();
        vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
            throw new DOMException('The operation is insecure.', 'SecurityError');
        });
        await import('../src/client/main.ts');
        const dialog = document.getElementById('consent-settings') as HTMLDialogElement;
        (document.querySelector('.footer-bottom [data-open-cookie-settings]') as HTMLElement).click();
        expect(dialog.open).toBe(true);
        (document.querySelector('#consent-settings [data-consent="accept"]') as HTMLElement).click();
        expect(dialog.open).toBe(false);
        // Kept in memory for the page: reopening shows the choice.
        (document.querySelector('[data-open-cookie-settings].btn') as HTMLElement).click();
        expect((document.getElementById('consent-analytics') as HTMLInputElement).checked).toBe(true);
    });
});

describe('when storage refuses writes', () => {
    beforeEach(loadPage);
    let stop = () => {};
    afterEach(() => stop());
    const open = () => (document.querySelector('.footer-bottom [data-open-cookie-settings]') as HTMLElement).click();
    const press = (action: string) =>
        (document.querySelector(`#consent-settings [data-consent="${action}"]`) as HTMLElement).click();
    const toggle = () => document.getElementById('consent-analytics') as HTMLInputElement;

    it('shows the choice made on this page when the dialog reopens, over an older stored one', () => {
        const store = memoryStore();
        writeChoice(store, false, NOW);
        // Full from now on: every write throws, as a QuotaExceededError would.
        const full = {
            getItem: store.getItem,
            setItem: () => {
                throw new DOMException('full', 'QuotaExceededError');
            },
        };
        const choices: boolean[] = [];
        stop = startConsent(document, full, NOW, (choice) => choices.push(choice.analytics));
        open();
        expect(toggle().checked).toBe(false);
        press('accept');
        open();
        expect(toggle().checked).toBe(true);
        toggle().checked = false;
        press('save');
        open();
        expect(toggle().checked).toBe(false);
        press('accept');
        open();
        expect(toggle().checked).toBe(true);
        expect(choices).toEqual([false, true, false, true]);
        // Nothing was written: the stored choice is still the old one.
        expect(JSON.parse(store.data.get(STORAGE_KEY) ?? '').analytics).toBe(false);
    });
});
