import { isRecord } from './chat-request.js';
import { type ReportedUsage, tokensOfChars } from './chat-stream.js';

/**
 * Reading an Anthropic Messages backend's answer as it passes (CB-239),
 * as chat-stream.ts does for Chat Completions: the usage it reports
 * and the characters of output so far, for when it reports none or runs
 * past its limit. Nothing is kept: the text is counted and forwarded,
 * never stored.
 *
 * Anthropic counts cache reads and writes apart from `input_tokens`; the
 * prompt is all three, and the cached part is the reads.
 */

const count = (value: unknown) => (typeof value === 'string' ? value.length : 0);
const whole = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;

interface Counts {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheCreation?: number;
}

/** The counts a `usage` object carries, each only when well formed. */
function countsOf(usage: unknown): Counts {
    if (!isRecord(usage)) {
        return {};
    }
    return {
        input: whole(usage.input_tokens),
        output: whole(usage.output_tokens),
        cacheRead: whole(usage.cache_read_input_tokens),
        cacheCreation: whole(usage.cache_creation_input_tokens),
    };
}

function reported(counts: Counts): ReportedUsage | undefined {
    if (counts.input === undefined || counts.output === undefined) {
        return undefined;
    }
    const cacheRead = counts.cacheRead ?? 0;
    return {
        promptTokens: counts.input + cacheRead + (counts.cacheCreation ?? 0),
        completionTokens: counts.output,
        cachedTokens: cacheRead,
    };
}

/** The usage of a whole (non-streamed) answer, when it is well formed. */
export function messagesUsageOf(body: unknown): ReportedUsage | undefined {
    return isRecord(body) ? reported(countsOf(body.usage)) : undefined;
}

/** Output characters of a whole (non-streamed) answer. */
export function messagesAnswerChars(body: unknown): number {
    if (!isRecord(body) || !Array.isArray(body.content)) {
        return 0;
    }
    let n = 0;
    for (const block of body.content) {
        if (!isRecord(block)) {
            continue;
        }
        if (block.type === 'text') {
            n += count(block.text);
        } else if (block.type === 'thinking') {
            n += count(block.thinking);
        } else if (block.type === 'tool_use' && block.input !== undefined) {
            n += JSON.stringify(block.input).length;
        }
    }
    return n;
}

/**
 * Follows a server-sent event stream of Messages events: the output so far
 * and the usage. `message_start` carries the prompt's counts and
 * `message_delta` the cumulative output (and sometimes the prompt's counts
 * again); usage is known once a `message_delta` with `output_tokens`
 * follows a `message_start`. Lines are read as they complete; a partial
 * line waits for the next chunk.
 */
export class MessagesStreamMeter {
    outputChars = 0;
    done = false;
    private counts: Counts = {};
    private started = false;
    private delivered = false;
    private pending = '';
    get usage(): ReportedUsage | undefined {
        return this.started && this.delivered ? reported(this.counts) : undefined;
    }
    push(text: string) {
        this.pending += text;
        // A single line past 8 MB is not a Messages event.
        if (this.pending.length > 8 * 1024 * 1024) {
            this.pending = '';
        }
        let newline: number;
        while ((newline = this.pending.indexOf('\n')) >= 0) {
            const line = this.pending.slice(0, newline).replace(/\r$/, '');
            this.pending = this.pending.slice(newline + 1);
            this.line(line);
        }
    }
    /** Takes the counts `usage` has, keeping the others. */
    private take(usage: unknown) {
        for (const [key, value] of Object.entries(countsOf(usage))) {
            if (value !== undefined) {
                this.counts[key as keyof Counts] = value;
            }
        }
    }
    private line(line: string) {
        if (!line.startsWith('data:')) {
            return;
        }
        let event: unknown;
        try {
            event = JSON.parse(line.slice(5).trim());
        } catch {
            return;
        }
        if (!isRecord(event)) {
            return;
        }
        switch (event.type) {
            case 'message_start':
                this.started = true;
                this.delivered = false;
                this.counts = {};
                if (isRecord(event.message)) {
                    this.take(event.message.usage);
                }
                break;
            case 'message_delta':
                if (!this.started) {
                    break;
                }
                this.take(event.usage);
                if (isRecord(event.usage) && whole(event.usage.output_tokens) !== undefined) {
                    this.delivered = true;
                }
                break;
            case 'content_block_delta': {
                const delta = event.delta;
                if (!isRecord(delta)) {
                    break;
                }
                if (delta.type === 'text_delta') {
                    this.outputChars += count(delta.text);
                } else if (delta.type === 'input_json_delta') {
                    this.outputChars += count(delta.partial_json);
                } else if (delta.type === 'thinking_delta') {
                    this.outputChars += count(delta.thinking);
                }
                break;
            }
            case 'message_stop':
                this.done = true;
                break;
        }
    }
    get outputTokens() {
        return tokensOfChars(this.outputChars);
    }
}
