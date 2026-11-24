import type { Message, RunAgentInput } from '@ag-ui/core';
import type { AnyTextAdapter, ContentPart, ModelMessage, TextOptions } from '@tanstack/ai';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { sqliteData } from '@socio/data/open';
import {
    MARKER_EVERY_MS,
    markerPart,
    timeText,
    utcTimeText,
    withMarker,
    type TimeMarker,
} from '@socio/foundation/context/time-markers';
import { isNotesPart, isTurnNote, withNotes, withTurnNote } from '@socio/foundation/context/turn-note';

import type { PlatformConfig } from '../src/server/composition/config.js';
import { resetCalibration } from '../src/server/context/budget.js';
import { fitContext } from '../src/server/context/fit.js';
import { ContextNotes, SUMMARY_PROMPT } from '../src/server/context/notes.js';
import { timeMarkers } from '../src/server/context/time-markers.js';
import { InferenceService } from '../src/server/inference/service.js';

import { completion } from './fixtures/model-stream.js';
import { DotAgent } from './helpers/dot-agent.js';
import { LocalAgentRunner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

// CB-141: no date in the system prompt; the date and time in markers along
// the thread, stored and put back with their messages, pruned on a fold.

const cleanup: Array<() => unknown> = [];
beforeEach(() => resetCalibration());
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
});

type Sent = { role: string; content: string | Array<{ text: string }> };
const MARKER = '[Date and time of this message: ';
const NOTE = "[This turn's context, from Socio:]";
const texts = (message: Sent) =>
    typeof message.content === 'string' ? [message.content] : (message.content ?? []).map((part) => part.text);
const markersIn = (messages: Sent[]) => messages.flatMap(texts).filter((text) => text.startsWith(MARKER));
function chatFixture() {
    const store = new Store(testDatabase());
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(
        () => store.close(),
        () => workspace.close(),
    );
    const dot = workspace.dots()[0];
    workspace.bindThread('thread', dot.id, 'Times', 'owner');
    const network = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => completion({ role: 'assistant', content: 'Done.' }));
    const history: Message[] = [];
    /** A web chat's turn at `at`: the client sends the whole conversation. */
    const turn = async (at: string, text: string) => {
        vi.setSystemTime(new Date(at));
        const id = `u${history.length}`;
        history.push({ id, role: 'user', content: text });
        const agent = new DotAgent(
            store,
            workspace,
            {
                apiKey: 'fixture',
                model: 'custom-model',
                baseUrl: 'https://unused.invalid/v1',
            },
            dot.id,
        );
        const input: RunAgentInput = {
            threadId: 'thread',
            runId: `run-${id}`,
            state: {},
            context: [],
            messages: [...history],
            tools: [],
            forwardedProps: {},
        };
        await lastValueFrom(agent.run(input).pipe(toArray()));
        history.push({
            id: `a${history.length}`,
            role: 'assistant',
            content: 'Done.',
        });
        const body = JSON.parse(String(network.mock.calls.at(-1)![1]?.body)) as {
            messages: Sent[];
        };
        return body.messages;
    };
    return { workspace, turn };
}

it('keeps the system prompt the same, byte for byte, on two different days', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = chatFixture();
    const first = await f.turn('2026-10-21T09:00:00.000Z', 'Hello.');
    const second = await f.turn('2026-10-22T16:30:00.000Z', 'Hello again.');
    const system = (messages: Sent[]) => JSON.stringify(messages.filter((message) => message.role === 'system'));
    expect(system(first)).toContain('You are ');
    expect(system(second)).toBe(system(first));
    expect(system(first)).not.toMatch(/2026|Oct|UTC[−+]/);
    // The days are in the markers instead.
    expect(markersIn(second)).toEqual([
        `${MARKER}Wed 21 Oct 2026, 09:00 (UTC).]`,
        `${MARKER}Thu 22 Oct 2026, 16:30 (UTC).]`,
    ]);
});

