import { randomUUID } from 'node:crypto';

import { EventType, type AbstractAgent, type BaseEvent, type Message } from '@ag-ui/client';
import { lastValueFrom, toArray } from 'rxjs';

import type { AgentRunSource } from '@socio/shared/types';
import { voiceReceiptMessagePrefix } from '@socio/shared/voice/voice-receipt';

import { NO_ASSISTANT_RESPONSE, TurnRunError, type TurnOptions, type TurnOutcome, type TurnUsage } from './contract.js';
import type { LocalAgentRunner } from './local-runner.js';

export function currentTurnText(messages: Message[], error?: Error): string {
    if (error) {
        throw error;
    }
    const content = messages.filter((message) => message.role === 'assistant').at(-1)?.content;
    if (typeof content !== 'string' || !content.trim()) {
        throw new Error(NO_ASSISTANT_RESPONSE);
    }
    return content;
}

function turnUsage(events: BaseEvent[]): TurnUsage | null {
    const finished = events.find((event) => event.type === EventType.RUN_FINISHED) as { usage?: unknown } | undefined;
    if (!Array.isArray(finished?.usage)) {
        return null;
    }
    const count = (key: 'inputTokens' | 'outputTokens') =>
        (finished.usage as Array<Record<string, unknown>>).reduce(
            (sum, entry) => sum + (typeof entry[key] === 'number' ? (entry[key] as number) : 0),
            0,
        );
    return {
        inputTokens: count('inputTokens'),
        outputTokens: count('outputTokens'),
    };
}

/**
 * Runs one server-side turn (scheduled tasks, voice compute) in process,
 * through the same runner the browser uses, so the turn is stored with the
 * thread and replays when the conversation is opened.
 */
export async function runThreadTurn(
    runner: LocalAgentRunner,
    agent: AbstractAgent,
    threadId: string,
    prompt: string,
    signal: AbortSignal,
    metadata?: Record<string, unknown>,
    source?: AgentRunSource,
): Promise<string> {
    return (await runThreadTurnOutcome(runner, agent, threadId, prompt, signal, metadata, source)).text;
}

/** `runThreadTurn`, also returning the run id and the model's token usage. */
export async function runThreadTurnOutcome(
    runner: LocalAgentRunner,
    agent: AbstractAgent,
    threadId: string,
    prompt: string,
    signal: AbortSignal,
    metadata?: Record<string, unknown>,
    source?: AgentRunSource,
    options: TurnOptions = {},
): Promise<TurnOutcome> {
    signal.throwIfAborted();
    const history = await runner.messages(threadId);
    // Replaying a long thread takes a while (CB-318): a stop that came
    // meanwhile has no run to stop yet.
    signal.throwIfAborted();
    const message: Message = {
        id:
            options.messageId ??
            `${metadata?.socioSource === 'voice_receipt' ? voiceReceiptMessagePrefix : ''}${randomUUID()}`,
        role: 'user',
        content: prompt,
        ...(metadata ? { metadata } : {}),
    } as Message;
    const messages = [...history, message];
    const runId = randomUUID();
    agent.threadId = threadId;
    agent.setMessages(messages);
    const stop = () => void runner.stop({ threadId, runId });
    signal.addEventListener('abort', stop, { once: true });
    try {
        const run = runner.run({
            threadId,
            agent,
            source,
            ...(options.signals ? { signals: options.signals } : {}),
            input: {
                threadId,
                runId,
                messages,
                state: {},
                tools: [],
                context: [],
                forwardedProps: {},
            },
        });
        options.onStarted?.(runId);
        const events = await lastValueFrom(run.pipe(toArray()));
        signal.throwIfAborted();
        const known = new Set(messages.map((entry) => entry.id));
        const added = (await runner.messages(threadId)).filter((entry) => !known.has(entry.id));
        const failure = events.find((event) => event.type === EventType.RUN_ERROR) as { message?: string } | undefined;
        const text = currentTurnText(
            added,
            failure && !added.some((entry) => entry.role === 'assistant')
                ? new TurnRunError(failure.message || 'The turn failed.')
                : undefined,
        );
        return { text, runId, usage: turnUsage(events) };
    } finally {
        signal.removeEventListener('abort', stop);
    }
}
