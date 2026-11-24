import { AbstractAgent, EventType, type BaseEvent, type Message, type RunAgentInput } from '@ag-ui/client';
import { lastValueFrom, Observable } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import { withPrivateResultsWithheld, withToolActors } from '@socio/foundation/context/room-context';
import { ROOM_STREAM_CURSOR } from '@socio/shared/rooms/rooms';
import { SENDER_METADATA, TOOL_ACTOR_METADATA } from '@socio/shared/types';

import { readerFilter } from '../src/server/rooms/reader-events.js';
import type { LocalAgentRunner } from '../src/server/turns/local-runner.js';

import { matrixChats, roomsFixture, type Caller } from './fixtures/rooms.js';

// The owner's decision of 2026-10-28: the model's reasoning in a turn that
// acted for someone else is theirs. It can paraphrase their private tool
// results, so every other member gets only that the socio thought
// ("thinking…"), never what: in the history, the transcript, the live stream,
// the runtime's connect and what later turns and compaction read. The person
// the turn acted for sees their own.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

interface Frame {
    event?: string;
    data: string;
}

/** A server-sent event stream's frames, read as they come. */
function sse(response: Response) {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const frames: Frame[] = [];
    let buffer = '';
    const done = (async () => {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) {
                break;
            }
            buffer += decoder.decode(value, { stream: true });
            let at: number;
            while ((at = buffer.indexOf('\n\n')) >= 0) {
                const raw = buffer.slice(0, at);
                buffer = buffer.slice(at + 2);
                const frame: Frame = { data: '' };
                for (const line of raw.split('\n')) {
                    if (line.startsWith(':')) {
                        continue;
                    }
                    const split = line.indexOf(': ');
                    const [key, value] = [line.slice(0, split), line.slice(split + 2)];
                    if (key === 'event') {
                        frame.event = value;
                    } else if (key === 'data') {
                        frame.data += value;
                    }
                }
                if (frame.data || frame.event) {
                    frames.push(frame);
                }
            }
        }
    })().catch(() => undefined);
    cleanup.push(() => reader.cancel().catch(() => undefined));
    return {
        frames,
        done,
        text: () => frames.map((frame) => frame.data).join('\n'),
        events: () => frames.filter((frame) => !frame.event).map((frame) => JSON.parse(frame.data) as BaseEvent),
        named: (name: string) => frames.filter((frame) => frame.event === name),
    };
}

/**
 * A turn that reasons (`thought`), then answers; with `hold`, it waits
 * after reasoning until it is stopped.
 */
class ReasoningAgent extends AbstractAgent {
    private release?: () => void;
    constructor(
        private thought: string,
        private hold = false,
    ) {
        super({});
    }
    run(input: RunAgentInput): Observable<BaseEvent> {
        return new Observable<BaseEvent>((subscriber) => {
            const { threadId, runId } = input;
            const next = (event: object) => subscriber.next(event as BaseEvent);
            const id = `think-${runId}`;
            next({ type: EventType.RUN_STARTED, threadId, runId });
            next({ type: EventType.REASONING_START, messageId: id });
            next({
                type: EventType.REASONING_MESSAGE_START,
                messageId: id,
                role: 'reasoning',
            });
            next({
                type: EventType.REASONING_MESSAGE_CONTENT,
                messageId: id,
                delta: this.thought,
            });
            next({ type: EventType.REASONING_MESSAGE_END, messageId: id });
            next({
                type: EventType.REASONING_ENCRYPTED_VALUE,
                subtype: 'message',
                entityId: id,
                encryptedValue: `ENC-${this.thought}`,
            });
            next({ type: EventType.REASONING_END, messageId: id });
            const finish = () => {
                next({
                    type: EventType.TEXT_MESSAGE_START,
                    messageId: `t-${runId}`,
                    role: 'assistant',
                });
                next({
                    type: EventType.TEXT_MESSAGE_CONTENT,
                    messageId: `t-${runId}`,
                    delta: 'Here is the plan.',
                });
                next({ type: EventType.TEXT_MESSAGE_END, messageId: `t-${runId}` });
                next({ type: EventType.RUN_FINISHED, threadId, runId });
                subscriber.complete();
            };
            if (!this.hold) {
                finish();
            } else {
                this.release = () => subscriber.complete();
            }
        });
    }
    abortRun() {
        this.release?.();
    }
}

