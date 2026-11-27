// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { PairStatus } from '@socio/shared/device-sign-in';

import { AddDeviceDialog, askingDevice, claimingDevice, countdown } from '../src/shell/AddDeviceDialog';
import { appReach, forgetAppReach } from '../src/shell/app-reach';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

// CB-352: Add a device, the web's half.

let host: HTMLDivElement;
let root: Root;
let requests: { path: string; method: string; body?: unknown; keepalive?: boolean }[];
let minted: number;
let status: PairStatus;
let digitsAnswer: (digits: string) => { status: number; body: unknown };
let manifest: unknown;
let pairDelay = 0;
let confirmFails = false;
let mintFails = false;
let pairDelays: number[] = [];
let denyFails = false;
let pollDelays: number[] = [];

const unclaimed: PairStatus = { state: 'unclaimed', platform: null, label: null, claimedAt: null };
const claimed: PairStatus = {
    state: 'waiting',
    platform: 'ios',
    label: 'Ada’s iPhone',
    claimedAt: '2026-11-16T12:00:00Z',
};
/** As the Socio app names itself, with the claim's 2 minutes. */
const appClaim = (): PairStatus => ({
    state: 'waiting',
    platform: 'ios',
    label: 'Socio app on iPhone',
    claimedAt: new Date().toISOString(),
});

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    requests = [];
    minted = 0;
    status = unclaimed;
    digitsAnswer = (digits) =>
        digits === '123456'
            ? { status: 200, body: { state: 'allowed', triesLeft: 3 } }
            : { status: 400, body: { state: 'waiting', triesLeft: 2 } };
    manifest = undefined;
    pairDelay = 0;
    confirmFails = false;
    mintFails = false;
    pairDelays = [];
    denyFails = false;
    pollDelays = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const path = new URL(input, 'http://app.test').pathname;
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ path, method, ...(body ? { body } : {}), ...(init?.keepalive ? { keepalive: true } : {}) });
        if (path === '/api/auth/device/pair') {
            const delay = pairDelays.shift() ?? pairDelay;
            if (mintFails) {
                return Response.json({ error: 'Too many QR codes. Try again in a few minutes.' }, { status: 429 });
            }
            minted += 1;
            const made = minted;
            if (delay) {
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
            return Response.json({
                pairingId: `pairing-${made}-0123456789`,
                link: `https://link.socio.sh/app/d/brain.example.com#c=CODE${made}`,
                variant: 'production',
                expiresAt: new Date(Date.now() + 300_000).toISOString(),
            });
        }
        if (path.endsWith('/confirm')) {
            if (status.state !== 'waiting') {
                return Response.json(
                    { error: 'That code didn’t match. Make a new QR code.', code: 'denied' },
                    { status: 403 },
                );
            }
            const answer = digitsAnswer((body as { digits: string }).digits);
            if (answer.status === 200) {
                status = { ...status, state: 'allowed' };
            }
            if (confirmFails) {
                throw new TypeError('Failed to fetch');
            }
            return Response.json(answer.body, { status: answer.status });
        }
        if (path.endsWith('/deny') && denyFails && !init?.keepalive) {
            throw new TypeError('Failed to fetch');
        }
        if (path.endsWith('/deny')) {
            // As the server: a finished sign-in stays finished.
            status = status.state === 'signed_in' ? status : { ...status, state: 'denied' };
            return Response.json({ state: 'denied' });
        }
        if (path.startsWith('/api/auth/device/pair/')) {
            const seen = status;
            const delay = pollDelays.shift();
            if (delay) {
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
            return Response.json(seen);
        }
        if (path === '/api/auth/device/send-link') {
            return Response.json({ via: 'email' });
        }
        if (path === '/.well-known/socio/workspace') {
            return manifest ? Response.json(manifest) : new Response('', { status: 404 });
        }
        return Response.json({ ok: true });
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    forgetAppReach();
});

