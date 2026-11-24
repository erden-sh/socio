import type { AssistantMessage, BaseEvent, Message, ToolCall } from '@ag-ui/core';

import { applyRoomEvent, type LiveTurn } from '@socio/shared/rooms/live-turn';
import { AG_UI_EVENT } from '@socio/shared/runs/event-types';
import { TraceTimes } from '@socio/shared/runs/trace-times';
import { turnSteps, type TraceStep } from '@socio/shared/runs/turn-steps';

import { cardCalls } from './cards';

// The running turn's steps (CB-434), from today's AG-UI events, as the web's
// TurnTrace shows them while a turn runs ("Working · 3 steps"): each tool
// call (TOOL_CALL_START, its ARGS, its RESULT) and each reasoning message
// (REASONING_MESSAGE_*, its text where the reader may see it), in shared's
// `turnSteps` with the times the events carry. Shared's `applyRoomEvent`
// keeps only the turn's phase, so `applyRunEvent` runs it and keeps the
// work beside the turn it returns, in a WeakMap: a LiveTurn stays the plain
// value the run client, the follow stream and their tests compare. A change
// to the work that leaves the turn as it was (a result, a reasoning delta)
// hands back a copy, so the screen draws it; an argument delta doesn't (the
// next change shows it). A new run starts with no work. Approvals and page
// reviews are cards, never steps (cards.ts). No React Native here.

/** The running turn's work: its calls, results and reasoning, as messages. */
interface LiveWork {
    /** One assistant message per call, and the reasoning messages, in order. */
    readonly messages: readonly Message[];
    readonly results: ReadonlyMap<string, string>;
    /** The reasoning message still being written. */
    readonly reasoning?: string;
    /** When each step started and ended (only grows). */
    readonly times: TraceTimes;
    /** The call the last TOOL_CALL_CHUNK named, for chunks that name none. */
    readonly chunkCall?: string;
}

const work = new WeakMap<LiveTurn, LiveWork>();
const stepsOf = new WeakMap<LiveWork, readonly TraceStep[]>();

const field = (event: BaseEvent, name: string) => {
    const value = (event as unknown as Record<string, unknown>)[name];
    return typeof value === 'string' ? value : undefined;
};

const callMessage = (id: string, name: string): AssistantMessage => ({
    id: `call:${id}`,
    role: 'assistant',
    toolCalls: [{ id, type: 'function', function: { name, arguments: '' } }],
});

/** `messages` with the call `id`'s arguments grown by `delta`. */
const withArgs = (messages: readonly Message[], id: string, delta: string) =>
    messages.map((message) => {
        if (message.role !== 'assistant' || message.toolCalls?.[0]?.id !== id) {
            return message;
        }
        const call = message.toolCalls[0]!;
        const grown: ToolCall = { ...call, function: { ...call.function, arguments: call.function.arguments + delta } };
        return { ...message, toolCalls: [grown] };
    });

/** `messages` with the reasoning message `id`'s text grown by `delta` (started if new). */
const withReasoning = (messages: readonly Message[], id: string, delta: string) =>
    messages.some((message) => message.id === id)
        ? messages.map((message) =>
              message.id === id && message.role === 'reasoning'
                  ? { ...message, content: message.content + delta }
                  : message,
          )
        : [...messages, { id, role: 'reasoning', content: delta } as Message];