/** A turn in the room as `person` sent it, run as the app runs it. */
function runAs(
    runner: LocalAgentRunner,
    dotId: string,
    threadId: string,
    runId: string,
    person: string,
    agent: AbstractAgent,
) {
    const messages: Message[] = [
        {
            id: `u-${runId}`,
            role: 'user',
            content: 'Plan my week.',
            metadata: { [SENDER_METADATA]: person },
        } as Message,
    ];
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
}

const follow = async (caller: Caller, roomId: string) => {
    const response = await caller(`/conversations/${roomId}/stream?after=0`);
    expect(response.status).toBe(200);
    return sse(response);
};

const reasoningOf = (stream: ReturnType<typeof sse>) =>
    stream
        .events()
        .filter((event) => /^(REASONING|THINKING)_/.test(event.type))
        .map((event) => event.type);

it('withholds another person’s reasoning from every member, live and stored, and keeps the thinking state', async () => {
    const f = await roomsFixture(cleanup);
    const { roomId } = await matrixChats(f);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const runner = f.platform.runner;
    // A finished turn of Ada's whose reasoning retells her private result.
    await runAs(
        runner,
        f.company.id,
        roomId,
        'run-ada-1',
        'ada',
        new ReasoningAgent('ADA-THOUGHT-CANARY her 3pm oncologist visit'),
    );
    expect(runner.runTrace('run-ada-1')?.status).toBe('finished');

    // Mo and Ada follow the room; Ada's next turn reasons while they do.
    const mo = await follow(f.as('mo'), roomId);
    const ada = await follow(f.as('ada'), roomId);
    const live = new ReasoningAgent('ADA-LIVE-THOUGHT-CANARY salary 140k', true);
    const running = runAs(runner, f.company.id, roomId, 'run-ada-2', 'ada', live);
    await vi.waitFor(() => expect(ada.text()).toContain('ADA-LIVE-THOUGHT'));
    await vi.waitFor(() => expect(mo.text()).toContain('"messageId":"think-run-ada-2"'));
    // Mo: that the socio thinks, in both turns; never what.
    for (const canary of ['ADA-THOUGHT-CANARY', 'ADA-LIVE-THOUGHT-CANARY']) {
        expect(mo.text(), canary).not.toContain(canary);
    }
    expect(mo.text()).not.toContain('ENC-');
    expect(reasoningOf(mo)).toEqual(
        [1, 2].flatMap(() => ['REASONING_START', 'REASONING_MESSAGE_START', 'REASONING_MESSAGE_END', 'REASONING_END']),
    );
    // Ada: her own, whole.
    expect(ada.text()).toContain('ADA-THOUGHT-CANARY');
    expect(ada.text()).toContain('ENC-ADA-THOUGHT-CANARY');
    // The answer is the room's.
    expect(mo.text()).toContain('Here is the plan.');
    live.abortRun();
    await running;
    await vi.waitFor(() => expect(mo.named(ROOM_STREAM_CURSOR)).toHaveLength(2));
    expect(mo.text()).not.toContain('ADA-LIVE-THOUGHT-CANARY');

    // The history: Mo gets each reasoning message emptied (the "thought"
    // without its words), Ada her own; the transcript (CB-283) now shows a
    // socio's per-round thinking traces, with the same privacy — Ada keeps
    // her own reasoning, Mo gets it emptied.
    const read = async (person: string, path: string) =>
        JSON.stringify(await (await f.as(person)(`/conversations/${roomId}/${path}`)).json());
    const history = JSON.parse(await read('mo', 'history')) as {
        runs: { messages: Message[] }[];
    };
    const thoughts = history.runs.flatMap((run) => run.messages.filter((message) => message.role === 'reasoning'));
    expect(thoughts).toHaveLength(2);
    for (const thought of thoughts) {
        expect(thought.content).toBe('');
        expect(thought).not.toHaveProperty('encryptedValue');
        expect(JSON.stringify(thought)).not.toContain(TOOL_ACTOR_METADATA);
    }
    for (const path of ['history', 'transcript']) {
        for (const canary of ['ADA-THOUGHT-CANARY', 'ADA-LIVE-THOUGHT-CANARY']) {
            expect(await read('mo', path), `${path} ${canary}`).not.toContain(canary);
        }
    }
    expect(await read('ada', 'history')).toContain('ADA-THOUGHT-CANARY');
    // CB-283: the transcript now shows the acting person's own reasoning.
    expect(await read('ada', 'transcript')).toContain('ADA-THOUGHT-CANARY');

    // The runtime's own connect: a member's, filtered the same way.
    const viaConnect = await f.as('mo')(`/copilotkit/agent/${f.company.id}/connect`, 'POST', {
        threadId: roomId,
        runId: 'connect',
        messages: [],
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
    });
    expect(viaConnect.status).toBe(200);
    const connected = sse(viaConnect);
    await connected.done;
    expect(connected.text()).toContain('think-run-ada-1');
    for (const canary of ['ADA-THOUGHT-CANARY', 'ADA-LIVE-THOUGHT-CANARY']) {
        expect(connected.text(), canary).not.toContain(canary);
    }
});