async function until(check: () => boolean, label = '') {
    for (let i = 0; i < 400; i++) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out ${label}: ${document.body.textContent}`);
}
const dialog = () => document.body.querySelector('[data-slot="add-device"]');
const button = (label: string) =>
    [...(dialog()?.querySelectorAll('button') ?? [])].find((entry) => entry.textContent?.trim() === label);
const code = () => dialog()?.querySelector<HTMLImageElement>('[data-slot="add-device-code"]');
const input = () => dialog()?.querySelector<HTMLInputElement>('input[aria-label="Code shown on your new device"]');
const type = (value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input()!, value);
    input()!.dispatchEvent(new Event('input', { bubbles: true }));
};
const title = () => dialog()?.querySelector('[data-slot="dialog-title"]')?.textContent;
const description = () => dialog()?.querySelector('[data-slot="dialog-description"]')?.textContent;
const paths = (suffix: string) => requests.filter((entry) => entry.path.endsWith(suffix));
const open = () => act(() => root.render(<AddDeviceDialog onClose={() => {}} />));

it('blurs the QR code until Show, and a new code replaces the old', async () => {
    await open();
    await until(() => !!code());
    expect(code()!.dataset.shown).toBe('false');
    expect(code()!.className).toContain('blur');
    expect(code()!.src).toMatch(/^data:image\/svg\+xml/);
    await act(async () => dialog()!.querySelector<HTMLButtonElement>('button[aria-label="Show the QR code"]')!.click());
    expect(code()!.dataset.shown).toBe('true');
    await act(async () => button('New code')!.click());
    await until(() => minted === 2);
    expect(code()!.dataset.shown).toBe('false');
    // Polls the new code only.
    await until(() => requests.some((entry) => entry.path === '/api/auth/device/pair/pairing-2-0123456789'));
});

it('asks before signing a claiming device in, naming it', async () => {
    await open();
    await until(() => !!code());
    status = claimed;
    await until(() => !!input(), 'confirm');
    expect(code()).toBeNull();
    expect(title()).toBe('Sign in on a new device?');
    // A label the device set itself: quoted as given, never vouched for.
    expect(description()).toBe(
        'A device called “Ada’s iPhone” is asking to sign in as you. If it’s yours, type the code it shows.',
    );
    expect(dialog()!.textContent).not.toContain('scan this code');
    // No Sign in button: the 6th digit sends the code.
    expect(button('Sign in')).toBeUndefined();
    expect(dialog()!.querySelector('button[type="submit"]')).toBeNull();
    expect(button('Not my device')).toBeDefined();
    type('123456');
    await until(() => paths('/confirm').length === 1, 'auto-submit');
    expect(paths('/confirm').map((entry) => entry.body)).toEqual([{ digits: '123456' }]);
    status = { ...claimed, state: 'signed_in' };
    await until(() => dialog()!.textContent!.includes('Ada’s iPhone is signed in'));
});

it('counts wrong tries, then ends the claim', async () => {
    await open();
    await until(() => !!code());
    status = claimed;
    await until(() => !!input());
    input()!.focus();
    type('000000');
    await until(() => dialog()!.textContent!.includes('That code didn’t match. 2 tries left.'));
    expect(paths('/confirm')).toHaveLength(1);
    // Cleared, and still the field to type in.
    expect(input()!.value).toBe('');
    expect(document.activeElement).toBe(input());
    digitsAnswer = () => ({ status: 400, body: { state: 'denied', triesLeft: 0 } });
    type('111111');
    await until(() => dialog()!.textContent!.includes('That code didn’t match. Make a new QR code.'));
    expect(button('New code')).toBeDefined();
});

it('denies on “Not my device”, and when the page goes', async () => {
    await open();
    await until(() => !!code());
    status = claimed;
    await until(() => !!input());
    await act(async () => button('Not my device')!.click());
    await until(() => paths('/deny').length === 1);
    expect(dialog()!.textContent).toContain('Nothing was signed in.');
    await act(async () => button('New code')!.click());
    await until(() => minted === 2 && !!code());
    window.dispatchEvent(new Event('pagehide'));
    await until(() => paths('/pairing-2-0123456789/deny').length === 1);
    expect(paths('/pairing-2-0123456789/deny')[0]!.keepalive).toBe(true);
});

it('says when the code expired', async () => {
    await open();
    await until(() => !!code());
    status = { ...unclaimed, state: 'expired' };
    await until(() => dialog()!.textContent!.includes('This QR code expired.'));
});

it('sends a link for the app', async () => {
    await open();
    await act(async () => button('Send me a link for the app')!.click());
    await until(() => paths('/send-link').length === 1);
});

it('offers Add a device only where the app can reach the workspace', async () => {
    expect(await appReach()).toEqual({ addDevice: false });
    forgetAppReach();
    manifest = {
        id: 'w',
        name: 'Brain',
        origin: 'https://brain.example.com',
        logo: null,
        serverVersion: '0.40.0',
        protocol: 1,
        methods: { password: true, passkey: true, sheet: true, signInCodes: null, addDevice: true },
        policy: { leaseDays: 30, wipeDays: 30, appLock: false, notificationText: true },
    };
    const found = await appReach();
    expect(found.addDevice).toBe(true);
});

it('counts down', () => {
    expect(countdown(299_001)).toBe('5:00');
    expect(countdown(61_000)).toBe('1:01');
    expect(countdown(-5)).toBe('0:00');
});

it('keeps waiting when a confirm’s answer is lost, and follows the claim', async () => {
    await open();
    await until(() => !!code());
    status = claimed;
    await until(() => !!input());
    confirmFails = true;
    type('123456');
    await until(() => dialog()!.textContent!.includes('Could not reach the server.'));
    expect(dialog()!.textContent).not.toContain('didn’t match');
    status = { ...claimed, state: 'signed_in' };
    await until(() => dialog()!.textContent!.includes('Ada’s iPhone is signed in'));
});

it('ignores the old code’s polls while a new one is made', async () => {
    await open();
    await until(() => !!code());
    pairDelay = 2500;
    await act(async () => button('New code')!.click());
    // The old code is denied by the new mint; a poll of it must not end the new one.
    status = { ...unclaimed, state: 'denied' };
    await act(() => new Promise((resolve) => setTimeout(resolve, 2000)));
    status = unclaimed;
    await until(() => minted === 2 && !!code(), 'new code');
    expect(dialog()!.textContent).not.toContain('didn’t match');
    await until(() => requests.some((entry) => entry.path === '/api/auth/device/pair/pairing-2-0123456789'));
});

it('retrying after a lost answer finds the device already allowed', async () => {
    await open();
    await until(() => !!code());
    status = claimed;
    await until(() => !!input());
    confirmFails = true;
    type('123456');
    await until(() => dialog()!.textContent!.includes('Could not reach the server.'));
    expect(paths('/confirm')).toHaveLength(1);
    // The field emptied for another try.
    expect(input()!.value).toBe('');
    confirmFails = false;
    // Typed again before the poll saw it: the server says the claim isn't waiting.
    type('123456');
    expect(paths('/confirm')).toHaveLength(2);
    await until(() => !dialog()!.textContent!.includes('didn’t match') && !input(), 'allowed');
    status = { ...claimed, state: 'signed_in' };
    await until(() => dialog()!.textContent!.includes('Ada’s iPhone is signed in'));
});

it('still ends the last code on leaving when a new one can’t be made', async () => {
    await open();
    await until(() => !!code());
    mintFails = true;
    await act(async () => button('New code')!.click());
    await until(() => dialog()!.textContent!.includes('Too many QR codes'));
    window.dispatchEvent(new Event('pagehide'));
    await until(() => paths('/pairing-1-0123456789/deny').length === 1);
});

it('keeps following the claim when “Not my device” doesn’t get through', async () => {
    await open();
    await until(() => !!code());
    status = claimed;
    await until(() => !!input());
    denyFails = true;
    await act(async () => button('Not my device')!.click());
    await until(() => dialog()!.textContent!.includes('Could not end it yet.'));
    expect(dialog()!.textContent).not.toContain('Nothing was signed in');
    denyFails = false;
    await act(async () => button('Not my device')!.click());
    await until(() => dialog()!.textContent!.includes('Nothing was signed in.'));
});

it('ends a code that arrives after the dialog closed', async () => {
    pairDelays = [400];
    await open();
    act(() => root.unmount());
    await until(() => paths('/pairing-1-0123456789/deny').length === 1, 'late deny');
    root = createRoot(host);
});

it('shows the latest code when StrictMode makes two and the first answers last', async () => {
    pairDelays = [500, 10];
    await act(() =>
        root.render(
            <StrictMode>
                <AddDeviceDialog onClose={() => {}} />
            </StrictMode>,
        ),
    );
    await until(() => paths('/pairing-1-0123456789/deny').length === 1, 'stale deny');
    await until(() => requests.some((entry) => entry.path === '/api/auth/device/pair/pairing-2-0123456789'));
    expect(requests.some((entry) => entry.path === '/api/auth/device/pair/pairing-1-0123456789')).toBe(false);
});

it('says so when “Not my device” comes after the device already signed in', async () => {
    await open();
    await until(() => !!code());
    status = claimed;
    await until(() => !!input());
    // Signed in meanwhile (the confirm's answer lost), before the poll saw it.
    status = { ...claimed, state: 'signed_in' };
    await act(async () => button('Not my device')!.click());
    await until(() => dialog()!.textContent!.includes('had already signed in'));
    expect(dialog()!.textContent).not.toContain('Nothing was signed in');
    expect(dialog()!.textContent).toContain('Ada’s iPhone is signed in');
});

it('never goes back to the QR code on a late poll', async () => {
    await open();
    await until(() => !!code());
    // The next poll answers "unclaimed" late, after the claim shows up.
    pollDelays = [2500];
    await act(() => new Promise((resolve) => setTimeout(resolve, 1600)));
    status = claimed;
    await until(() => !!input(), 'claim');
    // Watched throughout, until well after the late answer lands.
    for (let i = 0; i < 40; i++) {
        await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
        expect(code()).toBeNull();
    }
    expect(input()).not.toBeNull();
});

// CB-567: once a device claims the code, the dialog says what is happening.

it('names the claiming app, and counts down the claim’s time left', async () => {
    await open();
    await until(() => !!code());
    expect(title()).toBe('Add a device');
    expect(description()).toContain('scan this code');
    status = appClaim();
    await until(() => !!input(), 'claim');
    expect(title()).toBe('Sign in on a new device?');
    expect(description()).toBe('An iPhone is asking to sign in as you. If it’s yours, type the code it shows.');
    expect(dialog()!.textContent).not.toMatch(/your iPhone/i);
    // One line: the old "wants to sign in as you" is gone.
    expect(dialog()!.textContent).not.toContain('wants to sign in');
    const left = () => dialog()!.querySelector('[data-slot="add-device-claim-countdown"]')?.textContent;
    expect(left()).toMatch(/Time left: (2:00|1:5\d)\./);
    // The QR code's own countdown (its 5 minutes) is not the one shown.
    expect(dialog()!.querySelector('[data-slot="add-device-countdown"]')).toBeNull();
    const first = left();
    await until(() => left() !== first, 'tick');
    expect(left()).toMatch(/Time left: 1:5\d\./);
});

it('falls back to “your new device” when the claim carries no name', async () => {
    await open();
    await until(() => !!code());
    status = { ...claimed, platform: null, label: null, claimedAt: null };
    await until(() => !!input(), 'claim');
    expect(title()).toBe('Sign in on a new device?');
    expect(description()).toMatch(/^A new device is asking to sign in as you\./);
    // No claim time: no countdown, nothing made up.
    expect(dialog()!.querySelector('[data-slot="add-device-claim-countdown"]')).toBeNull();
});

it('names devices from what the claim carries', () => {
    expect(claimingDevice(undefined)).toBeUndefined();
    expect(claimingDevice({ ...claimed, label: 'Socio app on iPad' })).toEqual({ name: 'iPad', quoted: false });
    expect(claimingDevice({ ...claimed, label: 'Socio app on Android' })).toEqual({
        name: 'Android phone',
        quoted: false,
    });
    expect(claimingDevice({ ...claimed, label: 'Pixel 9' })).toEqual({ name: 'Pixel 9', quoted: true });
    expect(askingDevice(claimingDevice({ ...claimed, label: 'Socio app on Android' }))).toBe('An Android phone');
    expect(askingDevice(claimingDevice({ ...claimed, label: null, platform: 'ios' }))).toBe('An iPhone or iPad');
    expect(askingDevice(claimingDevice({ ...claimed, label: 'Pixel 9' }))).toBe('A device called “Pixel 9”');
    expect(askingDevice(undefined)).toBe('A new device');
    expect(claimingDevice({ ...claimed, label: null, platform: 'android' })).toEqual({
        name: 'Android phone',
        quoted: false,
    });
});

it('hides “No app yet?” once a device claimed the code, and shows it again with a new code', async () => {
    const footer = () => dialog()?.querySelector('[data-slot="add-device-no-app"]');
    await open();
    await until(() => !!code());
    expect(footer()).not.toBeNull();
    expect(button('Send me a link for the app')).toBeDefined();
    status = appClaim();
    await until(() => !!input(), 'claim');
    expect(footer()).toBeNull();
    expect(dialog()!.textContent).not.toContain('No app yet?');
    status = { ...status, state: 'signed_in' };
    await until(() => dialog()!.textContent!.includes('is signed in to your account'), 'signed in');
    expect(footer()).toBeNull();
});

it('makes the field a 6-digit code field', async () => {
    await open();
    await until(() => !!code());
    status = appClaim();
    await until(() => !!input(), 'claim');
    const field = input()!;
    expect(field.getAttribute('inputmode')).toBe('numeric');
    expect(field.getAttribute('autocomplete')).toBe('one-time-code');
    // No maxLength on the raw field, so a pasted "123 456" arrives whole; the digits are cut to 6.
    expect(field.hasAttribute('maxlength')).toBe(false);
    expect(field.getAttribute('pattern')).toBe('[0-9]{6}');
    expect(field.placeholder).toBe('6-digit code');
    expect(document.getElementById(field.getAttribute('aria-describedby')!)!.textContent).toContain(
        'The 6 digits shown on that device.',
    );
    type('12a-3');
    expect(input()!.value).toBe('123');
    expect(paths('/confirm')).toHaveLength(0);
    type('12 34 56 78');
    await until(() => paths('/confirm').length === 1, 'cut to 6');
    expect(paths('/confirm').map((entry) => entry.body)).toEqual([{ digits: '123456' }]);
});

it('sends the code once on the 6th typed digit, even with Enter and more typing on top', async () => {
    await open();
    await until(() => !!code());
    status = appClaim();
    await until(() => !!input(), 'claim');
    pollDelays = [];
    type('12345');
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(paths('/confirm')).toHaveLength(0);
    // Hold the confirm's answer so the extra submits land while it is on its way.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        if (String(input).endsWith('/confirm')) {
            await held;
        }
        return real(input, init);
    });
    await act(async () => {
        type('123456');
        input()!.form!.requestSubmit();
        type('12345');
        type('123456');
        input()!.form!.requestSubmit();
    });
    release();
    await until(() => !input(), 'allowed');
    expect(paths('/confirm').map((entry) => entry.body)).toEqual([{ digits: '123456' }]);
});

it.each(['123 456', '123-456', ' 123456 '])('sends a pasted “%s” once, as its digits', async (pasted) => {
    await open();
    await until(() => !!code());
    status = appClaim();
    await until(() => !!input(), 'claim');
    type(pasted);
    await until(() => !input(), 'allowed');
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(paths('/confirm').map((entry) => entry.body)).toEqual([{ digits: '123456' }]);
});

it('says a wrong code didn’t match without a count when the server gives none', async () => {
    await open();
    await until(() => !!code());
    status = appClaim();
    await until(() => !!input(), 'claim');
    digitsAnswer = () => ({ status: 400, body: { state: 'waiting' } });
    input()!.focus();
    type('000000');
    await until(() => dialog()!.textContent!.includes('That code didn’t match. Try again.'), 'mismatch');
    expect(dialog()!.textContent).not.toMatch(/tries? left/);
    expect(input()!.value).toBe('');
    expect(document.activeElement).toBe(input());
    expect(paths('/confirm')).toHaveLength(1);
    // The next code goes as well.
    digitsAnswer = () => ({ status: 200, body: { state: 'allowed', triesLeft: 2 } });
    type('123456');
    await until(() => !input(), 'allowed');
    expect(paths('/confirm')).toHaveLength(2);
});

// Review of #44: the scan instruction belongs to the QR code's view only.

const SCAN = 'scan this code';

it('says it is finishing once the code matched, without the scan instruction', async () => {
    await open();
    await until(() => !!code());
    status = appClaim();
    await until(() => !!input(), 'claim');
    // The poll keeps answering "allowed" from here.
    type('123456');
    await until(() => dialog()!.textContent!.includes('Finishing on'), 'allowed');
    expect(title()).toBe('Sign in on a new device?');
    expect(description()).toBe('Finishing sign-in on the new device…');
    expect(dialog()!.textContent).not.toContain(SCAN);
});

it('says the device is signed in, without the scan instruction', async () => {
    await open();
    await until(() => !!code());
    status = { ...appClaim(), state: 'signed_in' };
    await until(() => !!dialog()!.querySelector('[data-slot="add-device-done"]'), 'signed in');
    expect(title()).toBe('Sign in on a new device?');
    expect(description()).toBe('The new device is signed in.');
    expect(dialog()!.textContent).not.toContain(SCAN);
});

it('says the request ended, without the scan instruction, until a new code', async () => {
    await open();
    await until(() => !!code());
    status = appClaim();
    await until(() => !!input(), 'claim');
    await act(async () => button('Not my device')!.click());
    await until(() => !!dialog()!.querySelector('[data-slot="add-device-ended"]'), 'ended');
    expect(title()).toBe('Add a device');
    expect(description()).toBe('This request ended. Make a new code to add a device.');
    expect(dialog()!.textContent).not.toContain(SCAN);
    status = unclaimed;
    await act(async () => button('New code')!.click());
    await until(() => !!code(), 'new code');
    expect(description()).toContain(SCAN);
});

it('says an expired code ended, without the scan instruction', async () => {
    await open();
    await until(() => !!code());
    status = { ...unclaimed, state: 'expired' };
    await until(() => dialog()!.textContent!.includes('This QR code expired.'));
    expect(description()).toBe('This request ended. Make a new code to add a device.');
    expect(dialog()!.textContent).not.toContain(SCAN);
});
