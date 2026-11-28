// @vitest-environment jsdom
// Settings → Account → Google and Apple: the person's links, Link for each
// provider the website offers that isn't linked yet, and Unlink.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { SocialLinks } from '../src/modules/settings/AccountSettings';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let host: HTMLDivElement;
let root: Root;
let requests: { path: string; method: string; body?: unknown }[];
let links: { provider: string; linkedAt: string; email?: string }[];
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    requests = [];
    links = [{ provider: 'apple', linkedAt: '2026-11-01T10:00:00.000Z', email: 'ada@example.com' }];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const path = new URL(input, 'http://app.test').pathname;
        requests.push({
            path,
            method: init?.method ?? 'GET',
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        const body =
            path === '/api/auth/social/links'
                ? links
                : path === '/api/auth/web/social/start'
                  ? { url: 'https://auth.socio.test/s?t=ticket' }
                  : { ok: true };
        return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
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
    throw new Error(`Timed out: ${host.textContent}`);
}
const button = (label: string) =>
    [...host.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label);

const show = (offered: ('google' | 'apple')[]) =>
    root.render(
        <MemoryRouter initialEntries={['/settings/account']}>
            <SocialLinks offered={offered} />
        </MemoryRouter>,
    );

it('lists the links and offers Link only for a website provider not linked yet', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { pathname: '/settings/account', search: '', hash: '', assign });
    act(() => show(['google', 'apple']));
    await until(() => !!host.textContent?.includes('Link Google'));
    expect(host.textContent).toContain('Apple (ada@example.com): linked');
    expect(button('Link Apple')).toBeUndefined();
    expect(button('Unlink')).toBeTruthy();
    await act(async () => button('Link Google')!.click());
    await until(() => assign.mock.calls.length > 0);
    expect(requests.at(-1)).toEqual({
        path: '/api/auth/web/social/start',
        method: 'POST',
        body: { provider: 'google', purpose: 'link', next: '/settings/account#sign-in-methods' },
    });
    expect(assign).toHaveBeenCalledWith('https://auth.socio.test/s?t=ticket');
});

it('unlinks from the website', async () => {
    act(() => show([]));
    await until(() => !!button('Unlink'));
    links = [];
    await act(async () => button('Unlink')!.click());
    await until(() => requests.some((request) => request.method === 'DELETE'));
    expect(requests.find((request) => request.method === 'DELETE')?.path).toBe('/api/auth/social/link/apple');
});

it('shows nothing with no links and nothing offered', async () => {
    links = [];
    act(() => show([]));
    await until(() => requests.length > 0);
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(host.textContent).toBe('');
});