it('marks the first turn, not one 5 minutes later, then one 40 minutes later and the next day; earlier turns replay byte for byte', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = chatFixture();
    const requests = [
        await f.turn('2026-10-21T09:00:00.000Z', 'Plan the week.'),
        await f.turn('2026-10-21T09:05:00.000Z', 'Shorter, please.'),
        await f.turn('2026-10-21T09:45:00.000Z', 'Add Friday.'),
        await f.turn('2026-10-22T08:00:00.000Z', 'Good morning.'),
    ];
    const newest = (messages: Sent[]) => messages.findLast((message) => message.role === 'user')!;
    // The newest message: the turn's note, its marker when it has one, then
    // the person's words.
    expect(texts(newest(requests[0]))).toEqual([
        expect.stringContaining('Current time: Wed 21 Oct 2026, 09:00 (UTC).'),
        `${MARKER}Wed 21 Oct 2026, 09:00 (UTC).]`,
        'Plan the week.',
    ]);
    // Five minutes later: nothing time-related but the note's current time.
    expect(texts(newest(requests[1]))).toEqual([
        expect.stringContaining('Current time: Wed 21 Oct 2026, 09:05 (UTC)'),
        'Shorter, please.',
    ]);
    expect(markersIn(requests[1])).toHaveLength(1);
    // Forty minutes after the last marker, then the next day: a new one.
    expect(texts(newest(requests[2]))[1]).toBe(`${MARKER}Wed 21 Oct 2026, 09:45 (UTC).]`);
    expect(texts(newest(requests[3]))[1]).toBe(`${MARKER}Thu 22 Oct 2026, 08:00 (UTC).]`);
    expect(markersIn(requests[3])).toHaveLength(3);
    // Each request starts with the one before it, byte for byte, up to the
    // person's newest message, whose note is gone the turn after.
    for (let index = 1; index < requests.length; index++) {
        const before = requests[index - 1];
        const at = before.findLastIndex((message) => message.role === 'user');
        expect(JSON.stringify(requests[index].slice(0, at))).toBe(JSON.stringify(before.slice(0, at)));
        // That message's own parts (its marker, its words) as they were; a
        // model's template reads a lone text part as plain text.
        expect(texts(requests[index][at])).toEqual(texts(before[at]).filter((text) => !text.startsWith(NOTE)));
    }
    // Stored with their messages; the thread's state is the newest.
    const stored = timeMarkers(f.workspace.db).all('thread');
    expect([...stored.keys()]).toEqual(['u0', 'u4', 'u6']);
    expect(stored.get('u6')).toMatchObject({
        toldAt: Date.parse('2026-10-22T08:00:00.000Z'),
        sentAt: Date.parse('2026-10-22T08:00:00.000Z'),
    });
});

it('decides by the thread’s last marker: none, the date, or 30 minutes', () => {
    const db = testDatabase();
    cleanup.push(() => db.close());
    const markers = timeMarkers(db);
    const at = Date.parse('2026-10-21T23:50:00.000Z');
    expect(markers.forTurn('t', ['a'], at).get('a')?.text).toBe(`${MARKER}Wed 21 Oct 2026, 23:50 (UTC).]`);
    // Within 30 minutes on the same day: none.
    expect(markers.forTurn('t', ['a', 'b'], at + 5 * 60_000).has('b')).toBe(false);
    // Ten minutes later, but past midnight: a new date.
    expect(markers.forTurn('t', ['a', 'b', 'c'], at + 10 * 60_000).has('c')).toBe(true);
    // A marker on a message no longer in the conversation was never told.
    expect(markers.forTurn('t', ['x'], at + 11 * 60_000).has('x')).toBe(true);
    // The same message again (a retry) keeps its marker, word for word.
    const again = markers.forTurn('t', ['x'], at + MARKER_EVERY_MS * 3);
    expect(again.get('x')?.toldAt).toBe(at + 11 * 60_000);
});

it('marks a turn while another unit of work is open, saving it after (CB-110)', async () => {
    const db = testDatabase();
    cleanup.push(() => db.close());
    const markers = timeMarkers(db);
    const { uow } = sqliteData(db);
    const at = Date.parse('2026-10-21T23:50:00.000Z');
    let release!: () => void;
    // Another chain's write, say: a unit open across awaits.
    const open = uow.run(() => new Promise<void>((done) => (release = done)), {
        label: 'another chain',
    });
    await Promise.resolve();
    const marker = markers.forTurn('t', ['a'], at).get('a');
    expect(marker?.text).toBe(`${MARKER}Wed 21 Oct 2026, 23:50 (UTC).]`);
    expect(markers.all('t').has('a')).toBe(false);
    release();
    await open;
    await vi.waitFor(() => expect(markers.all('t').get('a')).toEqual(marker));
});

