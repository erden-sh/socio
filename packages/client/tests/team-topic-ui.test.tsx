// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Conversation, State, User, WorkspaceState } from '@socio/shared/types';

import { createTestRouter } from './helpers/app-router';

// CB-73: opening a Telegram team topic showed a "Conversation not found."
// toast, because the chat view polled the owner's capture route, which
// answers 404 to everyone else. The server here answers as the real one:
// owner routes only for the owner (requireOwnedThread), the transcript for
// whoever may read it (readableThread).
vi.mock('@copilotkit/react-core/v2', () => ({
    CopilotKitProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../src/modules/chat/ClientChat', () => ({
    ClientChat: () => <div data-slot="live-chat-stand-in" />,
}));

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const state: State = {
    settings: {
        name: 'Brain',
        paused: false,
        researchAllowed: false,
        memoryAllowed: true,
    },
    tasks: [],
    memories: [],
    mode: 'live',
    configured: true,
};
const alice: User = { id: 'alice', name: 'Alice', role: 'admin' };
const bob: User = { id: 'bob', name: 'Bob', role: 'member' };
let user = alice;
// Team topics belong to the group chat, never to a person; the workspace
// marks them `team` for every member (WorkspaceStore.conversations).
const topic: Conversation = {
    id: 't1',
    dotId: 'd1',
    ownerId: 'telegram-team:chat-1',
    title: 'Team plan',
    createdAt: 2,
    team: true,
    source: 'telegram',
    telegram: { kind: 'topic', chatId: 'chat-1', topicId: '7' },
};
const conversations = () => [
    topic,
    {
        id: `${user.id}-own`,
        dotId: 'd1',
        ownerId: user.id,
        title: 'My chat',
        createdAt: 1,
    },
];
const workspace = (): WorkspaceState => ({
    user,
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
    conversations: conversations(),
    setup: {
        model: true,
        voice: false,
        telegram: 'online',
        missing: [],
    },
    calls: [],
});

let requests: string[] = [];
const missing: [number, unknown] = [404, { error: 'Conversation not found.' }];
const respond = (url: URL, init?: RequestInit): [number, unknown] => {
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    if (path === '/api/state') {
        return [200, state];
    }
    if (path === '/api/workspace') {
        return [200, workspace()];
    }
    if (path === '/api/issues') {
        return [200, { issues: [], users: {} }];
    }
    if (path.startsWith('/api/learning/')) {
        return [200, []];
    }
    const match = path.match(/^\/api\/conversations\/([^/]+)(\/[a-z-]+)?$/);
    if (!match) {
        return [404, { error: 'Not found.' }];
    }
    const thread = conversations().find((c) => c.id === match[1]);
    if (!thread) {
        return missing;
    }
    if (match[2] === '/transcript' && method === 'GET') {
        return [
            200,
            {
                conversation: thread,
                messages: [
                    {
                        id: 'm1',
                        role: 'user',
                        content: 'What is on the agenda?',
                        author: { name: 'Bob', you: user.id === 'bob' },
                    },
                    { id: 'm2', role: 'assistant', content: 'Plan the offsite.' },
                ],
            },
        ];
    }
    // A member reads and gives reactions (CB-133).
    if (match[2] === '/reactions' && method === 'GET') {
        return [200, { shared: true, messages: {} }];
    }
    // Everything else is the owner's: capture, deletion, PATCH, DELETE.
    const owned = thread.ownerId === user.id && !thread.team;
    if (!owned) {
        return missing;
    }
    if (match[2] === '/capture') {
        return [200, null];
    }
    if (match[2] === '/deletion') {
        return [200, { scheduledTasks: 0, blocked: null }];
    }
    return [200, thread];
};

let root: Root;
let host: HTMLElement;
vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    window.matchMedia = (query: string) =>
        ({
            matches: false,
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
        }) as unknown as MediaQueryList;
    requests = [];
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://app.test');
        const [status, body] = respond(url, init);
        requests.push(`${init?.method ?? 'GET'} ${url.pathname} ${status}`);
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

async function until(check: () => boolean, what: string) {
    for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${document.body.textContent}`);
}
const settle = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
async function open(path: string) {
    const router = createTestRouter(path);
    act(() => root.render(<RouterProvider router={router} />));
    await until(() => !!host.querySelector('[data-slot="app-header"]'), 'shell');
    return router;
}
// Refused requests for a conversation (other polls this stand-in server
// doesn't answer are not this test's).
const refused = () => requests.filter((line) => line.includes(' /api/conversations/') && / 4\d\d$/.test(line));
const asked = (suffix: string) => requests.filter((line) => line.split(' ')[1]?.endsWith(suffix));

for (const who of [alice, bob]) {
    it(`opens a team topic for ${who.name} (${who.role}) with no 404 and no toast`, async () => {
        user = who;
        const router = await open('/chats/t1');
        await until(() => /Plan the offsite\./.test(host.textContent ?? ''), 'the team transcript');
        // A capture poll asks as it mounts: none may be asked for at all.
        await settle(200);
        expect(asked('/t1/capture')).toEqual([]);
        expect(refused()).toEqual([]);
        expect(document.body.textContent).not.toContain('Conversation not found');
        // The user's own chat still polls its capture, and gets it.
        await act(() => router.navigate(`/chats/${who.id}-own`));
        await until(() => asked(`/${who.id}-own/capture`).length > 0, 'the own chat’s capture');
        expect(asked(`/${who.id}-own/capture`)[0]).toMatch(/ 200$/);
        // And back to the topic: still nothing refused.
        await act(() => router.navigate('/chats/t1'));
        await until(() => /Plan the offsite\./.test(host.textContent ?? ''), 'back');
        await settle(200);
        expect(asked('/t1/capture')).toEqual([]);
        expect(refused()).toEqual([]);
        expect(document.body.textContent).not.toContain('Conversation not found');
    });
}
