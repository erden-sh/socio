import { randomUUID } from 'node:crypto';

import type { Message, RunAgentInput } from '@ag-ui/core';
import type { AnyTextAdapter, ModelMessage, TextOptions } from '@tanstack/ai';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { withPrivateResultsWithheld, withToolActors } from '@socio/foundation/context/room-context';
import { teamOwner } from '@socio/foundation/telegram/team-owner';
import type { DotTurn } from '@socio/foundation/turns/turn';
import { TURN_MEMORY_CHARS } from '@socio/shared/context-settings';
import type { EpisodesState } from '@socio/shared/memory';
import { TOOL_ACTOR_METADATA } from '@socio/shared/types';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { episodeRetentionDaysFromEnv, type PlatformConfig } from '../src/server/composition/config.js';
import { resetCalibration } from '../src/server/context/budget.js';
import { fitContext } from '../src/server/context/fit.js';
import { ContextNotes, SUMMARY_PROMPT } from '../src/server/context/notes.js';
import { InferenceService } from '../src/server/inference/service.js';
import { DEFAULT_EPISODE_RETENTION_DAYS } from '../src/server/memory/contract.js';
import { factEpisode } from '../src/server/memory/domain/rules.js';
import {
    EPISODE_RETENTION_EVERY_MS,
    episodeRetentionDays,
    expireEpisodes,
    memoriesModule,
} from '../src/server/memory/module.js';
import { personalContext, TURN_EPISODE_SHARE } from '../src/server/memory/turn.js';
import type { ModuleContext } from '../src/server/modules/contract.js';

import { completion } from './fixtures/model-stream.js';
import { DotAgent } from './helpers/dot-agent.js';
import { testModuleServices } from './helpers/module-services.js';
import { LocalAgentRunner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-180: episodes. What happened in a person's own chats (the facts a
// fold pinned, the chat's summary) is captured automatically, recalled in
// their other chats of their own (a few in the turn's note, more through
// search_episodes), never in a chat with other people in it (CB-210), and
// seen, searched and deleted (for real) on the Memories page; the leader
// deletes them after the retention in Settings.

const cleanup: Array<() => unknown> = [];
beforeEach(() => resetCalibration());
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
});

const DAY = 24 * 60 * 60_000;
const CANARY = 'EPISODE-CANARY Decision: the Atlas launch moves to March 3';

interface Body {
    messages: Array<{ role: string; content: unknown }>;
    tools?: Array<{ function?: { name?: string } }>;
}
const system = (body: Body) =>
    body.messages
        .filter((message) => message.role === 'system')
        .map((message) => JSON.stringify(message.content))
        .join('\n');
const newest = (body: Body) =>
    JSON.stringify(body.messages.filter((message) => message.role === 'user').at(-1)?.content);
const SUMMARY = /running notes of a long conversation/;
const SUMMARY_ANSWER =
    'PINNED:\n- Goal: ship the beta on Friday\n- Decision: invoices go out on the 1st\nSUMMARY:\nThey planned the beta launch step by step.';
const user = (text: string): Message => ({
    id: randomUUID(),
    role: 'user',
    content: text,
});

/**
 * Socio on an OpenAI-compatible backend that never leaves this process:
 * each turn runs through the durable runner, as the app's do; the notes'
 * requests get a fixed summary, every other request is a round.
 */
