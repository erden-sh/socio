// AG-UI 1.0 (deps/ag-ui-1): the server stores attachments as 1.0 media parts,
// and gives them as the pre-1.0 `binary` reference to a client that doesn't
// send `X-Socio-Reads: ag-ui-media` (the native app builds already shipped,
// 0.2.6 and earlier), in history, the transcript and the live stream. Without
// that those builds show no attachment, and their steering recovery (which
// finds a delivered message in history by its attachment ids) sends it again.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Message } from '@ag-ui/client';
import { lastValueFrom } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import type { HistoryPage } from '@socio/shared/chat/chat-history';
import { attachmentPart, READS_AG_UI_MEDIA, READS_HEADER } from '@socio/shared/media/refs';

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

/** What a shipped build's steering recovery matches a delivered message by (0.2.6's `fileIds`). */
const shippedFileIds = (content: unknown): string[] =>
    Array.isArray(content)
        ? (content as { type?: unknown; id?: unknown }[])
              .filter((part) => part?.type === 'binary' && typeof part.id === 'string')
              .map((part) => part.id as string)
        : [];

async function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'cb-legacy-media-'));
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
    // A turn the runner stored, its person's message with an attachment as
    // the server writes it now.
    const message = {
        id: 'u1',
        role: 'user',
        content: [{ type: 'text', text: 'see' }, NEW_SHAPE],
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
    /** A request as a client: a shipped build sends no `X-Socio-Reads`. */
    const request = (path: string, reads: boolean, init: { method?: string; body?: unknown } = {}) =>
        app.request(`/api${path}`, {
            method: init.method ?? 'GET',
            headers: {
                cookie,
                ...(reads ? { [READS_HEADER]: READS_AG_UI_MEDIA } : {}),
                ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        });
    return { thread, dot, request };
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
    ['a shipped build (no X-Socio-Reads) gets the pre-1.0 binary reference', false, OLD_SHAPE],
    ['a build that reads AG-UI 1.0 media gets the media part', true, NEW_SHAPE],
])('%s in history, the transcript and the live stream', async (_, reads, shape) => {
    const f = await fixture();
    const expected = [{ type: 'text', text: 'see' }, shape];

    // History: what the app syncs, and what its steering recovery searches.
    const history = (await (await f.request(`/conversations/${f.thread.id}/history`, reads)).json()) as HistoryPage;
    const sent = history.runs.flatMap((run) => run.messages).find((message) => message.id === 'u1')!;
    expect(sent.content).toEqual(expected);
    // The recovery a shipped build runs finds the delivered copy by its ids,
    // so it doesn't send it again; on a 1.0 build the shared reader does.
    expect(shippedFileIds(sent.content)).toEqual(reads ? [] : [ID]);

    // The transcript.
    const transcript = (await (await f.request(`/conversations/${f.thread.id}/transcript`, reads)).json()) as {
        messages: Message[];
    };
    expect(transcript.messages.find((message) => message.id === 'u1')!.content).toEqual(expected);

    // The live stream: the conversation's follow stream, from the start…
    const follow = await f.request(`/conversations/${f.thread.id}/stream?after=0`, reads);
    expect(startedContent(await frames(follow, (seen) => startedContent(seen) !== undefined))).toEqual(expected);

    // …and the runtime's connect, which the apps' run client opens.
    const connect = await f.request(`/copilotkit/agent/${f.dot.id}/connect`, reads, {
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
