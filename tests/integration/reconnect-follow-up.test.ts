import '@socio/foundation/no-vendor-telemetry';
import { AbstractAgent, EventType, type BaseEvent, type Message, type RunAgentInput } from '@ag-ui/client';
import { CopilotKitCore } from '@copilotkit/core';
import { Observable, from, throwError } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import type { Outcome } from '@socio/shared/reconnect';

import { recoverTurn } from '../../packages/client/src/shell/reconnect';

// CB-108 with CopilotKit's own run handling, not a stand-in: a page review
// approved while the server drains. CopilotKit sends the run that carries
// on after the review itself, nested in the turn's run, and its refusal is
// what the chat hears for the turn.

const draining = Object.assign(new Error('HTTP 503: {"error":"Socio is updating.","code":"draining"}'), {
    status: 503,
    payload: { error: 'Socio is updating.', code: 'draining' },
});
afterEach(() => vi.restoreAllMocks());

const review = { title: 'Notes', content: 'Hello', spaceId: 's1' };

/** Events for one run, as the runtime streams and stores them. */
function runEvents(input: RunAgentInput, events: BaseEvent[]): BaseEvent[] {
    return [
        {
            type: EventType.RUN_STARTED,
            threadId: input.threadId,
            runId: input.runId,
            input,
        } as BaseEvent,
        ...events,
        {
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
        } as BaseEvent,
    ];
}

/** The server: it answers the turn with a review, then starts draining. */
class Server extends AbstractAgent {
    stored: BaseEvent[] = [];
    draining = false;
    runs = 0;
    run(input: RunAgentInput): Observable<BaseEvent> {
        this.runs++;
        if (this.draining) {
            return throwError(() => draining);
        }
        const events = runEvents(input, [
            {
                type: EventType.TOOL_CALL_START,
                toolCallId: 'review1',
                toolCallName: 'review_space_page',
                parentMessageId: 'a1',
            } as BaseEvent,
            {
                type: EventType.TOOL_CALL_ARGS,
                toolCallId: 'review1',
                delta: JSON.stringify(review),
            } as BaseEvent,
            { type: EventType.TOOL_CALL_END, toolCallId: 'review1' } as BaseEvent,
        ]);
        this.stored.push(...events);
        return from(events);
    }
    protected connect(): Observable<BaseEvent> {
        return from(this.stored);
    }
}

it('never resends a turn whose review was approved while draining, and opens the review again once the server is back', async () => {
    // CopilotKit logs the refused run as well as reporting it.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const agent = new Server({ agentId: 'chat-c1', threadId: 'c1' });
    const copilotkit = new CopilotKitCore({
        agents__unsafe_dev_only: { 'chat-c1': agent },
    });
    // The page review (useHumanInTheLoop): each call waits for a decision.
    const decisions: Array<(result: unknown) => void> = [];
    copilotkit.addTool({
        name: 'review_space_page',
        type: 'human-in-the-loop',
        handler: () => new Promise((resolve) => decisions.push(resolve)),
    } as Parameters<typeof copilotkit.addTool>[0]);
    // What the chat's `capture` does: the error CopilotKit reports for it.
    let failure: unknown;
    copilotkit.subscribe({
        onError: ({ error }) => void (failure ??= error),
    });
    const capture = async <T>(action: () => Promise<T>): Promise<Outcome<T>> => {
        failure = undefined;
        const value = await action();
        return failure === undefined ? { value } : { value, error: failure };
    };

    await copilotkit.connectAgent({ agent });
    const turn: Message = { id: 'u1', role: 'user', content: 'Draft my notes' };
    agent.addMessage(turn);
    const first = capture(() => copilotkit.runAgent({ agent }));
    await expect.poll(() => decisions.length).toBe(1);
    // A deploy starts draining; then the person approves.
    agent.draining = true;
    decisions[0]!({ approved: true, pageId: 'p1' });
    const failed = await first;
    expect(failed.error).toBe(draining);
    // The refusal came from the run carrying on, not the turn's own.
    expect(agent.runs).toBe(2);
    expect(agent.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);

    // Stopped while waiting: the server has the turn.
    const stop = new AbortController();
    const stopped = recoverTurn({
        agent,
        message: turn,
        failed: failed.error,
        connect: () => capture(() => copilotkit.connectAgent({ agent })),
        run: () => capture(() => copilotkit.runAgent({ agent })),
        // The server stays away until stopped.
        ready: ({ signal }) =>
            new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
        signal: stop.signal,
    });
    stop.abort();
    expect(await stopped).toEqual({
        resent: false,
        gaveUp: 'stopped',
        unsent: false,
    });

    // The server is back: the replay has the turn, which is never sent
    // again, and the review it waits on is open for a decision again.
    agent.draining = false;
    const recovered = await recoverTurn({
        agent,
        message: turn,
        failed: failed.error,
        connect: () => capture(() => copilotkit.connectAgent({ agent })),
        run: () => capture(() => copilotkit.runAgent({ agent })),
        ready: async () => {},
        signal: new AbortController().signal,
    });
    expect(recovered).toEqual({ error: undefined, resent: false });
    expect(agent.runs).toBe(2);
    await expect.poll(() => decisions.length).toBe(2);
    expect(agent.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    // Deciding again carries on.
    decisions[1]!({ approved: true, pageId: 'p1' });
    await expect.poll(() => agent.runs).toBe(3);
});

it('connects by adding what the replay has: a turn the server never got stays shown', async () => {
    // Why a reconnect starts from no messages (the chat's stand-in for
    // CopilotKit in chat-reconnect-ui merges the same way).
    const agent = new Server({ agentId: 'chat-c1', threadId: 'c1' });
    const copilotkit = new CopilotKitCore({
        agents__unsafe_dev_only: { 'chat-c1': agent },
    });
    await copilotkit.connectAgent({ agent });
    const stored: Message = { id: 'u0', role: 'user', content: 'Stored' };
    agent.stored = runEvents({ threadId: 'c1', runId: 'r0', messages: [stored] } as RunAgentInput, []);
    const unsent: Message = { id: 'u1', role: 'user', content: 'Never got' };
    agent.setMessages([unsent]);
    await copilotkit.connectAgent({ agent });
    expect(agent.messages.map((message) => message.id)).toEqual(['u1', 'u0']);
    agent.setMessages([]);
    await copilotkit.connectAgent({ agent });
    expect(agent.messages.map((message) => message.id)).toEqual(['u0']);
});
