import type { Message, RunAgentInput } from '@ag-ui/core';
import type { AnyTextAdapter, ModelMessage, TextOptions } from '@tanstack/ai';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { contextBudget, fittedChars } from '@socio/foundation/context/budget';
import { isNotesPart } from '@socio/foundation/context/turn-note';
import { ChatGptError } from '@socio/foundation/inference/chatgpt-errors';
import {
    CONTEXT_COMPACTION_EVENT,
    RUN_TIDYING_EVENT,
    nextPhase,
    phaseText,
    startPhase,
    type ContextCompactionInfo,
} from '@socio/shared/runs/run-phase';

import type { PlatformConfig } from '../src/server/composition/config.js';
import { fixedTokens, messagesTokens, resetCalibration } from '../src/server/context/budget.js';
import { compactMessages, excerptNote, levels } from '../src/server/context/compact.js';
import { MAX_SUMMARIES_PER_TURN, fitContext, isOverLength } from '../src/server/context/fit.js';
import { ContextNotes, SUMMARY_PROMPT, mergeNames, mergePinned, turnAnchor } from '../src/server/context/notes.js';
import { recallTool, rememberOriginals } from '../src/server/context/recall.js';
import { chatGptCapabilities } from '../src/server/inference/chatgpt/adapter.js';
import { responsesHttpError, responsesStreamError } from '../src/server/inference/chatgpt/errors.js';
import { InferenceService } from '../src/server/inference/service.js';

