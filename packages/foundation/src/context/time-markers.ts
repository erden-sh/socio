import type { ContentPart, ModelMessage } from '@tanstack/ai';

import { DEFAULT_TIME_ZONE } from '@socio/shared/time-zone';

import { isNotesPart, isTurnNote, partsOf } from './turn-note.js';

/**
 * The date and time along a thread (CB-141). The system prompt carries no
 * date, so it stays the same, byte for byte, across days and a model's
 * prefix cache keeps it. Instead a turn's person's message carries a short
 * marker with the date and time when the model has not been told them in
 * this thread yet, the date has changed, or `MARKER_EVERY_MS` has passed
 * since the last marker. A turn that needs none adds nothing.
 *
 * Markers are stored (`chat_time_markers`, one per message that has one)
 * and put back into their messages on every later turn, as a marked part
 * just before the person's words, so the prompt up to the person's newest
 * message stays the same from turn to turn. The thread's state, when the
 * model was last told and what, is its newest marker. Compaction keeps only
 * the latest marker (`fit.ts`, `pruneMarkers`), and the notes carry its
 * time once its turn is folded into them.
 *
 * A marker states the time in its turn's person's time zone (CB-159), as
 * the caller gives it, UTC when it gives none, and keeps that zone: its
 * text is stored word for word, and markers written before in UTC stay so.
 */

// Moved from `src/server/context/time-markers.ts`, which keeps the markers' store.

/** Whom notes or a marker were written for (CB-210); null before it was kept. */
export type NotesAudience = 'private' | 'shared';

/** A new marker once this long has passed since the last. */
export const MARKER_EVERY_MS = 30 * 60_000;

export interface TimeMarker {
    /** The person's message it is attached to. */
    messageId: string;
    /** The marker as the model reads it, word for word. */
    text: string;
    /** The time it tells, to the minute. */
    toldAt: number;
    /** When it was sent. */
    sentAt: number;
    /**
     * Whom it was written for (CB-210): `shared` in a chat with other people
     * in it, whose turns send it to anyone's model; null for one written
     * before this was kept.
     */
    audience?: NotesAudience | null;
}

/** A marker's text, word for word, for the time it tells in `timeZone`. */
export const markerText = (toldAt: number, timeZone: string) =>
    `[Date and time of this message: ${timeText(toldAt, timeZone)}.]`;

/** A zone's UTC offset at `at`: "UTC−4", "UTC+5:30", "UTC+0". */
export function offsetText(at: number, timeZone: string) {
    const name =
        new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
            .formatToParts(at)
            .find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
    const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name);
    if (!match) {
        return 'UTC+0';
    }
    const [, sign, hours, minutes] = match;
    return `UTC${sign === '-' ? '\u2212' : '+'}${Number(hours)}${minutes === '00' ? '' : `:${minutes}`}`;
}

/**
 * A time as the turn's note, new markers and the notes give it (CB-159),
 * in `timeZone`, named with its UTC offset: "Thu 22 Oct 2026, 04:46
 * (America/New_York, UTC−4)"; "Thu 22 Oct 2026, 08:46 (UTC)" in UTC.
 */
export function timeText(at: number, timeZone: string = DEFAULT_TIME_ZONE) {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
            timeZone,
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        })
            .formatToParts(at)
            .map((part) => [part.type, part.value]),
    ) as Record<Intl.DateTimeFormatPartTypes, string>;
    const zone = timeZone === DEFAULT_TIME_ZONE ? timeZone : `${timeZone}, ${offsetText(at, timeZone)}`;
    return `${parts.weekday} ${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} (${zone})`;
}

/**
 * A time as markers and the notes gave it before CB-159, always in UTC:
 * "2026-10-21 14:05 UTC (Wednesday)". Kept for notes folded then, so their
 * text stays the same.
 */
export function utcTimeText(at: number) {
    const time = new Date(at).toISOString();
    return `${time.slice(0, 10)} ${time.slice(11, 16)} UTC (${new Date(at).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })})`;
}

const dayOf = (at: number, timeZone: string) => new Date(at).toLocaleDateString('en-CA', { timeZone });

/**
 * Whether a turn at `now` needs a marker, after the thread's `last`: a new
 * day is one in the turn's person's `timeZone`.
 */
export function needsMarker(last: TimeMarker | undefined, now: number, timeZone: string = DEFAULT_TIME_ZONE) {
    return !last || dayOf(last.toldAt, timeZone) !== dayOf(now, timeZone) || now - last.sentAt > MARKER_EVERY_MS;
}

/** The marked part a message carries its marker in. */
export const markerPart = (marker: TimeMarker): ContentPart => ({
    type: 'text',
    content: marker.text,
    metadata: { timeMarker: marker.toldAt },
});

/** A marker part's time, when `part` is one. */
export const markerAt = (part: ContentPart) =>
    part.type === 'text' ? (part.metadata as { timeMarker?: number } | undefined)?.timeMarker : undefined;

/** Whether a part is a time marker, which is not the person's own words. */
export const isTimeMarker = (part: ContentPart) => markerAt(part) !== undefined;

/**
 * `message` with `marker` just before the person's words: after the chat's
 * notes and the turn's note when it has them, so they stay first and the
 * marker stays where later turns put it back.
 */
export function withMarker(message: ModelMessage, marker: TimeMarker): ModelMessage {
    const content = partsOf(message.content);
    if (content.some(isTimeMarker)) {
        return message;
    }
    const at = content.findIndex((part) => !isNotesPart(part) && !isTurnNote(part));
    const index = at < 0 ? content.length : at;
    return {
        ...message,
        content: [...content.slice(0, index), markerPart(marker), ...content.slice(index)],
    };
}

/**
 * The conversation with each stored marker back in its message:
 * `userIds` are the ids of its person's messages, in order.
 */
export function withTimeMarkers(
    messages: readonly ModelMessage[],
    userIds: readonly (string | undefined)[],
    markers: ReadonlyMap<string, TimeMarker>,
): ModelMessage[] {
    let user = 0;
    return messages.map((message) => {
        if (message.role !== 'user') {
            return message;
        }
        const id = userIds[user++];
        const marker = id ? markers.get(id) : undefined;
        return marker ? withMarker(message, marker) : message;
    });
}

/** The newest marker's time in `messages`, and its message's index. */
export function latestMarker(messages: readonly ModelMessage[]) {
    let latest: { at: number; index: number } | undefined;
    messages.forEach((message, index) => {
        if (message.role !== 'user' || !Array.isArray(message.content)) {
            return;
        }
        for (const part of message.content) {
            const at = markerAt(part);
            if (at !== undefined && (!latest || at >= latest.at)) {
                latest = { at, index };
            }
        }
    });
    return latest;
}

/** `messages` without the markers older than `from`. */
export function pruneMarkers(messages: readonly ModelMessage[], from: number): ModelMessage[] {
    return messages.map((message) => {
        if (
            message.role !== 'user' ||
            !Array.isArray(message.content) ||
            !message.content.some((part) => (markerAt(part) ?? Infinity) < from)
        ) {
            return message;
        }
        return {
            ...message,
            content: message.content.filter((part) => (markerAt(part) ?? Infinity) >= from),
        };
    });
}
