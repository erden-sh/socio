// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { SignInMethods } from '@socio/shared/auth';
import { canDeleteAttachment, canTriage } from '@socio/shared/issues/issue-board';
import { isAdmin, isOperator, normalizeRole, roleLabel, ROLES } from '@socio/shared/roles';
import type { User } from '@socio/shared/types';

import { AccountSections } from '../src/modules/settings/AccountSettings';
import { CurrentUser } from '../src/shell/current-user';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

// A row an older release or backup still carries; it reads as an admin (CB-390).
const legacy = { id: 'alice', name: 'Olga', role: 'operator' } as unknown as User;
const admin: User = { id: 'u-ada', name: 'Ada', role: 'admin' };
const member: User = { id: 'bob', name: 'Bob', role: 'member' };

it('has one admin tier: the retired operator role reads as an admin, and isOperator is the admin check', () => {
    expect(ROLES).toEqual(['admin', 'member']);
    expect([legacy, admin, member].map(isAdmin)).toEqual([true, true, false]);
    expect([legacy, admin, member].map(isOperator)).toEqual([true, true, false]);
    expect(isAdmin(undefined)).toBe(false);
    expect(['operator', 'admin', 'member'].map((r) => roleLabel(r as never))).toEqual(['Admin', 'Admin', 'Member']);
    expect(['operator', 'admin', 'member', 'owner', undefined].map(normalizeRole)).toEqual([
        'admin',
        'admin',
        'member',
        'member',
        'member',
    ]);
    // Client gates (the server enforces the same).
    expect(canTriage(admin)).toBe(true);
    expect(canTriage(member)).toBe(false);
    expect(canDeleteAttachment({ uploaderId: 'someone' }, admin)).toBe(true);
});

const methods: SignInMethods = {
    passkey: false,
    password: false,
    signUp: false,
    emailReset: false,
    signInLink: true,
    providers: [],
};

let host: HTMLDivElement;
let root: Root;
let requests: { path: string; method: string; body?: unknown }[];
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    requests = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const path = new URL(input, 'http://app.test').pathname;
        requests.push({
            path,
            method: init?.method ?? 'GET',
            ...(path === '/api/auth/update-user' ? { body: JSON.parse(String(init?.body)) } : {}),
        });
        const body = path === '/api/me/inference' ? { kinds: [], active: null } : { ok: true };
        return new Response(JSON.stringify(body), {
            headers: { 'Content-Type': 'application/json' },
        });
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

async function profile(user: User) {
    act(() =>
        root.render(
            <MemoryRouter>
                <CurrentUser.Provider value={user}>
                    <AccountSections methods={methods} onSignedOut={() => {}} />
                </CurrentUser.Provider>
            </MemoryRouter>,
        ),
    );
    for (let i = 0; i < 100 && !document.querySelector('input[aria-label="Your name"]'); i++) {
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
}

it('lets people change their own display name', async () => {
    await profile(member);
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Your name"]')!;
    const save = [...input.form!.querySelectorAll('button')].find((b) => b.textContent === 'Save')!;
    expect(input.value).toBe('Bob');
    // Nothing to save until the name changes.
    expect(save.disabled).toBe(true);
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
        setValue.call(input, '  Robert ');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    expect(requests).toContainEqual({
        path: '/api/auth/update-user',
        method: 'POST',
        body: { name: 'Robert' },
    });
});
