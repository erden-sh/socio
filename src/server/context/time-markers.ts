import type { DatabaseSync } from 'node:sqlite';

import { writeSoon } from '@socio/data/open';
import { markerText, needsMarker, type NotesAudience, type TimeMarker } from '@socio/foundation/context/time-markers';
import { DEFAULT_TIME_ZONE } from '@socio/shared/time-zone';

import type { TimeMarkersShape } from './contract.js';

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

/** The thread's markers, by the message each is attached to. */
export class TimeMarkerStore implements TimeMarkersShape {
    constructor(private db: DatabaseSync) {}
    /**
     * In a chat with other people in it (`shared`, CB-210), a marker not
     * written for one is given in UTC, never in the zone of the person it
     * was written for: a chat opened to others later doesn't tell them its
     * owner's zone. The same for every turn, so the prompt stays the same.
     */
    all(threadId: string, shared = false): Map<string, TimeMarker> {
        const rows = this.db
            .prepare(
                'SELECT messageId, text, toldAt, sentAt, audience FROM chat_time_markers WHERE threadId=? ORDER BY sentAt',
            )
            .all(threadId) as unknown as TimeMarker[];
        return new Map(
            rows.map(({ messageId, text, toldAt, sentAt, audience }) => [
                messageId,
                {
                    messageId,
                    text: shared && audience !== 'shared' ? markerText(toldAt, DEFAULT_TIME_ZONE) : text,
                    toldAt,
                    sentAt,
                    audience: audience ?? null,
                },
            ]),
        );
    }
    /**
     * The marker for `messageId`, written now in the person's `timeZone`;
     * the one it has, if any, unchanged. Saved with `writeSoon` (CB-110): a
     * turn marks while another chain's unit of work may be open, so the
     * turn uses the marker returned, not a read back.
     */
    mark(
        threadId: string,
        messageId: string,
        now = Date.now(),
        timeZone: string = DEFAULT_TIME_ZONE,
        shared = false,
    ): TimeMarker {
        const stored = this.all(threadId, shared).get(messageId);
        if (stored) {
            return stored;
        }
        const toldAt = Math.floor(now / 60_000) * 60_000;
        const audience: NotesAudience = shared ? 'shared' : 'private';
        const marker: TimeMarker = {
            messageId,
            text: markerText(toldAt, timeZone),
            toldAt,
            sentAt: now,
            audience,
        };
        writeSoon(this.db, 'mark the time', () =>
            this.db
                .prepare(
                    'INSERT OR IGNORE INTO chat_time_markers (threadId, messageId, text, toldAt, sentAt, audience) VALUES (?, ?, ?, ?, ?, ?)',
                )
                .run(threadId, messageId, marker.text, toldAt, now, audience),
        );
        return marker;
    }
    /**
     * A turn's markers: those of the conversation's messages (`userIds`, its
     * person's messages in order), and one for the newest if it needs one.
     * Only markers in this conversation count: one on a message since
     * edited away was never told. A new one is in the turn's person's
     * `timeZone`. In a chat with other people in it, `shared` (CB-210).
     */
    forTurn(
        threadId: string,
        userIds: readonly (string | undefined)[],
        now = Date.now(),
        timeZone: string = DEFAULT_TIME_ZONE,
        shared = false,
    ): Map<string, TimeMarker> {
        const stored = this.all(threadId, shared);
        const markers = new Map<string, TimeMarker>();
        let last: TimeMarker | undefined;
        for (const id of userIds) {
            const marker = id ? stored.get(id) : undefined;
            if (!marker) {
                continue;
            }
            markers.set(marker.messageId, marker);
            if (!last || marker.sentAt > last.sentAt) {
                last = marker;
            }
        }
        const newest = userIds.at(-1);
        if (newest && !markers.has(newest) && needsMarker(last, now, timeZone)) {
            markers.set(newest, this.mark(threadId, newest, now, timeZone, shared));
        }
        return markers;
    }
}

const storesByDb = new WeakMap<DatabaseSync, TimeMarkerStore>();
/** One marker store per database. */
export function timeMarkers(db: DatabaseSync) {
    let store = storesByDb.get(db);
    if (!store) {
        storesByDb.set(db, (store = new TimeMarkerStore(db)));
    }
    return store;
}
