/**
 * When things happened in a conversation (CB-72), read from the time the
 * runner stamps on each event it stores and streams. The chat shows them:
 * a message's time, how long each step of a turn took, "Thought for 12s".
 * Runs stored before CB-72 have times only on their start and end (runs
 * migration 3); what their events can't tell is left out, never guessed.
 */
export interface Span {
    start?: number;
    end?: number;
}

/** The fields of an AG-UI event read here. */
export interface TimedEvent {
    type: string;
    timestamp?: number;
    messageId?: string;
    toolCallId?: string;
    input?: { messages?: readonly { id: string }[] };
}

export class TraceTimes {
    /**
     * When each message was written: a user message when its run started, a
     * reply when its text began. A message whose event has no time gets the
     * next time its run has (a run stored before CB-72: its end).
     */
    readonly messages = new Map<string, number>();
    /** When each tool call started, and when its result came. */
    readonly tools = new Map<string, Span>();
    /** When each reasoning message started and ended. */
    readonly reasoning = new Map<string, Span>();
    private untimed: string[] = [];

    constructor(events: Iterable<TimedEvent> = []) {
        for (const event of events) {
            this.add(event);
        }
    }

    add(event: TimedEvent) {
        const at = typeof event.timestamp === 'number' ? event.timestamp : undefined;
        switch (event.type) {
            case 'RUN_STARTED':
                this.untimed = [];
                for (const message of event.input?.messages ?? []) {
                    this.message(message.id, at);
                }
                break;
            case 'TEXT_MESSAGE_START':
                if (event.messageId) {
                    this.message(event.messageId, at);
                }
                break;
            case 'TOOL_CALL_START':
                if (event.toolCallId) {
                    span(this.tools, event.toolCallId).start ??= at;
                }
                break;
            case 'TOOL_CALL_RESULT':
                if (event.toolCallId && at !== undefined) {
                    span(this.tools, event.toolCallId).end = at;
                }
                break;
            case 'REASONING_START':
            case 'REASONING_MESSAGE_START':
                if (event.messageId) {
                    span(this.reasoning, event.messageId).start ??= at;
                }
                break;
            case 'REASONING_MESSAGE_END':
            case 'REASONING_END':
                if (event.messageId && at !== undefined) {
                    span(this.reasoning, event.messageId).end = at;
                }
                break;
        }
        if (at === undefined || !this.untimed.length) {
            return;
        }
        for (const id of this.untimed) {
            if (!this.messages.has(id)) {
                this.messages.set(id, at);
            }
        }
        this.untimed = [];
    }

    /** The times as JSON (a synced run's, CB-136). */
    snapshot() {
        return {
            messages: [...this.messages],
            tools: [...this.tools],
            reasoning: [...this.reasoning],
        };
    }

    /**
     * Adds the times of `snapshot` that aren't known yet: a run from the
     * chat's store, under the times its connection streamed.
     */
    absorb(snapshot: {
        messages: Iterable<[string, number]>;
        tools: Iterable<[string, Span]>;
        reasoning: Iterable<[string, Span]>;
    }) {
        for (const [id, at] of snapshot.messages) {
            if (!this.messages.has(id)) {
                this.messages.set(id, at);
            }
        }
        for (const [id, found] of snapshot.tools) {
            if (!this.tools.has(id)) {
                this.tools.set(id, { ...found });
            }
        }
        for (const [id, found] of snapshot.reasoning) {
            if (!this.reasoning.has(id)) {
                this.reasoning.set(id, { ...found });
            }
        }
    }

    private message(id: string, at: number | undefined) {
        if (this.messages.has(id)) {
            return;
        }
        if (at !== undefined) {
            this.messages.set(id, at);
        } else if (!this.untimed.includes(id)) {
            this.untimed.push(id);
        }
    }
}

function span(map: Map<string, Span>, id: string) {
    let found = map.get(id);
    if (!found) {
        map.set(id, (found = {}));
    }
    return found;
}
