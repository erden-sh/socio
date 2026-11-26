import { AbstractAgent, EventType, type BaseEvent, type Message, type RunAgentInput } from '@ag-ui/client';
import { lastValueFrom, Observable } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import { conversationSpeakers } from '@socio/foundation/context/room-context';
import { ROOM_FAILURE_NOTES, TURN_FAILURE_MESSAGES, type TurnFailure } from '@socio/foundation/observability/failures';
import { ROOM_PROBLEM_FALLBACK, TURN_PROBLEM_FALLBACK, turnProblems } from '@socio/foundation/rooms/turn-problems';
import { approvalNoteMessagePrefix, approvalNoteSource } from '@socio/shared/approvals';
import { ROOM_DISCLOSURE_VERSION } from '@socio/shared/rooms/rooms';
import { SENDER_METADATA, SOCIO_METADATA, type MessageAuthor, type TranscriptTurnProblem } from '@socio/shared/types';

import type { LocalAgentRunner } from '../src/server/turns/local-runner.js';

import { ToolAgent, matrixChats, roomsFixture } from './fixtures/rooms.js';

// CB-212 follow-ups: a room's transcript says which socio wrote each reply
// (stamped as it was stored), whose a converted chat's earlier messages were
// (its former owner's), each sender by id as well as name, and where a turn
// was refused or failed; and where its live stream resumes.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

interface TranscriptMessage {
    id: string;
    role: string;
    content: unknown;
    author?: MessageAuthor;
    socioId?: string;
}
interface Transcript {
    messages: TranscriptMessage[];
    cursor?: number;
    inTurn?: string[];
    problems?: TranscriptTurnProblem[];
}

/** A turn of `messages` in `threadId`, started by `person`. */
const run = (
    runner: LocalAgentRunner,
    dotId: string,
    threadId: string,
    runId: string,
    person: string,
    messages: Message[],
) => {
    const agent = new ToolAgent({ id: `call-${runId}`, result: 'ok' });
    agent.agentId = dotId;
    agent.threadId = threadId;
    agent.setMessages(messages);
    return lastValueFrom(
        runner.run({
            threadId,
            agent,
            input: {
                threadId,
                runId,
                messages,
                state: {},
                tools: [],
                context: [],
                forwardedProps: {},
            },
            signals: { trigger: { kind: 'person', id: person } },
        }),
        { defaultValue: undefined },
    ).catch(() => undefined);
};

it('says which socio wrote each reply, each sender by id, where a refused turn stopped and where the stream resumes', async () => {
    const f = await roomsFixture(cleanup);
    const { roomId, privateId } = await matrixChats(f);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const runner = f.platform.runner;
    await run(runner, f.company.id, roomId, 'run-mo', 'mo', [
        {
            id: 'u-mo',
            role: 'user',
            content: 'Hello room',
            metadata: { [SENDER_METADATA]: 'mo' },
        } as Message,
    ]);
    // The runner stamps the socio on the stored reply.
    const reply = (await runner.messages(roomId)).find((message) => message.id === 't-run-mo') as Message & {
        metadata?: Record<string, unknown>;
    };
    expect(reply.metadata?.[SOCIO_METADATA]).toBe(f.company.id);
    // Nina is in none of it: her turn is refused, and the room sees that.
    await run(runner, f.company.id, roomId, 'run-nina', 'nina', [
        {
            id: 'u-nina',
            role: 'user',
            content: 'Let me in',
            metadata: { [SENDER_METADATA]: 'nina' },
        } as Message,
    ]);
    expect(runner.runTrace('run-nina')?.status).toBe('failed');

    const transcript = (await (await f.as('ada')(`/conversations/${roomId}/transcript`)).json()) as Transcript;
    const byId = new Map(transcript.messages.map((m) => [m.id, m]));
    expect(byId.get('t-run-mo')?.socioId).toBe(f.company.id);
    expect(byId.get('u-mo')?.author).toEqual({
        name: 'Mo',
        you: false,
        id: 'mo',
    });
    expect(transcript.cursor).toBe(runner.historyRows(roomId, { limit: 1 })[0]!.seq);
    expect(transcript.problems).toHaveLength(1);
    const [problem] = transcript.problems!;
    expect(problem).toMatchObject({ runId: 'run-nina' });
    expect(Object.values(TURN_FAILURE_MESSAGES)).toContain(problem!.message);
    // After the last message shown before it ended: Nina's, kept.
    expect(byId.get('u-nina')?.author).toMatchObject({ name: 'Nina' });
    expect(problem!.after).toBe('u-nina');
    expect(problem!.author).toEqual({ name: 'Nina', you: false, id: 'nina' });
    // Ada reads it about Nina, not Socio's words to Nina (CB-205).
    expect(problem!.message).toBe(TURN_FAILURE_MESSAGES.room_access);
    expect(problem!.roomMessage).toBe('Nina can’t start work in this room right now.');

    // A private chat's transcript is as before: no ids, cursor or problems.
    await run(runner, f.company.id, privateId, 'run-olive', 'olive', [
        { id: 'u-olive', role: 'user', content: 'Mine' } as Message,
    ]);
    const own = (await (await f.as('olive')(`/conversations/${privateId}/transcript`)).json()) as Transcript;
    expect(own.messages.length).toBeGreaterThan(0);
    expect(own).not.toHaveProperty('cursor');
    expect(own).not.toHaveProperty('problems');
    expect(own.messages.every((message) => !message.author)).toBe(true);
});

