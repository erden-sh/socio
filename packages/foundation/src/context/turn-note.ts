import type { ContentPart, ModelMessage } from '@tanstack/ai';

// Moved from `src/server/context/turn-note.ts`.

/**
 * The turn's note: everything in a prompt that changes from turn to turn,
 * in one place, just before the person's newest words, in the same
 * message. The Dot's turn puts the current time, the person's preferences,
 * the page, news of their requests and the modules' notes
 * (`ServerModule.dotTurnNote`, such as the reactions since the Dot's last
 * turn, CB-133) there; fitting adds the stored facts that match the
 * request (CB-139). Never in the system prompt or with the chat's notes at
 * the start: what changes every turn stays after the part of the prompt
 * that stays the same, so that part can be cached from turn to turn.
 *
 * In the newest message rather than a message of its own (CB-139 first
 * had one): both keep the same prefix, but a message of its own would be
 * a second user message in a row, which some chat templates refuse, and a
 * user message that compaction counts as a turn of its own (its anchors,
 * its kept turns). Inside the person's message it is never a turn, and its
 * part is marked, so the facts' search and a cut of a long paste skip it.
 *
 * What Socio puts in a person's message goes before their words,
 * always in this order: the chat's notes (`withNotes`, the first kept
 * message of a compacted prompt only), the turn's note (the newest message
 * only), then the message's time marker (`time-markers.ts`). What stays
 * the same from turn to turn comes first.
 */

const TURN_NOTE = { turnNote: true } as const;

/**
 * The conversation with `note` just before the person's newest words: after
 * the turn's note when it has one already, in the same part.
 */
export function withTurnNote(messages: readonly ModelMessage[], note: string): ModelMessage[] {
    if (!note) {
        return messages as ModelMessage[];
    }
    const at = newestFromPerson(messages);
    // No message from the person (a turn with no conversation yet): the note
    // is the whole of one.
    if (at < 0) {
        return [
            ...messages,
            {
                role: 'user',
                content: [{ type: 'text', content: note, metadata: TURN_NOTE }],
            },
        ];
    }
    const newest = messages[at];
    const content = partsOf(newest.content);
    // After the chat's notes, when this message carries them.
    const lead = content.findIndex((part) => !isNotesPart(part));
    const index = lead < 0 ? content.length : lead;
    const first = content[index];
    const merged = first && isTurnNote(first);
    const part: ContentPart = {
        type: 'text',
        content: merged ? `${(first as { content: string }).content}\n\n${note}` : note,
        metadata: TURN_NOTE,
    };
    return messages.with(at, {
        ...newest,
        content: [...content.slice(0, index), part, ...content.slice(merged ? index + 1 : index)],
    });
}

/** Whether a part is a turn note, which is not the person's own words. */
export const isTurnNote = (part: ContentPart) =>
    part.type === 'text' && (part.metadata as typeof TURN_NOTE | undefined)?.turnNote === true;

/** A message's content as parts. */
export const partsOf = (content: ModelMessage['content']): ContentPart[] =>
    Array.isArray(content) ? content : content ? [{ type: 'text', content }] : [];

/**
 * The chat's notes in a compacted prompt (CB-147, `notesText`): a marked
 * part at the start of the first kept message from the person, not a
 * message of their own. A message of their own would be a user message
 * right before the person's, two in a row, which strict chat templates
 * (llama.cpp's Gemma- and Mistral-style ones) refuse. The kept turns stay
 * the same until the next fold, so the notes stay where they are, byte for
 * byte, from turn to turn, and the turn's note and the time marker come
 * after them. Marked, so they are never taken for the person's words.
 */
const NOTES = { contextNotes: true } as const;

/** Whether a part is the chat's notes, which are not the person's words. */
export const isNotesPart = (part: ContentPart) =>
    part.type === 'text' && (part.metadata as typeof NOTES | undefined)?.contextNotes === true;

/**
 * The kept conversation (from a turn's start) with the chat's `notes` at
 * the start of its first message; a message of their own before it when
 * that message is not the person's.
 */
export function withNotes(messages: readonly ModelMessage[], notes: string): ModelMessage[] {
    const part: ContentPart = { type: 'text', content: notes, metadata: NOTES };
    const first = messages.at(0);
    if (first?.role !== 'user') {
        return [{ role: 'user', content: [part] }, ...messages];
    }
    return messages.with(0, {
        ...first,
        content: [part, ...partsOf(first.content)],
    });
}

/**
 * A steering message (CB-151): what the person sent while the turn ran,
 * delivered after a round's tool results, before the next round. Marked
 * while its turn runs, so the turn still starts where the person's message
 * that started it is: the turn's note, its facts and its time marker stay
 * in that message, and compaction counts no new turn, so every round's
 * prompt up to the steering message stays the same, byte for byte. Stored
 * as the person's message, unmarked, so later turns read it as any other.
 */
const STEERING = { socioSteering: true } as const;

/** The person's `text`, delivered to the running turn. */
export const steeringMessage = (text: string): ModelMessage => ({
    role: 'user',
    content: text,
    metadata: STEERING,
});

/** Whether a message was delivered to the running turn. */
export const isSteering = (message: ModelMessage) =>
    (message.metadata as typeof STEERING | undefined)?.socioSteering === true;

/** Where the person's message that started the turn is; -1 if none. */
export const newestFromPerson = (messages: readonly ModelMessage[]) =>
    messages.findLastIndex((message) => message.role === 'user' && !isSteering(message));
