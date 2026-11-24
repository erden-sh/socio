// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { AuthSession } from '@socio/shared/auth';

import { CurrentUser } from '../src/shell/current-user';
import { SignIn } from '../src/shell/SignIn';
import { DeviceContinue, deviceContinueTitle } from '../src/views/DeviceContinue';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

// CB-352: the Socio app's sign-in sheet lands on the Continue page.

const REDIRECT = 'https://link.socio.sh/app/cb/brain.example.com#code=ABCDEFGHJKMNPQRS&state=s';
let host: HTMLDivElement;
let root: Root;
let requests: { path: string; method: string; body?: unknown }[];
let approveAnswer: () => Response;
let replaced: string[];
let sessionAnswer: () => Response;
const session: AuthSession = {
    provider: 'betterauth',
    user: null,
    methods: {
        passkey: true,
        password: true,
        signUp: true,
        emailReset: false,
        signInLink: false,
        providers: [{ id: 'logto', name: 'Logto' }],
    },
};

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    requests = [];
    replaced = [];
    approveAnswer = () => Response.json({ redirect: REDIRECT });
    sessionAnswer = () =>
        Response.json({ user: { name: 'Ada Lovelace', email: 'ada@example.com' }, session: { id: 'sess-ada' } });
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const path = new URL(input, 'http://app.test').pathname;
        requests.push({
            path,
            method: init?.method ?? 'GET',
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        if (path === '/api/auth/device/approve') {
            return approveAnswer();
        }
        if (path === '/api/auth/get-session') {
            return sessionAnswer();
        }
        if (path === '/api/auth/sign-in/social') {
            return Response.json({ url: 'https://auth.example.com/oidc/auth?state=s' });
        }
        return Response.json(path === '/api/auth/session' ? session : { ok: true });
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const show = (address: string, page = <DeviceContinue />) =>
    act(() =>
        root.render(
            <MemoryRouter key={address} initialEntries={[address]}>
                {page}
            </MemoryRouter>,
        ),
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
    [...host.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label);
/** Where Continue sends the browser, instead of going. */
const watchReplace = () =>
    vi.stubGlobal('location', { ...window.location, replace: (url: string | URL) => void replaced.push(String(url)) });
const approvals = () => requests.filter((entry) => entry.path === '/api/auth/device/approve');

it('names the app and the account, and approves nothing until Continue is clicked', async () => {
    watchReplace();
    await show('/device/continue?request=req-0123456789abcdef&app=1&platform=ios');
    await until(() => host.textContent!.includes('ada@example.com'));
    expect(host.textContent).toContain('Sign in to the Socio app on iPhone?');
    expect(host.textContent).toContain('As Ada Lovelace (ada@example.com)');
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(approvals()).toEqual([]);
    expect(replaced).toEqual([]);
    await act(async () => button('Continue')!.click());
    await until(() => replaced.length > 0);
    expect(approvals()).toEqual([
        {
            path: '/api/auth/device/approve',
            method: 'POST',
            body: { request: 'req-0123456789abcdef', session: 'sess-ada' },
        },
    ]);
    expect(replaced).toEqual([REDIRECT]);
});

it('approves nothing on Cancel', async () => {
    await show('/device/continue?request=req-0123456789abcdef&app=1&platform=android');
    expect(host.textContent).toContain('Sign in to the Socio app on Android?');
    await act(async () => button('Cancel')!.click());
    expect(host.textContent).toContain('The Socio app was not signed in');
    expect(host.textContent).toContain('Close this window to go back to the app.');
    expect(button('Continue')).toBeUndefined();
    expect(approvals()).toEqual([]);
});

it('says why when the server refuses, and stays put', async () => {
    watchReplace();
    approveAnswer = () =>
        Response.json(
            { error: 'This sign-in request has expired. Start again in the app.', code: 'code_expired' },
            { status: 400 },
        );
    await show('/device/continue?request=req-0123456789abcdef&app=1');
    await act(async () => button('Continue')!.click());
    await until(() => host.textContent!.includes('has expired'));
    expect(replaced).toEqual([]);
});

it('offers nothing to approve without a request', async () => {
    await show('/device/continue?app=1');
    expect(host.textContent).toContain('Nothing to sign in here.');
    expect(button('Continue')).toBeUndefined();
});

it('words the title without a platform it doesn’t know', () => {
    expect(deviceContinueTitle(null)).toBe('Sign in to the Socio app?');
    expect(deviceContinueTitle('windows')).toBe('Sign in to the Socio app?');
});

it('hides sign-up when the app’s sheet asks for sign-in, and only there', async () => {
    await show('/device/continue?request=req-0123456789abcdef&app=1', <SignIn onSignedIn={() => {}} />);
    await until(() => !!button('Sign in'));
    expect(button('Create an account')).toBeUndefined();
    await show('/', <SignIn onSignedIn={() => {}} />);
    await until(() => !!button('Create an account'));
});

it('comes back to the Continue page from a provider’s sign-in', async () => {
    const address = '/device/continue?request=req-0123456789abcdef&app=1&platform=ios';
    window.history.replaceState(null, '', address);
    vi.stubGlobal('location', { ...window.location, assign: () => undefined, href: window.location.href });
    try {
        await show(address, <SignIn onSignedIn={() => {}} />);
        await until(() => !!button('Sign in with Logto'));
        await act(async () => button('Sign in with Logto')!.click());
        await until(() => requests.some((entry) => entry.path === '/api/auth/sign-in/social'));
        expect(requests.find((entry) => entry.path === '/api/auth/sign-in/social')!.body).toMatchObject({
            provider: 'logto',
            callbackURL: address,
            errorCallbackURL: address,
        });
    } finally {
        window.history.replaceState(null, '', '/');
    }
});

it('can’t continue before it knows the account, and says when it can’t tell', async () => {
    sessionAnswer = () => Response.json({ error: 'Server unavailable' }, { status: 503 });
    await show('/device/continue?request=req-0123456789abcdef&app=1&platform=ios');
    expect(button('Continue')!.disabled).toBe(true);
    await until(() => host.textContent!.includes('Could not check which account this is.'));
    expect(button('Continue')!.disabled).toBe(true);
    sessionAnswer = () =>
        Response.json({ user: { name: 'Ada Lovelace', email: 'ada@example.com' }, session: { id: 'sess-ada' } });
    await act(async () => button('Try again')!.click());
    await until(() => !button('Continue')!.disabled);
    expect(host.textContent).toContain('ada@example.com');
    expect(approvals()).toEqual([]);
});

it('asks for the account again when another sign-in changes the shell’s user', async () => {
    const page = (id: string) => (
        <CurrentUser.Provider value={{ id, name: id, role: 'member' }}>
            <DeviceContinue />
        </CurrentUser.Provider>
    );
    const address = '/device/continue?request=req-0123456789abcdef&app=1';
    await act(() => root.render(<MemoryRouter initialEntries={[address]}>{page('u-ada')}</MemoryRouter>));
    await until(() => host.textContent!.includes('ada@example.com'));
    sessionAnswer = () =>
        Response.json({ user: { name: 'Bea', email: 'bea@example.com' }, session: { id: 'sess-bea' } });
    await act(() => root.render(<MemoryRouter initialEntries={[address]}>{page('u-bea')}</MemoryRouter>));
    await until(() => host.textContent!.includes('bea@example.com'));
    expect(host.textContent).not.toContain('ada@example.com');
});

it('asks for the session again when the server says it changed, and waits for another click', async () => {
    watchReplace();
    approveAnswer = () =>
        Response.json(
            {
                error: 'You’re signed in as someone else now. Check the account, then Continue again.',
                code: 'not_authorized',
            },
            { status: 403 },
        );
    await show('/device/continue?request=req-0123456789abcdef&app=1');
    await until(() => !button('Continue')!.disabled);
    sessionAnswer = () =>
        Response.json({ user: { name: 'Ada Lovelace', email: 'ada@example.com' }, session: { id: 'sess-ada-2' } });
    await act(async () => button('Continue')!.click());
    await until(() => host.textContent!.includes('signed in as someone else'));
    approveAnswer = () => Response.json({ redirect: REDIRECT });
    await until(() => !button('Continue')!.disabled);
    expect(approvals()).toHaveLength(1);
    await act(async () => button('Continue')!.click());
    await until(() => replaced.length > 0);
    expect(approvals().at(-1)!.body).toEqual({ request: 'req-0123456789abcdef', session: 'sess-ada-2' });
});

it('says why a provider’s sign-in failed and keeps the app’s request', async () => {
    const address = '/device/continue?request=req-0123456789abcdef&app=1&error=access_denied';
    let at = '';
    const Where = () => {
        at = `${useLocation().pathname}${useLocation().search}`;
        return null;
    };
    await act(() =>
        root.render(
            <MemoryRouter initialEntries={[address]}>
                <SignIn onSignedIn={() => {}} />
                <Where />
            </MemoryRouter>,
        ),
    );
    await until(() => !!host.querySelector('[role="alert"]'));
    await until(() => !at.includes('error='));
    expect(at).toBe('/device/continue?request=req-0123456789abcdef&app=1');
});
