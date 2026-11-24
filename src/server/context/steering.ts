import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { transaction } from '@socio/data/open';
import type { QueuedMessage } from '@socio/shared/chat/steering';
import type { AttachmentRef } from '@socio/shared/media-types';

import type { SteeringQueue } from './contract.js';

/**
 * The steering queue (CB-151): messages a person sent while their Dot's
 * turn ran, per conversation and person, oldest first. The only module that
 * reads or writes `chat_steering`.
 *
 * A message is delivered at most once: `take` removes the rows it returns
 * in one statement, so a second turn, a retry or a fallback never gets
 * them again, and an edit or a cancel after it finds nothing. The turn that
 * took them puts them in the conversation at once (`dot-agent.ts`), so
 * they are never lost either; one that cannot, puts them back (`restore`).
 * A turn's own round takes only the text before the first message with
 * attachments (`takeText`, CB-223); that one, and what follows, start the
 * next turn (`take`).
 */
const COLUMNS = 'id, text, attachments, createdAt, updatedAt';

type Row = Omit<QueuedMessage, 'attachments'> & { attachments: string | null };
/** A stored row as the chat shows it: attachments only when it has some. */
const messageOf = ({ attachments, ...message }: Row): QueuedMessage =>
    attachments
        ? {
              ...message,
              attachments: JSON.parse(attachments) as AttachmentRef[],
          }
        : message;
/** The attachments column: null for none. */
const stored = (attachments?: readonly AttachmentRef[]) => (attachments?.length ? JSON.stringify(attachments) : null);
/** A new message, as `add` stores it. */
const fresh = (text: string, now: number, attachments?: readonly AttachmentRef[]): QueuedMessage => ({
    id: randomUUID(),
    text,
    ...(attachments?.length ? { attachments: [...attachments] } : {}),
    createdAt: now,
    updatedAt: now,
});

