import { createHash } from 'node:crypto';

import type { ContentPart, ModelMessage } from '@tanstack/ai';

import { textTokens } from '@socio/foundation/context/budget';
import { isTimeMarker } from '@socio/foundation/context/time-markers';
import { isNotesPart, isSteering, isTurnNote } from '@socio/foundation/context/turn-note';
import { PROSE_CHARS } from '@socio/shared/context-settings';

import { DATA_CHARS, messageTokens } from './budget.js';

/**
 * The cheap, deterministic part of fitting a conversation into a model's
 * context (CB-129): the same messages and level give the same result, so it
 * runs before every round and the prompt's start stays the same between
 * rounds. Nothing here changes what is stored: a tool result cut to an
 * excerpt or set aside names its ref, and `recall` reads the original.
 *
 * In order, cheapest first:
 * a. every tool result longer than the level's cap, new or old, becomes a
 *    head-and-tail excerpt with a note;
 * b. while the prompt is still over budget, results (and long arguments)
 *    older than the last few rounds are set aside, screenshots, snapshots
 *    and base64 first, then the oldest.
 * The running notes (`notes.ts`) then take whole turns if that's not enough.
 */

/** How hard to compact; later levels are for retries and tight windows. */
export interface Level {
    /** A tool result's most tokens in the prompt. */
    capTokens: number;
    /**
     * The rounds whose results are never set aside: the last ones, and the
     * last ones before the current turn.
     */
    keepRounds: number;
    /** The turns never folded into the notes (the current one included). */
    keepTurns: number;
}

/** The levels for a budget of `target` tokens, gentlest first. */
export function levels(target: number): Level[] {
    // The CLI keeps a tool output at 10k tokens; small windows keep less.
    const cap = Math.min(10_000, Math.max(400, Math.floor(target * 0.1)));
    return [
        { capTokens: cap, keepRounds: 4, keepTurns: 3 },
        {
            capTokens: Math.max(250, Math.floor(cap / 2)),
            keepRounds: 2,
            keepTurns: 2,
        },
        {
            capTokens: Math.max(150, Math.floor(cap / 4)),
            keepRounds: 1,
            keepTurns: 1,
        },
    ];
}

/** Results this short are never set aside: a stub would be as long. */
const STUB_MIN_CHARS = 600;
/** What a set-aside result still shows of its start. */
const PREVIEW_CHARS = 160;

const sizeText = (chars: number) => (chars >= 1_000 ? `${Math.round(chars / 1_000)}k chars` : `${chars} chars`);

/** The note a result cut to an excerpt starts with. */
export const excerptNote = (tool: string, chars: number, ref: string) =>
    `[${tool} result, ${sizeText(chars)}; excerpt shown; call recall with ref ${ref} for the rest]`;

/** A result cut to its head and tail, with the note. */
export function excerpt(text: string, tool: string, ref: string, capTokens: number) {
    const note = excerptNote(tool, text.length, ref);
    const room = Math.max(200, Math.floor(capTokens * DATA_CHARS) - note.length - 10);
    const head = Math.ceil((room * 2) / 3);
    const tail = room - head;
    return `${note}\n${text.slice(0, head)}\n[…]\n${text.slice(text.length - tail)}`;
}

/** A result set aside: its size, where to read it and how it began. */
export function stub(text: string, tool: string, ref: string) {
    const preview = text
        .slice(0, PREVIEW_CHARS)
        .replace(/[A-Za-z0-9+/=]{40,}/g, '…')
        .replace(/\s+/g, ' ')
        .trim();
    return `[${tool} result, ${sizeText(text.length)}, set aside to keep this chat within the model’s limits; call recall with ref ${ref} to read it. It began: ${preview}${text.length > PREVIEW_CHARS ? '…' : ''}]`;
}

/** Long arguments of an old call, set aside (still a JSON object). */
const argumentsStub = (chars: number, ref: string) =>
    JSON.stringify({
        note: `[arguments, ${sizeText(chars)}, set aside; call recall with ref ${ref}:args to read them]`,
    });

