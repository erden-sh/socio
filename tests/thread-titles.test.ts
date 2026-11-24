import { lastValueFrom } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import type { EndpointSource } from '@socio/foundation/inference/endpoints';

import { cleanTitle, ThreadTitler } from '../src/server/chat-name-suggestions/thread-titles.js';
import { modelSettingsFromEnv } from '../src/server/composition/config.js';

import { ScriptAgent } from './fixtures/script-agent.js';
import { LocalAgentRunner } from './helpers/runners.js';
import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => void> = [];
afterEach(() =>
    cleanup
        .splice(0)
        .reverse()
        .forEach((fn) => fn()),
);

const endpoint = {
    baseUrl: 'http://model.test/v1/',
    apiKey: 'unused',
    model: 'qwen-test',
    titleModelOptions: { chat_template_kwargs: { enable_thinking: false } },
};

function fixture(reply: (init: RequestInit) => Promise<Response>, source: EndpointSource = endpoint) {
    const workspace = new WorkspaceStore(testDatabase());
    const runner = new LocalAgentRunner(testDatabase(), { flushIntervalMs: 5 });
    cleanup.push(
        () => runner.close(),
        () => workspace.close(),
    );
    const thread = workspace.bindThread(
        'thread',
        workspace.dots()[0].id,
        'how do I back up a sqlite database safely?',
        'owner',
    );
    const requests: RequestInit[] = [];
    const titler = new ThreadTitler(workspace, runner, source, async (_url, init) => {
        requests.push(init!);
        return reply(init!);
    });
    titler.attach();
    const finish = async (agent: ScriptAgent, runId: string, content: unknown = 'Back up SQLite?') => {
        agent.threadId = thread.id;
        const messages = [
            ...(await runner.messages(thread.id)),
            { id: `u-${runId}`, role: 'user' as const, content: content as string },
        ];
        agent.setMessages(messages);
        await lastValueFrom(
            runner.run({
                threadId: thread.id,
                agent,
                input: {
                    threadId: thread.id,
                    runId,
                    messages,
                    state: {},
                    tools: [],
                    context: [],
                    forwardedProps: {},
                },
            }),
            { defaultValue: undefined },
        );
    };
    const run = async (...args: Parameters<typeof finish>) => {
        await finish(...args);
        await titler.idle();
    };
    const title = async () => (await workspace.conversations('owner')).find((t) => t.id === thread.id)?.title;
    return { run, finish, title, requests, titler };
}
const reply = (content: unknown) => async () => Response.json({ choices: [{ message: { content } }] });

it('names a conversation once, after its first successful run', async () => {
    const f = fixture(reply('Title: "Safely Backing Up SQLite."'));
    await f.run(new ScriptAgent('Use the backup API.'), 'r1');
    expect(await f.title()).toBe('Safely Backing Up SQLite');
    await f.run(new ScriptAgent('Also VACUUM INTO.'), 'r2');
    expect(f.requests).toHaveLength(1);
    const body = JSON.parse(String(f.requests[0].body));
    expect(body).toMatchObject({
        model: 'qwen-test',
        chat_template_kwargs: { enable_thinking: false },
    });
    expect(body.messages[1].content).toBe('User: Back up SQLite?\n\nAssistant: Use the backup API.');
});

it('names a conversation whose first message carries attachments by their names', async () => {
    const f = fixture(reply('Chart Review'));
    await f.run(new ScriptAgent('A bar chart.'), 'r1', [
        {
            type: 'binary',
            id: 'cbatt_AAAAAAAAAAAAAAAAAAAAAA',
            mimeType: 'image/png',
            filename: 'chart.png',
        },
    ]);
    expect(await f.title()).toBe('Chart Review');
    expect(JSON.parse(String(f.requests[0].body)).messages[1].content).toBe(
        'User: [attachment: chart.png]\n\nAssistant: A bar chart.',
    );
});

it('keeps the first-message title when the run or naming fails, and retries naming', async () => {
    const stopped = fixture(reply('Unused'));
    const agent = new ScriptAgent('partial', true);
    const pending = stopped.run(agent, 'r1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    agent.abortRun();
    await pending;
    // The run ended without a terminal event, so it is recorded as failed.
    expect(stopped.requests).toHaveLength(0);

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const replies = [async () => new Response('busy', { status: 503 }), reply('Recovered Title')];
    const failing = fixture(() => replies.shift()!());
    await failing.run(new ScriptAgent('Answer'), 'r1');
    expect(await failing.title()).toBe('how do I back up a sqlite database safely?');
    expect(errors).toHaveBeenCalledWith('Conversation title failed: Error (HTTP 503)');
    // A failed request is not recorded, so the next successful run retries.
    await failing.run(new ScriptAgent('Second answer'), 'r2');
    expect(await failing.title()).toBe('Recovered Title');
    expect(failing.requests).toHaveLength(2);
});

it('asks for no title once stopped, and cancels one in flight without saving it', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    errors.mockClear();
    // The shared backend is read async: stopped before it resolves.
    let resolve!: (value: typeof endpoint) => void;
    const later = fixture(reply('Too Late'), () => new Promise((done) => (resolve = done)));
    await later.finish(new ScriptAgent('Use the backup API.'), 'r1');
    const stopped = later.titler.stop();
    resolve(endpoint);
    await stopped;
    expect(later.requests).toHaveLength(0);

    // A request in flight is aborted, and nothing is saved.
    const inFlight = fixture(
        (init) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))),
    );
    await inFlight.finish(new ScriptAgent('Use the backup API.'), 'r1');
    await expect.poll(() => inFlight.requests.length).toBe(1);
    await inFlight.titler.stop();
    expect(await inFlight.title()).toBe('how do I back up a sqlite database safely?');
    // A later run asks for nothing, and shutdown is not reported as a failure.
    await inFlight.finish(new ScriptAgent('Also VACUUM INTO.'), 'r2');
    await inFlight.titler.idle();
    expect(inFlight.requests).toHaveLength(1);
    expect(errors).not.toHaveBeenCalled();
});

it('cleans model replies into a single short title', () => {
    expect(cleanTitle('<think>hmm</think>\n\n“Weekly Plan”\nextra')).toBe('Weekly Plan');
    expect(cleanTitle('**Budget Review!**')).toBe('Budget Review');
    expect(cleanTitle('   \n')).toBeUndefined();
    expect(cleanTitle('x'.repeat(200))).toHaveLength(80);
});

it('parses TITLE_MODEL_OPTIONS as a JSON object', () => {
    expect(
        modelSettingsFromEnv({
            TITLE_MODEL_OPTIONS: '{"chat_template_kwargs":{"enable_thinking":false}}',
        }).titleModelOptions,
    ).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    for (const value of ['[1]', 'nope', '"text"', 'null']) {
        expect(() => modelSettingsFromEnv({ TITLE_MODEL_OPTIONS: value })).toThrow(
            'TITLE_MODEL_OPTIONS must be a JSON object.',
        );
    }
});
