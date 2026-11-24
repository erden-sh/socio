// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Conversation, State, WorkspaceState } from '@socio/shared/types';

import { useRevalidateOn } from '../src/hooks/use-tab-refresh';
import { CHANGES_CHANNEL, closeChangeChannel } from '../src/lib/change-channel';
import { closeAuthChannel } from '../src/shell/auth-channel';

import { createTestRouter, fetchServices } from './helpers/app-router';
import { FakeBroadcastChannel } from './helpers/fake-broadcast-channel';
import { memoriesOf } from './helpers/memories';

// Chat isn't configured here, so CopilotKit never renders; its package
// imports a stylesheet Node can't load.
vi.mock('@copilotkit/react-core/v2', () => ({
    CopilotKitProvider: ({ children }: { children: unknown }) => children,
}));

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

/**
 * CB-74: the rendered app is one tab; `other` is another tab's end of the
 * changes channel. The stubbed server is what both tabs read.
 */
let state: State;
let conversations: Conversation[];
let signedIn = true;
let requests: string[] = [];
// The paths that answered 404.
let missing: string[] = [];
// Holds the next /api/workspace answer while set (the shell mid-read).
let holdWorkspace: Promise<void> | undefined;

const workspace = (): WorkspaceState => ({
    user: { id: 'admin', name: 'Alice', role: 'admin' },
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
    conversations,
    setup: {
        model: false,
        voice: false,
        telegram: 'not_configured',
        missing: ['model'],
    },
    calls: [],
});

const respond = (path: string, method: string): [number, unknown] => {
    if (path === '/api/auth/session') {
        return [200, { provider: 'mock', user: null }];
    }
    if (path === '/api/auth/mock/users') {
        return [200, []];
    }
    if (!signedIn) {
        return [401, { error: 'Sign in to continue.' }];
    }
    if (path === '/api/state') {
        return [200, state];
    }
    if (path === '/api/memories') {
        return [200, memoriesOf(state.memories)];
    }
    if (path === '/api/workspace') {
        return [200, workspace()];
    }
    const capture = /^\/api\/conversations\/([^/]+)\/capture$/.exec(path);
    if (capture) {
        return conversations.some((item) => item.id === capture[1])
            ? [200, null]
            : [404, { error: 'Conversation not found.' }];
    }
    const memory = /^\/api\/memories\/([^/]+)$/.exec(path);
    if (memory && method === 'DELETE') {
        state = {
            ...state,
            memories: state.memories.filter((item) => item.id !== memory[1]),
        };
        return [200, { ok: true }];
    }
    return [404, { error: 'Not found.' }];
};

let root: Root;
let host: HTMLElement;
let other: FakeBroadcastChannel;
let heard: unknown[];
let hidden = false;

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    // Only the poll timers are fake: no poll runs unless the test moves
    // them on, so whatever is fetched came from a note or a return.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    window.matchMedia = (query: string) =>
        ({
            matches: false,
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
        }) as unknown as MediaQueryList;
    hidden = false;
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => (hidden ? 'hidden' : 'visible'),
    });
    FakeBroadcastChannel.reset();
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    other = new FakeBroadcastChannel(CHANGES_CHANNEL);
    heard = [];
    other.addEventListener('message', (event) => heard.push((event as MessageEvent).data));
    state = {
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
    conversations = [{ id: 'c1', dotId: 'd1', ownerId: 'admin', title: 'Plan', createdAt: 1 }];
    signedIn = true;
    requests = [];
    missing = [];
    holdWorkspace = undefined;
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const path = new URL(input, 'http://app.test').pathname;
        requests.push(path);
        if (path === '/api/workspace' && holdWorkspace) {
            await holdWorkspace;
        }
        const [status, body] = respond(path, init?.method ?? 'GET');
        if (status === 404) {
            missing.push(path);
        }
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
    closeChangeChannel();
    Reflect.deleteProperty(document, 'visibilityState');
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
const shellShown = () => !!host.querySelector('[data-slot="app-header"]');
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 200)));
async function wait(ms: number) {
    await act(async () => {
        vi.advanceTimersByTime(ms);
    });
    await settle();
}
const loaderRuns = { probe: 0 };
// A page with no poll: a `media` note revalidates it (like Media).
function Probe() {
    useRevalidateOn('media');
    return <p>Probe page</p>;
}

function open(path: string, log: string[] = []) {
    const router = createTestRouter(path, {
        services: () => fetchServices(log),
        // A page whose data is its loader's alone.
        extraRoutes: [
            {
                id: 'probe',
                path: 'probe',
                loader: () => ++loaderRuns.probe,
                Component: Probe,
            },
        ],
    });
    act(() => root.render(<RouterProvider router={router} />));
    return router;
}