it('attributes a converted chat’s earlier messages to its former owner, never a server note', async () => {
    const f = await roomsFixture(cleanup);
    const { privateId } = await matrixChats(f);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const runner = f.platform.runner;
    // Olive's chat from before senders were stamped, with an approval's note.
    await run(runner, f.company.id, privateId, 'run-old', 'olive', [
        { id: 'u-old', role: 'user', content: 'My old question' } as Message,
        {
            id: `${approvalNoteMessagePrefix}n1`,
            role: 'user',
            content: 'Approved: the old action.',
            metadata: { socioSource: approvalNoteSource },
        } as Message,
    ]);
    const olive = f.as('olive');
    expect(
        (
            await olive(`/rooms/${privateId}/convert`, 'POST', {
                confirmHistory: true,
            })
        ).status,
    ).toBe(201);
    expect(f.workspace.convertedFrom(privateId)?.userId).toBe('olive');
    await olive(`/rooms/${privateId}/invites`, 'POST', { userId: 'ada' });
    await f.as('ada')(`/rooms/${privateId}/accept`, 'POST', {
        disclosureVersion: ROOM_DISCLOSURE_VERSION,
    });
    const read = async (person: string) =>
        new Map(
            ((await (await f.as(person)(`/conversations/${privateId}/transcript`)).json()) as Transcript).messages.map(
                (message) => [message.id, message.author],
            ),
        );
    expect((await read('ada')).get('u-old')).toEqual({
        name: 'Olive',
        you: false,
        id: 'olive',
    });
    expect((await read('olive')).get('u-old')).toEqual({
        name: 'Olive',
        you: true,
        id: 'olive',
    });
    expect((await read('ada')).get(`${approvalNoteMessagePrefix}n1`)).toEqual({
        name: 'Team member',
        you: false,
    });
    // Each author and time travel in `metadata` too, which AG-UI 1.0 keeps,
    // and for now at the top level as well, for the app builds already shipped.
    const listed = ((await (await f.as('ada')(`/conversations/${privateId}/transcript`)).json()) as Transcript)
        .messages as unknown as Array<{
        id: string;
        author?: unknown;
        at?: number;
        metadata?: Record<string, unknown>;
    }>;
    const old = listed.find((message) => message.id === 'u-old')!;
    expect(old.metadata?.author).toEqual({ name: 'Olive', you: false, id: 'olive' });
    expect(old.author).toEqual(old.metadata?.author);
    expect(old.at).toEqual(expect.any(Number));
    expect(old.metadata?.at).toBe(old.at);
    // A room made as a room has no former owner.
    expect(f.workspace.convertedFrom('nope')).toBeUndefined();

    // The model's labels say the same (`conversationSpeakers`).
    const speakers = conversationSpeakers(
        await runner.messages(privateId),
        'room',
        (id) => (id === 'olive' ? 'Olive' : undefined),
        'olive',
    );
    expect(speakers).toEqual([
        { id: 'olive', name: 'Olive' },
        { kind: 'system', name: 'Socio' },
    ]);
});

