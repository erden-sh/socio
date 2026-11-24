import { DatabaseSync } from 'node:sqlite';

import type { Message, RunAgentInput } from '@ag-ui/core';
import type { AnyTextAdapter, ModelMessage, TextOptions } from '@tanstack/ai';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { migrate } from '@socio/data/migrate';
import { isNotesPart, isTurnNote } from '@socio/foundation/context/turn-note';
import { CONTEXT_COMPACTION_EVENT, type ContextCompactionInfo } from '@socio/shared/runs/run-phase';
import type { TraceEntry, TraceNotes } from '@socio/shared/runs/run-trace';

import type { PlatformConfig } from '../src/server/composition/config.js';
import { messagesTokens, resetCalibration } from '../src/server/context/budget.js';
import { ContextConfig, type FitTrace, type Summarizer } from '../src/server/context/contract.js';
import { MAX_SUMMARIES_PER_TURN, fitContext } from '../src/server/context/fit.js';
import { chatModule } from '../src/server/context/module.js';
import { chatSchema, ContextNotes, PINNED_MAX, SUMMARY_PROMPT } from '../src/server/context/notes.js';
import { searchNotesTool } from '../src/server/context/search-notes.js';
import { RANK_PROMPT, coreFacts, parseRanking, relevantNotes, selectNotes } from '../src/server/context/select.js';
import { InferenceService } from '../src/server/inference/service.js';
import { WorkspaceSettings } from '../src/server/settings/contract.js';
import { Runner } from '../src/server/turns/contract.js';
import { TraceRecorder, TurnTracer } from '../src/server/turns/turn-trace.js';

import { completion } from './fixtures/model-stream.js';
import { DotAgent } from './helpers/dot-agent.js';
import { LocalAgentRunner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

// CB-137: the running notes written by the shared model or the chat's, and
// traced; CB-134: which pinned facts a prompt carries, every one stored.

const cleanup: Array<() => unknown> = [];
beforeEach(() => resetCalibration());
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
});

const notesStore = () => {
    const db = testDatabase();
    cleanup.push(() => db.close());
    return { db, notes: new ContextNotes(db) };
};

const data = (chars: number, seed = 0) => {
    const row = `{"id":${seed},"name":"row ${seed}","value":${seed * 7}},`;
    return `[${row.repeat(Math.ceil(chars / row.length))}`.slice(0, chars);
};

/** A thread of `count` turns, each a data query and an answer. */
function thread(count: number, say = (index: number) => `Turn ${index}.`) {
    const messages: ModelMessage[] = [];
    for (let index = 0; index < count; index++) {
        const id = `call_${index}`;
        messages.push(
            { role: 'user', content: say(index) },
            {
                role: 'assistant',
                content: null,
                toolCalls: [
                    {
                        id,
                        type: 'function',
                        function: { name: 'data_query', arguments: '{}' },
                    },
                ],
            },
            { role: 'tool', toolCallId: id, content: data(6_000, index) },
            { role: 'assistant', content: `Done ${index}. `.padEnd(1_500, 'z') },
        );
    }
    return messages;
}

type Chunk = { type: string } & Record<string, unknown>;
const answer = (text: string, usage?: Record<string, number>): Chunk[] => [
    { type: 'RUN_STARTED', runId: 'r', threadId: 't' },
    { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: text },
    { type: 'TEXT_MESSAGE_END', messageId: 'm' },
    {
        type: 'RUN_FINISHED',
        runId: 'r',
        threadId: 't',
        ...(usage ? { usage } : {}),
    },
];

/** A scripted model: notes' requests (summaries and rankings) and rounds. */
function fakeModel(
    options: {
        summary?: (request: TextOptions, count: number) => string | Chunk[];
        rank?: (request: TextOptions) => string;
        /** A round's reported usage (calibration), by its count. */
        usage?: (count: number, request: TextOptions) => Record<string, number> | undefined;
    } = {},
) {
    const rounds: TextOptions[] = [];
    const summaries: TextOptions[] = [];
    const rankings: TextOptions[] = [];
    const adapter = {
        name: 'fake',
        chatStream: async function* (request: TextOptions) {
            if (request.systemPrompts?.[0] === SUMMARY_PROMPT) {
                summaries.push(request);
                const reply = options.summary?.(request, summaries.length) ?? [
                    'PINNED:',
                    `- Decision: summary ${summaries.length} decided something`,
                    'SUMMARY:',
                    `Summary ${summaries.length}.`,
                ];
                yield* typeof reply === 'string'
                    ? answer(reply, { promptTokens: 900, completionTokens: 60 })
                    : Array.isArray(reply) && typeof reply[0] === 'object'
                      ? (reply as Chunk[])
                      : answer((reply as string[]).join('\n'), {
                            promptTokens: 900,
                            completionTokens: 60,
                        });
                return;
            }
            if (request.systemPrompts?.[0] === RANK_PROMPT) {
                rankings.push(request);
                yield* answer(options.rank?.(request) ?? 'none');
                return;
            }
            rounds.push(request);
            yield* answer('Done.', options.usage?.(rounds.length, request));
        },
    } as unknown as AnyTextAdapter;
    return { adapter, rounds, summaries, rankings };
}