import { LONG_THREAD_SHAPE } from './fixtures/long-thread-shape.js';
import { completion } from './fixtures/model-stream.js';
import { DotAgent } from './helpers/dot-agent.js';
import { LocalAgentRunner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

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

/** Characters of filler that read like a data result. */
const data = (chars: number, seed = 0) => {
    const row = `{"id":${seed},"name":"row ${seed}","value":${seed * 7}},`;
    return `[${row.repeat(Math.ceil(chars / row.length))}`.slice(0, chars);
};

/** A turn: the person's message, tool rounds, and the answer. */
function turn(
    index: number,
    user: string,
    calls: Array<[tool: string, args: string, result: string]>,
    answer: string,
): ModelMessage[] {
    const messages: ModelMessage[] = [{ role: 'user', content: user }];
    calls.forEach(([tool, args, result], call) => {
        const id = `call_${index}_${call}`;
        messages.push(
            {
                role: 'assistant',
                content: null,
                toolCalls: [{ id, type: 'function', function: { name: tool, arguments: args } }],
            },
            { role: 'tool', toolCallId: id, content: result },
        );
    });
    if (answer) {
        messages.push({ role: 'assistant', content: answer });
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

/**
 * A scripted model: summary requests get `summary`, rounds get `round`
 * (by how many rounds it has answered). Records every request.
 */
function fakeModel(options: {
    summary?: (request: TextOptions) => string;
    round?: (count: number, request: TextOptions) => Chunk[];
}) {
    const rounds: TextOptions[] = [];
    const summaries: TextOptions[] = [];
    const adapter = {
        name: 'fake',
        chatStream: async function* (request: TextOptions) {
            if (request.systemPrompts?.[0] === SUMMARY_PROMPT) {
                summaries.push(request);
                yield* answer(
                    options.summary?.(request) ??
                        'PINNED:\n- Working on: the CRM marketplace dashboard\nSUMMARY:\nThe person and the Dot built a dashboard of CRM installs.',
                );
                return;
            }
            rounds.push(request);
            yield* options.round?.(rounds.length, request) ?? answer('Done.');
        },
    } as unknown as AnyTextAdapter;
    return { adapter, rounds, summaries };
}

const request = (messages: ModelMessage[]): TextOptions =>
    ({
        model: 'fake-model',
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

/** The person's messages' text, without the chat's notes (CB-147). */
const userTexts = (messages: readonly ModelMessage[]) =>
    messages
        .filter((message) => message.role === 'user')
        .map((message) =>
            Array.isArray(message.content)
                ? message.content
                      .flatMap((part) => (part.type === 'text' && !isNotesPart(part) ? [part.content] : []))
                      .join('\n')
                : (message.content as string),
        );

/** The chat's notes in a prompt: in its first message from the person. */
const notesIn = (messages: readonly ModelMessage[]) => {
    const first = messages.find((message) => message.role === 'user');
    const part = Array.isArray(first?.content) ? first.content.find(isNotesPart) : undefined;
    return part?.type === 'text' ? part.content : undefined;
};

it('fits a 400k-token thread of huge tool results under budget, keeping recent turns and pinned facts word for word', async () => {
    const { notes } = notesStore();
    const messages: ModelMessage[] = [];
    messages.push(
        ...turn(
            0,
            'Build the dashboard from dataset ghl_installs, saved as reports/crm-dashboard.html. Source: https://marketplace.example.test/apps?sort=installs',
            [['data_query', '{"sql":"SELECT * FROM ghl_installs"}', data(80_000)]],
            'I read 2,400 installs.',
        ),
    );
    for (let index = 1; index < 40; index++) {
        messages.push(
            ...turn(
                index,
                `Step ${index}: refine the chart for segment ${index}.`,
                [
                    ['data_query', `{"sql":"SELECT ${index}"}`, data(40_000, index)],
                    ['computer_screenshot', '{}', 'iVBOR' + 'A'.repeat(20_000)],
                ],
                `Refined segment ${index}.`,
            ),
        );
    }
    messages.push({ role: 'user', content: 'What changed since yesterday?' });
    const before = messagesTokens(messages);
    expect(before).toBeGreaterThan(400_000);

    const capabilities = { acceptsImages: false, contextWindow: 16_000 };
    const { target } = contextBudget(capabilities);
    const model = fakeModel({});
    const emitted: Array<{ name?: string; value?: unknown }> = [];
    const fitted = fitContext(model.adapter, {
        capabilities,
        key: 'test:fit',
        threadId: 't1',
        notes,
        emit: (event) => emitted.push(event as never),
        log: () => {},
    });
    const chunks = await drain(fitted.chatStream(request(messages)));
    expect(chunks.map((chunk) => chunk.type)).toContain('RUN_FINISHED');

    const sent = model.rounds[0];
    const prompt = messagesTokens(sent.messages) + fixedTokens(sent.systemPrompts ?? [], []);
    expect(prompt).toBeLessThanOrEqual(target);
    // The latest turns' messages, word for word.
    const users = userTexts(sent.messages);
    expect(users.slice(-3)).toEqual([
        'Step 38: refine the chart for segment 38.',
        'Step 39: refine the chart for segment 39.',
        'What changed since yesterday?',
    ]);
    // The notes come first, with the pinned facts word for word, in the
    // first kept message from the person: the roles still take turns.
    const note = notesIn(sent.messages)!;
    expect(sent.messages[0].role).toBe('user');
    expect(sent.messages[0].content).toEqual([
        expect.objectContaining({ content: note }),
        { type: 'text', content: users[0] },
    ]);
    expect(note).toMatch(/^\[Notes on the earlier part of this conversation/);
    expect(note).toContain('- Working on: the CRM marketplace dashboard');
    expect(note).toContain('https://marketplace.example.test/apps?sort=installs');
    expect(note).toContain('reports/crm-dashboard.html');
    expect(note).toContain('ghl_installs');
    // One compaction event: sizes and counts only.
    const compaction = emitted.filter((event) => event.name === CONTEXT_COMPACTION_EVENT);
    expect(compaction).toHaveLength(1);
    const info = compaction[0].value as ContextCompactionInfo;
    expect(info).toMatchObject({ window: 16_000, retried: 0 });
    expect(info.beforeTokens).toBeGreaterThan(400_000);
    expect(info.afterTokens).toBeLessThanOrEqual(target);
    expect(info.stubbed).toBeGreaterThan(0);
    expect(info.summarised).toBeGreaterThan(0);
    // The phase line said so first.
    expect(emitted[0]).toMatchObject({ name: RUN_TIDYING_EVENT });
});

it('counts the prompt as it is sent, its merged messages too (CB-147)', async () => {
    const { notes } = notesStore();
    const model = fakeModel({});
    const emitted: Array<{ name?: string; value?: unknown }> = [];
    await drain(
        fitContext(model.adapter, {
            capabilities: { acceptsImages: false, contextWindow: 16_000 },
            key: 'test:recount',
            threadId: 'recount-1',
            notes,
            emit: (event) => emitted.push(event as never),
            log: () => {},
        }).chatStream(
            request([
                ...turn(0, 'Query it.', [['data_query', '{}', data(66_000, 1)]], 'Ok.'),
                // A failed turn: two messages from the person in a row, sent as one.
                { role: 'user', content: 'And the totals?' },
                { role: 'user', content: 'Hello?' },
            ]),
        ),
    );
    const sent = model.rounds[0];
    expect(sent.messages.filter((message) => message.role === 'user')).toHaveLength(2);
    const info = emitted.find((event) => event.name === CONTEXT_COMPACTION_EVENT)!.value as ContextCompactionInfo;
    expect(info.stubbed).toBe(1);
    expect(info.afterTokens).toBe(messagesTokens(sent.messages) + fixedTokens(sent.systemPrompts ?? [], []));
});

it('cuts big results to a head-and-tail excerpt with a ref, and recall returns the full original', async () => {
    const original = data(66_000, 3);
    const messages = turn(0, 'Query it.', [['data_query', '{"sql":"SELECT 1"}', original]], '');
    const [level] = levels(20_000);
    const compacted = compactMessages(messages, level, 100_000);
    const cut = compacted.messages[2].content as string;
    expect(cut.startsWith(excerptNote('data_query', 66_000, 'call_0_0'))).toBe(true);
    expect(cut).toContain('[data_query result, 66k chars; excerpt shown; call recall with ref call_0_0 for the rest]');
    expect(cut.length).toBeLessThan(original.length / 5);
    // The original messages are untouched.
    expect(messages[2].content).toBe(original);

    // From the stored conversation (AG-UI messages, as the runner rebuilds them).
    const stored: Message[] = [
        { id: 'u1', role: 'user', content: 'Query the installs table.' },
        {
            id: 'a1',
            role: 'assistant',
            content: '',
            toolCalls: [
                {
                    id: 'call_0_0',
                    type: 'function',
                    function: { name: 'data_query', arguments: '{"sql":"SELECT 1"}' },
                },
            ],
        },
        { id: 'r1', role: 'tool', toolCallId: 'call_0_0', content: original },
    ];
    const tool = recallTool({ threadId: 'recall-1', check: () => {} }, async () => stored);
    rememberOriginals('recall-1', new Map(), 20_000);
    let text = '';
    let offset: number | undefined = 0;
    while (offset !== undefined) {
        const page = (await tool.execute!({ ref: 'call_0_0', offset })) as {
            text: string;
            totalChars: number;
            nextOffset?: number;
        };
        expect(page.totalChars).toBe(66_000);
        expect(page.text.length).toBeLessThanOrEqual(20_000);
        text += page.text;
        offset = page.nextOffset;
    }
    expect(text).toBe(original);
    // Arguments, and a search over older messages.
    expect(await tool.execute!({ ref: 'call_0_0:args' })).toMatchObject({
        text: '{"sql":"SELECT 1"}',
    });
    const found = (await tool.execute!({ query: 'installs' })) as {
        hits: Array<{ ref: string; from: string }>;
    };
    expect(found.hits[0]).toMatchObject({ ref: 'message:u1', from: 'person' });

    // A result of the turn in progress is not stored yet: compaction hands it over.
    rememberOriginals('recall-1', new Map([['call_live', { tool: 'job_logs', text: 'live output' }]]), 20_000);
    expect(await tool.execute!({ ref: 'call_live' })).toMatchObject({
        from: 'job_logs result',
        text: 'live output',
    });
});

it('sets aside old results, screenshots first, before folding turns', () => {
    const messages = [
        ...turn(0, 'One.', [['computer_screenshot', '{}', 'A'.repeat(30_000)]], ''),
        ...turn(1, 'Two.', [['data_query', '{}', data(9_000)]], ''),
        ...turn(2, 'Three.', [['data_query', '{}', data(9_000, 2)]], 'Ok.'),
    ];
    const level = { capTokens: 10_000, keepRounds: 1, keepTurns: 1 };
    // Room for everything but the screenshot.
    const compacted = compactMessages(messages, level, 7_000);
    expect(compacted.tokens).toBeLessThanOrEqual(7_000);
    expect(compacted.messages[2].content).toMatch(/^\[computer_screenshot result, 30k chars, set aside/);
    expect(compacted.messages[5].content).toBe(messages[5].content);
    expect(compacted.messages[8].content).toBe(messages[8].content);
    expect(compacted.stubbed).toBe(1);
    // The same input gives the same prompt.
    expect(compactMessages(messages, level, 7_000).messages).toEqual(compacted.messages);
});

it('updates the running notes incrementally and keeps them across turns', async () => {
    const { notes } = notesStore();
    const capabilities = { acceptsImages: false, contextWindow: 16_000 };
    const history: ModelMessage[] = [];
    for (let index = 0; index < 30; index++) {
        history.push(
            ...turn(
                index,
                `Turn ${index}: check the job ${index === 0 ? 'nightly-crm-sync' : `step-${index}`}.`,
                [['job_logs', `{"jobId":"job-${index}"}`, data(6_000, index)]],
                `Checked ${index}. `.padEnd(1_500, 'z'),
            ),
        );
    }
    const summaries: string[] = [];
    const model = fakeModel({
        summary: (request) => {
            const text = request.messages[0].content as string;
            summaries.push(text);
            return `PINNED:\n- Working on: the nightly sync\nSUMMARY:\nSummary ${summaries.length}.`;
        },
    });
    const fit = () =>
        fitContext(model.adapter, {
            capabilities,
            key: 'test:notes',
            threadId: 'notes-1',
            notes,
            emit: () => {},
            log: () => {},
        });
    await drain(fit().chatStream(request([...history, { role: 'user', content: 'Next?' }])));
    const first = notes.get('notes-1')!;
    expect(first.turns).toBeGreaterThan(0);
    expect(first.summary).toBe(`Summary ${summaries.length}.`);
    expect(first.pinned).toEqual(['Working on: the nightly sync']);
    expect(first.names).toContain('jobId: job-0');
    expect(summaries[0]).toContain('Current notes:\n(none yet)');
    expect(summaries[0]).toContain('Turn 0: check the job nightly-crm-sync.');
    const calls = summaries.length;

    // The next turn, a new agent: the stored notes are used as they are.
    await drain(
        fit().chatStream(
            request([
                ...history,
                { role: 'user', content: 'Next?' },
                { role: 'assistant', content: 'Nothing new.' },
                { role: 'user', content: 'And now?' },
            ]),
        ),
    );
    expect(summaries).toHaveLength(calls);

    // Many turns later: only the new turns are summarized, onto the notes.
    const later = [...history];
    for (let index = 30; index < 70; index++) {
        later.push(
            ...turn(
                index,
                `Turn ${index}: check step-${index}.`,
                [['job_logs', `{"jobId":"job-${index}"}`, data(6_000, index)]],
                `Checked ${index}. `.padEnd(1_500, 'z'),
            ),
        );
    }
    await drain(fit().chatStream(request([...later, { role: 'user', content: 'Done?' }])));
    const update = summaries[calls];
    expect(update).toContain(`Summary ${calls}.`);
    expect(update).not.toContain('Turn 0: check the job nightly-crm-sync.');
    expect(update).toContain(`Turn ${first.turns}:`);
    const second = notes.get('notes-1')!;
    expect(second.turns).toBeGreaterThan(first.turns);
    expect(second.updates).toBeGreaterThan(first.updates);
    // Names found earlier stay pinned.
    expect(second.names).toContain('jobId: job-0');
});

it('keeps earlier pinned facts word for word when a later summary leaves them out', async () => {
    const { notes } = notesStore();
    const capabilities = { acceptsImages: false, contextWindow: 16_000 };
    const thread = (count: number) => {
        const messages: ModelMessage[] = [];
        for (let index = 0; index < count; index++) {
            messages.push(
                ...turn(
                    index,
                    `Turn ${index}: chart step ${index}.`,
                    [['data_query', `{"sql":"SELECT ${index}"}`, data(6_000, index)]],
                    `Charted ${index}. `.padEnd(1_500, 'z'),
                ),
            );
        }
        return messages;
    };
    // Each summary pins one fact of its own and repeats none of the earlier.
    const facts = [
        'Decision: never email clients on Sundays',
        'Working on: the Q3 chart',
        'Prefers: bar charts over pies',
        'Conclusion: churn peaks in week 2',
    ];
    let calls = 0;
    const model = fakeModel({
        summary: () => `PINNED:\n- ${facts[Math.min(calls++, facts.length - 1)]}\nSUMMARY:\nSummary ${calls}.`,
    });
    const fit = () =>
        fitContext(model.adapter, {
            capabilities,
            key: 'test:pinned',
            threadId: 'pinned-1',
            notes,
            emit: () => {},
            log: () => {},
        });
    await drain(fit().chatStream(request([...thread(30), { role: 'user', content: 'Next?' }])));
    await drain(fit().chatStream(request([...thread(70), { role: 'user', content: 'Done?' }])));
    expect(calls).toBeGreaterThan(1);
    const stored = notes.get('pinned-1')!;
    expect(stored.pinned).toEqual(facts.slice(0, Math.min(calls, facts.length)));
    // And the prompt shows them all, word for word.
    const note = notesIn(model.rounds.at(-1)!.messages);
    expect(note).toContain('- Decision: never email clients on Sundays');
    expect(note).toContain('- Working on: the Q3 chart');
});

it('merges pinned facts and names: repeats move up, the newest stay at the cap', () => {
    expect(mergePinned(['Decision: weekly reports', 'Working on: Q2'], ['working on: q2.', 'Working on: Q3'])).toEqual([
        'Decision: weekly reports',
        'Working on: Q2',
        'Working on: Q3',
    ]);
    expect(mergePinned(['A fact', 'B fact'], ['A fact', 'C fact'], 2)).toEqual(['A fact', 'C fact']);
    // Bare snake_case words give way first: an early link stays.
    const names = mergeNames(
        ['https://example.test/app', 'dataset: ghl_installs'],
        Array.from({ length: 500 }, (_, index) => `col_${index}`),
    );
    expect(names).toHaveLength(400);
    expect(names).toContain('https://example.test/app');
    expect(names).toContain('dataset: ghl_installs');
    expect(names).toContain('col_499');
    expect(names).not.toContain('col_0');
});

it('folds a long thread on a small window with a few summaries at most', async () => {
    const { notes } = notesStore();
    const history: ModelMessage[] = [];
    for (let index = 0; index < 60; index++) {
        history.push(
            ...turn(
                index,
                `Turn ${index}: look at https://example.test/item-${index}`,
                [['data_query', '{}', data(8_000, index)]],
                `Looked at ${index}. `.padEnd(2_000, 'z'),
            ),
        );
    }
    const model = fakeModel({});
    const chunks = await drain(
        fitContext(model.adapter, {
            capabilities: { acceptsImages: false, contextWindow: 8_192 },
            key: 'test:few-summaries',
            threadId: 'few-1',
            notes,
            emit: () => {},
            log: () => {},
        }).chatStream(request([...history, { role: 'user', content: 'Next?' }])),
    );
    expect(chunks.map((chunk) => chunk.type)).not.toContain('RUN_ERROR');
    expect(model.summaries.length).toBeLessThanOrEqual(MAX_SUMMARIES_PER_TURN);
    const stored = notes.get('few-1')!;
    expect(stored.turns).toBeGreaterThan(50);
    expect(stored.pinned).toEqual(['Working on: the CRM marketplace dashboard']);
    // Turns past the summaries are noted from the turns themselves.
    expect(stored.summary).toContain('- The person asked: Turn ');
    expect(stored.names).toContain('https://example.test/item-0');
});

it('keeps the notes when an image in the last folded turn ages into a note', () => {
    const withImage: ModelMessage[] = [
        {
            role: 'user',
            content: [
                { type: 'text', content: 'What is in this photo?' },
                {
                    type: 'image',
                    source: { type: 'url', value: 'https://example.test/a.png' },
                },
            ] as never,
        },
    ];
    const aged: ModelMessage[] = [
        {
            role: 'user',
            content: [
                { type: 'text', content: 'What is in this photo?' },
                {
                    type: 'text',
                    content:
                        '[The user attached an image earlier; only the most recent images are shown to the model.]',
                },
            ] as never,
        },
    ];
    expect(turnAnchor(aged, 0)).toBe(turnAnchor(withImage, 0));
    expect(turnAnchor([{ role: 'user', content: 'What is in this file?' }], 0)).not.toBe(turnAnchor(withImage, 0));
});

it('cuts a huge pasted message as a last resort, and recall returns it whole', async () => {
    const { notes } = notesStore();
    const paste = `Here is the export:\n${data(200_000, 9)}\nWhat stands out?`;
    const model = fakeModel({});
    const fitted = fitContext(model.adapter, {
        capabilities: { acceptsImages: false, contextWindow: 16_000 },
        key: 'test:paste',
        threadId: 'paste-1',
        notes,
        emit: () => {},
        log: () => {},
    });
    const chunks = await drain(
        fitted.chatStream(request([...turn(0, 'Hi.', [], 'Hello.'), { role: 'user', content: paste }])),
    );
    expect(chunks.map((chunk) => chunk.type)).not.toContain('RUN_ERROR');
    expect(model.rounds).toHaveLength(1);
    const sent = model.rounds[0];
    expect(messagesTokens(sent.messages) + fixedTokens(sent.systemPrompts ?? [], [])).toBeLessThanOrEqual(
        contextBudget({ acceptsImages: false, contextWindow: 16_000 }).target,
    );
    const cut = userTexts(sent.messages).at(-1)!;
    const ref = /call recall with ref (message:paste-\S+) for the rest/.exec(cut)?.[1];
    expect(ref).toBeDefined();
    expect(cut).toContain('Here is the export:');
    expect(cut).toContain('What stands out?');
    const tool = recallTool({ threadId: 'paste-1', check: () => {} }, async () => []);
    let text = '';
    let offset: number | undefined = 0;
    while (offset !== undefined) {
        const page = (await tool.execute!({ ref, offset })) as {
            text: string;
            from: string;
            nextOffset?: number;
        };
        expect(page.from).toBe('person');
        text += page.text;
        offset = page.nextOffset;
    }
    expect(text).toBe(paste);
});

it('times the first round by the fitted prompt, not the whole history', () => {
    const capabilities = { acceptsImages: false, contextWindow: 272_000 };
    expect(fittedChars(capabilities, 1_200_000)).toBe(contextBudget(capabilities).target * 4);
    expect(fittedChars(capabilities, 50_000)).toBe(50_000);
});

it('keeps the notes when the summarizer fails, from the turns themselves', async () => {
    const { notes } = notesStore();
    const history: ModelMessage[] = [];
    for (let index = 0; index < 30; index++) {
        history.push(
            ...turn(
                index,
                `Turn ${index}: read https://example.test/page-${index}`,
                [['http_get', '{}', data(8_000, index)]],
                `Read page ${index}. `.padEnd(2_000, 'z'),
            ),
        );
    }
    const adapter = {
        name: 'fake',
        chatStream: async function* (request: TextOptions) {
            if (request.systemPrompts?.[0] === SUMMARY_PROMPT) {
                yield { type: 'RUN_STARTED' };
                yield { type: 'RUN_ERROR', message: 'busy', code: '503' };
                return;
            }
            yield* answer('Fine.');
        },
    } as unknown as AnyTextAdapter;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const chunks = await drain(
        fitContext(adapter, {
            capabilities: { acceptsImages: false, contextWindow: 16_000 },
            key: 'test:fallback',
            threadId: 'fallback-1',
            notes,
            emit: () => {},
            log: () => {},
        }).chatStream(request([...history, { role: 'user', content: 'Next?' }])),
    );
    expect(chunks.map((chunk) => chunk.type)).not.toContain('RUN_ERROR');
    const stored = notes.get('fallback-1')!;
    expect(stored.summary).toContain('- The person asked: Turn 0: read https://example.test/page-0');
    expect(stored.names).toContain('https://example.test/page-0');
});

it('compacts harder and retries when the model refuses the prompt as too long, then answers', async () => {
    const { notes } = notesStore();
    const history: ModelMessage[] = [];
    for (let index = 0; index < 8; index++) {
        history.push(...turn(index, `Turn ${index}.`, [['data_query', '{}', data(3_000, index)]], `Answer ${index}.`));
    }
    const sizes: number[] = [];
    const model = fakeModel({
        round: (count, request) => {
            sizes.push(messagesTokens(request.messages));
            return count === 1
                ? [
                      { type: 'RUN_STARTED' },
                      {
                          type: 'RUN_ERROR',
                          message: "400 This model's maximum context length is 8192 tokens.",
                          code: 'context_length_exceeded',
                      },
                  ]
                : answer('Here it is.', { promptTokens: 3_000 });
        },
    });
    const emitted: Array<{ name?: string; value?: unknown }> = [];
    const lines: string[] = [];
    const chunks = await drain(
        fitContext(model.adapter, {
            capabilities: { acceptsImages: false, contextWindow: 64_000 },
            key: 'test:retry',
            threadId: 'retry-1',
            notes,
            emit: (event) => emitted.push(event as never),
            log: (line) => lines.push(line),
        }).chatStream(request([...history, { role: 'user', content: 'Now?' }])),
    );
    expect(chunks.map((chunk) => chunk.type)).toEqual([
        'RUN_STARTED',
        'TEXT_MESSAGE_START',
        'TEXT_MESSAGE_CONTENT',
        'TEXT_MESSAGE_END',
        'RUN_FINISHED',
    ]);
    expect(model.rounds).toHaveLength(2);
    expect(sizes[1]).toBeLessThan(sizes[0]);
    expect(
        emitted
            .filter((event) => event.name === CONTEXT_COMPACTION_EVENT)
            .map((event) => (event.value as ContextCompactionInfo).retried),
    ).toEqual([1]);
    expect(lines[0]).toMatch(/refused a \d+-token prompt as too long/);
});

it('gives up after two harder retries, passing the refusal on', async () => {
    const { notes } = notesStore();
    const model = fakeModel({
        round: () => [
            { type: 'RUN_STARTED' },
            {
                type: 'RUN_ERROR',
                message: 'too long',
                code: 'chatgpt_context_too_long',
            },
        ],
    });
    const chunks = await drain(
        fitContext(model.adapter, {
            capabilities: { acceptsImages: false },
            key: 'test:give-up',
            threadId: 'give-up-1',
            notes,
            emit: () => {},
            log: () => {},
        }).chatStream(request([{ role: 'user', content: 'Hi' }])),
    );
    expect(model.rounds).toHaveLength(3);
    expect(chunks.map((chunk) => chunk.type)).toEqual(['RUN_STARTED', 'RUN_ERROR']);
});

it('tells over-length refusals from other failures', () => {
    expect(isOverLength({ type: 'RUN_ERROR', code: 'context_length_exceeded' })).toBe(true);
    expect(isOverLength({ type: 'RUN_ERROR', code: 'chatgpt_context_too_long' })).toBe(true);
    expect(
        isOverLength({
            type: 'RUN_ERROR',
            code: '400',
            message: "400 This model's maximum context length is 32768 tokens. However, you requested 40000 tokens.",
        }),
    ).toBe(true);
    expect(isOverLength({ type: 'RUN_ERROR', code: '413', message: '' })).toBe(true);
    expect(
        isOverLength({
            type: 'RUN_ERROR',
            code: '400',
            message: '400 image input is not supported',
        }),
    ).toBe(false);
    expect(
        isOverLength({
            type: 'RUN_ERROR',
            code: 'max_tokens',
            message: 'the response was cut off because the maximum token limit was reached',
        }),
    ).toBe(false);
    expect(isOverLength({ type: 'RUN_ERROR', code: 'chatgpt_rejected' })).toBe(false);
    // An attachment's size is not the prompt's length.
    expect(
        isOverLength({
            type: 'RUN_ERROR',
            code: '400',
            message: '400 The image exceeds the maximum allowed size of 20 MB.',
        }),
    ).toBe(false);
    // llama.cpp's server, by its words and by its type.
    expect(
        isOverLength({
            type: 'RUN_ERROR',
            code: '400',
            message: '400 the request exceeds the available context size, try increasing it',
        }),
    ).toBe(true);
    expect(
        isOverLength({
            type: 'RUN_ERROR',
            error: { type: 'exceed_context_size_error', message: 'too big' },
        }),
    ).toBe(true);
});

it('classifies a ChatGPT prompt that is too long as too long, not as a refused attachment', () => {
    const tooLong = responsesHttpError(
        400,
        JSON.stringify({
            error: {
                message: 'Your input exceeds the context window of this model. Please adjust your input and try again.',
                type: 'invalid_request_error',
            },
        }),
    );
    expect(tooLong.code).toBe('chatgpt_context_too_long');
    expect(tooLong.message).not.toMatch(/too long|new conversation/i);
    expect(responsesHttpError(413, '').code).toBe('chatgpt_context_too_long');
    expect(responsesHttpError(400, JSON.stringify({ error: { code: 'context_length_exceeded' } })).code).toBe(
        'chatgpt_context_too_long',
    );
    expect(responsesHttpError(400, JSON.stringify({ error: { message: 'Invalid image data.' } })).code).toBe(
        'chatgpt_rejected',
    );
    expect(
        responsesHttpError(
            400,
            JSON.stringify({
                error: { message: 'The file exceeds the maximum allowed size.' },
            }),
        ).code,
    ).toBe('chatgpt_rejected');
    expect(
        responsesStreamError({
            type: 'response.failed',
            response: {
                error: {
                    code: 'invalid_prompt',
                    message: 'The prompt is too long for this model.',
                },
            },
        }).code,
    ).toBe('chatgpt_context_too_long');
    expect(
        isOverLength({
            type: 'RUN_ERROR',
            code: new ChatGptError('chatgpt_context_too_long').code,
        }),
    ).toBe(true);
});

it('fits the shape of the real long thread into a ChatGPT window', async () => {
    const { notes } = notesStore();
    const messages: ModelMessage[] = [];
    LONG_THREAD_SHAPE.forEach((shape, index) =>
        messages.push(
            ...turn(
                index,
                `Turn ${index} `.padEnd(shape.user, 'x'),
                shape.calls.map(([tool, args, result], call) => [
                    tool,
                    JSON.stringify({ input: 'a'.repeat(Math.max(0, args - 12)) }),
                    data(result, index * 100 + call),
                ]),
                shape.text ? 'y'.repeat(shape.text) : '',
            ),
        ),
    );
    messages.push({ role: 'user', content: 'Where were we?' });
    const before = messagesTokens(messages);
    // About what the model reported for the thread (~290k tokens).
    expect(before).toBeGreaterThan(250_000);
    const { acceptsImages, contextWindow, outputReserve } = chatGptCapabilities('gpt-6-luna');
    const capabilities = { acceptsImages, contextWindow, outputReserve };
    const budget = contextBudget(capabilities);
    expect(budget).toEqual({ window: 258_400, reserve: 32_000, target: 180_880 });
    const model = fakeModel({});
    // A big tool list, as a Dot with every module has.
    const tools = Array.from({ length: 60 }, (_, index) => ({
        name: `tool_${index}`,
        description: 'd'.repeat(400),
        inputSchema: { type: 'object', properties: { a: { type: 'string' } } },
    }));
    await drain(
        fitContext(model.adapter, {
            capabilities,
            key: 'test:shape',
            threadId: 'shape-1',
            notes,
            emit: () => {},
            log: () => {},
        }).chatStream({ ...request(messages), tools } as TextOptions),
    );
    const sent = model.rounds[0];
    expect(messagesTokens(sent.messages) + fixedTokens(sent.systemPrompts ?? [], tools)).toBeLessThanOrEqual(
        budget.target,
    );
    expect(userTexts(sent.messages).at(-1)).toBe('Where were we?');
    // No single result is over the cap (10k tokens).
    for (const message of sent.messages) {
        if (message.role === 'tool') {
            expect((message.content as string).length).toBeLessThan(36_000);
        }
    }
});

it('shows "Tidying notes" while the notes are summarised', () => {
    let phase = nextPhase(startPhase(0), { type: 'RUN_STARTED' }, 0);
    phase = nextPhase(phase, { type: 'CUSTOM', name: RUN_TIDYING_EVENT }, 1_000);
    expect(phaseText(phase, 'Ada', 3_500)).toBe('Tidying notes · 2 s');
    phase = nextPhase(phase, { type: 'CUSTOM', name: CONTEXT_COMPACTION_EVENT, value: {} }, 4_000);
    expect(phase.kind).toBe('waiting');
    // A compaction without tidying leaves the phase as it is.
    const tool = nextPhase(phase, { type: 'TOOL_CALL_START', toolCallName: 'search_web' }, 5_000);
    expect(nextPhase(tool, { type: 'CUSTOM', name: CONTEXT_COMPACTION_EVENT, value: {} }, 6_000)).toBe(tool);
});

it('runs a Dot turn through a too-long refusal on a small window: compacted, retried, answered', async () => {
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
    });
    const bodies: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        bodies.push(String(init?.body ?? ''));
        if (bodies.length === 1) {
            return new Response(
                JSON.stringify({
                    error: {
                        message: "This model's maximum context length is 8192 tokens.",
                        type: 'invalid_request_error',
                        code: 'context_length_exceeded',
                    },
                }),
                { status: 400, headers: { 'Content-Type': 'application/json' } },
            );
        }
        return completion({ role: 'assistant', content: 'All caught up.' });
    });
    const dot = workspace.dots()[0];
    workspace.bindThread('t-small', dot.id, 'Long', 'bob');
    const config: PlatformConfig = {
        baseUrl: '',
        apiKey: '',
        model: '',
        voiceName: 'marin',
        runtimeUrl: '',
        sessionSecret: 'context-test-secret-0123456789abcdef',
    };
    const agent = new DotAgent(store, workspace, config, dot.id, false, undefined, {
        inference,
        textOnly: true,
    });
    const history: Message[] = [];
    for (let index = 0; index < 6; index++) {
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
            { id: `b${index}`, role: 'assistant', content: `Answer ${index}.` },
        );
    }
    const input: RunAgentInput = {
        threadId: 't-small',
        runId: 'r-small',
        state: {},
        context: [],
        messages: [...history, { id: 'u-last', role: 'user', content: 'And now?' }],
        tools: [],
        forwardedProps: {},
    };
    agent.threadId = 't-small';
    agent.setMessages(input.messages);
    const events = await lastValueFrom(runner.run({ threadId: 't-small', agent, input }).pipe(toArray()));
    expect(events.map((event) => event.type)).not.toContain('RUN_ERROR');
    expect(events.at(-1)?.type).toBe('RUN_FINISHED');
    const compactions = events.filter(
        (event) => event.type === 'CUSTOM' && (event as { name?: string }).name === CONTEXT_COMPACTION_EVENT,
    );
    expect(compactions.length).toBeGreaterThan(0);
    expect((compactions.at(-1) as unknown as { value: ContextCompactionInfo }).value).toMatchObject({
        window: 8_192,
        retried: 1,
    });
    // The model calls: the refused round, the notes, then the retry, smaller.
    const rounds = bodies.filter((body) => !body.includes('running notes'));
    expect(rounds).toHaveLength(2);
    expect(rounds[1].length).toBeLessThan(rounds[0].length);
    expect(rounds[1]).toContain('And now?');
    expect((await runner.messages('t-small')).at(-1)?.content).toBe('All caught up.');
});