it('gives later turns and the shared notes another person’s reasoning emptied, and a turn its own', async () => {
    const f = await roomsFixture(cleanup);
    const { roomId } = await matrixChats(f);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const runner = f.platform.runner;
    await runAs(runner, f.company.id, roomId, 'run-ada', 'ada', new ReasoningAgent('ADA-THOUGHT-CANARY'));
    await runAs(runner, f.company.id, roomId, 'run-mo', 'mo', new ReasoningAgent('MO-THOUGHT-CANARY'));
    // What a turn, recall and compaction read: the stored conversation,
    // stamped by the runner (`toolActors`) and filtered for the acting person.
    const stamped = withToolActors(await runner.messages(roomId), runner.toolActors(roomId));
    expect(runner.toolActors(roomId).get('reasoning:think-run-ada')).toBe('ada');
    const forMo = JSON.stringify(withPrivateResultsWithheld(stamped, 'mo'));
    expect(forMo).not.toContain('ADA-THOUGHT-CANARY');
    expect(forMo).toContain('MO-THOUGHT-CANARY');
    const forAda = JSON.stringify(withPrivateResultsWithheld(stamped, 'ada'));
    expect(forAda).toContain('ADA-THOUGHT-CANARY');
    expect(forAda).not.toContain('MO-THOUGHT-CANARY');
    // This turn's own (not stored yet, so not stamped) stays.
    const own: Message = {
        id: 'think-now',
        role: 'reasoning',
        content: 'NOW-CANARY',
    } as Message;
    expect(JSON.stringify(withPrivateResultsWithheld([own], 'mo'))).toContain('NOW-CANARY');
});

it('fails closed on reasoning: a turn nobody is known to have started is no one’s, and a snapshot’s is emptied', () => {
    const filter = readerFilter('mo', {
        runActor: () => '',
        toolActors: () => new Map([['reasoning:old', 'ada']]),
    });
    filter({ type: EventType.RUN_STARTED, runId: 'r' } as BaseEvent);
    expect(
        filter({
            type: EventType.REASONING_MESSAGE_CONTENT,
            messageId: 'x',
            delta: 'SECRET',
        } as BaseEvent),
    ).toBeUndefined();
    expect(
        filter({
            type: EventType.THINKING_START,
            title: 'SECRET title',
        } as BaseEvent),
    ).toEqual({ type: EventType.THINKING_START });
    const snapshot = filter({
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
            { id: 'old', role: 'reasoning', content: 'OLD-SECRET' },
            { id: 'u', role: 'user', content: 'hello' },
        ],
    } as BaseEvent) as unknown as { messages: Message[] };
    expect(snapshot.messages).toEqual([
        { id: 'old', role: 'reasoning', content: '' },
        { id: 'u', role: 'user', content: 'hello' },
    ]);
});
