import type { DatabaseSync } from 'node:sqlite';

import type { RoomPinOrigin, RoomPinStatus } from '@socio/shared/rooms/room-pins';

/** A `chat_pins` row (chat migration 9, CB-217). */
export interface StoredPin {
    id: string;
    threadId: string;
    pinId: string;
    version: number | null;
    text: string;
    status: RoomPinStatus;
    origin: RoomPinOrigin;
    supersedes: string | null;
    pinnedBy: string | null;
    proposedBy: string;
    proposedAt: number;
    decidedBy: string | null;
    decidedAt: number | null;
    endedBy: string | null;
    endedAt: number | null;
}

const COLUMNS =
    'id, threadId, pinId, version, text, status, origin, supersedes, pinnedBy, proposedBy, proposedAt, decidedBy, decidedAt, endedBy, endedAt';

/**
 * A room's pinned facts and proposals (CB-217), one row per version: the
 * only code that reads or writes `chat_pins`. Synchronous statements, run
 * by the pins service inside its unit of work (`RoomPins`), so a check and
 * the change it allows are one transaction.
 */
export class SqlitePinRepository {
    constructor(private db: DatabaseSync) {}

    private rows(sql: string, ...params: Array<string | number>) {
        return (this.db.prepare(sql).all(...params) as unknown as StoredPin[]).map((row) => ({ ...row }));
    }

    /** The facts pinned in a thread now, oldest pin first. */
    inUse(threadId: string): StoredPin[] {
        return this.rows(
            `SELECT ${COLUMNS} FROM chat_pins AS p WHERE threadId=? AND status='pinned'
       ORDER BY (SELECT MIN(COALESCE(decidedAt, proposedAt)) FROM chat_pins WHERE pinId=p.pinId AND version IS NOT NULL), pinId`,
            threadId,
        );
    }

    /** Proposals waiting in a thread, oldest first. */
    waiting(threadId: string): StoredPin[] {
        return this.rows(
            `SELECT ${COLUMNS} FROM chat_pins WHERE threadId=? AND status='proposed' ORDER BY proposedAt, id`,
            threadId,
        );
    }

    /** One row of the thread, by its id. */
    get(threadId: string, id: string): StoredPin | undefined {
        return this.rows(`SELECT ${COLUMNS} FROM chat_pins WHERE threadId=? AND id=?`, threadId, id)[0];
    }

    /** A pin's version in use, if it is pinned now. */
    current(threadId: string, pinId: string): StoredPin | undefined {
        return this.rows(
            `SELECT ${COLUMNS} FROM chat_pins WHERE threadId=? AND pinId=? AND status='pinned'`,
            threadId,
            pinId,
        )[0];
    }

    /** Every version and proposal of a pin, newest first. */
    history(threadId: string, pinId: string): StoredPin[] {
        return this.rows(
            `SELECT ${COLUMNS} FROM chat_pins WHERE threadId=? AND pinId=?
       ORDER BY COALESCE(endedAt, decidedAt, proposedAt) DESC, COALESCE(version, 0) DESC, id DESC`,
            threadId,
            pinId,
        );
    }

    insert(row: StoredPin) {
        this.db
            .prepare(`INSERT INTO chat_pins (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(
                row.id,
                row.threadId,
                row.pinId,
                row.version,
                row.text,
                row.status,
                row.origin,
                row.supersedes,
                row.pinnedBy,
                row.proposedBy,
                row.proposedAt,
                row.decidedBy,
                row.decidedAt,
                row.endedBy,
                row.endedAt,
            );
    }

    /**
     * A row moves on from `from` (as read in this unit of work): false when
     * it no longer is, so nothing changed.
     */
    move(
        id: string,
        from: RoomPinStatus,
        to: Pick<StoredPin, 'status'> &
            Partial<Pick<StoredPin, 'version' | 'pinnedBy' | 'decidedBy' | 'decidedAt' | 'endedBy' | 'endedAt'>>,
    ): boolean {
        const fields = Object.entries(to).filter(([, value]) => value !== undefined);
        const { changes } = this.db
            .prepare(`UPDATE chat_pins SET ${fields.map(([field]) => `${field}=?`).join(', ')} WHERE id=? AND status=?`)
            .run(...fields.map(([, value]) => value as string | number | null), id, from);
        return Number(changes) === 1;
    }

    /** The proposals waiting to change a pin. */
    changesWaiting(threadId: string, pinId: string): StoredPin[] {
        return this.rows(
            `SELECT ${COLUMNS} FROM chat_pins WHERE threadId=? AND pinId=? AND status='proposed'`,
            threadId,
            pinId,
        );
    }
}
