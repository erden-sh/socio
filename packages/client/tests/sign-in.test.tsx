// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { AuthSession } from '@socio/shared/auth';

import { PASSKEY_CHECK_KEY } from '../src/shell/auth-client';
import { SignIn } from '../src/shell/SignIn';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let host: HTMLDivElement;
let root: Root;
let requests: { path: string; method: string; body?: unknown }[];
let session: AuthSession;
const betterAuth: AuthSession = {
    provider: 'betterauth',
    user: null,
    methods: {
        passkey: true,
        password: true,
        signUp: false,
        emailReset: false,
        signInLink: false,
        providers: [{ id: 'logto', name: 'Logto' }],
    },
};
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    requests = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const path = new URL(input, 'http://app.test').pathname;
        requests.push({
            path,
            method: init?.method ?? 'GET',
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        const body =
            path === '/api/auth/session'
                ? session
                : path === '/api/auth/mock/users'
                  ? [
                        { id: 'alice', name: 'Alice', role: 'admin' },
                        { id: 'bob', name: 'Bob', role: 'admin' },
                    ]
                  : path === '/api/auth/sign-in/social'
                    ? { url: 'https://auth.example.com/oidc/auth?state=s' }
                    : path === '/api/auth/web/social/start'
                      ? { url: 'https://auth.socio.test/s?t=ticket' }
                      : { ok: true };
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
    window.history.replaceState(null, '', '/');
});

/** SignIn under a router, at the address the test set (window.location). */
const show = (onSignedIn = () => {}) =>
    root.render(
        <MemoryRouter initialEntries={[window.location.pathname + window.location.search]}>
            <SignIn onSignedIn={onSignedIn} />
        </MemoryRouter>,
    );

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
    [...host.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label)!;
const fill = (label: string, value: string) => {
    const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
};

it('keeps the mock user picker in mock mode', async () => {
    session = { provider: 'mock', user: null };
    act(() => show());
    await until(() => !!host.textContent?.includes('Continue as Alice'));
    expect(host.textContent).toContain('Development sign-in');
    expect(button('Continue as AliceAdmin')).toBeTruthy();
    expect(button('Continue as BobAdmin')).toBeTruthy();
    expect(requests.map((r) => r.path)).toEqual(['/api/auth/session', '/api/auth/mock/users']);
});

it('shows the configured methods with Better Auth and signs in by password', async () => {
    session = betterAuth;
    const signedIn = vi.fn();
    act(() => show(signedIn));
    await until(() => !!host.textContent?.includes('Sign in with Logto'));
    expect(button('Sign in with a passkey')).toBeTruthy();
    expect(host.textContent).not.toContain('Development sign-in');
    expect(host.textContent).not.toContain('Forgot password?');
    expect(host.textContent).not.toContain('Create an account');
    expect(host.textContent).toContain('Accounts are by invitation');
    // No channel delivers sign-in links: no button for one.
    expect(host.textContent).not.toContain('sign-in link');
    act(() => fill('Email', 'ada@example.com'));
    act(() => fill('Password', 'correct-horse-battery'));
    await act(async () => button('Sign in').click());
    await until(() => signedIn.mock.calls.length > 0);
    expect(requests.at(-1)).toEqual({
        path: '/api/auth/sign-in/email',
        method: 'POST',
        body: { email: 'ada@example.com', password: 'correct-horse-battery' },
    });
    // The sidebar may now check once whether to suggest a passkey (CB-68).
    expect(sessionStorage.getItem(PASSKEY_CHECK_KEY)).toBe('pending');
    sessionStorage.clear();
});

it('sends the browser to the provider, and explains a refused sign-in', async () => {
    session = betterAuth;
    window.history.replaceState(null, '', '/?error=not_invited');
    const assign = vi.fn();
    vi.stubGlobal('location', {
        pathname: window.location.pathname,
        search: window.location.search,
        assign,
    });
    act(() => show());
    await until(() => !!host.textContent?.includes('Sign in with Logto'));
    expect(host.textContent).toContain('not invited to this workspace');
    await act(async () => button('Sign in with Logto').click());
    await until(() => assign.mock.calls.length > 0);
    expect(requests.at(-1)).toEqual({
        path: '/api/auth/sign-in/social',
        method: 'POST',
        body: { provider: 'logto', callbackURL: '/', errorCallbackURL: '/' },
    });
    expect(assign).toHaveBeenCalledWith('https://auth.example.com/oidc/auth?state=s');
});

it('offers Google and Apple from the website list, and starts there', async () => {
    session = { ...betterAuth, methods: { ...betterAuth.methods!, social: ['google', 'apple'] } };
    window.history.replaceState(null, '', '/connect/agent?x=1');
    const assign = vi.fn();
    vi.stubGlobal('location', {
        pathname: window.location.pathname,
        search: window.location.search,
        hash: '',
        assign,
    });
    act(() => show());
    await until(() => !!host.textContent?.includes('Continue with Google'));
    expect(button('Continue with Apple')).toBeTruthy();
    await act(async () => button('Continue with Google').click());
    await until(() => assign.mock.calls.length > 0);
    expect(requests.at(-1)).toEqual({
        path: '/api/auth/web/social/start',
        method: 'POST',
        body: { provider: 'google', purpose: 'signin', next: '/connect/agent?x=1' },
    });
    expect(assign).toHaveBeenCalledWith('https://auth.socio.test/s?t=ticket');
});

