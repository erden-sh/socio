// AG-UI 1.0 (deps/ag-ui-1): every client gets attachments as 1.0 media parts,
// with no header to ask for them, in history, the transcript and the live
// stream; a transcript message's author and time come in its `metadata`
// only. A run stored before 1.0, its attachment as the pre-1.0 `binary`
// reference, reads the same: the replay upgrades it on the way out.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type { Message } from '@ag-ui/client';
import { lastValueFrom } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import type { HistoryPage } from '@socio/shared/chat/chat-history';
import { attachmentPart } from '@socio/shared/media/refs';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';

import { ScriptAgent } from './fixtures/script-agent.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const ID = 'cbatt_AAAAAAAAAAAAAAAAAAAAAA';
const REF = { id: ID, mimeType: 'image/png', filename: 'shot.png' };
const NEW_SHAPE = attachmentPart(REF);
const OLD_SHAPE = { type: 'binary', ...REF };

/** A conversation with one stored turn, its person's message holding `part`. */
async function fixture(part: unknown) {
    const dir = mkdtempSync(join(tmpdir(), 'cb-ag-ui-media-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const { platform, workspace, app, dispose } = await makeTestRuntime({
        config: { sessionSecret: 'secret-0123456789abcdef-xyz', data: { userDataDir: dir } },
        app: {
            auth: {
                provider: new MockAuthProvider(DEFAULT_MOCK_USERS, 'secret-0123456789abcdef-xyz'),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    for (const user of DEFAULT_MOCK_USERS) {
        workspace.recordUser(user);
    }
    const login = await app.request('/api/auth/mock/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'alice' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const dot = workspace.dots()[0];
    const thread = await platform.createConversation(dot.id, 'A', 'alice');
    // A turn the runner stored, its person's message with an attachment in
    // the given shape: as the server writes it now, or as one stored before 1.0.
    const message = {
        id: 'u1',
        role: 'user',
        content: [{ type: 'text', text: 'see' }, part],
    } as unknown as Message;
    const agent = new ScriptAgent('a chart');
    agent.agentId = dot.id;
    agent.threadId = thread.id;
    agent.setMessages([message]);
    await lastValueFrom(
        platform.runner.run({
            threadId: thread.id,
            agent,
            input: {
                threadId: thread.id,
                runId: 'r1',
                messages: [message],
                state: {},
                tools: [],
                context: [],
                forwardedProps: {},
            },
        }),
    );
    await vi.waitFor(() => expect(platform.runner.activeRunId(thread.id)).toBeUndefined());
    // The run as stored: the shape it was given, never rewritten in the row.
    const stored = (platform.runner as unknown as { db: DatabaseSync }).db
        .prepare('SELECT events FROM agent_runs WHERE runId = ?')
        .get('r1') as { events: string };
    /** A request as a client: the cookie and nothing else, no header asking for a shape. */
    const request = (path: string, init: { method?: string; body?: unknown } = {}) =>
        app.request(`/api${path}`, {
            method: init.method ?? 'GET',
            headers: {
                cookie,
                ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        });
    return { thread, dot, request, stored: stored.events };
}

/** The `data:` JSON of a server-sent events body, until `enough` says so (a follow stream stays open). */
async function frames(response: Response, enough: (seen: unknown[]) => boolean = () => false) {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const seen: unknown[] = [];
    let buffer = '';
    for (;;) {
        const { value, done } = await reader.read();
        if (done) {
            break;
        }
        buffer += decoder.decode(value, { stream: true });
        let at: number;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
            for (const line of buffer.slice(0, at).split('\n')) {
                if (line.startsWith('data: ')) {
                    seen.push(JSON.parse(line.slice(6)));
                }
            }
            buffer = buffer.slice(at + 2);
        }
        if (enough(seen)) {
            await reader.cancel();
            break;
        }
    }
    return seen;
}

/** The person's message's content, out of a RUN_STARTED's input. */
const startedContent = (events: unknown[]) =>
    (
        events.find((event) => (event as { type?: string }).type === 'RUN_STARTED') as
            | { input?: { messages?: Message[] } }
            | undefined
    )?.input?.messages?.find((message) => message.id === 'u1')?.content;

it.each([
    ['a run stored now (1.0 media part)', NEW_SHAPE, true],
    ['a run stored before 1.0 (binary reference)', OLD_SHAPE, false],
])('%s reaches every client as the 1.0 media part, with no header', async (_, part, modern) => {
    const f = await fixture(part);
    expect(f.stored.includes('"type":"binary"')).toBe(!modern);
    const expected = [{ type: 'text', text: 'see' }, NEW_SHAPE];

    // History: what the apps sync, and what the native app's steering recovery searches.
    const history = (await (await f.request(`/conversations/${f.thread.id}/history`)).json()) as HistoryPage;
    const sent = history.runs.flatMap((run) => run.messages).find((message) => message.id === 'u1')!;
    expect(sent.content).toEqual(expected);

    // The transcript: the attachment, and its time in `metadata` only (an
    // author, in a room, goes there the same way: `withSocioFields`).
    const transcript = (await (await f.request(`/conversations/${f.thread.id}/transcript`)).json()) as {
        messages: Array<Message & { metadata?: Record<string, unknown> }>;
    };
    const shown = transcript.messages.find((message) => message.id === 'u1')!;
    expect(shown.content).toEqual(expected);
    expect(typeof shown.metadata?.at).toBe('number');
    expect(shown).not.toHaveProperty('author');
    expect(shown).not.toHaveProperty('at');

    // The live stream: the conversation's follow stream, from the start…
    const follow = await f.request(`/conversations/${f.thread.id}/stream?after=0`);
    expect(startedContent(await frames(follow, (seen) => startedContent(seen) !== undefined))).toEqual(expected);

    // …and the runtime's connect, which the apps' run client opens.
    const connect = await f.request(`/copilotkit/agent/${f.dot.id}/connect`, {
        method: 'POST',
        body: {
            threadId: f.thread.id,
            runId: 'connect',
            messages: [],
            state: {},
            tools: [],
            context: [],
            forwardedProps: {},
        },
    });
    expect(connect.status).toBe(200);
    expect(startedContent(await frames(connect))).toEqual(expected);
});