it('places each turn problem after the last message shown before it, in a fixed text only', () => {
    const problems = turnProblems(
        [
            {
                type: 'RUN_STARTED',
                runId: 'a',
                input: { messages: [{ id: 'm1' }] },
            },
            { type: 'TEXT_MESSAGE_START', messageId: 'hidden' },
            {
                type: 'RUN_ERROR',
                message: TURN_FAILURE_MESSAGES.cycle_rate,
                timestamp: 5,
            },
            { type: 'RUN_STARTED', runId: 'b' },
            {
                type: 'RUN_ERROR',
                message: 'provider said: key sk-SECRET-CANARY over quota',
            },
        ] as never,
        new Set(['m1']),
        {
            author: (runId) => (runId === 'a' ? { name: 'Mo', you: false } : undefined),
        },
    );
    expect(problems).toEqual([
        {
            runId: 'a',
            after: 'm1',
            message: TURN_FAILURE_MESSAGES.cycle_rate,
            roomMessage: 'The room got too many messages in a minute.',
            author: { name: 'Mo', you: false },
            at: 5,
        },
        {
            runId: 'b',
            after: 'm1',
            message: TURN_PROBLEM_FALLBACK,
            roomMessage: ROOM_PROBLEM_FALLBACK,
        },
    ]);
    expect(JSON.stringify(problems)).not.toContain('CANARY');
});

