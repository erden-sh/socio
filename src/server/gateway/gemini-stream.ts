import { isRecord } from './chat-request.js';
import { type ReportedUsage, tokensOfChars } from './chat-stream.js';

/**
 * Reading a Gemini API backend's answer as it passes (CB-326), as
 * chat-stream.ts does for Chat Completions: the usage it reports and the
 * characters of output so far, for when it reports none or runs past its
 * limit. Nothing is kept: the text is counted and forwarded, never stored.
 *
 * A `GenerateContentResponse` carries `usageMetadata`: the prompt
 * (`promptTokenCount`, plus `toolUsePromptTokenCount`), the answer
 * (`candidatesTokenCount`) and its reasoning (`thoughtsTokenCount`, billed
 * as output), and the cached part of the prompt (`cachedContentTokenCount`).
 * A stream's chunks each carry the counts so far; the last one wins.
 */

const count = (value: unknown) => (typeof value === 'string' ? value.length : 0);
const whole = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;

/** The usage a response's `usageMetadata` reports, when it says what the prompt cost. */
function usageFrom(body: unknown, needOutput: boolean): ReportedUsage | undefined {
    if (!isRecord(body) || !isRecord(body.usageMetadata)) {
        return undefined;
    }
    const usage = body.usageMetadata;
    const prompt = whole(usage.promptTokenCount);
    const answer = whole(usage.candidatesTokenCount);
    if (prompt === undefined || (needOutput && answer === undefined)) {
        return undefined;
    }
    return {
        promptTokens: prompt + (whole(usage.toolUsePromptTokenCount) ?? 0),
        completionTokens: (answer ?? 0) + (whole(usage.thoughtsTokenCount) ?? 0),
        cachedTokens: whole(usage.cachedContentTokenCount) ?? 0,
    };
}

/** The usage of a whole (non-streamed) answer, when it is well formed. */
export function geminiUsageOf(body: unknown): ReportedUsage | undefined {
    return usageFrom(body, false);
}

/** Output characters of one response (a whole answer, or one chunk of a stream). */
export function geminiAnswerChars(body: unknown): number {
    if (!isRecord(body) || !Array.isArray(body.candidates)) {
        return 0;
    }
    let n = 0;
    for (const candidate of body.candidates) {
        const parts = isRecord(candidate) && isRecord(candidate.content) ? candidate.content.parts : undefined;
        if (!Array.isArray(parts)) {
            continue;
        }
        for (const part of parts) {
            if (!isRecord(part)) {
                continue;
            }
            n += count(part.text);
            if (isRecord(part.functionCall)) {
                n += count(part.functionCall.name) + JSON.stringify(part.functionCall.args ?? {}).length;
            }
        }
    }
    return n;
}

/**
 * Follows a server-sent event stream of `GenerateContentResponse` chunks
 * (`?alt=sse`: one `data:` line each): the output so far and the usage of
 * the last chunk that reported the answer's count. Lines are read as they
 * complete; a partial line waits for the next chunk.
 */
export class GeminiStreamMeter {
    outputChars = 0;
    usage?: ReportedUsage;
    done = false;
    private pending = '';
    push(text: string) {
        this.pending += text;
        // A single line past 8 MB is not a chunk.
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
        let chunk: unknown;
        try {
            chunk = JSON.parse(line.slice(5).trim());
        } catch {
            return;
        }
        if (!isRecord(chunk)) {
            return;
        }
        this.outputChars += geminiAnswerChars(chunk);
        this.usage = usageFrom(chunk, true) ?? this.usage;
        const candidates = Array.isArray(chunk.candidates) ? chunk.candidates : [];
        if (candidates.some((candidate) => isRecord(candidate) && typeof candidate.finishReason === 'string')) {
            this.done = true;
        }
    }
    get outputTokens() {
        return tokensOfChars(this.outputChars);
    }
}