export class SqliteSteeringQueue implements SteeringQueue {
    constructor(private db: DatabaseSync) {}
    async list(threadId: string, userId: string) {
        return (
            this.db
                .prepare(`SELECT ${COLUMNS} FROM chat_steering WHERE threadId=? AND userId=? ORDER BY createdAt, seq`)
                .all(threadId, userId) as unknown as Row[]
        ).map(messageOf);
    }
    async count(threadId: string, userId: string) {
        return (
            this.db
                .prepare('SELECT COUNT(*) AS n FROM chat_steering WHERE threadId=? AND userId=?')
                .get(threadId, userId) as { n: number }
        ).n;
    }
    async add(
        threadId: string,
        userId: string,
        text: string,
        now = Date.now(),
        attachments?: readonly AttachmentRef[],
    ) {
        const message = fresh(text, now, attachments);
        await transaction(this.db, 'queue steering message', () =>
            this.db
                .prepare(
                    'INSERT INTO chat_steering (id, threadId, userId, text, attachments, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
                )
                .run(message.id, threadId, userId, text, stored(attachments), now, now),
        );
        return message;
    }
    async addIfRoom(
        threadId: string,
        userId: string,
        text: string,
        limit: number,
        now = Date.now(),
        attachments?: readonly AttachmentRef[],
    ) {
        const message = fresh(text, now, attachments);
        const { changes } = await transaction(this.db, 'queue steering message', () =>
            this.db
                .prepare(
                    `INSERT INTO chat_steering (id, threadId, userId, text, attachments, createdAt, updatedAt)
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE (SELECT COUNT(*) FROM chat_steering WHERE threadId=? AND userId=?) < ?`,
                )
                .run(message.id, threadId, userId, text, stored(attachments), now, now, threadId, userId, limit),
        );
        return changes > 0 ? message : undefined;
    }
    async edit(
        threadId: string,
        userId: string,
        id: string,
        text: string,
        now = Date.now(),
        attachments?: readonly AttachmentRef[],
    ) {
        // Its attachments as they were, unless given.
        const row = await transaction(
            this.db,
            'edit steering message',
            () =>
                this.db
                    .prepare(
                        `UPDATE chat_steering SET text=?, attachments=CASE WHEN ? THEN ? ELSE attachments END, updatedAt=? WHERE id=? AND threadId=? AND userId=? RETURNING ${COLUMNS}`,
                    )
                    .get(text, attachments ? 1 : 0, stored(attachments), now, id, threadId, userId) as Row | undefined,
        );
        return row && messageOf(row);
    }
    async cancel(threadId: string, userId: string, id: string) {
        return transaction(
            this.db,
            'cancel steering message',
            () =>
                this.db
                    .prepare('DELETE FROM chat_steering WHERE id=? AND threadId=? AND userId=?')
                    .run(id, threadId, userId).changes > 0,
        );
    }
    async others(threadId: string, userId: string) {
        return (
            this.db
                .prepare(
                    `SELECT userId, ${COLUMNS} FROM chat_steering WHERE threadId=? AND userId!=? ORDER BY createdAt, seq`,
                )
                .all(threadId, userId) as unknown as (Row & { userId: string })[]
        ).map(({ userId: author, ...row }) => ({
            ...messageOf(row),
            userId: author,
        }));
    }
    async cancelAny(threadId: string, id: string) {
        return transaction(
            this.db,
            'cancel steering message',
            () =>
                (
                    this.db
                        .prepare('DELETE FROM chat_steering WHERE id=? AND threadId=? RETURNING userId')
                        .get(id, threadId) as { userId: string } | undefined
                )?.userId,
        );
    }
    async take(threadId: string, userId: string) {
        const rows = await transaction(
            this.db,
            'take steering messages',
            () =>
                this.db
                    .prepare(`DELETE FROM chat_steering WHERE threadId=? AND userId=? RETURNING seq, ${COLUMNS}`)
                    .all(threadId, userId) as unknown as (Row & { seq: number })[],
        );
        return rows
            .sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq)
            .map(({ seq: _seq, ...row }) => messageOf(row));
    }
    async takeText(threadId: string, userId: string, waits?: (message: QueuedMessage) => boolean) {
        // The read and the delete in one transaction: nothing comes between.
        const rows = await transaction(this.db, 'take steering messages', () => {
            const waiting = this.db
                .prepare(
                    `SELECT seq, ${COLUMNS} FROM chat_steering WHERE threadId=? AND userId=? ORDER BY createdAt, seq`,
                )
                .all(threadId, userId) as unknown as (Row & { seq: number })[];
            const first = waiting.findIndex((row) => row.attachments !== null || !!waits?.(messageOf(row)));
            const taken = first < 0 ? waiting : waiting.slice(0, first);
            const remove = this.db.prepare('DELETE FROM chat_steering WHERE seq=?');
            for (const row of taken) {
                remove.run(row.seq);
            }
            return taken;
        });
        return rows.map(({ seq: _seq, ...row }) => messageOf(row));
    }
    async restore(threadId: string, userId: string, messages: readonly QueuedMessage[]) {
        // Their times keep them before any sent since (the queue's order).
        await transaction(this.db, 'restore steering messages', () => {
            const insert = this.db.prepare(
                'INSERT OR IGNORE INTO chat_steering (id, threadId, userId, text, attachments, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
            );
            for (const message of messages) {
                insert.run(
                    message.id,
                    threadId,
                    userId,
                    message.text,
                    stored(message.attachments),
                    message.createdAt,
                    message.updatedAt,
                );
            }
        });
    }
    async ids(threadId: string) {
        return new Set(
            (this.db.prepare('SELECT id FROM chat_steering WHERE threadId=?').all(threadId) as { id: string }[]).map(
                (row) => row.id,
            ),
        );
    }
    async attachmentIds() {
        return new Set(
            (
                this.db
                    .prepare(
                        "SELECT DISTINCT json_extract(value, '$.id') AS id FROM chat_steering, json_each(chat_steering.attachments) WHERE chat_steering.attachments IS NOT NULL",
                    )
                    .all() as { id: string }[]
            ).map((row) => row.id),
        );
    }
    async waiting() {
        return this.db
            .prepare('SELECT DISTINCT threadId, userId FROM chat_steering ORDER BY threadId, userId')
            .all() as unknown as { threadId: string; userId: string }[];
    }
}

const queues = new WeakMap<DatabaseSync, SqliteSteeringQueue>();
/** One steering queue per database. */
export function steeringQueue(db: DatabaseSync): SteeringQueue {
    let queue = queues.get(db);
    if (!queue) {
        queues.set(db, (queue = new SqliteSteeringQueue(db)));
    }
    return queue;
}
