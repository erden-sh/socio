import type { DatabaseSync } from 'node:sqlite';

import { transaction } from '@socio/data/open';
import type { RoomStreamCloseReason } from '@socio/shared/rooms/rooms';

import type { RoomStreamHandle, StreamsShape } from './contract.js';

/** How often a runtime looks for streams another one ended (CB-108). */
export const ROOM_STREAM_POLL_MS = 500;
/** How often every open stream's reader is checked against the rule afresh. */
export const ROOM_STREAM_RECHECK_MS = 5_000;

interface Tracked {
    roomId: string;
    userId: string;
    /** A room's (a private chat's owner's is held for the stop and re-check). */
    room: boolean;
    handle: RoomStreamHandle;
    openedAt: number;
}

export interface RoomStreamsOptions {
    /** Whether the person may still read the room (`roomAllows` `read`). */
    mayRead(roomId: string, userId: string): boolean;
    /** Settings → General → Rooms in force (read afresh: every runtime sees it). */
    roomsOn(): boolean;
    now?: () => number;
    log?: (line: string) => void;
}

/** `runtime_signals` row kind; its id is the room's, or `<room>\u001f<person>`. */
const KIND = 'room-stream';
const SIGNAL = 'close';
/** A signal for every room (Rooms turned off). */
const EVERY_ROOM = '*';
const SEPARATOR = '\u001f';

/**
 * The open live streams of conversations, per conversation and reader (CB-212;
 * a private chat's owner's too, so the server's stop and the re-check end
 * them): what this runtime closes the moment a member is removed or leaves, the
 * room is archived or Rooms are turned off, so nobody keeps watching a room
 * they may no longer see (or, with Rooms off, watches one as if it still ran).
 * Every such end is also written to `runtime_signals`, which every other
 * runtime of a deploy (CB-108) polls every `ROOM_STREAM_POLL_MS`, as CB-232's
 * revocations do; and every open stream's reader is checked against the rule
 * afresh every `ROOM_STREAM_RECHECK_MS`, so a missed signal (or a change made
 * from the CLI) still ends it within seconds. The poll and the re-check run
 * only while a stream is open here. A stream opened after an end it hasn't seen
 * yet (a person removed and invited back) is never closed by it.
 */
export class RoomStreams implements StreamsShape {
    private tracked = new Set<Tracked>();
    private timers: ReturnType<typeof setInterval>[] = [];
    private lastSignal: number;
    private seen = new Map<string, number>();
    private on: boolean | undefined;
    private now: () => number;
    constructor(
        private db: DatabaseSync,
        private options: RoomStreamsOptions,
    ) {
        this.now = options.now ?? Date.now;
        this.lastSignal = this.now();
    }

    /** Holds a stream open for `userId` in `roomId`; returns its release. */
    open(roomId: string, userId: string, handle: RoomStreamHandle, room = true) {
        const entry: Tracked = {
            roomId,
            userId,
            room,
            handle,
            openedAt: this.now(),
        };
        this.tracked.add(entry);
        this.watch();
        return () => {
            this.tracked.delete(entry);
            if (!this.tracked.size) {
                this.unwatch();
            }
        };
    }

    /** How many streams are open here (for a room, a person in it). */
    count(roomId?: string, userId?: string) {
        let n = 0;
        for (const entry of this.tracked) {
            if (
                (roomId === undefined || entry.roomId === roomId) &&
                (userId === undefined || entry.userId === userId)
            ) {
                n += 1;
            }
        }
        return n;
    }

    /**
     * A person's streams of a room end (removed, left), or everyone's
     * (archived), here at once and on the other runtimes by their poll.
     */
    async end(roomId: string, userId: string | undefined, reason: RoomStreamCloseReason) {
        const at = this.now();
        this.close((entry) => entry.roomId === roomId && (userId === undefined || entry.userId === userId), reason, at);
        await this.signal(userId === undefined ? roomId : `${roomId}${SEPARATOR}${userId}`, reason, at);
    }

    /** Rooms were turned off: every room's streams end, everywhere. */
    async endAll(reason: RoomStreamCloseReason = 'rooms_off') {
        const at = this.now();
        this.on = false;
        this.close((entry) => entry.room, reason, at);
        await this.signal(EVERY_ROOM, reason, at);
    }

