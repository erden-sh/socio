import { CHARS_PER_TOKEN } from './chat-request.js';

/**
 * Reading a backend's answer as it passes (CB-239): the usage it
 * reports (the last chunk of a stream, or the body), and, for when it
 * reports none or runs past its limit, the characters it has produced so
 * far. Nothing is kept: the text is counted and forwarded, never stored.
 */

export interface ReportedUsage {
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
}

const count = (value: unknown) => (typeof value === 'string' ? value.length : 0);
const whole = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;

/** The `usage` object of a chunk or body, when it is well formed. */
export function usageOf(value: unknown): ReportedUsage | undefined {
    if (typeof value !== 'object' || value === null) {
        return undefined;
    }
    const usage = (value as { usage?: unknown }).usage;
    if (typeof usage !== 'object' || usage === null) {
        return undefined;
    }
    const record = usage as Record<string, unknown>;
    const prompt = whole(record.prompt_tokens);
    const completion = whole(record.completion_tokens);
    if (prompt === undefined || completion === undefined) {
        return undefined;
    }
    const details = record.prompt_tokens_details as Record<string, unknown> | undefined;
    return {
        promptTokens: prompt,
        completionTokens: completion,
        cachedTokens: whole(details?.cached_tokens) ?? 0,
    };
}

/** Characters of output in a choice's `delta` or `message`. */
function outputChars(part: unknown): number {
    if (typeof part !== 'object' || part === null) {
        return 0;
    }
    const record = part as Record<string, unknown>;
    let n = count(record.content) + count(record.reasoning_content) + count(record.reasoning) + count(record.refusal);
    if (Array.isArray(record.tool_calls)) {
        for (const call of record.tool_calls) {
            const fn = (call as { function?: Record<string, unknown> })?.function;
            n += count(fn?.name) + count(fn?.arguments);
        }
    }
    return n;
}

/** Output characters of a whole (non-streamed) answer. */
export function answerChars(body: unknown): number {
    const choices = (body as { choices?: unknown })?.choices;
    if (!Array.isArray(choices)) {
        return 0;
    }
    return choices.reduce((sum: number, choice) => sum + outputChars((choice as { message?: unknown })?.message), 0);
}

export const tokensOfChars = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);

/**
 * Follows a server-sent event stream of Chat Completions chunks: the
 * output so far and the usage of the last chunk that had one. Lines are
 * read as they complete; a partial line waits for the next chunk.
 */
export class StreamMeter {
    outputChars = 0;
    usage?: ReportedUsage;
    done = false;
    private pending = '';
    push(text: string) {
        this.pending += text;
        // A single line past 8 MB is not a Chat Completions chunk.
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
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
            this.done = true;
            return;
        }
        let chunk: unknown;
        try {
            chunk = JSON.parse(data);
        } catch {
            return;
        }
        const usage = usageOf(chunk);
        if (usage) {
            this.usage = usage;
        }
        const choices = (chunk as { choices?: unknown })?.choices;
        if (Array.isArray(choices)) {
            for (const choice of choices) {
                this.outputChars += outputChars((choice as { delta?: unknown })?.delta);
            }
        }
    }
    get outputTokens() {
        return tokensOfChars(this.outputChars);
    }
}