const request = (messages: ModelMessage[]): TextOptions =>
    ({
        model: 'chat-model',
        modelOptions: { max_completion_tokens: 4096 },
        messages,
        systemPrompts: ['You are Ada, a specialist Dot in Socio.'],
        tools: [],
    }) as unknown as TextOptions;

async function drain(stream: AsyncIterable<unknown>) {
    const chunks: Chunk[] = [];
    for await (const chunk of stream) {
        chunks.push(chunk as Chunk);
    }
    return chunks;
}

/** A fit trace that keeps what it is told. */
function traceLog() {
    const notes: Array<Omit<TraceNotes, 'kind' | 'round'>> = [];
    const compactions: ContextCompactionInfo[] = [];
    const requests: unknown[] = [];
    const trace: FitTrace = {
        request: (kind) => requests.push(kind),
        compaction: (info) => compactions.push(info),
        notes: (update) => notes.push(update),
    };
    return { trace, notes, compactions, requests };
}

const small = { acceptsImages: false, contextWindow: 16_000 };
/** The chat's notes (CB-147): at the start of the first message from the person. */
const notesIn = (messages: readonly ModelMessage[]) => {
    const first = messages.find((message) => message.role === 'user');
    const part = Array.isArray(first?.content) ? first.content.find(isNotesPart) : undefined;
    return part?.type === 'text' ? part.content : '';
};
/** The request's facts (CB-139): in the turn's note, in the person's newest message. */
const factsOf = (messages: readonly ModelMessage[]) => {
    const newest = messages.findLast((message) => message.role === 'user');
    const note = Array.isArray(newest?.content) ? newest.content.find(isTurnNote) : undefined;
    return note?.type === 'text' && note.content.includes('[Facts from the notes') ? note.content : undefined;
};

it('writes the notes with the shared model when given one, and traces each update', async () => {
    const { notes } = notesStore();
    const chat = fakeModel();
    const shared = fakeModel({
        summary: () => 'PINNED:\n- Working on: the Q3 churn report\nSUMMARY:\nThe churn work so far.',
    });
    const summarizer: Summarizer = {
        adapter: shared.adapter,
        model: 'qwen-shared',
        modelOptions: { chat_template_kwargs: { enable_thinking: false } },
        capabilities: { acceptsImages: false, contextWindow: 262_144 },
    };
    const log = traceLog();
    await drain(
        fitContext(chat.adapter, {
            capabilities: small,
            key: 'test:shared',
            threadId: 's1',
            notes,
            emit: () => {},
            log: () => {},
            trace: log.trace,
            model: 'chat-model',
            summarizer: async () => summarizer,
        }).chatStream(request([...thread(30), { role: 'user', content: 'Next?' }])),
    );
    // Only the shared model was asked for notes, with its own model and options.
    expect(chat.summaries).toHaveLength(0);
    expect(shared.summaries.length).toBeGreaterThan(0);
    expect(shared.summaries[0]).toMatchObject({
        model: 'qwen-shared',
        modelOptions: { chat_template_kwargs: { enable_thinking: false } },
        tools: [],
    });
    expect(chat.rounds).toHaveLength(1);
    expect(notes.get('s1')!.pinned).toEqual(['Working on: the Q3 churn report']);
    // Each update traced: whose model, its time and tokens, no fallback.
    expect(log.notes).toHaveLength(shared.summaries.length);
    expect(log.notes[0]).toMatchObject({
        by: 'shared',
        model: 'qwen-shared',
        inputTokens: 900,
        outputTokens: 60,
    });
    expect(log.notes[0].turns).toBeGreaterThan(0);
    expect(log.notes[0].endedAt).toBeGreaterThanOrEqual(log.notes[0].startedAt);
    expect(log.notes[0]).not.toHaveProperty('fallback');
    // Each request is marked as the notes', so it is not counted as a round.
    expect(log.requests).toEqual(shared.summaries.map(() => ({ summary: true })));
});

