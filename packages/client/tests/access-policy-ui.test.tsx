// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';

import type { AccessPolicyImpact, AccessPolicyView } from '@socio/shared/access-policy';

import { AccessPolicySection } from '../src/modules/settings/AccessPolicySection';
import { SETTINGS_GROUPS, allowed, listed } from '../src/modules/settings/sections';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    vi.unstubAllGlobals();
});

async function until(check: () => boolean, what: string) {
    for (const deadline = Date.now() + 5_000; Date.now() < deadline;) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${document.body.textContent}`);
}
const type = (element: HTMLInputElement, value: string) =>
    act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
    });
const button = (label: string) =>
    [...document.querySelectorAll('button')].find((entry) => entry.textContent === label)!;
const checkbox = (label: string) =>
    [...document.querySelectorAll('label')]
        .find((entry) => entry.textContent?.startsWith(label))!
        .querySelector('input')!;

const VIEW: AccessPolicyView = {
    version: 3,
    updatedAt: Date.UTC(2026, 9, 27, 12),
    updatedBy: 'alice',
    unreadable: false,
    saved: {},
    signIn: {
        ceiling: {
            password: true,
            passkey: true,
            signInLink: false,
            emailLinks: false,
            openSignUp: false,
            google: true,
            apple: true,
            providers: [{ id: 'logto', name: 'Logto' }],
            allowedEmails: [],
            allowedDomains: ['example.com'],
            adminEmails: [],
        },
        inForce: {
            password: true,
            passkey: true,
            signInLink: false,
            emailLinks: false,
            openSignUp: false,
            google: true,
            apple: true,
            providers: ['logto'],
            allowedEmails: [],
            allowedDomains: ['example.com'],
            adminEmails: [],
        },
    },
    audit: [],
};

it('lists Access for admins (CB-390), not members', () => {
    const item = SETTINGS_GROUPS.flatMap((group) => group.entries).find((entry) => entry.id === 'access')!;
    const access = { signIn: true, telegram: false };
    expect(allowed(item, { ...access, admin: false, operator: false })).toBe(false);
    expect(listed(item, { ...access, admin: true, operator: true })).toBe(true);
    expect(allowed(item, { ...access, admin: true, operator: false })).toBe(true);
});

it('narrows only what the environment allows, previews it, and confirms with the password', async () => {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const impact: AccessPolicyImpact = {
        changes: ['Passkeys: off'],
        refusal: null,
        sessionsEnded: 1,
        withoutWayIn: [],
        signsYouOut: false,
        codeRunsStopped: 0,
    };
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const path = new URL(input, 'http://app.test').pathname;
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, path, body });
        let reply: unknown = VIEW;
        if (path === '/api/access-policy/preview') {
            reply = impact;
        }
        if (path === '/api/access-policy/step-up') {
            reply = {
                id: 'challenge-1',
                methods: ['password'],
                expiresAt: new Date(Date.now() + 300_000).toISOString(),
            };
        }
        if (method === 'PUT') {
            reply = { view: VIEW, impact };
        }
        return new Response(JSON.stringify(reply), {
            headers: { 'Content-Type': 'application/json' },
        });
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() =>
        root!.render(
            <MemoryRouter>
                <AccessPolicySection />
            </MemoryRouter>,
        ),
    );
    await until(() => !!host!.querySelector('[data-slot=access-policy]'), 'the page');
    // Code access moved to People → Groups: the link holds its words.
    const groups = host!.querySelector<HTMLAnchorElement>('[data-slot="code-access-moved"] a')!;
    expect(groups.textContent).toBe('People → Groups');
    expect(groups.getAttribute('href')).toBe('/settings/people?tab=groups');
    // What the environment leaves off can't be turned on here.
    expect(checkbox('Sign-in links by Telegram').disabled).toBe(true);
    expect(checkbox('Open sign-up').disabled).toBe(true);
    // Email links need SMTP (CB-352).
    expect(checkbox('Sign-in links by email').disabled).toBe(true);
    expect(button('Review and confirm').disabled).toBe(true);
    act(() => checkbox('Passkeys').click());
    await until(() => !!host!.querySelector('[data-slot=access-impact]'), 'the preview');
    expect(host!.textContent).toContain('1 session will end.');
    expect(calls.find((call) => call.path === '/api/access-policy/preview')?.body).toEqual({
        policy: { passkey: false },
        version: 3,
    });
    act(() => button('Review and confirm').click());
    await until(() => !!document.querySelector('input[type=password]'), 'the step-up');
    type(document.querySelector('input[type=password]')!, 'correct-horse-battery');
    act(() => button('Confirm with password').click());
    await until(() => calls.some((call) => call.method === 'PUT'), 'the save');
    expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({
        policy: { passkey: false },
        version: 3,
        stepUp: { id: 'challenge-1', password: 'correct-horse-battery' },
    });
});

it('turns sign-in links by email on only by choice, where email is set up (CB-352)', async () => {
    const calls: { path: string; body?: unknown }[] = [];
    const view: AccessPolicyView = {
        ...VIEW,
        signIn: { ceiling: { ...VIEW.signIn!.ceiling, emailLinks: true }, inForce: VIEW.signIn!.inForce },
    };
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const path = new URL(input, 'http://app.test').pathname;
        calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const reply =
            path === '/api/access-policy/preview'
                ? {
                      changes: ['Sign-in links by email: on'],
                      refusal: null,
                      sessionsEnded: 0,
                      withoutWayIn: [],
                      signsYouOut: false,
                      codeRunsStopped: 0,
                  }
                : view;
        return new Response(JSON.stringify(reply), { headers: { 'Content-Type': 'application/json' } });
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() =>
        root!.render(
            <MemoryRouter>
                <AccessPolicySection />
            </MemoryRouter>,
        ),
    );
    await until(() => !!host!.querySelector('[data-slot=access-policy]'), 'the page');
    const toggle = checkbox('Sign-in links by email');
    // Off by default, even with email set up.
    expect(toggle.disabled).toBe(false);
    expect(toggle.checked).toBe(false);
    expect(host!.textContent).toContain('Codes and links go by email to every account. Off by default.');
    act(() => toggle.click());
    await until(() => calls.some((call) => call.path === '/api/access-policy/preview'), 'the preview');
    expect(calls.find((call) => call.path === '/api/access-policy/preview')?.body).toEqual({
        policy: { emailLinks: true },
        version: 3,
    });
});