const textOf = (content: ModelMessage['content']) =>
    typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
                .map((part) => ('content' in part && typeof part.content === 'string' ? part.content : ''))
                .join('\n')
          : '';

/** Screenshots, page snapshots and base64 go first. */
const isMedia = (tool: string, text: string) => /screenshot|snapshot/.test(tool) || /[A-Za-z0-9+/=]{400,}/.test(text);

/**
 * Where each turn starts: at each user message (the first turn at 0), but
 * a steering message, which is within the running turn (CB-151).
 */
export function turnStarts(messages: readonly ModelMessage[]) {
    const starts = messages.flatMap((message, index) =>
        message.role === 'user' && !isSteering(message) ? [index] : [],
    );
    if (!starts.length || starts[0] !== 0) {
        starts.unshift(0);
    }
    return starts;
}

/** The tool each call id belongs to. */
export function toolNames(messages: readonly ModelMessage[]) {
    const names = new Map<string, string>();
    for (const message of messages) {
        for (const call of message.toolCalls ?? []) {
            names.set(call.id, call.function.name);
        }
    }
    return names;
}

export interface Compacted {
    /** The same length as the input, message for message. */
    messages: ModelMessage[];
    /** Results and arguments cut or set aside. */
    stubbed: number;
    /** The messages' estimated tokens now (uncalibrated). */
    tokens: number;
    /** The originals of what was cut or set aside, by ref. */
    originals: Map<string, { tool: string; text: string }>;
}

// Cut results are the same strings round after round: cut once per cap.
const cuts = new WeakMap<ModelMessage, Map<number, ModelMessage>>();

/**
 * Steps a and b: the messages within `budget` tokens if cutting and setting
 * aside results can do it; otherwise as small as this level makes them.
 */
export function compactMessages(messages: readonly ModelMessage[], level: Level, budget: number): Compacted {
    const names = toolNames(messages);
    const originals = new Map<string, { tool: string; text: string }>();
    const out = messages.slice();
    let stubbed = 0;
    // a. Cap every tool result.
    for (let index = 0; index < out.length; index++) {
        const message = out[index];
        if (message.role !== 'tool' || !message.toolCallId) {
            continue;
        }
        const text = textOf(message.content);
        if (textTokens(text, DATA_CHARS) <= level.capTokens) {
            continue;
        }
        const ref = message.toolCallId;
        const tool = names.get(ref) ?? 'tool';
        originals.set(ref, { tool, text });
        let byCap = cuts.get(message);
        if (!byCap) {
            cuts.set(message, (byCap = new Map()));
        }
        let cut = byCap.get(level.capTokens);
        if (!cut) {
            cut = {
                ...message,
                content: excerpt(text, tool, ref, level.capTokens),
            };
            byCap.set(level.capTokens, cut);
        }
        out[index] = cut;
        stubbed += 1;
    }
    let tokens = out.reduce((sum, message) => sum + messageTokens(message), 0);
    if (tokens <= budget) {
        return { messages: out, stubbed, tokens, originals };
    }

    // b. Set aside results older than the last `keepRounds` rounds.
    const rounds = out.flatMap((message, index) =>
        message.role === 'assistant' && message.toolCalls?.length ? [index] : [],
    );
    const recentFrom = rounds.at(-level.keepRounds) ?? out.length;
    // The earlier turns' rounds kept at the current turn's first round stay
    // kept for all of it: the prompt before the person's newest message is
    // then the same from round to round, for a model's prefix cache (CB-139).
    const current = turnStarts(messages).at(-1)!;
    const keptBefore = rounds.filter((index) => index < current).at(-level.keepRounds) ?? 0;
    const old: number[] = [];
    for (let index = 0; index < recentFrom; index++) {
        if (index >= keptBefore && index < current) {
            continue;
        }
        const message = out[index];
        if (message.role === 'tool' && message.toolCallId) {
            const original = messages[index];
            if (textOf(original.content).length > STUB_MIN_CHARS) {
                old.push(index);
            }
        } else if (
            message.role === 'assistant' &&
            (message.thinking?.length ||
                message.toolCalls?.some((call) => (call.function.arguments ?? '').length > STUB_MIN_CHARS))
        ) {
            old.push(index);
        }
    }
    const media = (index: number) => {
        const message = messages[index];
        return message.role === 'tool' && isMedia(names.get(message.toolCallId ?? '') ?? '', textOf(message.content))
            ? 0
            : 1;
    };
    // Media first, then oldest first: a stable order, so a stable prompt.
    old.sort((a, b) => media(a) - media(b) || a - b);
    for (const index of old) {
        if (tokens <= budget) {
            break;
        }
        const message = out[index];
        const before = messageTokens(message);
        let next: ModelMessage;
        if (message.role === 'tool') {
            const ref = message.toolCallId!;
            const tool = names.get(ref) ?? 'tool';
            const text = textOf(messages[index].content);
            originals.set(ref, { tool, text });
            next = { ...message, content: stub(text, tool, ref) };
            if (out[index] === messages[index]) {
                stubbed += 1;
            }
        } else {
            next = {
                ...message,
                thinking: undefined,
                toolCalls: message.toolCalls?.map((call) => {
                    const args = call.function.arguments ?? '';
                    if (args.length <= STUB_MIN_CHARS) {
                        return call;
                    }
                    stubbed += 1;
                    originals.set(`${call.id}:args`, {
                        tool: call.function.name,
                        text: args,
                    });
                    return {
                        ...call,
                        function: {
                            ...call.function,
                            arguments: argumentsStub(args.length, call.id),
                        },
                    };
                }),
            };
            if (!next.thinking) {
                delete next.thinking;
            }
        }
        out[index] = next;
        tokens += messageTokens(next) - before;
    }
    return { messages: out, stubbed, tokens, originals };
}