it('writes them with the chat’s model when the shared one is unavailable', async () => {
    const { notes } = notesStore();
    const chat = fakeModel();
    const log = traceLog();
    await drain(
        fitContext(chat.adapter, {
            capabilities: small,
            key: 'test:fallback-chat',
            threadId: 's2',
            notes,
            emit: () => {},
            log: () => {},
            trace: log.trace,
            model: 'chat-model',
            summarizer: async () => undefined,
        }).chatStream(request([...thread(30), { role: 'user', content: 'Next?' }])),
    );
    expect(chat.summaries.length).toBeGreaterThan(0);
    // The chat's own request, with its model options.
    expect(chat.summaries[0]).toMatchObject({
        model: 'chat-model',
        modelOptions: { max_completion_tokens: 4096 },
    });
    expect(log.notes[0]).toMatchObject({ by: 'chat', model: 'chat-model' });
});

it('traces the plain summary kept, and why: a failed request, an empty answer, the turn’s cap', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { notes } = notesStore();
    const chat = fakeModel({
        summary: (_request, count) =>
            count === 1
                ? [
                      { type: 'RUN_STARTED', runId: 'r', threadId: 't' },
                      { type: 'RUN_ERROR', code: 'model_unavailable', message: 'down' },
                  ]
                : count === 2
                  ? 'PINNED:\n- A fact\nSUMMARY:\n'
                  : 'PINNED:\n- Decision: later\nSUMMARY:\nLater.',
    });
    const log = traceLog();
    await drain(
        fitContext(chat.adapter, {
            capabilities: { acceptsImages: false, contextWindow: 8_192 },
            key: 'test:fallbacks',
            threadId: 's3',
            notes,
            emit: () => {},
            log: () => {},
            trace: log.trace,
        }).chatStream(request([...thread(60), { role: 'user', content: 'Next?' }])),
    );
    expect(chat.summaries).toHaveLength(MAX_SUMMARIES_PER_TURN);
    expect(log.notes.map((update) => update.fallback)).toEqual(['error', 'empty', undefined, 'cap']);
    // A request that failed reported no tokens; the cap made no request.
    expect(log.notes[0]).not.toHaveProperty('inputTokens');
    expect(log.notes[3]).not.toHaveProperty('inputTokens');
    expect(log.notes[3].by).toBe('chat');
});

it('keeps every pinned fact in the thread’s store, past the notes’ own cap', async () => {
    const { notes } = notesStore();
    // Each summary pins 30 new facts: the notes keep the newest 80.
    const chat = fakeModel({
        summary: (_request, count) =>
            `PINNED:\n${Array.from({ length: 30 }, (_, index) => `- Result: fact ${count}-${index}`).join('\n')}\nSUMMARY:\nSummary ${count}.`,
    });
    const fit = () =>
        fitContext(chat.adapter, {
            capabilities: small,
            key: 'test:store',
            threadId: 'store-1',
            notes,
            emit: () => {},
            log: () => {},
        });
    await drain(fit().chatStream(request([...thread(30), { role: 'user', content: 'A?' }])));
    await drain(fit().chatStream(request([...thread(70), { role: 'user', content: 'B?' }])));
    const stored = notes.get('store-1')!;
    const facts = notes.facts('store-1').map((fact) => fact.fact);
    expect(chat.summaries.length).toBeGreaterThan(3);
    expect(stored.pinned).toHaveLength(PINNED_MAX);
    expect(facts).toHaveLength(30 * chat.summaries.length);
    expect(facts[0]).toBe('Result: fact 1-0');
    expect(stored.pinned).not.toContain('Result: fact 1-0');
    // A fact pinned again moves to the end, its words kept.
    notes.addFacts('store-1', ['result: FACT 1-0.']);
    expect(notes.facts('store-1').at(-1)!.fact).toBe('Result: fact 1-0');
    expect(notes.facts('store-1')).toHaveLength(facts.length);
    // Notes that start over (a changed history) start the store over too.
    notes.addFacts('store-1', ['Goal: a new start'], true);
    expect(notes.facts('store-1').map((fact) => fact.fact)).toEqual(['Goal: a new start']);
});

