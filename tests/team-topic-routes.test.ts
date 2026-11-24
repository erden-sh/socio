import type { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it } from 'vitest';

import { teamOwner } from '@socio/foundation/telegram/team-owner';
import { SENDER_METADATA, type Conversation } from '@socio/shared/types';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-73: what a Telegram team topic answers to the requests the chat view
// can make. Members (alice, an admin, and bob) read the topic and its
// transcript; nobody owns it, so every owner route stays 404 for them
// (the chat view must not ask), and a non-member gets 404 everywhere.
const SECRET = 'team-topic-secret-0123456789abcdef';
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function fixture() {
    const config = { mode: 'live' as const, baseUrl: 'https://model.invalid/v1' };
    const { app, workspace, platform, dispose } = await makeTestRuntime({
        config: {
            baseUrl: config.baseUrl,
            apiKey: 'unused',
            model: 'qwen-test',
            runtimeUrl: '',
        },
        app: {
            config,
            auth: {
                provider: new MockAuthProvider(
                    [...DEFAULT_MOCK_USERS, { id: 'carol', name: 'Carol', role: 'member' }],
                    SECRET,
                ),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    const signIn = async (userId: string) => {
        const response = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        return response.headers.get('set-cookie')!.split(';')[0];
    };
    const as =
        (cookie: string) =>
        (path: string, method = 'GET', body?: unknown) =>
            app.request(`/api${path}`, {
                method,
                headers: {
                    cookie,
                    ...(['GET', 'HEAD'].includes(method) ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
    const users = {
        alice: as(await signIn('alice')),
        bob: as(await signIn('bob')),
        carol: as(await signIn('carol')),
    };
    // Topic 7 of a forum group, bound as the Telegram channel binds it, with
    // one finished turn: bob asked, the Dot answered.
    const dot = workspace.dots()[0];
    workspace.bindThread('topic', dot.id, 'Team plans', teamOwner('chat-1'));
    await workspace.telegram.bindThread('tg:chat-1:topic:7', 'topic', 'topic', 'chat-1', '7');
    await workspace.telegram.recordMember('chat-1', 'alice');
    await workspace.telegram.recordMember('chat-1', 'bob');
    const events = [
        {
            type: 'RUN_STARTED',
            threadId: 'topic',
            runId: 'r1',
            input: {
                threadId: 'topic',
                runId: 'r1',
                state: {},
                tools: [],
                context: [],
                forwardedProps: {},
                messages: [
                    {
                        id: 'u1',
                        role: 'user',
                        content: 'What is on the agenda?',
                        metadata: { [SENDER_METADATA]: 'bob' },
                    },
                ],
            },
        },
        { type: 'TEXT_MESSAGE_START', messageId: 'a1', role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: 'The offsite.' },
        { type: 'TEXT_MESSAGE_END', messageId: 'a1' },
        { type: 'RUN_FINISHED', threadId: 'topic', runId: 'r1' },
    ];
    (platform.runner as unknown as { db: DatabaseSync }).db
        .prepare(
            "INSERT INTO agent_runs(threadId, runId, status, events, startedAt, finishedAt, source) VALUES ('topic', 'r1', 'finished', ?, 1, 2, 'telegram')",
        )
        .run(JSON.stringify(events));
    return { ...users, workspace };
}

// Every owner route the chat view, its header and its sidebar row know.
const ownerRoutes: Array<[string, string, unknown?]> = [
    ['GET', '/conversations/topic/capture'],
    ['GET', '/conversations/topic/deletion'],
    ['PATCH', '/conversations/topic', { title: 'Ours' }],
    ['PATCH', '/conversations/topic', { inference: null }],
    ['DELETE', '/conversations/topic'],
    ['POST', '/voice/calls', { threadId: 'topic', sdp: 'v=0' }],
];

it('lets members read a team topic and keeps its owner routes closed', async () => {
    const f = await fixture();
    for (const [name, member] of [
        ['alice', f.alice],
        ['bob', f.bob],
    ] as const) {
        const listed = (
            (await (await member('/workspace')).json()) as {
                conversations: Conversation[];
            }
        ).conversations.find((thread) => thread.id === 'topic');
        // Marked team for every member: the client's ownsChat is false.
        expect(listed, name).toMatchObject({
            team: true,
            source: 'telegram',
            ownerId: teamOwner('chat-1'),
        });
        const transcript = await member('/conversations/topic/transcript');
        expect(transcript.status, name).toBe(200);
        const { messages } = (await transcript.json()) as {
            messages: Array<{ role: string; author?: { name: string } }>;
        };
        expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
        // Who asked (CB-66), never their id.
        expect(messages[0].author).toBeDefined();
        expect(JSON.stringify(messages)).not.toContain('"bob"');
        for (const [method, path, body] of ownerRoutes) {
            expect((await member(path, method, body)).status, `${name} ${method} ${path}`).toBe(404);
        }
    }
    // Nothing changed through them.
    expect(f.workspace.thread('topic')).toMatchObject({ title: 'Team plans' });
    // Not a member: missing, transcript included, and not in the list.
    expect((await f.carol('/conversations/topic/transcript')).status).toBe(404);
    for (const [method, path, body] of ownerRoutes) {
        expect((await f.carol(path, method, body)).status).toBe(404);
    }
    const carolList = (
        (await (await f.carol('/workspace')).json()) as {
            conversations: Conversation[];
        }
    ).conversations;
    expect(carolList.map((thread) => thread.id)).not.toContain('topic');
});
