import type { ModelMessage } from '@tanstack/ai';

import { textTokens } from '@socio/foundation/context/budget';
import { PROSE_CHARS } from '@socio/shared/context-settings';

/**
 * A model's context budget and cheap token estimates (CB-129). Estimates
 * are characters over a weight per kind of text, corrected per model by
 * the prompt sizes the model reports (`calibrate`). No tokenizer: this runs
 * before every model round.
 */

/** Of tool results and arguments: JSON, code and numbers are denser. */
export const DATA_CHARS = 3.5;
/** What an image part costs, whatever its size. */
export const IMAGE_TOKENS = 1_000;
/** Each message's own framing (role, separators). */
const MESSAGE_TOKENS = 4;

type Part = { type?: unknown; content?: unknown; text?: unknown };

function contentTokens(content: ModelMessage['content'], chars: number) {
    if (typeof content === 'string') {
        return textTokens(content, chars);
    }
    if (!Array.isArray(content)) {
        return 0;
    }
    let tokens = 0;
    for (const part of content as Part[]) {
        if (part.type === 'image') {
            tokens += IMAGE_TOKENS;
        } else if (typeof part.content === 'string') {
            tokens += textTokens(part.content, chars);
        } else if (typeof part.text === 'string') {
            tokens += textTokens(part.text, chars);
        } else {
            tokens += textTokens(JSON.stringify(part) ?? '', chars);
        }
    }
    return tokens;
}

// Messages are the same objects round after round: each is measured once.
const measured = new WeakMap<object, number>();

/** A message's estimated tokens (uncalibrated). */
export function messageTokens(message: ModelMessage): number {
    const known = measured.get(message);
    if (known !== undefined) {
        return known;
    }
    let tokens = MESSAGE_TOKENS + contentTokens(message.content, message.role === 'tool' ? DATA_CHARS : PROSE_CHARS);
    for (const call of message.toolCalls ?? []) {
        tokens +=
            MESSAGE_TOKENS + textTokens(call.function.name) + textTokens(call.function.arguments ?? '', DATA_CHARS);
    }
    for (const thought of message.thinking ?? []) {
        tokens += textTokens(thought.content);
    }
    measured.set(message, tokens);
    return tokens;
}

export const messagesTokens = (messages: readonly ModelMessage[]) =>
    messages.reduce((sum, message) => sum + messageTokens(message), 0);

/** System prompts and tool definitions: the part of a round compaction can't touch. */
export function fixedTokens(systemPrompts: readonly unknown[], tools: unknown) {
    const prompts = systemPrompts
        .map((prompt) =>
            typeof prompt === 'string' ? prompt : String((prompt as { content?: unknown })?.content ?? ''),
        )
        .join('\n');
    const definitions = Array.isArray(tools)
        ? JSON.stringify(
              tools.map((tool: Record<string, unknown>) => ({
                  name: tool.name,
                  description: tool.description,
                  inputSchema: tool.inputSchema,
              })),
          )
        : '';
    return textTokens(prompts) + textTokens(definitions, DATA_CHARS);
}

/**
 * Per model, how the prompt sizes it reports compare with the estimates:
 * estimates are multiplied by this. Learned in memory, as rounds go.
 */
const ratios = new Map<string, number>();
const clampRatio = (ratio: number) => Math.min(3, Math.max(0.6, ratio));

export const calibration = (key: string) => ratios.get(key) ?? 1;

/** A round's reported prompt size against its estimate. */
export function calibrate(key: string, estimated: number, reported: number) {
    if (!(estimated >= 500) || !(reported > 0)) {
        return;
    }
    const ratio = clampRatio(reported / estimated);
    const known = ratios.get(key);
    ratios.set(key, known === undefined ? ratio : (known + ratio) / 2);
}

/** The model refused a prompt as too long: its estimates were low. */
export function distrust(key: string) {
    ratios.set(key, clampRatio(calibration(key) * 1.25));
}

/** Tests only: forgets what was learned. */
export const resetCalibration = () => ratios.clear();