/** The work after `event`, or `previous` itself when the event tells nothing of it. */
function nextWork(previous: LiveWork | undefined, event: BaseEvent): LiveWork | undefined {
    if (event.type === AG_UI_EVENT.RUN_STARTED) {
        const times = new TraceTimes();
        times.add(event as never);
        return { messages: [], results: new Map(), times };
    }
    const current: LiveWork = previous ?? { messages: [], results: new Map(), times: new TraceTimes() };
    const timed = () => current.times.add(event as never);
    switch (event.type) {
        case AG_UI_EVENT.TOOL_CALL_START: {
            const id = field(event, 'toolCallId');
            const name = field(event, 'toolCallName');
            if (id === undefined || name === undefined || current.messages.some((m) => m.id === `call:${id}`)) {
                return previous;
            }
            timed();
            return { ...current, messages: [...current.messages, callMessage(id, name)] };
        }
        case AG_UI_EVENT.TOOL_CALL_ARGS: {
            const id = field(event, 'toolCallId');
            const delta = field(event, 'delta');
            return id === undefined || !delta
                ? previous
                : { ...current, messages: withArgs(current.messages, id, delta) };
        }
        case AG_UI_EVENT.TOOL_CALL_CHUNK: {
            const id = field(event, 'toolCallId') ?? current.chunkCall;
            const name = field(event, 'toolCallName');
            const delta = field(event, 'delta') ?? '';
            if (id === undefined) {
                return previous;
            }
            const known = current.messages.some((m) => m.id === `call:${id}`);
            if (!known && name === undefined) {
                return previous;
            }
            if (!known) {
                current.times.add({ type: AG_UI_EVENT.TOOL_CALL_START, toolCallId: id, timestamp: event.timestamp });
            }
            const messages = known ? current.messages : [...current.messages, callMessage(id, name!)];
            return { ...current, chunkCall: id, messages: delta ? withArgs(messages, id, delta) : messages };
        }
        case AG_UI_EVENT.TOOL_CALL_RESULT: {
            const id = field(event, 'toolCallId');
            const content = field(event, 'content');
            if (id === undefined || content === undefined) {
                return previous;
            }
            timed();
            const results = new Map(current.results).set(id, content);
            const message: Message = {
                id: field(event, 'messageId') ?? `result:${id}`,
                role: 'tool',
                toolCallId: id,
                content,
            };
            return { ...current, results, messages: [...current.messages, message] };
        }
        case AG_UI_EVENT.REASONING_MESSAGE_START: {
            const id = field(event, 'messageId');
            if (id === undefined) {
                return previous;
            }
            timed();
            return { ...current, reasoning: id, messages: withReasoning(current.messages, id, '') };
        }
        case AG_UI_EVENT.REASONING_MESSAGE_CONTENT:
        case AG_UI_EVENT.REASONING_MESSAGE_CHUNK: {
            const id = field(event, 'messageId') ?? current.reasoning;
            const delta = field(event, 'delta');
            if (id === undefined || !delta) {
                return previous;
            }
            if (!current.messages.some((m) => m.id === id)) {
                current.times.add({
                    type: AG_UI_EVENT.REASONING_MESSAGE_START,
                    messageId: id,
                    timestamp: event.timestamp,
                });
            }
            return { ...current, reasoning: id, messages: withReasoning(current.messages, id, delta) };
        }
        case AG_UI_EVENT.REASONING_MESSAGE_END:
        case AG_UI_EVENT.REASONING_END: {
            const id = field(event, 'messageId') ?? current.reasoning;
            if (current.reasoning === undefined) {
                return previous;
            }
            current.times.add({ type: AG_UI_EVENT.REASONING_MESSAGE_END, messageId: id, timestamp: event.timestamp });
            const { reasoning: _done, ...rest } = current;
            return rest;
        }
        case AG_UI_EVENT.RUN_FINISHED:
        case AG_UI_EVENT.RUN_ERROR: {
            if (current.reasoning === undefined) {
                return previous;
            }
            const { reasoning: _done, ...rest } = current;
            return rest;
        }
        default:
            return previous;
    }
}

/**
 * Shared's `applyRoomEvent`, keeping the running turn's steps beside the turn
 * it returns ({@link liveSteps}). Use it wherever a run's events make the live
 * turn: the run client and the follow stream.
 */
export function applyRunEvent(turn: LiveTurn, event: BaseEvent, me: string | undefined): LiveTurn {
    const next = applyRoomEvent(turn, event, me);
    const before = work.get(turn);
    const after = nextWork(before, event);
    if (after === undefined) {
        return next;
    }
    if (after === before) {
        if (next !== turn) {
            work.set(next, after);
        }
        return next;
    }
    // A change to the work alone (a result, a reasoning delta) is a new turn, so the screen draws it;
    // an argument delta isn't: it would redraw for every few characters of a call's input.
    const quiet = event.type === AG_UI_EVENT.TOOL_CALL_ARGS || event.type === AG_UI_EVENT.TOOL_CALL_CHUNK;
    const shown = next === turn && !quiet ? { ...next } : next;
    work.set(shown, after);
    return shown;
}

/**
 * `to`, a turn made from `from` without `applyRunEvent` (shared's `stillLive`
 * taking out what the history now holds), with `from`'s steps kept.
 */
export function keepLiveSteps(from: LiveTurn, to: LiveTurn): LiveTurn {
    const kept = work.get(from);
    if (kept !== undefined && to !== from && !work.has(to)) {
        work.set(to, kept);
    }
    return to;
}

/** The running turn's steps, in shared's `turnSteps` (none for a turn not made by `applyRunEvent`). */
export function liveSteps(turn: LiveTurn): readonly TraceStep[] {
    const current = work.get(turn);
    if (current === undefined || current.messages.length === 0) {
        return [];
    }
    const known = stepsOf.get(current);
    if (known !== undefined) {
        return known;
    }
    const steps = turnSteps(current.messages, {
        results: current.results,
        times: current.times,
        ...(current.reasoning === undefined ? {} : { streamingId: current.reasoning }),
        isCard: cardCalls(current.messages),
    });
    stepsOf.set(current, steps);
    return steps;
}
