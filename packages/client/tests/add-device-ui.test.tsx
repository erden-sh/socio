// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { PairStatus } from '@socio/shared/device-sign-in';

import { AddDeviceDialog, countdown } from '../src/shell/AddDeviceDialog';
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

it('asks before signing a claiming device in, and says when it is', async () => {
    await open();
    await until(() => !!code());
    status = claimed;
    await until(() => !!input(), 'confirm');
    expect(code()).toBeNull();
    expect(dialog()!.textContent).toContain('Sign in on a new device?');
    expect(dialog()!.textContent).toContain('Ada’s iPhone wants to sign in as you');
    expect(input()!.getAttribute('autocomplete')).toBe('off');
    expect(input()!.getAttribute('inputmode')).toBe('numeric');
    type('123456');
    await act(async () => button('Sign in')!.click());
    expect(paths('/confirm').map((entry) => entry.body)).toEqual([{ digits: '123456' }]);
    status = { ...claimed, state: 'signed_in' };
    await until(() => dialog()!.textContent!.includes('Signed in on Ada’s iPhone'));
});

it('counts wrong tries, then ends the claim', async () => {
    await open();
    await until(() => !!code());
    status = claimed;
    await until(() => !!input());
    type('000000');
    await act(async () => button('Sign in')!.click());
    await until(() => dialog()!.textContent!.includes('2 tries left'));
    digitsAnswer = () => ({ status: 400, body: { state: 'denied', triesLeft: 0 } });
    type('111111');
    await act(async () => button('Sign in')!.click());
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
    await act(async () => button('Sign in')!.click());
    await until(() => dialog()!.textContent!.includes('Could not reach the server.'));
    expect(dialog()!.textContent).not.toContain('didn’t match');
    status = { ...claimed, state: 'signed_in' };
    await until(() => dialog()!.textContent!.includes('Signed in on Ada’s iPhone'));
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
    await act(async () => button('Sign in')!.click());
    await until(() => dialog()!.textContent!.includes('Could not reach the server.'));
    confirmFails = false;
    // Typed again before the poll saw it: the server says the claim isn't waiting.
    type('123456');
    await act(async () => button('Sign in')!.click());
    expect(paths('/confirm')).toHaveLength(2);
    await until(() => !dialog()!.textContent!.includes('didn’t match') && !input(), 'allowed');
    status = { ...claimed, state: 'signed_in' };
    await until(() => dialog()!.textContent!.includes('Signed in on Ada’s iPhone'));
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
    expect(dialog()!.textContent).toContain('Signed in on Ada’s iPhone');
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
