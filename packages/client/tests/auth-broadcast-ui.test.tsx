// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Role, State, WorkspaceState } from '@socio/shared/types';

import { AUTH_CHANNEL, closeAuthChannel } from '../src/shell/auth-channel';

import { createTestRouter, fetchServices } from './helpers/app-router';
import { FakeBroadcastChannel } from './helpers/fake-broadcast-channel';

// Chat isn't configured here, so CopilotKit never renders; its package
// imports a stylesheet Node can't load.
vi.mock('@copilotkit/react-core/v2', () => ({
    CopilotKitProvider: ({ children }: { children: unknown }) => children,
}));

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

/**
 * The shell (App.tsx) and its sign-in state across tabs. The rendered app
 * is one tab; `other` is another tab's channel on the same name. The
 * stubbed server's `signedIn` is the browser's shared cookie.
 */
const state: State = {
    settings: {
        name: 'Brain',
        paused: false,
        researchAllowed: false,
        memoryAllowed: true,
    },
    tasks: [],
    memories: [{ id: 'm1', text: 'Keep it short.', createdAt: 1 }],
    mode: 'live',
    configured: false,
};
const workspace = (role: Role): WorkspaceState => ({
    user: { id: role, name: role === 'admin' ? 'Alice' : 'Bob', role },
    spaces: [{ id: 's1', name: 'Everyday', description: '', createdAt: 1 }],
    dots: [
        {
            id: 'd1',
            spaceId: 's1',
            spaceIds: ['s1'],
            name: 'Dot',
            instructions: 'Dot helps.',
            researchAllowed: false,
            memoryAllowed: false,
            createdAt: 1,
        },
    ],
    conversations: [
        {
            id: 'c1',
            dotId: 'd1',
            ownerId: role,
            title: 'Quarterly plan',
            createdAt: 1,
        },
    ],
    setup: {
        model: false,
        voice: false,
        telegram: 'not_configured',
        missing: ['model'],
    },
    calls: [],
});

let role: Role = 'admin';
let signedIn = true;
let requests: string[] = [];
const respond = (path: string): [number, unknown] => {
    if (path === '/api/auth/session') {
        return [200, { provider: 'mock', user: null }];
    }
    if (path === '/api/auth/mock/users') {
        return [200, [{ id: 'member', name: 'Bob', role: 'member' }]];
    }
    if (path === '/api/auth/mock/login') {
        signedIn = true;
        role = 'member';
        return [200, { id: 'member' }];
    }
    if (path === '/api/auth/logout') {
        signedIn = false;
        return [200, { ok: true }];
    }
    if (!signedIn) {
        return [401, { error: 'Sign in to continue.' }];
    }
    if (path === '/api/state') {
        return [200, state];
    }
    if (path === '/api/workspace') {
        return [200, workspace(role)];
    }
    if (path.startsWith('/api/runs')) {
        return [200, { limit: 100, runs: [] }];
    }
    return [404, { error: 'Not found.' }];
};