// Fitting: a small window and a long thread whose oldest turns fold.
type Chunk = { type: string } & Record<string, unknown>;
const answer = (text: string): Chunk[] => [
    { type: 'RUN_STARTED', runId: 'r', threadId: 't' },
    { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: text },
    { type: 'TEXT_MESSAGE_END', messageId: 'm' },
    { type: 'RUN_FINISHED', runId: 'r', threadId: 't' },
];
function fakeModel() {
    const rounds: TextOptions[] = [];
    const adapter = {
        name: 'fake',
        chatStream: async function* (request: TextOptions) {
            if (request.systemPrompts?.[0] === SUMMARY_PROMPT) {
                yield* answer('PINNED:\n- Working on: the week\nSUMMARY:\nPlanning.');
                return;
            }
            rounds.push(request);
            yield* answer('Done.');
        },
    } as unknown as AnyTextAdapter;
    return { adapter, rounds };
}
const START = Date.parse('2026-10-21T09:00:00.000Z');
const marker = (turn: number): TimeMarker => {
    const toldAt = START + turn * 60_000;
    return {
        messageId: `u${turn}`,
        text: `${MARKER}${timeText(toldAt)}.]`,
        toldAt,
        sentAt: toldAt,
    };
};
/** 30 turns of big results; `marked` turns carry a marker. */
function longThread(marked: number[]): ModelMessage[] {
    const messages: ModelMessage[] = [];
    for (let turn = 0; turn < 30; turn++) {
        const words = { type: 'text' as const, content: `Turn ${turn}.` };
        messages.push(
            {
                role: 'user',
                content: marked.includes(turn) ? [markerPart(marker(turn)), words] : [words],
            },
            {
                role: 'assistant',
                content: null,
                toolCalls: [
                    {
                        id: `c${turn}`,
                        type: 'function',
                        function: { name: 'data_query', arguments: '{}' },
                    },
                ],
            },
            { role: 'tool', toolCallId: `c${turn}`, content: 'x'.repeat(6_000) },
            { role: 'assistant', content: `Answer ${turn}.`.padEnd(1_500, 'z') },
        );
    }
    return messages;
}
const markerTexts = (messages: readonly ModelMessage[]) =>
    messages.flatMap((message) =>
        Array.isArray(message.content)
            ? message.content.flatMap((part) =>
                  part.type === 'text' && part.content.startsWith(MARKER) ? [part.content] : [],
              )
            : [],
    );
/** The chat's notes (CB-147): at the start of the prompt's first message. */
const notesOf = (messages: readonly ModelMessage[]) => {
    const part = Array.isArray(messages[0]?.content) ? messages[0].content.find(isNotesPart) : undefined;
    return part?.type === 'text' ? part.content : '';
};
const fitted = (notes: ContextNotes, ensure?: () => TimeMarker | undefined, timeZone?: string) => {
    const model = fakeModel();
    const adapter = fitContext(model.adapter, {
        capabilities: { acceptsImages: false, contextWindow: 16_000 },
        key: 'test:markers',
        threadId: 't',
        notes,
        emit: () => {},
        log: () => {},
        timeMarker: ensure,
        ...(timeZone ? { timeZone } : {}),
    });
    const run = async (messages: ModelMessage[]) => {
        const stream = adapter.chatStream({
            model: 'fake',
            messages,
            systemPrompts: ['You are Ada.'],
            tools: [],
        } as unknown as TextOptions);
        // Drains the round.
        const chunks = stream[Symbol.asyncIterator]();
        while (!(await chunks.next()).done) {}
        return model.rounds.at(-1)!.messages;
    };
    return run;
};
const notesStore = () => {
    const db = testDatabase();
    cleanup.push(() => db.close());
    return new ContextNotes(db);
};