    private async signal(id: string, reason: string, at: number) {
        if (!this.db.isOpen) {
            return;
        }
        this.seen.set(id, at);
        try {
            await transaction(this.db, 'signal room streams', () => {
                this.db
                    .prepare(
                        `INSERT INTO runtime_signals VALUES(?,?,?,?,?) ON CONFLICT(kind,id,signal) DO UPDATE SET reason=excluded.reason, requestedAt=excluded.requestedAt`,
                    )
                    .run(KIND, id, SIGNAL, reason, at);
            });
        } catch {
            // The other runtimes' re-check still ends their streams.
            this.options.log?.('Rooms: the end of a stream could not be signalled.');
        }
    }

    private close(
        match: (entry: Tracked) => boolean,
        reason: RoomStreamCloseReason,
        /** Only streams opened before this moment (a later one is new access). */
        before = Number.POSITIVE_INFINITY,
    ) {
        for (const entry of [...this.tracked]) {
            if (entry.openedAt <= before && match(entry)) {
                this.tracked.delete(entry);
                try {
                    entry.handle.close(reason);
                } catch {
                    // One stream failing to close must not keep the others open.
                }
            }
        }
        if (!this.tracked.size) {
            this.unwatch();
        }
    }

    /**
     * The fast path (CB-108): the ends another runtime signaled since the
     * last poll, and the switch turned off. What it closed, as `room` or
     * `room\u001fperson` ids.
     */
    poll(): string[] {
        const ended: string[] = [];
        if (this.db.isOpen) {
            const rows = this.db
                .prepare(
                    'SELECT id, reason, requestedAt FROM runtime_signals WHERE kind=? AND signal=? AND requestedAt>=? ORDER BY requestedAt',
                )
                .all(KIND, SIGNAL, this.lastSignal) as Array<{
                id: string;
                reason: string | null;
                requestedAt: number;
            }>;
            // Same-millisecond signals are read again next time; `seen` dedupes.
            if (rows.length) {
                this.lastSignal = rows.at(-1)!.requestedAt;
            }
            for (const row of rows) {
                if ((this.seen.get(row.id) ?? -1) >= row.requestedAt) {
                    continue;
                }
                this.seen.set(row.id, row.requestedAt);
                const reason = (row.reason ?? 'access') as RoomStreamCloseReason;
                const [roomId, userId] = row.id.split(SEPARATOR);
                this.close(
                    (entry) =>
                        (row.id === EVERY_ROOM && entry.room) ||
                        (entry.roomId === roomId && (userId === undefined || entry.userId === userId)),
                    reason,
                    row.requestedAt,
                );
                ended.push(row.id);
            }
            if (this.seen.size > 10_000) {
                for (const [id, at] of this.seen) {
                    if (this.now() - at > 60 * 60_000) {
                        this.seen.delete(id);
                    }
                }
            }
        }
        // The switch, read afresh: another runtime's admin may have turned it.
        const on = this.options.roomsOn();
        if (this.on === true && !on) {
            this.close((entry) => entry.room, 'rooms_off');
            ended.push(EVERY_ROOM);
        }
        this.on = on;
        return ended;
    }

    /**
     * The guarantee: every open stream's reader may still read the room;
     * the others are closed. How many.
     */
    recheck() {
        let closed = 0;
        for (const entry of [...this.tracked]) {
            let allowed: boolean;
            try {
                allowed = this.options.mayRead(entry.roomId, entry.userId);
            } catch {
                // A check that fails is no reason to keep it open.
                allowed = false;
            }
            if (allowed) {
                continue;
            }
            this.close((other) => other === entry, 'access');
            closed += 1;
        }
        return closed;
    }

    private watch() {
        if (this.timers.length) {
            return;
        }
        this.on ??= this.options.roomsOn();
        const poll = setInterval(() => {
            try {
                this.poll();
            } catch {
                this.options.log?.('Rooms: reading the ends of streams failed.');
            }
        }, ROOM_STREAM_POLL_MS);
        const recheck = setInterval(() => this.recheck(), ROOM_STREAM_RECHECK_MS);
        poll.unref();
        recheck.unref();
        this.timers.push(poll, recheck);
    }
    private unwatch() {
        for (const timer of this.timers.splice(0)) {
            clearInterval(timer);
        }
    }

    /** Closes every stream here (the server stopping) and stops watching. */
    stop() {
        for (const entry of [...this.tracked]) {
            this.tracked.delete(entry);
            try {
                entry.handle.close();
            } catch {
                // Closing on the way out.
            }
        }
        this.unwatch();
    }
}
