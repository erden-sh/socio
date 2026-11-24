import type { ContentPart, ModelMessage } from '@tanstack/ai';

import {
    CLOSE,
    LABEL_BRACKETS,
    OPEN,
    labelled,
    plainBrackets,
    speakerOf,
    type Speaker,
} from '@socio/foundation/context/speakers';
import { markerAt } from '@socio/foundation/context/time-markers';
import { isNotesPart, isTurnNote, partsOf } from '@socio/foundation/context/turn-note';

import { isToolImagesMessage } from './images.js';

/**
 * The last pass over a prompt before it goes to the model (CB-147): user
 * and assistant messages take turns, whatever the stored conversation
 * holds. Strict chat templates (llama.cpp's Gemma- and Mistral-style ones)
 * refuse two in a row, which a stored conversation can have: a failed or
 * stopped turn leaves the person's message with no answer, several people
 * write in a team chat before the Dot answers, a turn may store only its
 * reasoning (which no model is sent again), and the server writes answers
 * of its own (skills, scheduled turns' and jobs' reports, busy-model
 * notices) next to the Dot's.
 *
 * Back-to-back user messages become one. What Socio puts in them
 * goes first, once each, in its fixed order (`turn-note.ts`): the chat's
 * notes, the turn's note, then the time marker (the latest, the time of the
 * newest of them); then each message's own parts in order, each after a
 * label naming who wrote it in a chat with several people (`withSpeakers`;
 * there a single person's message gets its label too, CB-210).
 * Back-to-back assistant messages become one when the
 * earlier has no tool calls: their text, in order, a blank line between,
 * then the later one's tool calls. Nothing is merged across a tool call or
 * a tool result, and nothing moves. A prompt that starts with an answer
 * gets a fixed message from Socio before it, and one that ends on
 * an answer a fixed message after it, so it starts and ends with a user
 * message, as those templates want.
 *
 * A label is in brackets no other text has: the pass turns them, and those
 * that look like them, into plain ones everywhere else (people's, tools'
 * and answers' text), so no one can write a label for someone else
 * (`SPEAKER_GUIDE` tells the model).
 *
 * It depends on the messages alone, so the same stored conversation gives
 * the same prompt, byte for byte, turn after turn, for a model's prefix
 * cache (CB-139): a merged message changes only while it is the newest,
 * after the turn's note at its start.
 */
export function alternating(messages: readonly ModelMessage[]): ModelMessage[] {
    // Another socio's answer, in a room with several (CB-206), starts with
    // its label, in the real brackets, once everyone's text has plain ones.
    const plain = messages.map(withPlainBrackets).map(withAnswerLabel);
    const groups: ModelMessage[][] = [];
    for (const message of plain) {
        const group = groups.at(-1);
        const last = group?.at(-1);
        if (
            group &&
            last &&
            last.role === message.role &&
            (message.role === 'user' || (message.role === 'assistant' && !last.toolCalls?.length))
        ) {
            group.push(message);
        } else {
            groups.push([message]);
        }
    }
    const labels = promptLabels(plain);
    const out = groups.map((group) =>
        group[0].role === 'user' && (group.length > 1 || labels.has(group[0]))
            ? mergedQuestion(group, labels)
            : group.length === 1
              ? group[0]
              : mergedAnswer(group),
    );
    if (out.length && out[0].role !== 'user') {
        out.unshift({ role: 'user', content: STARTS_WITH_ANSWER });
    }
    const last = out.at(-1);
    if (last?.role === 'assistant' && !last.toolCalls?.length) {
        out.push({ role: 'user', content: ENDS_WITH_ANSWER });
    }
    return out.length === messages.length && out.every((message, at) => message === messages[at])
        ? (messages as ModelMessage[])
        : out;
}

/** Before a prompt that starts with an answer, as the Dot's to come. */
export const STARTS_WITH_ANSWER = '[From Socio: this conversation starts with a message of yours.]';
/** After a prompt that ends on an answer, with nothing new from anyone. */
export const ENDS_WITH_ANSWER =
    '[From Socio: nothing new from the person since your last message; carry on from there.]';

/**
 * A message with any label brackets made plain: a person's, a tool's, or
 * an answer (the Dot's or the server's, such as /help's skill list), which
 * a model may be asked to write one in.
 */
