// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { DeviceSummary } from '@socio/shared/device-sign-in';

import { DevicesCard, deviceDetails } from '../src/modules/settings/DevicesCard';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

// CB-352: the Socio app's devices, the person's own and an admin's view.

const NOW = Date.parse('2026-11-16T12:00:00Z');
const phone = (patch: Partial<DeviceSummary> = {}): DeviceSummary => ({
    id: 'dev-1',
    label: 'Ada’s iPhone',
    platform: 'ios',
    variant: 'production',
    state: 'active',
    signInMethod: 'passkey',
    createdAt: '2026-11-01T10:00:00Z',
    lastSeenAt: '2026-11-16T11:00:00Z',
    current: false,
    ...patch,
});
let host: HTMLDivElement;
let root: Root;
let requests: { path: string; method: string }[];
let listed: DeviceSummary[];

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    requests = [];
    listed = [
        phone(),
        phone({ id: 'dev-2', label: 'Old Pixel', platform: 'android', state: 'revoked', signInMethod: null }),
    ];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://app.test');
        const method = init?.method ?? 'GET';
        requests.push({ path: `${url.pathname}${url.search}`, method });
        if (method === 'DELETE') {
            listed = listed.map((device) =>
                url.pathname.endsWith(`/${device.id}`)
                    ? { ...device, state: url.search ? 'revoked_and_erase' : 'revoked', signInMethod: null }
                    : device,
            );
            return Response.json({ ok: true });
        }
        return Response.json({ devices: listed });
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
});

async function until(check: () => boolean) {
    for (let i = 0; i < 100; i++) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out: ${document.body.textContent}`);
}
/** A button of the confirm dialog. */
const confirmButton = (label: string) =>
    [...document.body.querySelectorAll('[data-slot="device-sign-out"] button')].find(
        (entry) => entry.textContent?.trim() === label,
    ) as HTMLButtonElement | undefined;
const labelled = (label: string) => document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const deletes = () => requests.filter((entry) => entry.method === 'DELETE').map((entry) => entry.path);

it('words a device’s row', () => {
    expect(deviceDetails(phone(), NOW)).toBe('iPhone or iPad · by Passkey · last seen 1 h ago · since Nov 1');
    expect(deviceDetails(phone({ state: 'revoked_and_erase', signInMethod: null, lastSeenAt: null }), NOW)).toBe(
        'iPhone or iPad · Signed out; erase requested · since Nov 1',
    );
});

it('lists the person’s own devices and signs one out after a confirm that says what it does', async () => {
    await act(() => root.render(<DevicesCard />));
    await until(() => host.textContent!.includes('Old Pixel'));
    expect(requests[0]).toEqual({ path: '/api/auth/devices', method: 'GET' });
    // A signed-out device offers nothing to do.
    expect(labelled('Sign out Old Pixel')).toBeNull();
    await act(async () => labelled('Sign out Ada’s iPhone')!.click());
    expect(document.body.textContent).toContain('Sign out Ada’s iPhone?');
    expect(document.body.textContent).toContain('what it keeps from this workspace stays on it');
    expect(deletes()).toEqual([]);
    await act(async () => confirmButton('Sign out')!.click());
    await until(() => deletes().length > 0);
    expect(deletes()).toEqual(['/api/auth/devices/dev-1']);
    await until(() => !labelled('Sign out Ada’s iPhone'));
});

it('signs out and erases, saying that unsent work goes too', async () => {
    await act(() => root.render(<DevicesCard />));
    await until(() => !!labelled('Sign out and erase Ada’s iPhone'));
    await act(async () => labelled('Sign out and erase Ada’s iPhone')!.click());
    expect(document.body.textContent).toContain('including anything not sent yet');
    await act(async () => confirmButton('Cancel')!.click());
    expect(deletes()).toEqual([]);
    await act(async () => labelled('Sign out and erase Ada’s iPhone')!.click());
    await act(async () => confirmButton('Sign out and erase')!.click());
    await until(() => deletes().length > 0);
    expect(deletes()).toEqual(['/api/auth/devices/dev-1?erase=1']);
});

it('shows an admin a person’s devices through the admin routes, and nothing to do when locked', async () => {
    await act(() => root.render(<DevicesCard accountId="acc 1" />));
    await until(() => !!labelled('Sign out and erase Ada’s iPhone'));
    expect(requests[0]).toEqual({ path: '/api/accounts/acc%201/devices', method: 'GET' });
    await act(async () => labelled('Sign out and erase Ada’s iPhone')!.click());
    await act(async () => confirmButton('Sign out and erase')!.click());
    await until(() => deletes().length > 0);
    expect(deletes()).toEqual(['/api/accounts/acc%201/devices/dev-1?erase=1']);
    act(() => root.unmount());
    root = createRoot(host);
    listed = [phone()];
    await act(() => root.render(<DevicesCard accountId="acc 1" locked />));
    await until(() => host.textContent!.includes('Ada’s iPhone'));
    expect(labelled('Sign out Ada’s iPhone')).toBeNull();
});

it('says when there are none', async () => {
    listed = [];
    await act(() => root.render(<DevicesCard />));
    await until(() => host.textContent!.includes('You haven’t signed in on the app.'));
});

it('tells the person page when a device signs out, and reloads when the page did', async () => {
    let changed = 0;
    const gets = () => requests.filter((entry) => entry.method === 'GET').length;
    await act(() =>
        root.render(<DevicesCard accountId="acc 1" onChanged={() => (changed += 1)} version={{ detail: 1 }} />),
    );
    await until(() => host.textContent!.includes('Old Pixel'));
    await act(async () => labelled('Sign out Ada’s iPhone')!.click());
    await act(async () => confirmButton('Sign out')!.click());
    await until(() => changed === 1);
    const before = gets();
    // The page reloaded after its own action (sign out everywhere): a new detail.
    await act(() =>
        root.render(<DevicesCard accountId="acc 1" onChanged={() => (changed += 1)} version={{ detail: 2 }} />),
    );
    await until(() => gets() === before + 1);
});
