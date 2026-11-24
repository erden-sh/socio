import type { Message, ToolCall } from '@ag-ui/core';

import type { Args } from './tool-labels.js';
import type { Span, TraceTimes } from './trace-times.js';

/**
 * A turn's work as the chat shows it (CB-72), shared by the web and the
 * app: one step per reasoning block
 * and per tool call, in the order they happened. Cards that need the
 * reader (approvals, page reviews) are not steps: they show on their own.
 */
export type StepState = 'running' | 'done' | 'failed' | 'stopped';

export interface ReasoningStep {
    kind: 'reasoning';
    /** The first part's id: the step keeps its open state as parts arrive. */
    id: string;
    text: string;
    streaming: boolean;
    span: Span;
}
export interface ToolStep {
    kind: 'tool';
    id: string;
    call: ToolCall;
    /** The tool's result as the model got it, once it came. */
    result?: string;
    span: Span;
}
export type TraceStep = ReasoningStep | ToolStep;

/** JSON text as a value, or undefined when it isn't JSON. */
export function parseJson(text: string | undefined): unknown {
    if (text === undefined) {
        return undefined;
    }
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

/** A value as an object's fields: `{}` for anything that isn't one. */
export function fieldsOf(value: unknown): Args {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Args) : {};
}

/**
 * How a tool step ended, from its result: a result with an `error`, an
 * error status, `ok: false` or a nonzero exit code failed; one the runtime
 * closed for a stop says so. No result yet is running while the turn is,
 * and stopped after it (the turn ended without one).
 */
export function toolOutcome(result: string | undefined, live: boolean): { state: StepState; message?: string } {
    if (result === undefined) {
        return { state: live ? 'running' : 'stopped' };
    }
    const parsed = parseJson(result);
    const data = fieldsOf(parsed);
    const message = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined);
    if (data.status === 'stopped' || data.reason === 'stop_requested') {
        return { state: 'stopped', message: message(data.message) };
    }
    if (message(data.error)) {
        return { state: 'failed', message: data.error as string };
    }
    if (data.status === 'error' || data.status === 'failed' || data.ok === false) {
        return {
            state: 'failed',
            message: message(data.message) ?? message(data.reason),
        };
    }
    if (typeof data.exitCode === 'number' && data.exitCode !== 0) {
        return { state: 'failed', message: `Exited with code ${data.exitCode}.` };
    }
    if (parsed === undefined && /^error\b/i.test(result.trim())) {
        return { state: 'failed', message: result.trim() };
    }
    return { state: 'done' };
}

/** How long a span took, in ms, when both ends are known. */
export const spanMs = (span: Span) =>
    span.start !== undefined && span.end !== undefined ? Math.max(0, span.end - span.start) : undefined;

/** A duration as the trace shows it: `<0.1s`, `0.4s`, `12s`, `1m 12s`, `1h 5m`. */
export function formatDuration(ms: number) {
    if (ms < 50) {
        return '<0.1s';
    }
    if (ms < 9_950) {
        return `${Math.round(ms / 100) / 10}s`;
    }
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m ${seconds % 60}s`;
    }
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * A conversation's messages split into turns: each starts with a user
 * message (the server's own notes too: a turn carrying on after an
 * approval starts with one). Anything before the first is a turn too.
 */
export function splitTurns<M extends Message>(messages: readonly M[]) {
    const turns: M[][] = [];
    for (const message of messages) {
        if (message.role === 'user' || !turns.length) {
            turns.push([message]);
        } else {
            turns.at(-1)!.push(message);
        }
    }
    return turns;
}

/**
 * A turn's steps, in the order they happened. The client keeps a turn's
 * tool results together after its one assistant message, and its
 * reasoning after them, so the order comes from the steps' start times;
 * without them (runs stored before CB-72), it is the messages' order,
 * calls first, and calls still waiting for a result last. Reasoning parts
 * in a row fold into one step; a tool call between them starts a new one.
 */
export function turnSteps(
    turn: readonly Message[],
    {
        results,
        times,
        streamingId,
        isCard = () => false,
    }: {
        /** Tool results by call id. */
        results: ReadonlyMap<string, string>;
        times?: TraceTimes;
        /** The message the model is still writing, if any. */
        streamingId?: string;
        /** Calls shown as their own card (approvals, page reviews). */
        isCard?: (call: ToolCall) => boolean;
    },
): TraceStep[] {
    const calls = new Map<string, ToolCall>();
    for (const message of turn) {
        if (message.role === 'assistant') {
            for (const call of message.toolCalls ?? []) {
                if (!isCard(call)) {
                    calls.set(call.id, call);
                }
            }
        }
    }
    // One part each, in the messages' order: a call where its result is.
    const parts: TraceStep[] = [];
    const placed = new Set<string>();
    const tool = (call: ToolCall) => {
        placed.add(call.id);
        parts.push({
            kind: 'tool',
            id: call.id,
            call,
            result: results.get(call.id),
            span: times?.tools.get(call.id) ?? {},
        });
    };
    for (const message of turn) {
        if (message.role === 'reasoning' && message.content.trim()) {
            parts.push({
                kind: 'reasoning',
                id: message.id,
                text: message.content,
                streaming: message.id === streamingId,
                span: { ...times?.reasoning.get(message.id) },
            });
        } else if (message.role === 'tool') {
            const call = calls.get(message.toolCallId);
            if (call && !placed.has(call.id)) {
                tool(call);
            }
        }
    }
    for (const call of calls.values()) {
        if (!placed.has(call.id)) {
            tool(call);
        }
    }
    if (parts.every((part) => part.span.start !== undefined)) {
        parts.sort((a, b) => a.span.start! - b.span.start!);
    }
    const steps: TraceStep[] = [];
    for (const part of parts) {
        const last = steps.at(-1);
        if (part.kind === 'reasoning' && last?.kind === 'reasoning') {
            last.text += `\n\n${part.text}`;
            last.streaming = part.streaming;
            last.span = {
                start: last.span.start ?? part.span.start,
                end: part.span.end ?? last.span.end,
            };
        } else {
            steps.push(part);
        }
    }
    return steps;
}

/** How long a turn worked: from its start to its last step's end. */
export function workedMs(steps: readonly TraceStep[], start?: number) {
    const from = start ?? steps[0]?.span.start;
    const ends = steps.map((step) => step.span.end).filter((end): end is number => end !== undefined);
    return from !== undefined && ends.length ? Math.max(0, Math.max(...ends) - from) : undefined;
}

/** A reasoning block's label: "Thought for 12s", or "Thought" without times. */
export function thoughtLabel(seconds: number | undefined) {
    return seconds === undefined ? 'Thought' : `Thought for ${formatDuration(Math.max(1, seconds) * 1000)}`;
}