it('keeps only the latest marker on a fold, and the same ones from turn to turn until the next', async () => {
    const notes = notesStore();
    const ensure = vi.fn(() => undefined);
    // A marker on every turn from 24: the latest stays in the prompt.
    const marked = [0, 10, 24, 25, 26, 27, 28, 29];
    const thread = longThread(marked);
    const first = await fitted(notes, ensure)([...thread, { role: 'user', content: 'Next?' }]);
    const stored = notes.get('t')!;
    expect(stored.turns).toBeGreaterThan(0);
    // Turn 28 is kept, its marker left out.
    expect(stored.turns).toBeLessThanOrEqual(28);
    expect(JSON.stringify(first)).toContain('Turn 28.');
    expect(markerTexts(first)).toEqual([marker(29).text]);
    expect(stored).toMatchObject({
        timeAt: null,
        markersFrom: marker(29).toldAt,
    });
    // The notes have no time while the latest marker's turn is in the prompt.
    expect(notesOf(first)).toMatch(/^\[Notes on the earlier part/);
    expect(notesOf(first)).not.toContain('Date and time');
    expect(ensure).not.toHaveBeenCalled();
    // The next turn, with a marker of its own: the earlier ones stay as they
    // were, the new one after them.
    const next = marker(70);
    const second = await fitted(
        notes,
        ensure,
    )([
        ...thread,
        { role: 'user', content: 'Next?' },
        { role: 'assistant', content: 'Nothing new.' },
        {
            role: 'user',
            content: [markerPart(next), { type: 'text', content: 'And now?' }],
        },
    ]);
    expect(notes.get('t')!.updates).toBe(stored.updates);
    expect(markerTexts(second)).toEqual([marker(29).text, next.text]);
    expect(JSON.stringify(second.slice(0, first.length - 1))).toBe(JSON.stringify(first.slice(0, -1)));
});

it('carries the folded marker’s time into the notes, and marks the newest message when none is left', async () => {
    const notes = notesStore();
    const now = marker(40);
    const ensure = vi.fn(() => now);
    // Markers on the oldest turns only: they all fold.
    const prompt = await fitted(notes, ensure)([...longThread([0, 1, 2]), { role: 'user', content: 'Next?' }]);
    const stored = notes.get('t')!;
    expect(stored.turns).toBeGreaterThan(2);
    expect(stored).toMatchObject({
        timeAt: marker(2).toldAt,
        markersFrom: marker(2).toldAt,
    });
    // The notes' stable part has the latest folded marker's date and time.
    expect(notesOf(prompt)).toContain(`[Date and time of the latest of these turns: ${timeText(marker(2).toldAt)}.]`);
    // No marker was left in the turns: the newest message got one, so the
    // prompt holds the current date.
    expect(ensure).toHaveBeenCalled();
    expect(markerTexts(prompt)).toEqual([now.text]);
    expect(prompt.at(-1)!.content).toEqual([markerPart(now), { type: 'text', content: 'Next?' }]);
    expect(JSON.stringify(prompt)).toContain('Wed 21 Oct 2026');
});

it('gives the folded marker’s time in the folding turn’s zone, and keeps it there until the next fold; notes folded before stay in UTC (CB-159)', async () => {
    const db = testDatabase();
    cleanup.push(() => db.close());
    const notes = new ContextNotes(db);
    const thread = [...longThread([0, 1, 2]), { role: 'user', content: 'Next?' } as ModelMessage];
    const now = marker(40);
    const first = await fitted(notes, () => now, 'America/New_York')(thread);
    expect(notes.get('t')).toMatchObject({
        timeAt: marker(2).toldAt,
        timeZone: 'America/New_York',
    });
    // 09:02 UTC is 05:02 in New York, on daylight time in October.
    expect(notesOf(first)).toContain(
        '[Date and time of the latest of these turns: Wed 21 Oct 2026, 05:02 (America/New_York, UTC−4).]',
    );
    // Another person's turn (a shared chat) in another zone: the same notes,
    // byte for byte, until the next fold.
    const second = await fitted(notes, () => now, 'Asia/Kolkata')(thread);
    expect(notesOf(second)).toBe(notesOf(first));
    // Notes folded before CB-159 have no zone: their time stays in UTC, as
    // the model was told it then.
    db.exec("UPDATE chat_context_notes SET timeZone = NULL WHERE threadId = 't'");
    const legacy = await fitted(notes, () => now, 'America/New_York')(thread);
    expect(notesOf(legacy)).toContain(
        `[Date and time of the latest of these turns: ${utcTimeText(marker(2).toldAt)}.]`,
    );
    expect(utcTimeText(marker(2).toldAt)).toBe('2026-10-21 09:02 UTC (Wednesday)');
});

it('marks the newest message when it is the only one kept, with the notes in it (CB-147)', async () => {
    const notes = notesStore();
    const now = marker(40);
    const ensure = vi.fn(() => now);
    // One huge answer: only the newest turn is kept, the notes in its message.
    const prompt = await fitted(
        notes,
        ensure,
    )([
        {
            role: 'user',
            content: [markerPart(marker(0)), { type: 'text', content: 'Turn 0.' }],
        },
        { role: 'assistant', content: `Answer: ${'z'.repeat(60_000)}` },
        { role: 'user', content: 'Next?' },
    ]);
    expect(prompt).toHaveLength(1);
    expect(notesOf(prompt)).toContain(`[Date and time of the latest of these turns: ${timeText(marker(0).toldAt)}.]`);
    expect(ensure).toHaveBeenCalled();
    expect(
        (prompt[0].content as ContentPart[]).map((part) =>
            isNotesPart(part) ? 'notes' : (part as { content: string }).content,
        ),
    ).toEqual(['notes', now.text, 'Next?']);
});

it('puts the notes, the turn’s note and the marker before the person’s words, in that order, however they were added', () => {
    const words: ContentPart = { type: 'text', content: 'Next?' };
    const notesFirst = withNotes([{ role: 'user', content: 'Next?' }], 'Notes.');
    // Fitting adds the notes after the turn added its note and marker, then
    // the facts and a missing marker after the notes (CB-147).
    const orders = [
        withTurnNote([withMarker(notesFirst[0], marker(3))], 'Turn note.'),
        withNotes(withTurnNote([withMarker({ role: 'user', content: 'Next?' }, marker(3))], 'Turn note.'), 'Notes.'),
        [withMarker(withTurnNote(notesFirst, 'Turn note.')[0], marker(3))],
    ];
    for (const [message] of orders) {
        const parts = message.content as ContentPart[];
        expect(parts.map((part) => (part as { content: string }).content)).toEqual([
            'Notes.',
            'Turn note.',
            marker(3).text,
            'Next?',
        ]);
        expect(isNotesPart(parts[0])).toBe(true);
        expect(isTurnNote(parts[1])).toBe(true);
        expect(parts[3]).toEqual(words);
    }
    // The facts join the turn's note, after the notes.
    expect(
        (withTurnNote(orders[1], 'Facts.')[0].content as ContentPart[]).map(
            (part) => (part as { content: string }).content,
        ),
    ).toEqual(['Notes.', 'Turn note.\n\nFacts.', marker(3).text, 'Next?']);
    // Before an answer (a conversation that starts with one), a message of
    // their own: the roles still take turns.
    expect(withNotes([{ role: 'assistant', content: 'Hi.' }], 'Notes.').map((message) => message.role)).toEqual([
        'user',
        'assistant',
    ]);
});

it('runs a Dot turn on a small window: the folded marker’s date in the notes, a new marker on the newest message', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
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
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        bodies.push(String(init?.body ?? ''));
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
    const history: Message[] = [];
    for (let index = 0; index < 6; index++) {
        history.push(
            { id: `u${index}`, role: 'user', content: `Question ${index}.` },
            {
                id: `r${index}`,
                role: 'assistant',
                content: `Answer ${index}: ${'z'.repeat(9_000)}`,
            },
        );
    }
    // The first message was told the time ten minutes ago, on this day: the
    // rule alone adds no marker now, but its turn folds.
    vi.setSystemTime(new Date('2026-10-21T09:00:00.000Z'));
    timeMarkers(workspace.db).mark('t-small', 'u0');
    vi.setSystemTime(new Date('2026-10-21T09:10:00.000Z'));
    const agent = new DotAgent(store, workspace, config, dot.id, false, undefined, {
        inference,
        textOnly: true,
    });
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
    expect(events.at(-1)?.type).toBe('RUN_FINISHED');
    const sent = JSON.parse(bodies.at(-1)!) as { messages: Sent[] };
    const notesMessage = sent.messages.find((message) => texts(message)[0]?.startsWith('[Notes on the earlier part'))!;
    expect(texts(notesMessage)[0]).toContain(
        '[Date and time of the latest of these turns: Wed 21 Oct 2026, 09:00 (UTC).]',
    );
    expect(markersIn(sent.messages)).toEqual([`${MARKER}Wed 21 Oct 2026, 09:10 (UTC).]`]);
    expect(timeMarkers(workspace.db).all('t-small').has('u-last')).toBe(true);
});