it('fills the fact store from notes kept before it (chat migration 2)', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [{ ...chatSchema, migrations: chatSchema.migrations!.slice(0, 1) }]);
    db.prepare("INSERT INTO chat_context_notes VALUES ('old', 3, 'a', 'S', ?, '[]', 1, 5)").run(
        JSON.stringify(['Decision: keep it', 'Working on: Q3', 'decision: keep it.']),
    );
    migrate(db, [chatSchema]);
    const notes = new ContextNotes(db);
    expect(notes.facts('old')).toEqual([
        { seq: 2, fact: 'Working on: Q3' },
        { seq: 3, fact: 'Decision: keep it' },
    ]);
});

it('keeps the core for the pointer selection: working on, goals and the latest decisions', () => {
    const facts = [
        'Working on: the Q2 report',
        'Goal: cut churn 10%',
        ...Array.from({ length: 8 }, (_, index) => `Decision: rule ${index}`),
        'Result: churn 6%',
        'Working on: the Q3 report',
    ];
    expect(coreFacts(facts)).toEqual([
        'Goal: cut churn 10%',
        'Decision: rule 2',
        'Decision: rule 3',
        'Decision: rule 4',
        'Decision: rule 5',
        'Decision: rule 6',
        'Decision: rule 7',
        'Working on: the Q3 report',
    ]);
    // Untyped facts (older notes): the newest few.
    expect(coreFacts(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toEqual(['b', 'c', 'd', 'e', 'f', 'g']);
});

it('carries the facts that match the request when there are too many for the prompt', () => {
    const facts = [
        'Name: the nightly sync is job-4821',
        ...Array.from({ length: 300 }, (_, index) => `Result: segment ${index} moved ${index % 7}% this week`),
    ];
    const notes = {
        summary: 'Work so far.',
        pinned: facts.slice(-80),
        names: [],
    };
    // By age, the oldest fact is gone; by relevance it comes back.
    const age = selectNotes('age', notes, facts, 1_500);
    expect(age.pinned.join('\n')).not.toContain('job-4821');
    expect(age.pinned.at(-1)).toBe(facts.at(-1));
    // Relevance starts with the same notes (CB-139), and adds the facts that
    // match the request and that they leave out.
    expect(selectNotes('relevance', notes, facts, 1_500)).toEqual(age);
    const relevant = relevantNotes(age, notes, facts, 'What is the id of the nightly sync job?', 400);
    expect(relevant.pinned[0]).toBe('Name: the nightly sync is job-4821');
    for (const fact of relevant.pinned) {
        expect(age.pinned).not.toContain(fact);
    }
    expect(relevant.pinned.join('').length).toBeLessThanOrEqual(400 * 4);
    // A model's ranking goes first.
    const ranked = relevantNotes(age, notes, facts, 'Anything?', 400, [5]);
    expect(ranked.pinned[0]).toBe(facts[5]);
    // Nothing matches: no facts.
    expect(relevantNotes(age, notes, facts, 'Hello', 400).pinned).toEqual([]);
    // The pointer: the core and a count of the rest.
    const pointer = selectNotes('pointer', notes, facts, 1_500);
    expect(pointer.pinned).toEqual(coreFacts(facts));
    expect(pointer.stored).toEqual({
        facts: facts.length - pointer.pinned.length,
        names: 0,
    });
});

it('reads a ranking: in range, once each, past a reasoning block', () => {
    const facts = ['a', 'b', 'c'];
    expect(parseRanking('<think>maybe 1</think>3, 1, 3, 9', facts)).toEqual([2, 0]);
    expect(parseRanking('none', facts)).toEqual([]);
});

/** A long thread whose first turn holds the one fact the question needs. */
async function selectionRun(
    selection: 'age' | 'relevance' | 'pointer',
    rankWithModel?: boolean,
    recallTokens?: number,
    asked = 'What is the id of the nightly sync job?',
) {
    const { notes } = notesStore();
    const chat = fakeModel({
        summary: (_request, count) =>
            `PINNED:\n${count === 1 ? '- Name: the nightly sync is job-4821\n' : ''}${Array.from({ length: 40 }, (_, index) => `- Result: step ${count}-${index} looked fine this week`).join('\n')}\nSUMMARY:\nSummary ${count}.`,
        rank: (request) => {
            const text = request.messages[0].content as string;
            const line = text.split('\n').find((entry) => entry.includes('job-4821'))!;
            return line.split('.')[0];
        },
    });
    const log = traceLog();
    const fit = () =>
        fitContext(chat.adapter, {
            capabilities: small,
            key: `test:select-${selection}`,
            threadId: 'sel',
            notes,
            emit: () => {},
            log: () => {},
            trace: log.trace,
            selection,
            rankWithModel,
            recallTokens,
        });
    await drain(fit().chatStream(request([...thread(30), { role: 'user', content: 'A?' }])));
    await drain(fit().chatStream(request([...thread(70), { role: 'user', content: 'B?' }])));
    const question: ModelMessage = { role: 'user', content: asked };
    const turn = fit();
    await drain(turn.chatStream(request([...thread(70), question])));
    // A second round of the same turn.
    await drain(
        turn.chatStream(
            request([
                ...thread(70),
                question,
                {
                    role: 'assistant',
                    content: 'Looking.',
                    toolCalls: [
                        {
                            id: 'live_0',
                            type: 'function',
                            function: { name: 'job_logs', arguments: '{}' },
                        },
                    ],
                },
                { role: 'tool', toolCallId: 'live_0', content: 'ok' },
            ]),
        ),
    );
    return { chat, log, notes };
}

it('relevance: one ranking a turn by the notes’ model, the same notes every round, traced', async () => {
    const { chat, log, notes } = await selectionRun('relevance', true);
    expect(notes.facts('sel').length).toBeGreaterThan(PINNED_MAX);
    expect(notes.get('sel')!.pinned.join('\n')).not.toContain('job-4821');
    const [last, before] = [chat.rounds.at(-1)!, chat.rounds.at(-2)!];
    expect(factsOf(last.messages)).toContain('- Name: the nightly sync is job-4821');
    // The same notes at the start and the same facts every round; the notes
    // leave the old fact to the facts.
    expect(notesIn(last.messages)).toBe(notesIn(before.messages));
    expect(notesIn(last.messages)).not.toContain('job-4821');
    expect(factsOf(last.messages)).toBe(factsOf(before.messages));
    // Ranked once for the question's turn (and once for each earlier turn).
    expect(chat.rankings.length).toBeGreaterThan(0);
    const forQuestion = chat.rankings.filter((ranking) =>
        (ranking.messages[0].content as string).endsWith('What is the id of the nightly sync job?'),
    );
    expect(forQuestion).toHaveLength(1);
    expect(forQuestion[0].tools).toEqual([]);
    expect(log.compactions.at(-1)).toMatchObject({
        selection: 'relevance',
        pinnedStored: notes.facts('sel').length,
    });
    expect(log.compactions.at(-1)!.pinnedShown).toBeLessThan(notes.facts('sel').length);
    expect(log.compactions.at(-1)!.notesTokens).toBeGreaterThan(0);
    expect(log.compactions.at(-1)!.selectMs).toBeGreaterThanOrEqual(0);
});

it('relevance by words alone (the app’s) finds it too, without a request', async () => {
    const { chat } = await selectionRun('relevance');
    expect(chat.rankings).toHaveLength(0);
    expect(factsOf(chat.rounds.at(-1)!.messages)).toContain('job-4821');
});

it('carries more or fewer of the request’s facts with the recall budget (CB-173)', async () => {
    const lines = async (recallTokens?: number) =>
        factsOf(
            (await selectionRun('relevance', false, recallTokens, 'Which step looked fine this week?')).chat.rounds.at(
                -1,
            )!.messages,
        )!
            .split('\n')
            .filter((line) => line.startsWith('- ')).length;
    const usual = await lines();
    expect(await lines(1_000)).toBe(usual);
    expect(await lines(250)).toBeLessThan(usual);
    expect(await lines(4_000)).toBeGreaterThan(usual);
});

it('age leaves the old fact out, as CB-129 did', async () => {
    const { chat, log, notes } = await selectionRun('age');
    expect(chat.rankings).toHaveLength(0);
    const note = notesIn(chat.rounds.at(-1)!.messages);
    expect(note).not.toContain('job-4821');
    expect(log.compactions.at(-1)).toMatchObject({ selection: 'age' });
    // The same notes CB-129 sent, and no facts for the request.
    expect(note).toContain(`- ${notes.get('sel')!.pinned.at(-1)}`);
    expect(factsAt(chat.rounds.at(-1)!.messages)).toBe(-1);
});

it('pointer: a short core and a line for search_notes, which finds the fact', async () => {
    const { chat, notes } = await selectionRun('pointer');
    const note = notesIn(chat.rounds.at(-1)!.messages);
    expect(note).not.toContain('job-4821');
    expect(note).toMatch(/\[\d+ pinned facts and \d+ names, ids and links from earlier are stored: call search_notes/);
    // Only the core: the newest few untyped facts.
    expect(note.match(/^- Result: step/gm)).toHaveLength(6);
    expect(factsAt(chat.rounds.at(-1)!.messages)).toBe(-1);
    const tool = searchNotesTool({ threadId: 'sel', check: () => {} }, notes);
    const found = (await tool.execute!({ query: 'nightly sync job' })) as {
        facts: string[];
        storedFacts: number;
    };
    expect(found.facts[0]).toBe('Name: the nightly sync is job-4821');
    expect(found.storedFacts).toBe(notes.facts('sel').length);
    // Another thread's facts are not found.
    const other = searchNotesTool({ threadId: 'other', check: () => {} }, notes);
    expect(await other.execute!({ query: 'nightly sync job' })).toMatchObject({
        facts: [],
        note: expect.stringContaining('No stored fact'),
    });
});

it('offers search_notes only with the pointer selection', () => {
    const tools = (selection?: 'age' | 'pointer') =>
        chatModule.dotTools!(
            {
                db: notesStore().db,
                services: {
                    get: (tag: unknown) =>
                        new Map<unknown, unknown>([
                            [Runner, { messages: async () => [] }],
                            [ContextConfig, {}],
                            [WorkspaceSettings, { settings: () => (selection ? { context: { selection } } : {}) }],
                        ]).get(tag),
                },
            } as never,
            { threadId: 't', check: () => {} } as never,
        ).map((tool) => tool.name);
    expect(tools()).toEqual(['format_chart', 'recall']);
    expect(tools('age')).toEqual(['format_chart', 'recall']);
    expect(tools('pointer')).toEqual(['format_chart', 'recall', 'search_notes']);
});

it('records notes updates and selections in the run’s trace, and counts the notes’ tokens', async () => {
    const entries: TraceEntry[] = [];
    const tracer = new TurnTracer((entry) => entries.push(entry));
    const { notes } = notesStore();
    const chat = fakeModel();
    const shared = fakeModel();
    const fitted = fitContext(tracer.adapter(chat.adapter), {
        capabilities: small,
        key: 'test:trace',
        threadId: 'tr',
        notes,
        emit: () => {},
        log: () => {},
        trace: tracer.fit,
        selection: 'relevance',
        summarizer: async () => ({
            adapter: tracer.adapter(shared.adapter),
            model: 'qwen-shared',
            modelOptions: {},
            capabilities: { acceptsImages: false, contextWindow: 262_144 },
        }),
    });
    await drain(
        tracer.toolCalls(fitted, new Set()).chatStream(request([...thread(30), { role: 'user', content: 'Next?' }])),
    );
    const recorder = new TraceRecorder();
    for (const entry of entries) {
        recorder.add(JSON.parse(JSON.stringify(entry)));
    }
    const trace = recorder.finish('finished');
    expect(trace.notes!.length).toBe(shared.summaries.length);
    expect(trace.notes![0]).toMatchObject({
        kind: 'notes',
        round: 1,
        by: 'shared',
        model: 'qwen-shared',
        inputTokens: 900,
        outputTokens: 60,
    });
    expect(trace.compactions![0]).toMatchObject({
        selection: 'relevance',
        pinnedShown: shared.summaries.length,
        pinnedStored: shared.summaries.length,
    });
    // The shared model's requests are the round's notes' requests, and their
    // tokens count in the run's.
    const notesRounds = trace.rounds.filter((round) => round.summary);
    expect(notesRounds).toHaveLength(shared.summaries.length);
    expect(trace.totals).toMatchObject({
        rounds: 1,
        inputTokens: 900 * shared.summaries.length,
        outputTokens: 60 * shared.summaries.length,
    });
    // An entry that isn't one is dropped.
    recorder.add({
        kind: 'notes',
        round: 1,
        by: 'someone',
        startedAt: 1,
        endedAt: 2,
        turns: 1,
    });
    expect(recorder.trace.notes).toHaveLength(shared.summaries.length);
});

it('runs a Dot turn with the shared model writing the notes, as the settings say', async () => {
    const workspace = new WorkspaceStore(testDatabase());
    const store = new Store(testDatabase());
    const runner = new LocalAgentRunner(testDatabase());
    cleanup.push(
        () => workspace.close(),
        () => store.close(),
        () => runner.close(),
    );
    const inference = new InferenceService(workspace.db, {
        secret: 'context-test-secret-0123456789abcdef',
        log: () => {},
    });
    await inference.createBackend({
        label: 'Homelab',
        baseUrl: 'http://orion.invalid/v1',
        model: 'qwen',
        contextWindow: 8_192,
        titleModelOptions: { chat_template_kwargs: { enable_thinking: false } },
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const bodies: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        bodies.push(body);
        return JSON.stringify(body).includes('running notes')
            ? completion(
                  {
                      role: 'assistant',
                      content: 'PINNED:\n- Working on: the queries\nSUMMARY:\nQueries.',
                  },
                  'stop',
                  { prompt_tokens: 700, completion_tokens: 40, total_tokens: 740 },
              )
            : completion({ role: 'assistant', content: 'All caught up.' });
    });
    const dot = workspace.dots()[0];
    const config: PlatformConfig = {
        baseUrl: '',
        apiKey: '',
        model: '',
        voiceName: 'marin',
        runtimeUrl: '',
        sessionSecret: 'context-test-secret-0123456789abcdef',
    };
    const history: Message[] = [];
    for (let index = 0; index < 16; index++) {
        history.push(
            { id: `u${index}`, role: 'user', content: `Question ${index}.` },
            {
                id: `a${index}`,
                role: 'assistant',
                content: '',
                toolCalls: [
                    {
                        id: `c${index}`,
                        type: 'function',
                        function: { name: 'data_query', arguments: '{}' },
                    },
                ],
            },
            {
                id: `r${index}`,
                role: 'tool',
                toolCallId: `c${index}`,
                content: data(12_000, index),
            },
            {
                id: `b${index}`,
                role: 'assistant',
                content: `Answer ${index}. `.padEnd(2_500, 'z'),
            },
        );
    }
    const turn = async (threadId: string) => {
        workspace.bindThread(threadId, dot.id, 'Long', 'bob');
        const agent = new DotAgent(store, workspace, config, dot.id, false, undefined, {
            inference,
            textOnly: true,
        });
        const input: RunAgentInput = {
            threadId,
            runId: `run-${threadId}`,
            state: {},
            context: [],
            messages: [...history, { id: 'u-last', role: 'user', content: 'And now?' }],
            tools: [],
            forwardedProps: {},
        };
        agent.threadId = threadId;
        agent.setMessages(input.messages);
        const events = await lastValueFrom(runner.run({ threadId, agent, input }).pipe(toArray()));
        expect(events.at(-1)?.type).toBe('RUN_FINISHED');
        expect(events.some((event) => (event as { name?: string }).name === CONTEXT_COMPACTION_EVENT)).toBe(true);
        return runner.runTrace(`run-${threadId}`)!.trace!;
    };
    // The default: the shared model, with its one-shot options.
    const shared = await turn('t-shared');
    const summary = bodies.find((body) => JSON.stringify(body).includes('running notes'))!;
    expect(summary).toMatchObject({
        model: 'qwen',
        chat_template_kwargs: { enable_thinking: false },
    });
    expect(shared.notes![0]).toMatchObject({ by: 'shared', model: 'qwen' });
    expect(shared.totals!.inputTokens).toBeGreaterThanOrEqual(700);
    // An admin's choice: the chat's own model, with the chat's options.
    bodies.length = 0;
    await store.updateSettings({
        context: { summaryModel: 'chat', selection: 'age' },
    });
    const own = await turn('t-own');
    const ownSummary = bodies.find((body) => JSON.stringify(body).includes('running notes'))!;
    expect(ownSummary).not.toHaveProperty('chat_template_kwargs');
    expect(own.notes![0]).toMatchObject({ by: 'chat', model: 'qwen' });
});

// CB-139: the prompt's start stays the same from turn to turn and round to
// round, for a model's prefix cache; the request's facts come last.

/** Where a prompt's facts are: the person's newest message (-1: none). */
const factsAt = (messages: readonly ModelMessage[]) =>
    factsOf(messages) ? messages.findLastIndex((message) => message.role === 'user') : -1;
/** A round's prompt as sent, its first `count` messages only. */
const serialized = (round: TextOptions, count?: number) =>
    JSON.stringify({
        systemPrompts: round.systemPrompts,
        tools: round.tools,
        messages: round.messages.slice(0, count),
    });

/** A thread with notes on a 64k window, whose early facts the notes give up. */
function prefixRun() {
    const { notes } = notesStore();
    const chat = fakeModel({
        summary: (_request, count) =>
            `PINNED:\n${count === 1 ? '- Name: the nightly sync is job-4821\n- Decision: churn uses dataset ds_churn_q3_v2\n' : ''}${Array.from({ length: 40 }, (_, index) => `- Result: step ${count}-${index} looked fine this week`).join('\n')}\nSUMMARY:\nSummary ${count}.`,
        // The model's prompt sizes move the calibration from turn to turn.
        usage: (count, request) => ({
            promptTokens: Math.round(messagesTokens(request.messages) * (1.05 + 0.1 * (count % 3))),
        }),
    });
    const fit = () =>
        fitContext(chat.adapter, {
            capabilities: { acceptsImages: false, contextWindow: 64_000 },
            key: 'test:prefix',
            threadId: 'prefix',
            notes,
            emit: () => {},
            log: () => {},
            selection: 'relevance',
        });
    return { chat, notes, fit };
}

const ask = (content: string): ModelMessage => ({ role: 'user', content });
const said = (content: string): ModelMessage => ({
    role: 'assistant',
    content,
});

it('keeps the prompt’s start byte for byte from turn to turn, the request’s facts last, until a fold', async () => {
    const { chat, notes, fit } = prefixRun();
    // Turns that fold: the notes give up their first facts.
    await drain(fit().chatStream(request([...thread(60), ask('A?')])));
    await drain(fit().chatStream(request([...thread(150), ask('B?')])));
    expect(notes.get('prefix')!.pinned.join('\n')).not.toContain('job-4821');
    const folds = chat.summaries.length;
    const updates = notes.get('prefix')!.updates;

    const job = ask('What is the id of the nightly sync job?');
    const churn = ask('Which dataset does churn use?');
    const history = thread(150);
    await drain(fit().chatStream(request([...history, job])));
    await drain(fit().chatStream(request([...history, job, said('It is job-4821.'), churn])));
    const [first, second] = chat.rounds.slice(-2);
    // No fold between them.
    expect(chat.summaries).toHaveLength(folds);
    expect(notes.get('prefix')!.updates).toBe(updates);
    // The system prompt, the notes and the older turns, as sent, are the same.
    const at = factsAt(first.messages);
    expect(at).toBe(first.messages.length - 1);
    expect(serialized(second, at)).toBe(serialized(first, at));
    // The facts are each turn's own, just before the person's message.
    const facts = factsOf(first.messages)!;
    const next = factsOf(second.messages)!;
    expect(factsAt(second.messages)).toBe(second.messages.length - 1);
    expect(facts).toContain('- Name: the nightly sync is job-4821');
    expect(next).toContain('- Decision: churn uses dataset ds_churn_q3_v2');
    expect(next).not.toBe(facts);
    expect(notesIn(first.messages)).toMatch(/^\[Notes on the earlier part/);
    expect(notesIn(first.messages)).not.toContain('job-4821');

    // Many turns later a fold changes the notes, once; then they hold again.
    const later = thread(260);
    await drain(fit().chatStream(request([...later, job])));
    expect(chat.summaries.length).toBeGreaterThan(folds);
    const third = chat.rounds.at(-1)!;
    expect(notesIn(third.messages)).not.toBe(notesIn(first.messages));
    const refolds = chat.summaries.length;
    await drain(fit().chatStream(request([...later, job, said('job-4821.'), churn])));
    const fourth = chat.rounds.at(-1)!;
    expect(chat.summaries).toHaveLength(refolds);
    const again = factsAt(third.messages);
    expect(again).toBeGreaterThan(0);
    expect(serialized(fourth, again)).toBe(serialized(third, again));
});

it('keeps the prompt before a turn’s later rounds the same, the facts where they were', async () => {
    const { chat, fit } = prefixRun();
    await drain(fit().chatStream(request([...thread(60), ask('A?')])));
    await drain(fit().chatStream(request([...thread(150), ask('B?')])));
    const job = ask('What is the id of the nightly sync job?');
    const history = [...thread(150), job];
    /** The turn's own tool rounds, small results. */
    const rounds = (count: number) =>
        Array.from({ length: count }, (_, index): ModelMessage[] => [
            {
                role: 'assistant',
                content: null,
                toolCalls: [
                    {
                        id: `live_${index}`,
                        type: 'function',
                        function: { name: 'job_logs', arguments: '{}' },
                    },
                ],
            },
            { role: 'tool', toolCallId: `live_${index}`, content: `ok ${index}` },
        ]).flat();
    const turn = fit();
    for (let count = 0; count < 4; count++) {
        await drain(turn.chatStream(request([...history, ...rounds(count)])));
    }
    const sent = chat.rounds.slice(-4);
    const at = factsAt(sent[0].messages);
    expect(at).toBeGreaterThan(0);
    for (let index = 1; index < sent.length; index++) {
        // Each round's prompt is the one before it, with its new round after.
        expect(factsAt(sent[index].messages)).toBe(at);
        expect(serialized(sent[index], sent[index - 1].messages.length)).toBe(serialized(sent[index - 1]));
    }
});