async function fixture() {
    const workspace = new WorkspaceStore(testDatabase());
    const store = new Store(testDatabase());
    const runner = new LocalAgentRunner(testDatabase());
    cleanup.push(
        () => workspace.close(),
        () => store.close(),
        () => runner.close(),
    );
    const inference = new InferenceService(workspace.db, {
        secret: 'episodes-test-secret-0123456789abcdef',
        log: () => {},
    });
    await inference.createBackend({
        label: 'Homelab',
        baseUrl: 'http://orion.invalid/v1',
        model: 'qwen',
        contextWindow: 32_000,
    });
    const rounds: Body[] = [];
    const summaries: Body[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Body;
        if (SUMMARY.test(system(body))) {
            summaries.push(body);
            return completion({ role: 'assistant', content: SUMMARY_ANSWER });
        }
        rounds.push(body);
        return completion({
            role: 'assistant',
            content: `Reply ${rounds.length}.`,
        });
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const person of DEFAULT_MOCK_USERS) {
        workspace.recordUser(person);
    }
    const dot = workspace.dots()[0];
    workspace.bindThread('alice-chat', dot.id, 'Atlas planning', 'alice');
    workspace.bindThread('alice-other', dot.id, 'Weekly review', 'alice');
    workspace.bindThread('bob-chat', dot.id, 'Bob’s notes', 'bob');
    workspace.bindThread('team', dot.id, 'Team topic', teamOwner('-100'));
    const config: PlatformConfig = {
        baseUrl: '',
        apiKey: '',
        model: '',
        voiceName: 'marin',
        runtimeUrl: '',
        sessionSecret: 'episodes-test-secret-0123456789abcdef',
    };
    const ctx = {
        db: workspace.db,
        services: testModuleServices({ store, workspace }),
    } as unknown as ModuleContext;
    /** Sends `text` as `person` in `threadId`; the turn's last message. */
    const send = async (threadId: string, person: string, text: string) => {
        const agent = new DotAgent(store, workspace, config, dot.id, false, person, {
            inference,
            // The memories module's tools, as the platform gives them.
            extensions: { tools: (turn) => memoriesModule.dotTools!(ctx, turn) },
        });
        const input: RunAgentInput = {
            threadId,
            runId: randomUUID(),
            state: {},
            context: [],
            messages: [...(await runner.messages(threadId)), user(text)],
            tools: [],
            forwardedProps: {},
        };
        agent.threadId = threadId;
        agent.setMessages(input.messages);
        const events = await lastValueFrom(runner.run({ threadId, agent, input }).pipe(toArray()));
        expect(events.map((event) => event.type)).not.toContain('RUN_ERROR');
        return (await runner.messages(threadId)).at(-1)?.content;
    };
    /** Six turns, then /compact: four of them folded into the notes. */
    const longChat = async (threadId: string, person: string) => {
        for (let step = 1; step <= 6; step++) {
            await send(threadId, person, `Plan step ${step} of the beta launch.`);
        }
        return send(threadId, person, '/compact');
    };
    return { workspace, store, config, dot, ctx, rounds, summaries, send, longChat };
}

it('captures a fold’s new facts and summary as the person’s episodes, from their own chat only', async () => {
    const f = await fixture();
    expect(await f.longChat('alice-chat', 'alice')).toBe('Compacted: 4 earlier turns folded into this chat’s notes.');
    const episodes = await f.store.episodes.list('alice');
    expect(
        episodes.map(({ kind, label, text, threadId, dotId }) => ({
            kind,
            label,
            text,
            threadId,
            dotId,
        })),
    ).toEqual(
        expect.arrayContaining([
            {
                kind: 'fact',
                label: 'Goal',
                text: 'Goal: ship the beta on Friday',
                threadId: 'alice-chat',
                dotId: f.dot.id,
            },
            {
                kind: 'fact',
                label: 'Decision',
                text: 'Decision: invoices go out on the 1st',
                threadId: 'alice-chat',
                dotId: f.dot.id,
            },
            {
                kind: 'summary',
                label: null,
                text: 'They planned the beta launch step by step.',
                threadId: 'alice-chat',
                dotId: f.dot.id,
            },
        ]),
    );
    expect(episodes).toHaveLength(3);
    // No one else's.
    expect(await f.store.episodes.count('bob')).toBe(0);

    // A team topic folds its notes for everyone: no one's episodes.
    expect(await f.longChat('team', 'alice')).toBe('Compacted: 4 earlier turns folded into this chat’s notes.');
    expect(f.summaries).toHaveLength(2);
    expect(await f.store.episodes.count('alice')).toBe(3);
    expect((await f.store.episodes.list('alice')).some((episode) => episode.threadId === 'team')).toBe(false);

    // With memory off for the workspace, nothing is captured.
    await f.store.updateSettings({ memoryAllowed: false });
    await f.longChat('bob-chat', 'bob');
    expect(f.summaries).toHaveLength(3);
    expect(await f.store.episodes.count('bob')).toBe(0);
});