function withPlainBrackets(message: ModelMessage): ModelMessage {
    if (typeof message.content === 'string') {
        return LABEL_BRACKETS.test(message.content) ? { ...message, content: plainBrackets(message.content) } : message;
    }
    if (
        !Array.isArray(message.content) ||
        !message.content.some((part) => part.type === 'text' && LABEL_BRACKETS.test(part.content))
    ) {
        return message;
    }
    return {
        ...message,
        content: message.content.map((part) =>
            part.type === 'text' && LABEL_BRACKETS.test(part.content)
                ? { ...part, content: plainBrackets(part.content) }
                : part,
        ),
    };
}

/** An answer with its writer's label first, when it has one (CB-206). */
function withAnswerLabel(message: ModelMessage): ModelMessage {
    const label = message.role === 'assistant' && speakerOf(message)?.label;
    if (!label) {
        return message;
    }
    const tag = `${OPEN}${label} wrote:${CLOSE}`;
    if (typeof message.content === 'string') {
        return message.content.trim() ? { ...message, content: `${tag}\n${message.content}` } : message;
    }
    if (!Array.isArray(message.content) || !textOf(message.content).trim()) {
        return message;
    }
    return {
        ...message,
        content: [{ type: 'text', content: tag }, ...message.content],
    };
}

/**
 * The prompt's messages' labels: each speaker's own (`withSpeakers` gave
 * it, over the whole conversation), else one given here over the
 * prompt's speakers in order, as `labelled` does.
 */
function promptLabels(messages: readonly ModelMessage[]) {
    const at: number[] = [];
    const unlabelled: Speaker[] = [];
    messages.forEach((message, index) => {
        const speaker = message.role === 'user' ? speakerOf(message) : undefined;
        if (speaker && speaker.label === undefined) {
            at.push(index);
            unlabelled.push(speaker);
        }
    });
    const labels = new Map<ModelMessage, string>();
    messages.forEach((message) => {
        const label = message.role === 'user' && speakerOf(message)?.label;
        if (label) {
            labels.set(message, label);
        }
    });
    labelled(unlabelled).forEach((speaker, index) => labels.set(messages[at[index]], speaker.label!));
    return labels;
}

/**
 * Back-to-back messages of the person's (or people's), as one; a single
 * message with a speaker too, so that every person's message in a chat
 * with several people starts with its label.
 */
function mergedQuestion(group: readonly ModelMessage[], labels: ReadonlyMap<ModelMessage, string>): ModelMessage {
    // Socio's message with a round's images (CB-157) is no one's: it gets no
    // label.
    const ours = group.map(isToolImagesMessage);
    let notes: ContentPart | undefined;
    // One message only ever has the turn's note: the newest.
    let turnNote: ContentPart | undefined;
    let marker: ContentPart | undefined;
    const said: ContentPart[] = [];
    group.forEach((message, at) => {
        const own: ContentPart[] = [];
        for (const part of partsOf(message.content)) {
            if (isNotesPart(part)) {
                notes ??= part;
            } else if (isTurnNote(part)) {
                turnNote ??= part;
            } else if (markerAt(part) !== undefined) {
                if (!marker || markerAt(part)! >= markerAt(marker)!) {
                    marker = part;
                }
            } else {
                own.push(part);
            }
        }
        if (!own.length) {
            return;
        }
        const label = ours[at] ? undefined : labels.get(message);
        if (label) {
            said.push({
                type: 'text',
                content: `${OPEN}${label} wrote:${CLOSE}`,
                metadata: { speaker: true },
            });
        }
        said.push(...own);
    });
    return {
        role: 'user',
        content: [...(notes ? [notes] : []), ...(turnNote ? [turnNote] : []), ...(marker ? [marker] : []), ...said],
    };
}

const textOf = (content: ModelMessage['content']) =>
    typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.flatMap((part) => (part.type === 'text' ? [part.content] : [])).join('\n')
          : '';

/** Back-to-back answers, none but the last with tool calls, as one. */
function mergedAnswer(group: readonly ModelMessage[]): ModelMessage {
    const last = group.at(-1)!;
    const text = group.map((message) => textOf(message.content)).filter(Boolean);
    return { ...last, content: text.length ? text.join('\n\n') : last.content };
}