it('a rename in another tab shows at once, without waiting for the poll', async () => {
    open('/');
    await until(shellShown, 'the shell');
    await until(() => text().includes('Plan'), 'the chat on Home');
    conversations = [{ ...conversations[0]!, title: 'Renamed plan' }];
    other.postMessage([{ topic: 'conversation', id: 'c1' }]);
    await until(() => text().includes('Renamed plan'), 'the new title');
    // The note only said which chat; the title came from the server.
    expect(requests).toContain('/api/workspace');
});

it('a chat deleted in another tab: the open one leaves, and is never asked for again', async () => {
    open('/chats/c1');
    await until(() => requests.includes('/api/conversations/c1/capture'), 'the capture');
    await settle();
    // The shell is mid-read when the capture's poll comes round: it waits.
    let answer: () => void = () => {};
    holdWorkspace = new Promise<void>((resolve) => (answer = resolve));
    conversations = [];
    requests = [];
    other.postMessage([{ topic: 'conversation', id: 'c1' }]);
    await until(() => requests.includes('/api/workspace'), 'the shell re-read');
    await wait(3000);
    expect(requests).not.toContain('/api/conversations/c1/capture');
    holdWorkspace = undefined;
    answer();
    await until(() => /Conversation not found\./.test(text()), 'the chat gone');
    await wait(3000);
    await wait(3000);
    expect(requests).not.toContain('/api/conversations/c1/capture');
    // Nothing about the chat answered 404 (the browser would log it).
    expect(missing.filter((path) => path.includes('c1'))).toEqual([]);
});

it('a note about a chat that stays refetches its capture after the shell', async () => {
    open('/chats/c1');
    await until(() => requests.includes('/api/conversations/c1/capture'), 'the capture');
    await settle();
    requests = [];
    other.postMessage([{ topic: 'conversation', id: 'c1' }]);
    await until(() => requests.includes('/api/conversations/c1/capture'), 'the capture again');
    expect(requests.indexOf('/api/workspace')).toBeLessThan(requests.indexOf('/api/conversations/c1/capture'));
});

it('a write here tells the other tabs which item changed, nothing more', async () => {
    open('/memories');
    await until(() => /Keep it short\./.test(text()), 'the memories');
    await settle();
    heard = [];
    act(() => {
        host.querySelector<HTMLElement>('[aria-label="Forget memory"]')!.click();
    });
    act(() => {
        [...document.querySelectorAll<HTMLElement>('[data-slot="forget-memory"] button')]
            .find((button) => button.textContent === 'Forget')!
            .click();
    });
    await until(() => heard.length > 0, 'the note');
    expect(heard).toEqual([[{ topic: 'memory', id: 'm1' }]]);
    expect(JSON.stringify(heard)).not.toContain('Keep it short');
});

it('coming back after a while re-reads the shell and revalidates the pages, once', async () => {
    const log: string[] = [];
    const router = open('/probe', log);
    await until(() => /Probe page/.test(text()), 'the probe page');
    await settle();
    const before = loaderRuns.probe;
    const hide = () =>
        act(() => {
            hidden = true;
            document.dispatchEvent(new Event('visibilitychange'));
        });
    const show = () =>
        act(() => {
            hidden = false;
            document.dispatchEvent(new Event('visibilitychange'));
            window.dispatchEvent(new FocusEvent('focus'));
        });
    // Hidden for a moment only: nothing.
    hide();
    show();
    await settle();
    expect(loaderRuns.probe).toBe(before);
    requests = [];
    log.length = 0;
    // Hidden for over two seconds (a real clock: the poll timers are fake).
    hide();
    await act(() => new Promise((resolve) => setTimeout(resolve, 2100)));
    show();
    await until(() => loaderRuns.probe === before + 1, 'the pages revalidated');
    await settle();
    // Shown and focused together: one return, one read of the shell.
    expect(loaderRuns.probe).toBe(before + 1);
    expect(requests.filter((path) => path === '/api/state')).toHaveLength(1);
    // The shell's loader stayed out: its poll read it (with its tag).
    expect(log).not.toContain('/api/state');
    expect(router.state.revalidation).toBe('idle');
}, 15_000);

it('a note for a page with no poll revalidates its loader, not the shell’s', async () => {
    const log: string[] = [];
    open('/probe', log);
    await until(() => /Probe page/.test(text()), 'the probe page');
    await settle();
    const before = loaderRuns.probe;
    log.length = 0;
    other.postMessage([{ topic: 'media' }]);
    await until(() => loaderRuns.probe === before + 1, 'the page revalidated');
    await settle();
    expect(loaderRuns.probe).toBe(before + 1);
    expect(log).not.toContain('/api/state');
});

it('signed out, a note asks nothing', async () => {
    signedIn = false;
    open('/');
    await until(() => /Who’s thinking today\?/.test(text()), 'sign-in');
    await settle();
    requests = [];
    other.postMessage([{ topic: 'conversation', id: 'c1' }]);
    await settle();
    expect(requests).toEqual([]);
});
