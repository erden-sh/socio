import type { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it } from 'vitest';

import { DEFAULT_MOCK_USERS } from '../../src/server/auth/config.js';
import { MockAuthProvider } from '../../src/server/auth/mock.js';
import { makeTestRuntime } from '../helpers/test-runtime.js';

// CB-382: the reply reports as the app's runtime wires them. A test runtime
// has no cloud connection, so sharing is never available: the workspace
// payload says so, the admins' setting refuses to turn on, and a report on a
// thumbs-down is a plain thumbs-down.
const SECRET = 'reply-reports-wiring-secret-0123456789';
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

it('wires the reports into the workspace payload, the admins’ setting and the thumbs-down', async () => {
    const config = { mode: 'live' as const, baseUrl: 'https://model.invalid/v1' };
    const { app, workspace, platform, dispose } = await makeTestRuntime({
        config: { baseUrl: config.baseUrl, apiKey: 'unused', model: 'qwen-test', runtimeUrl: '' },
        app: {
            config,
            auth: { provider: new MockAuthProvider(DEFAULT_MOCK_USERS, SECRET), secureCookies: false },
        },
    });
    cleanup.push(dispose);
    const signIn = async (userId: string) => {
        const response = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        return response.headers.get('set-cookie')!.split(';')[0]!;
    };
    const as =
        (cookie: string) =>
        (path: string, method = 'GET', body?: unknown) =>
            app.request(`/api${path}`, {
                method,
                headers: { cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
    const alice = as(await signIn('alice'));
    const bob = as(await signIn('bob'));

    expect(((await (await bob('/workspace')).json()) as { replyReports: unknown }).replyReports).toBeNull();
    expect((await bob('/cloud/reply-reports')).status).toBe(403);
    expect((await bob('/cloud/reply-reports', 'PUT', { sharing: true })).status).toBe(403);
    expect(await (await alice('/cloud/reply-reports')).json()).toEqual({
        available: false,
        sharing: false,
        queued: 0,
        failed: 0,
    });
    expect((await alice('/cloud/reply-reports', 'PUT', { sharing: true })).status).toBe(409);

    const dot = workspace.dots()[0]!;
    workspace.bindThread('solo', dot.id, 'Plans', 'alice');
    const db = (platform.runner as unknown as { db: DatabaseSync }).db;
    db.prepare(
        "INSERT INTO agent_runs(threadId, runId, status, events, startedAt, finishedAt) VALUES (?, ?, 'finished', ?, 1, 2)",
    ).run(
        'solo',
        'r1',
        JSON.stringify([
            {
                type: 'RUN_STARTED',
                threadId: 'solo',
                runId: 'r1',
                input: { messages: [{ id: 'u1', role: 'user', content: 'Hello?' }] },
            },
            { type: 'TEXT_MESSAGE_START', messageId: 'a1', role: 'assistant' },
            { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: 'Hello, Alice.' },
            { type: 'TEXT_MESSAGE_END', messageId: 'a1' },
            { type: 'RUN_FINISHED', threadId: 'solo', runId: 'r1' },
        ]),
    );
    const reported = await alice('/conversations/solo/messages/a1/reactions/down', 'PUT', {
        report: { reason: 'wrong', consent: 'any', shownByOther: false },
    });
    expect(reported.status).toBe(200);
    expect(await reported.json()).toEqual({
        shared: false,
        messages: { a1: { counts: { down: 1 }, mine: ['down'] } },
        report: 'not-sharing',
    });
    expect(await (await alice('/conversations/solo/messages/a1/report')).json()).toEqual({
        sharing: false,
        promptByOther: false,
    });
});