it('offers no website Google or Apple without the list, or in the app’s sign-in sheet', async () => {
    session = { ...betterAuth, methods: { ...betterAuth.methods!, social: ['apple'] } };
    window.history.replaceState(null, '', '/device/continue?request=r1&app=1');
    act(() => show());
    await until(() => !!host.textContent?.includes('Sign in with Logto'));
    expect(host.textContent).not.toContain('Continue with');
    act(() => root.unmount());
    root = createRoot(host);
    session = betterAuth;
    window.history.replaceState(null, '', '/');
    act(() => show());
    await until(() => !!host.textContent?.includes('Sign in with Logto'));
    expect(host.textContent).not.toContain('Continue with');
});

it.each([
    ['social_not_linked', 'No account here is linked to that account'],
    ['social_canceled', 'Sign-in canceled.'],
    ['social_nonce_invalid', 'started in another browser'],
    ['social_<b>made-up</b>', 'Sign-in failed. Try again, or sign in another way.'],
])('explains ?error=%s in words, never echoing it', async (code, words) => {
    session = { ...betterAuth, methods: { ...betterAuth.methods!, social: ['google'] } };
    window.history.replaceState(null, '', `/?error=${encodeURIComponent(code)}&error_description=echo-me`);
    act(() => show());
    await until(() => !!host.textContent?.includes('Continue with Google'));
    expect(host.textContent).toContain(words);
    expect(host.textContent).not.toContain('made-up');
    expect(host.textContent).not.toContain('echo-me');
});

it('offers reset and sign-up only when they are on', async () => {
    session = {
        ...betterAuth,
        methods: {
            ...betterAuth.methods!,
            passkey: false,
            signUp: true,
            emailReset: true,
            providers: [],
        },
    };
    act(() => show());
    await until(() => !!host.textContent?.includes('Forgot password?'));
    expect(host.textContent).not.toContain('passkey');
    act(() => button('Forgot password?').click());
    act(() => fill('Email', 'ada@example.com'));
    await act(async () => button('Send reset link').click());
    await until(() => !!host.textContent?.includes('on its way'));
    expect(requests.at(-1)).toMatchObject({
        path: '/api/auth/request-password-reset',
        body: { email: 'ada@example.com', redirectTo: '/reset-password' },
    });
});

it('sets a password from an invite link, then asks to sign in', async () => {
    session = betterAuth;
    window.history.replaceState(null, '', '/reset-password?token=link-token');
    act(() => show());
    await until(() => !!host.textContent?.includes('Choose a password'));
    act(() => fill('New password', 'a-long-password'));
    act(() => fill('Repeat the password', 'a-long-password'));
    await act(async () => button('Set password').click());
    await until(() => !!host.textContent?.includes('Password set'));
    expect(requests.find((r) => r.path === '/api/auth/reset-password')).toEqual({
        path: '/api/auth/reset-password',
        method: 'POST',
        body: { token: 'link-token', newPassword: 'a-long-password' },
    });
    expect(window.location.pathname).toBe('/');
    expect(button('Sign in')).toBeTruthy();
});

it('asks for a sign-in link, with the same answer for any address', async () => {
    session = {
        ...betterAuth,
        methods: { ...betterAuth.methods!, signInLink: true },
    };
    act(() => show());
    await until(() => !!host.textContent?.includes('Send me a sign-in link'));
    act(() => button('Send me a sign-in link').click());
    // The link form asks for the email only.
    expect(host.querySelector('input[aria-label="Password"]')).toBeNull();
    act(() => fill('Email', 'nobody@example.com'));
    await act(async () => button('Send me a sign-in link').click());
    await until(() => !!host.textContent?.includes('on its way'));
    expect(host.textContent).toContain('If that account can receive links, one is on its way.');
    expect(requests.at(-1)).toEqual({
        path: '/api/auth/sign-in-link',
        method: 'POST',
        body: { email: 'nobody@example.com' },
    });
});

it('offers sign-in links with passwords off too', async () => {
    session = {
        ...betterAuth,
        methods: {
            ...betterAuth.methods!,
            password: false,
            signInLink: true,
            providers: [],
        },
    };
    act(() => show());
    await until(() => !!host.textContent?.includes('Send me a sign-in link'));
    expect(host.querySelector('form')).toBeNull();
    act(() => button('Send me a sign-in link').click());
    expect(host.querySelector('input[aria-label="Email"]')).toBeTruthy();
});

it('signs in from a one-time link only after a click', async () => {
    session = betterAuth;
    window.history.replaceState(null, '', '/sign-in-link?token=abc-123');
    const assign = vi.fn();
    vi.stubGlobal('location', {
        pathname: window.location.pathname,
        search: window.location.search,
        assign,
    });
    act(() => show());
    await until(() => !!host.textContent?.includes('Sign in to Socio'));
    // Opening the page (a link preview, a scanner) uses nothing up.
    expect(assign).not.toHaveBeenCalled();
    expect(requests.map((r) => r.path)).not.toContain('/api/auth/magic-link/verify');
    act(() => button('Continue').click());
    expect(assign).toHaveBeenCalledWith(
        '/api/auth/magic-link/verify?token=abc-123&callbackURL=%2F&errorCallbackURL=%2F',
    );
});

it('explains a used-up or expired sign-in link', async () => {
    session = betterAuth;
    window.history.replaceState(null, '', '/?error=INVALID_TOKEN');
    act(() => show());
    await until(() => !!host.textContent?.includes('Sign in with Logto'));
    expect(host.textContent).toContain('used up or expired');
});

it('shows the client name and logo on sign-in', async () => {
    session = {
        ...betterAuth,
        branding: { name: 'Acme Company Brain', logo: '/acme.png' },
    };
    await act(async () => show());
    await until(() => !!host.textContent?.includes('Sign in to Acme Company Brain.'));
    expect(host.querySelector('img[src="/acme.png"]')).not.toBeNull();
});