it('words a refused turn for the room about its sender, and keeps the sender’s own (CB-205)', () => {
    const events = (message: string) =>
        [
            { type: 'RUN_STARTED', runId: 'a', input: { messages: [{ id: 'm1' }] } },
            { type: 'RUN_ERROR', message },
        ] as never;
    const as = (author?: { name: string; you: boolean }) => ({
        author: () => author,
    });
    const shown = new Set(['m1']);
    const refused = TURN_FAILURE_MESSAGES.room_access;

    // Another member reads it about Nina, in the third person.
    const [other] = turnProblems(events(refused), shown, as({ name: 'Nina', you: false }));
    expect(other).toMatchObject({
        message: refused,
        roomMessage: 'Nina can’t start work in this room right now.',
    });
    // Nina keeps Socio's words to her; the room's are about her too.
    const [sender] = turnProblems(events(refused), shown, as({ name: 'Nina', you: true }));
    expect(sender).toMatchObject({
        message: refused,
        roomMessage: 'Nina can’t start work in this room right now.',
    });
    // No known sender: "Its sender".
    expect(turnProblems(events(refused), shown)[0]?.roomMessage).toBe(
        'Its sender can’t start work in this room right now.',
    );
    // A time limit with its minutes is still a known one.
    expect(
        turnProblems(
            events('This turn reached the 5 minute time limit and was stopped. Try a smaller request.'),
            shown,
        )[0]?.roomMessage,
    ).toBe('The turn reached its time limit and was stopped.');

    // Every fixed reason has a room wording with no second person in it.
    for (const kind of Object.keys(TURN_FAILURE_MESSAGES) as TurnFailure[]) {
        const [problem] = turnProblems(events(TURN_FAILURE_MESSAGES[kind]), shown, as({ name: 'Nina', you: false }));
        expect(problem?.roomMessage).toBe(ROOM_FAILURE_NOTES[kind]('Nina'));
        expect(problem?.roomMessage).not.toMatch(/\b(you|your)\b|[“”"]/i);
    }
});

/** A turn that starts and waits until it is stopped. */
class HoldAgent extends AbstractAgent {
    private release?: () => void;
    run(input: RunAgentInput): Observable<BaseEvent> {
        return new Observable<BaseEvent>((subscriber) => {
            subscriber.next({
                type: EventType.RUN_STARTED,
                threadId: input.threadId,
                runId: input.runId,
            } as BaseEvent);
            this.release = () => subscriber.complete();
        });
    }
    abortRun() {
        this.release?.();
    }
}

it('names the person messages the running turn took, so a reader tells a taken message from a cancelled one (CB-215)', async () => {
    const f = await roomsFixture(cleanup);
    const { roomId } = await matrixChats(f);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const runner = f.platform.runner;
    const read = async () => (await (await f.as('mo')(`/conversations/${roomId}/transcript`)).json()) as Transcript;
    expect((await read()).inTurn).toEqual([]);
    const agent = new HoldAgent({});
    const messages = [
        {
            id: 'u-taken',
            role: 'user',
            content: 'Taken from the queue',
            metadata: { [SENDER_METADATA]: 'mo' },
        } as Message,
    ];
    agent.agentId = f.company.id;
    agent.threadId = roomId;
    agent.setMessages(messages);
    const running = lastValueFrom(
        runner.run({
            threadId: roomId,
            agent,
            input: {
                threadId: roomId,
                runId: 'run-hold',
                messages,
                state: {},
                tools: [],
                context: [],
                forwardedProps: {},
            },
            signals: { trigger: { kind: 'person', id: 'mo' } },
        }),
        { defaultValue: undefined },
    ).catch(() => undefined);
    await vi.waitFor(async () => expect((await read()).inTurn).toEqual(['u-taken']));
    // Not stored yet: the transcript doesn't list it among its messages.
    expect((await read()).messages.some((m) => m.id === 'u-taken')).toBe(false);
    agent.abortRun();
    await running;
    expect((await read()).inTurn).toEqual([]);
});

// CB-283: a room's transcript shows a socio's per-round thinking traces and
// tool calls, with the same privacy the live stream and history keep (CB-210):
// the acting person sees their own reasoning and results; every other member
// gets reasoning emptied and tool results as a withheld note. The trace's
// times are sent so the client can show how long each step took.

/** A turn that reasons, calls a tool, then answers. */
class TraceAgent extends AbstractAgent {
    constructor(
        private thought: string,
        private call: { id: string; name: string; result: string },
    ) {
        super({});
    }
    run(input: RunAgentInput): Observable<BaseEvent> {
        return new Observable<BaseEvent>((subscriber) => {
            const { threadId, runId } = input;
            const next = (event: object) => subscriber.next(event as BaseEvent);
            next({ type: EventType.RUN_STARTED, threadId, runId });
            const think = `think-${runId}`;
            next({
                type: EventType.REASONING_START,
                messageId: think,
                timestamp: 100,
            });
            next({
                type: EventType.REASONING_MESSAGE_START,
                messageId: think,
                role: 'reasoning',
                timestamp: 100,
            });
            next({
                type: EventType.REASONING_MESSAGE_CONTENT,
                messageId: think,
                delta: this.thought,
            });
            next({
                type: EventType.REASONING_MESSAGE_END,
                messageId: think,
                timestamp: 200,
            });
            next({ type: EventType.REASONING_END, messageId: think, timestamp: 200 });
            next({
                type: EventType.TOOL_CALL_START,
                toolCallId: this.call.id,
                toolCallName: this.call.name,
                parentMessageId: `t-${runId}`,
                timestamp: 210,
            });
            next({
                type: EventType.TOOL_CALL_ARGS,
                toolCallId: this.call.id,
                delta: '{}',
            });
            next({
                type: EventType.TOOL_CALL_END,
                toolCallId: this.call.id,
                timestamp: 220,
            });
            next({
                type: EventType.TOOL_CALL_RESULT,
                messageId: `r-${runId}`,
                toolCallId: this.call.id,
                content: this.call.result,
                role: 'tool',
                timestamp: 230,
            });
            next({
                type: EventType.TEXT_MESSAGE_START,
                messageId: `t-${runId}`,
                role: 'assistant',
                timestamp: 240,
            });
            next({
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: `t-${runId}`,
                delta: 'Done.',
            });
            next({
                type: EventType.TEXT_MESSAGE_END,
                messageId: `t-${runId}`,
                timestamp: 250,
            });
            next({ type: EventType.RUN_FINISHED, threadId, runId });
            subscriber.complete();
        });
    }
}

interface TraceTranscript {
    messages: Array<{
        id: string;
        role: string;
        content: unknown;
        toolCallId?: string;
        toolCalls?: Array<{ id: string; function: { name: string } }>;
    }>;
    times?: {
        messages: [string, number][];
        tools: [string, { start?: number; end?: number }][];
        reasoning: [string, { start?: number; end?: number }][];
    };
}

it('shows a socio turn’s reasoning and tool calls in the room transcript, with the acting person’s kept and others’ withheld (CB-283)', async () => {
    const f = await roomsFixture(cleanup);
    const { roomId } = await matrixChats(f);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const runner = f.platform.runner;
    const agent = new TraceAgent('ADA-PRIVATE-THOUGHT-CANARY', {
        id: 'call-ada',
        name: 'calendar_read',
        result: '{"ok":true,"events":["ADA-PRIVATE-EVENT-CANARY"]}',
    });
    agent.agentId = f.company.id;
    agent.threadId = roomId;
    const messages = [
        {
            id: 'u-ada',
            role: 'user',
            content: 'What is on today?',
            metadata: { [SENDER_METADATA]: 'ada' },
        } as Message,
    ];
    agent.setMessages(messages);
    await lastValueFrom(
        runner.run({
            threadId: roomId,
            agent,
            input: {
                threadId: roomId,
                runId: 'run-trace',
                messages,
                state: {},
                tools: [],
                context: [],
                forwardedProps: {},
            },
            signals: { trigger: { kind: 'person', id: 'ada' } },
        }),
        { defaultValue: undefined },
    ).catch(() => undefined);

    const byId = async (person: string) =>
        new Map(
            (
                (await (await f.as(person)(`/conversations/${roomId}/transcript`)).json()) as TraceTranscript
            ).messages.map((m) => [m.id, m] as const),
        );

    // Ada, the acting person: sees her own reasoning and the tool's result.
    const ada = await byId('ada');
    expect(ada.get('think-run-trace')?.role).toBe('reasoning');
    expect(String(ada.get('think-run-trace')?.content)).toContain('ADA-PRIVATE-THOUGHT-CANARY');
    const adaTool = ada.get('r-run-trace');
    expect(adaTool?.role).toBe('tool');
    expect(adaTool?.toolCallId).toBe('call-ada');
    expect(String(adaTool?.content)).toContain('ADA-PRIVATE-EVENT-CANARY');
    // The assistant message carries its tool calls, so the client rebuilds steps.
    const adaReply = ada.get('t-run-trace');
    expect(adaReply?.role).toBe('assistant');
    expect(adaReply?.toolCalls?.[0]?.function.name).toBe('calendar_read');

    // Mo, another member: the reasoning is emptied and the tool result withheld.
    const mo = await byId('mo');
    expect(mo.get('think-run-trace')?.role).toBe('reasoning');
    expect(String(mo.get('think-run-trace')?.content)).toBe('');
    const moTool = mo.get('r-run-trace');
    expect(moTool?.role).toBe('tool');
    expect(moTool?.toolCallId).toBe('call-ada');
    // The withheld note names the tool and that it worked, never what it held.
    const withheld = JSON.parse(String(moTool?.content)) as {
        withheld: boolean;
        tool: string;
        status: string;
    };
    expect(withheld).toMatchObject({
        withheld: true,
        tool: 'calendar_read',
        status: 'ok',
    });
    expect(String(moTool?.content)).not.toContain('ADA-PRIVATE-EVENT-CANARY');
    expect(String(mo.get('t-run-trace')?.content)).toBe('Done.');

    // The trace's times are sent, so the client shows "Thought for …" and the
    // tool's duration.
    const trace = (await (await f.as('ada')(`/conversations/${roomId}/transcript`)).json()) as TraceTranscript;
    expect(trace.times).toBeDefined();
    const reasoning = new Map(trace.times!.reasoning);
    const thinkSpan = reasoning.get('think-run-trace');
    expect(thinkSpan?.start).toBeTypeOf('number');
    expect(thinkSpan?.end).toBeTypeOf('number');
    const tools = new Map(trace.times!.tools);
    const callSpan = tools.get('call-ada');
    expect(callSpan?.start).toBeTypeOf('number');
    expect(callSpan?.end).toBeTypeOf('number');
});