/** A notes model: a fixed summary for the notes' requests, "Done." otherwise. */
function notesModel() {
    const summaries: TextOptions[] = [];
    const adapter = {
        name: 'fake',
        chatStream: async function* (request: TextOptions) {
            const first = request.systemPrompts?.[0] ?? '';
            const text = (typeof first === 'string' ? first : first.content).endsWith(SUMMARY_PROMPT)
                ? (summaries.push(request), 'PINNED:\n- Decision: Bob runs the jobs\nSUMMARY:\nThey checked the jobs.')
                : 'Done.';
            yield { type: 'RUN_STARTED', runId: 'r', threadId: 't' };
            yield { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' };
            yield { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: text };
            yield { type: 'TEXT_MESSAGE_END', messageId: 'm' };
            yield { type: 'RUN_FINISHED', runId: 'r', threadId: 't' };
        },
    } as unknown as AnyTextAdapter;
    return { adapter, summaries };
}

/** One round on a history long enough that fitting folds it. */
async function foldRound(shared: boolean) {
    const db = testDatabase();
    cleanup.push(() => db.close());
    const messages: ModelMessage[] = [];
    for (let index = 0; index < 24; index++) {
        messages.push(
            { role: 'user', content: `Turn ${index}: check job-${index}.` },
            { role: 'assistant', content: `Checked ${index}. `.padEnd(3_000, 'z') },
        );
    }
    messages.push({ role: 'user', content: 'Where are we?' });
    const model = notesModel();
    const folds: unknown[] = [];
    const fit = fitContext(model.adapter, {
        capabilities: { acceptsImages: false, contextWindow: 16_000 },
        key: `test:episodes:${shared}`,
        threadId: 't',
        notes: new ContextNotes(db),
        emit: () => {},
        log: () => {},
        shared,
        episodes: (fold) => void folds.push(fold),
    });
    for await (const chunk of fit.chatStream({
        model: 'fake-model',
        messages,
        systemPrompts: ['You are Ada.'],
        tools: [],
    } as unknown as TextOptions)) {
        void chunk;
    }
    return { folds, summaries: model.summaries };
}

it('hands each automatic fold of a person’s own chat to their episodes, and never a shared chat’s', async () => {
    const own = await foldRound(false);
    expect(own.summaries.length).toBeGreaterThan(0);
    expect(own.folds[0]).toEqual({
        facts: ['Decision: Bob runs the jobs'],
        summary: 'They checked the jobs.',
    });
    const shared = await foldRound(true);
    expect(shared.summaries.length).toBeGreaterThan(0);
    expect(shared.folds).toEqual([]);
});

it('keeps one row per fact and chat, moved on when pinned again, and one summary per chat', async () => {
    const { store } = await fixture();
    const capture = (threadId: string, facts: string[], at: number) =>
        store.episodes.capture({ userId: 'alice', threadId, facts, summary: `Summary at ${at}.` }, at);
    await capture('alice-chat', ['Decision: weekly sync on Mondays'], 1_000);
    await capture('alice-chat', ['decision: weekly sync on mondays.'], 5_000);
    await capture('alice-other', ['Decision: weekly sync on Mondays'], 2_000);
    const all = await store.episodes.list('alice');
    expect(all.map((episode) => [episode.threadId, episode.kind])).toEqual([
        ['alice-chat', 'fact'],
        ['alice-chat', 'summary'],
        ['alice-other', 'fact'],
        ['alice-other', 'summary'],
    ]);
    // The same fact pinned again in the same chat: its newer words and time.
    expect(all[0]).toMatchObject({
        text: 'decision: weekly sync on mondays.',
        label: 'Decision',
        occurredAt: 5_000,
        createdAt: 1_000,
    });
    expect(all[1].text).toBe('Summary at 5000.');
    expect(factEpisode('  ')).toBeUndefined();
    expect(factEpisode('Just words')?.label).toBeNull();
    expect(factEpisode('x'.repeat(5_000))!.text).toHaveLength(1_000);
});

it('gives a turn the episodes of the person’s other chats that match, within a small share of the recall budget', async () => {
    const { store } = await fixture();
    await store.episodes.capture({ userId: 'alice', threadId: 'alice-other', facts: [CANARY] }, Date.UTC(2026, 9, 20));
    await store.episodes.capture({
        userId: 'alice',
        threadId: 'alice-chat',
        facts: ['Decision: Atlas launch budget is 40k'],
    });
    for (let index = 0; index < 12; index++) {
        await store.episodes.capture({
            userId: 'alice',
            threadId: 'alice-other',
            facts: [`Result: Atlas launch check ${index} ${'x'.repeat(300)}`],
        });
        await store.memoryItems.add({
            userId: 'alice',
            text: `Atlas launch note ${index} ${'y'.repeat(360)}`,
            source: 'person',
        });
    }
    const context = (options: Partial<Parameters<typeof personalContext>[1]>) =>
        personalContext(store, {
            userId: 'alice',
            shared: false,
            query: 'When is the Atlas launch?',
            threadId: 'alice-chat',
            chatTitle: (id) => (id === 'alice-other' ? 'Weekly review' : undefined),
            ...options,
        });
    const turn = await context({});
    const line = turn.lines.find((text) => text.startsWith('Episodes from'))!;
    const given = JSON.parse(line.slice(line.indexOf('[{'))) as Array<{
        episode: string;
        day: string;
        chat?: string;
    }>;
    // A couple at most, by default, never this chat's own (its notes have it).
    expect(given.length).toBeGreaterThan(0);
    expect(given.length).toBeLessThanOrEqual(2);
    expect(JSON.stringify(given)).not.toContain('40k');
    const used = given.reduce((sum, item) => sum + item.episode.length, 0);
    expect(used).toBeLessThanOrEqual(TURN_MEMORY_CHARS * TURN_EPISODE_SHARE);
    expect(given.every((item) => item.chat === 'Weekly review')).toBe(true);
    expect(line).toContain('untrusted data');
    // The memories take what is left of the budget.
    const memoryLine = turn.lines.find((text) => text.startsWith("The person's memories"))!;
    const memories = JSON.parse(memoryLine.slice(memoryLine.indexOf('[{'))) as {
        memory: string;
    }[];
    expect(memories.reduce((sum, item) => sum + item.memory.length, 0) + used).toBeLessThanOrEqual(TURN_MEMORY_CHARS);
    expect(turn.episodeIds).toHaveLength(given.length);

    // The canary, best match for its own words.
    const exact = await context({ query: 'Atlas launch moves March' });
    expect(exact.lines.join('\n')).toContain('EPISODE-CANARY');
    expect(exact.lines.join('\n')).toContain('"day":"2026-10-20"');
    // A bigger budget gives more, still a share.
    expect((await context({ recallTokens: 8_000 })).episodeIds.length).toBe(6);
    // Words that match nothing: none, never the newest for their own sake.
    expect((await context({ query: 'Hello there' })).episodeIds).toEqual([]);
    // A chat with other people in it: none, whoever acts.
    const shared = await context({ shared: true });
    expect(shared.episodeIds).toEqual([]);
    expect(shared.lines.join('\n')).not.toContain('EPISODE-CANARY');
    // Someone else's turn: none of hers.
    const bob = await personalContext(store, {
        userId: 'bob',
        shared: false,
        query: 'When is the Atlas launch?',
    });
    expect(bob.lines.join('\n')).not.toContain('Atlas');
});

it('never puts a private chat’s episode into a shared chat’s prompt, and keeps the system prompt the same', async () => {
    const f = await fixture();
    await f.send('alice-chat', 'alice', 'Hello.');
    const before = f.rounds.at(-1)!;
    await f.store.episodes.capture({
        userId: 'alice',
        threadId: 'alice-other',
        facts: [CANARY],
    });
    await f.send('alice-chat', 'alice', 'When does the Atlas launch move?');
    const own = f.rounds.at(-1)!;
    expect(newest(own)).toContain('EPISODE-CANARY');
    expect(newest(own)).toContain('Weekly review');
    // Byte for byte the same system prompt, with and without (CB-139).
    expect(system(own)).toBe(system(before));
    expect(system(own)).not.toContain('EPISODE-CANARY');
    expect(own.tools?.map((tool) => tool.function?.name)).toContain('search_episodes');

    // Her turn in a team topic, and Bob's in his own chat: not a trace.
    await f.send('team', 'alice', 'When does the Atlas launch move?');
    expect(JSON.stringify(f.rounds.at(-1))).not.toContain('EPISODE-CANARY');
    await f.send('bob-chat', 'bob', 'When does the Atlas launch move?');
    expect(JSON.stringify(f.rounds.at(-1))).not.toContain('EPISODE-CANARY');
    // A socio with saved memories off gets none either.
    f.workspace.updateDot(f.dot.id, {
        name: f.dot.name,
        researchAllowed: f.dot.researchAllowed,
        memoryAllowed: false,
    });
    await f.send('alice-chat', 'alice', 'When does the Atlas launch move?');
    expect(JSON.stringify(f.rounds.at(-1))).not.toContain('EPISODE-CANARY');
});

const toolTurn = (userId: string, threadId: string, dot: DotTurn['dot']) =>
    ({
        dot,
        userId,
        threadId,
        channel: false,
        purpose: 'chat',
        check: () => {},
        signal: new AbortController().signal,
        toolNames: () => [],
    }) as unknown as DotTurn;

it('searches the person’s episodes on demand, in their own chats only', async () => {
    const f = await fixture();
    await f.store.episodes.capture(
        {
            userId: 'alice',
            threadId: 'alice-other',
            dotId: f.dot.id,
            facts: [CANARY, 'Result: the churn model scored 0.81'],
            summary: 'They reviewed the week.',
        },
        Date.UTC(2026, 9, 1),
    );
    await f.store.episodes.capture({
        userId: 'alice',
        threadId: 'alice-chat',
        facts: ['Decision: Atlas launch copy is final'],
    });
    const search = (userId: string, threadId: string) => {
        const tool = memoriesModule.dotTools!(f.ctx, toolTurn(userId, threadId, f.dot)).find(
            (candidate) => candidate.name === 'search_episodes',
        );
        return tool && ((args: unknown) => tool.execute!(args as never));
    };
    const found = (await search('alice', 'alice-chat')!({
        query: 'Atlas launch',
    })) as { episodes: Array<Record<string, string>> };
    expect(found.episodes).toEqual([
        {
            episode: CANARY,
            kind: 'fact',
            day: '2026-10-01',
            chat: 'Weekly review',
        },
    ]);
    // In a chat with other people in it: nothing, the person's own included.
    const team = (await search('alice', 'team')!({
        query: 'Atlas launch',
    })) as { episodes: unknown[]; note: string };
    expect(team.episodes).toEqual([]);
    expect(JSON.stringify(team)).not.toContain('CANARY');
    expect(team.note).toContain('never used in a chat with other people');
    // Someone else: none of hers.
    const bob = (await search('bob', 'bob-chat')!({ query: 'Atlas launch' })) as {
        episodes: unknown[];
    };
    expect(bob.episodes).toEqual([]);
    // Memory off: not offered.
    await f.store.updateSettings({ memoryAllowed: false });
    expect(search('alice', 'alice-chat')).toBeUndefined();
});

it('withholds an episode search’s result in a shared chat from everyone, its own person too', () => {
    const messages = withToolActors(
        [
            {
                id: 'a1',
                role: 'assistant',
                content: '',
                toolCalls: [
                    {
                        id: 'c-episodes',
                        type: 'function',
                        function: { name: 'search_episodes', arguments: '{}' },
                    },
                    {
                        id: 'c-files',
                        type: 'function',
                        function: { name: 'data_list', arguments: '{}' },
                    },
                ],
            },
            {
                id: 't1',
                role: 'tool',
                toolCallId: 'c-episodes',
                content: JSON.stringify({ episodes: [{ episode: CANARY }] }),
            },
            {
                id: 't2',
                role: 'tool',
                toolCallId: 'c-files',
                content: 'ALICE-OWN-RESULT',
            },
        ] as Message[],
        new Map([
            ['c-episodes', 'alice'],
            ['c-files', 'alice'],
        ]),
    );
    expect((messages[1] as { metadata?: Record<string, unknown> }).metadata?.[TOOL_ACTOR_METADATA]).toBe('alice');
    for (const person of ['alice', 'bob']) {
        const seen = JSON.stringify(withPrivateResultsWithheld(messages, person));
        expect(seen, person).not.toContain('EPISODE-CANARY');
        expect(seen).toContain('\\"withheld\\":true');
    }
    // Her other results stay hers, as CB-210 has it.
    expect(JSON.stringify(withPrivateResultsWithheld(messages, 'alice'))).toContain('ALICE-OWN-RESULT');
});

it('deletes episodes past the retention, oldest first, the admin’s setting over the environment', async () => {
    const f = await fixture();
    const now = Date.UTC(2026, 9, 28);
    await f.store.episodes.capture({ userId: 'alice', threadId: 'alice-chat', facts: ['Goal: old'] }, now - 181 * DAY);
    await f.store.episodes.capture({ userId: 'bob', threadId: 'bob-chat', facts: ['Goal: old too'] }, now - 200 * DAY);
    await f.store.episodes.capture(
        { userId: 'alice', threadId: 'alice-chat', facts: ['Goal: recent'] },
        now - 179 * DAY,
    );
    // Pinned again lately: it came up, so it stays.
    await f.store.episodes.capture(
        { userId: 'alice', threadId: 'alice-other', facts: ['Goal: kept alive'] },
        now - 300 * DAY,
    );
    await f.store.episodes.capture(
        { userId: 'alice', threadId: 'alice-other', facts: ['Goal: kept alive'] },
        now - 10 * DAY,
    );
    expect(episodeRetentionDays({ store: f.store, config: f.config })).toBe(DEFAULT_EPISODE_RETENTION_DAYS);
    expect(await expireEpisodes(f.store, 180, now)).toBe(2);
    expect((await f.store.episodes.list('alice')).map((episode) => episode.text)).toEqual([
        'Goal: kept alive',
        'Goal: recent',
    ]);
    expect(await f.store.episodes.count('bob')).toBe(0);
    // An admin's setting wins over the environment's.
    await f.store.updateSettings({ limits: { episodeRetentionDays: 30 } });
    expect(
        episodeRetentionDays({
            store: f.store,
            config: { ...f.config, episodeRetentionDays: 90 },
        }),
    ).toBe(30);
    await f.store.updateSettings({ limits: {} });
    expect(
        episodeRetentionDays({
            store: f.store,
            config: { ...f.config, episodeRetentionDays: 90 },
        }),
    ).toBe(90);
    expect(episodeRetentionDaysFromEnv({})).toBeUndefined();
    expect(episodeRetentionDaysFromEnv({ EPISODE_RETENTION_DAYS: ' 30 ' })).toBe(30);
    for (const bad of ['0', '3651', '1.5', 'forever']) {
        expect(() => episodeRetentionDaysFromEnv({ EPISODE_RETENTION_DAYS: bad })).toThrow('EPISODE_RETENTION_DAYS');
    }
    // In batches: more than one batch's worth goes in one run.
    for (let index = 0; index < 1_005; index++) {
        await f.store.episodes.capture(
            { userId: 'bob', threadId: 'bob-chat', facts: [`Result: run ${index}`] },
            now - 400 * DAY,
        );
    }
    expect(await expireEpisodes(f.store, 180, now)).toBe(1_005);
});

it('runs retention only on the leader, as a module tick', async () => {
    const f = await fixture();
    // Retention is the module's tick: `Platform.lead()` schedules ticks on
    // the runtime that holds the leader lease (CB-108), and only there.
    expect(memoriesModule.tick?.everyMs).toBe(EPISODE_RETENTION_EVERY_MS);
    expect(memoriesModule.start).toBeUndefined();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    // The server's runtime over the fixture's config, on a database of its own.
    const { platform, store, dispose } = await makeTestRuntime({ config: f.config });
    cleanup.push(dispose);
    await store.episodes.capture(
        { userId: 'alice', threadId: 'alice-chat', facts: ['Goal: ancient'] },
        Date.now() - 400 * DAY,
    );
    // A follower: no tick runs, whatever the time.
    await vi.advanceTimersByTimeAsync(EPISODE_RETENTION_EVERY_MS * 2);
    expect(await store.episodes.count('alice')).toBe(1);
    // Leading, the next tick deletes it.
    await platform.lead();
    await vi.advanceTimersByTimeAsync(EPISODE_RETENTION_EVERY_MS);
    await vi.waitFor(async () => expect(await store.episodes.count('alice')).toBe(0));
});

it('lets each person list, search and really delete only their own episodes', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { store, workspace, app, dispose } = await makeTestRuntime({
        config: {
            baseUrl: 'http://model.invalid/v1',
            apiKey: 'k',
            model: 'qwen',
            episodeRetentionDays: 90,
        },
        app: {
            config: { mode: 'live', baseUrl: '' },
            auth: {
                provider: new MockAuthProvider(DEFAULT_MOCK_USERS, 'secret-0123456789abcdef-xyz'),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    const as = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0];
        return (path: string, method = 'GET') =>
            app.request(`/api${path}`, {
                method,
                headers: {
                    cookie,
                    ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                },
            });
    };
    const alice = await as('alice');
    const bob = await as('bob');
    await store.episodes.capture(
        {
            userId: 'alice',
            threadId: 'a1',
            facts: [CANARY, 'Result: churn model scored 0.81'],
        },
        2_000,
    );
    await store.episodes.capture({ userId: 'alice', threadId: 'a2', facts: ['Goal: hire a designer'] }, 3_000);
    await store.episodes.capture({ userId: 'bob', threadId: 'b1', facts: ['Goal: Bob’s own'] }, 1_000);
    const view = async (call: typeof alice, query = '') =>
        (await (await call(`/memories/episodes${query}`)).json()) as EpisodesState;

    // Signed out: nothing.
    expect((await app.request('/api/memories/episodes')).status).toBe(401);
    const mine = await view(alice);
    expect(mine.total).toBe(3);
    expect(mine.retentionDays).toBe(90);
    expect(mine.episodes.map((episode) => episode.text)).toEqual([
        'Goal: hire a designer',
        CANARY,
        'Result: churn model scored 0.81',
    ]);
    expect(JSON.stringify(mine)).not.toContain('Bob’s own');
    // Search by words.
    expect((await view(alice, '?q=churn')).episodes.map((episode) => episode.text)).toEqual([
        'Result: churn model scored 0.81',
    ]);
    expect((await view(alice, `?q=${'x'.repeat(301)}`)).episodes).toBeUndefined();
    // Bob sees only his own, and can't delete hers: not found.
    expect((await view(bob)).episodes.map((episode) => episode.text)).toEqual(['Goal: Bob’s own']);
    const target = mine.episodes[1];
    expect((await bob(`/memories/episodes/${target.id}`, 'DELETE')).status).toBe(404);
    expect((await bob('/memories/episodes', 'DELETE')).status).toBe(200);
    expect(await store.episodes.count('alice')).toBe(3);
    expect(await store.episodes.count('bob')).toBe(0);
    // Hers to delete, for real: the row is gone, and the audit has its id only.
    expect((await alice(`/memories/episodes/${target.id}`, 'DELETE')).status).toBe(200);
    expect((await alice(`/memories/episodes/${target.id}`, 'DELETE')).status).toBe(404);
    // On the store's connection (tests open two): no row, stamped or not.
    expect(store.connection.prepare('SELECT COUNT(*) AS n FROM memory_episodes WHERE id = ?').get(target.id)).toEqual({
        n: 0,
    });
    expect((await view(alice)).total).toBe(2);
    expect(JSON.stringify(await view(alice))).not.toContain('EPISODE-CANARY');
    const audit = JSON.stringify(
        workspace.db.prepare("SELECT * FROM workspace_audit WHERE targetKind = 'episode'").all(),
    );
    expect(audit).toContain(target.id);
    expect(audit).not.toContain('CANARY');
    // One chat's, then all.
    const one = (await (await alice('/memories/episodes?threadId=a2', 'DELETE')).json()) as { deleted: number };
    expect(one.deleted).toBe(1);
    expect((await view(alice)).total).toBe(1);
    await alice('/memories/episodes', 'DELETE');
    expect((await view(alice)).total).toBe(0);
});