let root: Root;
let host: HTMLElement;
let other: FakeBroadcastChannel;
// What the rendered tab posted (the other tab hears all of it).
let heard: unknown[];

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    // Only the shell's poll timer is fake: the test moves it on.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    window.matchMedia = (query: string) =>
        ({
            matches: false,
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
        }) as unknown as MediaQueryList;
    FakeBroadcastChannel.reset();
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    other = new FakeBroadcastChannel(AUTH_CHANNEL);
    heard = [];
    other.addEventListener('message', (event) => heard.push((event as MessageEvent).data));
    requests = [];
    signedIn = true;
    role = 'admin';
    vi.stubGlobal('fetch', async (input: string) => {
        const path = new URL(input, 'http://app.test').pathname;
        requests.push(path);
        const [status, body] = respond(path);
        return new Response(JSON.stringify(body), {
            status,
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
    closeAuthChannel();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

async function until(check: () => boolean, what: string) {
    for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${host.textContent}`);
}
const text = () => host.textContent ?? '';
// The signed-in person's account row in the sidebar.
const signedInAs = (name: string) => !!host.querySelector(`[aria-label="Account: ${name}"]`);
const signInShown = () => /Who’s thinking today\?/.test(text());
const shellShown = () => !!host.querySelector('[data-slot="app-header"]');
/** Lets the stubbed fetches and the timers' work settle. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));
/** Moves the shell's poll timer on by `ms`. */
async function wait(ms: number) {
    await act(async () => {
        vi.advanceTimersByTime(ms);
    });
    await settle();
}

function open(path: string) {
    const router = createTestRouter(path, { services: () => fetchServices() });
    act(() => root.render(<RouterProvider router={router} />));
    return router;
}

it('signed out, asks nothing until another tab signs in or the tab gains focus', async () => {
    signedIn = false;
    open('/');
    await until(signInShown, 'the sign-in screen');
    await settle();
    requests = [];
    // No poll: ten seconds, not one request.
    await wait(10_000);
    expect(requests).toEqual([]);
    // Focus: the tab asks the server (its loaders, with its own cookie).
    act(() => {
        window.dispatchEvent(new Event('focus'));
    });
    await until(() => requests.includes('/api/workspace'), 'a check on focus');
    expect(signInShown()).toBe(true);
    // Back into view: once more.
    requests = [];
    act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await until(() => requests.includes('/api/workspace'), 'a check when shown');
    // A "signed-in" the server doesn't back up changes nothing.
    requests = [];
    other.postMessage('signed-in');
    await until(() => requests.includes('/api/workspace'), 'a check on the event');
    await settle();
    expect(signInShown()).toBe(true);
    expect(requests).not.toContain('/api/state');
    // Another tab signed in: this one follows, without a reload.
    signedIn = true;
    role = 'member';
    other.postMessage('signed-in');
    await until(() => signedInAs('Bob'), 'the shell');
    // Signed in, the poll runs again.
    requests = [];
    await wait(3000);
    expect(requests).toContain('/api/state');
    // It only listened: it said nothing of its own.
    expect(heard).toEqual([]);
});

it('drops to sign-in at once and forgets the user when another tab signs out', async () => {
    const router = open('/runs');
    await until(() => /Recent turns across the team/.test(text()), 'Runs');
    expect(text()).toContain('Alice');
    expect(router.state.loaderData.runs).toBeTruthy();
    // The page loaded signed in, and said so.
    await until(() => heard.includes('signed-in'), 'the load announced');
    signedIn = false;
    other.postMessage('signed-out');
    await until(signInShown, 'sign-in');
    expect(text()).not.toContain('Alice');
    expect(text()).not.toContain('Recent turns');
    // The server agreed (the loaders ran again): no page keeps its data.
    await until(() => router.state.loaderData.shell?.session === 'signed-out', 'the loaders');
    expect(router.state.loaderData.runs ?? null).toBeNull();
    // And it doesn't poll.
    requests = [];
    await wait(10_000);
    expect(requests).not.toContain('/api/state');
    expect(heard).toEqual(['signed-in']);
});

it('comes back when the server says the session is still good', async () => {
    open('/');
    await until(shellShown, 'the shell');
    await settle();
    requests = [];
    // Someone posts "signed-out", but the cookie still works.
    other.postMessage('signed-out');
    await until(() => requests.includes('/api/workspace'), 'the check');
    await until(() => signedInAs('Alice'), 'the shell again');
    expect(heard).toEqual(['signed-in']);
});

it('a session that ends on the server: sign-in here, and the other tabs are told', async () => {
    open('/');
    await until(shellShown, 'the shell');
    heard = [];
    signedIn = false;
    await wait(3000);
    await until(signInShown, 'sign-in after the 401');
    await until(() => heard.includes('signed-out'), 'the other tabs told');
    expect(text()).not.toContain('Alice');
    requests = [];
    await wait(10_000);
    expect(requests).not.toContain('/api/state');
});

it('a poll in flight when another tab signs out does not bring the shell back', async () => {
    open('/');
    await until(shellShown, 'the shell');
    // The next /api/state waits until the test lets it answer (signed in).
    let answer: () => void = () => {};
    const held = new Promise<void>((resolve) => (answer = resolve));
    const plain = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        if (new URL(input, 'http://app.test').pathname === '/api/state') {
            const reply = respond('/api/state');
            await held;
            return new Response(JSON.stringify(reply[1]), {
                status: reply[0],
                headers: { 'Content-Type': 'application/json' },
            });
        }
        return plain(input, init);
    });
    await act(async () => {
        vi.advanceTimersByTime(3000);
    });
    signedIn = false;
    other.postMessage('signed-out');
    await until(signInShown, 'sign-in');
    answer();
    await settle();
    await settle();
    expect(signInShown()).toBe(true);
    expect(text()).not.toContain('Alice');
});

it('tells the other tabs when it signs out and in itself', async () => {
    open('/');
    await until(shellShown, 'the shell');
    await until(() => heard.includes('signed-in'), 'the load announced');
    heard = [];
    // Switch user, from the account menu.
    act(() => {
        host.querySelector('[aria-label="Account: Alice"]')!.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
    });
    const switchUser = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
        item.textContent?.includes('Switch user'),
    )!;
    await act(async () => switchUser.click());
    await until(signInShown, 'sign-in');
    await until(() => heard.includes('signed-out'), 'signed-out posted');
    const bob = await (async () => {
        await until(
            () => [...host.querySelectorAll('button')].some((item) => item.textContent?.startsWith('Continue as Bob')),
            'the mock users',
        );
        return [...host.querySelectorAll('button')].find((item) => item.textContent?.startsWith('Continue as Bob'))!;
    })();
    await act(async () => bob.click());
    await until(() => signedInAs('Bob'), 'the shell for bob');
    await until(() => heard.includes('signed-in'), 'signed-in posted');
    expect(heard).toEqual(['signed-out', 'signed-in']);
});
