import { isRecord } from './chat-request.js';
import { type ReportedUsage, tokensOfChars } from './chat-stream.js';

/**
 * Reading a Responses backend's answer as it passes (CB-239), as
 * chat-stream.ts does for Chat Completions: the usage the final response
 * reports, and the characters of output so far, for when it reports none
 * or runs past its limit. Nothing is kept: the text is counted and
 * forwarded, never stored.
 */

const count = (value: unknown) => (typeof value === 'string' ? value.length : 0);
const whole = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The `usage` of a response object, when it is well formed. */
export function responsesUsageOf(value: unknown): ReportedUsage | undefined {
    if (!isRecord(value) || !isRecord(value.usage)) {
        return undefined;
    }
    const usage = value.usage;
    const prompt = whole(usage.input_tokens);
    const completion = whole(usage.output_tokens);
    if (prompt === undefined || completion === undefined) {
        return undefined;
    }
    const details = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
    return {
        promptTokens: prompt,
        completionTokens: completion,
        cachedTokens: whole(details?.cached_tokens) ?? 0,
    };
}

/** Characters of output in one item of a response's `output`. */
function itemChars(item: unknown): number {
    if (!isRecord(item)) {
        return 0;
    }
    switch (item.type) {
        case 'message':
            return list(item.content).reduce<number>(
                (sum, part) => sum + (isRecord(part) ? count(part.text) + count(part.refusal) : 0),
                0,
            );
        case 'function_call':
            return count(item.arguments);
        case 'custom_tool_call':
            return count(item.input);
        case 'reasoning':
            return [...list(item.summary), ...list(item.content)].reduce<number>(
                (sum, part) => sum + (isRecord(part) ? count(part.text) : 0),
                0,
            );
        default:
            return 0;
    }
}

/** Output characters of a whole (non-streamed) response. */
export function responsesAnswerChars(body: unknown): number {
    if (!isRecord(body)) {
        return 0;
    }
    return list(body.output).reduce<number>((sum, item) => sum + itemChars(item), 0);
}

/** Stream events whose `delta` is output text. */
const DELTAS = new Set([
    'response.output_text.delta',
    'response.refusal.delta',
    'response.function_call_arguments.delta',
    'response.custom_tool_call_input.delta',
    'response.reasoning_summary_text.delta',
    'response.reasoning_text.delta',
]);
/** Stream events that end a response and carry it, usage included. */
const ENDINGS = new Set(['response.completed', 'response.incomplete', 'response.failed']);

/**
 * Follows a server-sent event stream of Responses events: the output so
 * far and the usage of the response that ended it. Lines are read as they
 * complete; a partial line waits for the next chunk. `event:` lines are
 * ignored, since each `data:` object names its own type.
 */
export class ResponsesStreamMeter {
    outputChars = 0;
    usage?: ReportedUsage;
    done = false;
    private pending = '';
    push(text: string) {
        this.pending += text;
        // A single line past 8 MB is not a Responses event.
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
        if (!isRecord(event) || typeof event.type !== 'string') {
            return;
        }
        if (DELTAS.has(event.type)) {
            this.outputChars += count(event.delta);
        } else if (ENDINGS.has(event.type)) {
            this.done = true;
            const usage = responsesUsageOf(event.response);
            if (usage) {
                this.usage = usage;
            }
        }
    }
    get outputTokens() {
        return tokensOfChars(this.outputChars);
    }
}