/** The note a person's message cut to an excerpt starts with. */
export const messageNote = (chars: number, ref: string) =>
    `[the person’s message, ${sizeText(chars)}; excerpt shown; call recall with ref ${ref} for the rest]`;

/**
 * The last resort, when even the hardest level leaves the prompt over
 * `budget`: the longest messages of the person's (a huge paste) cut to a
 * head-and-tail excerpt, largest first, so the turn can still be answered.
 * Each original goes to `originals` under a ref made from its text.
 */
export function capPersonMessages(
    messages: readonly ModelMessage[],
    level: Level,
    budget: number,
    originals: Map<string, { tool: string; text: string }>,
) {
    const out = messages.slice();
    let tokens = out.reduce((sum, message) => sum + messageTokens(message), 0);
    const cap = Math.max(level.capTokens * 2, Math.floor(budget * 0.25));
    const long = out
        .flatMap((message, index) => (message.role === 'user' && messageTokens(message) > cap ? [index] : []))
        .sort((a, b) => messageTokens(out[b]) - messageTokens(out[a]) || a - b);
    let capped = 0;
    for (const index of long) {
        if (tokens <= budget) {
            break;
        }
        const message = out[index];
        // The chat's notes, the turn's note and the time marker are not the
        // person's words: they stay whole (CB-147, CB-139, CB-141).
        const ours = (part: ContentPart) => isNotesPart(part) || isTurnNote(part) || isTimeMarker(part);
        const notes = Array.isArray(message.content) ? message.content.filter(ours) : [];
        const text = textOf(
            Array.isArray(message.content) ? message.content.filter((part) => !ours(part)) : message.content,
        );
        if (textTokens(text) <= cap) {
            continue;
        }
        const ref = `message:paste-${createHash('sha256').update(text).digest('base64url').slice(0, 12)}`;
        originals.set(ref, { tool: 'message', text });
        const room = Math.max(400, Math.floor(cap * PROSE_CHARS));
        const head = Math.ceil((room * 2) / 3);
        const cut = `${messageNote(text.length, ref)}\n${text.slice(0, head)}\n[…]\n${text.slice(text.length - (room - head))}`;
        const next: ModelMessage = {
            ...message,
            content: Array.isArray(message.content)
                ? [...notes, { type: 'text', content: cut }, ...message.content.filter((part) => part.type !== 'text')]
                : cut,
        };
        tokens += messageTokens(next) - messageTokens(message);
        out[index] = next;
        capped += 1;
    }
    return { messages: out, tokens, capped };
}
