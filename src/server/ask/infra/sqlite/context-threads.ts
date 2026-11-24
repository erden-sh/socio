import type { DatabaseSync } from 'node:sqlite';

import { writeSoon } from '@socio/data/open';
import type { AskContextKind } from '@socio/shared/ask';

/** One person's conversation about one item with one socio. */
export interface ContextThread {
    contextKind: AskContextKind;
    contextId: string;
    dotId: string;
    userId: string;
    threadId: string;
}

const rowOf = (row: Record<string, unknown>): ContextThread => ({
    contextKind: String(row.contextKind) as AskContextKind,
    contextId: String(row.contextId),
    dotId: String(row.dotId),
    userId: String(row.userId),
    threadId: String(row.threadId),
});

/** The rows, on the workspace connection. */
export class ContextThreads {
    constructor(private db: DatabaseSync) {}
    find(kind: AskContextKind, contextId: string, dotId: string, userId: string): ContextThread | undefined {
        const row = this.db
            .prepare('SELECT * FROM context_threads WHERE contextKind=? AND contextId=? AND dotId=? AND userId=?')
            .get(kind, contextId, dotId, userId);
        return row ? rowOf(row) : undefined;
    }
    forThread(threadId: string): ContextThread | undefined {
        const row = this.db.prepare('SELECT * FROM context_threads WHERE threadId=?').get(threadId);
        return row ? rowOf(row) : undefined;
    }
    /**
     * Binds the item's conversation to `threadId`; a row whose conversation
     * was deleted is pointed at the new one (no row is ever deleted). Run it
     * inside the caller's `transaction()`.
     */
    bind(row: ContextThread, now = Date.now()) {
        this.db
            .prepare(
                `INSERT INTO context_threads(contextKind, contextId, dotId, userId, threadId, createdAt) VALUES(?,?,?,?,?,?)
         ON CONFLICT(contextKind, contextId, dotId, userId) DO UPDATE SET threadId=excluded.threadId, createdAt=excluded.createdAt`,
            )
            .run(row.contextKind, row.contextId, row.dotId, row.userId, row.threadId, now);
    }
    /** The page a conversation is about, if it is about one (CB-181). */
    pageOf(threadId: string): string | undefined {
        const row = this.db
            .prepare("SELECT contextId FROM context_threads WHERE threadId=? AND contextKind='page'")
            .get(threadId);
        return row ? String(row.contextId) : undefined;
    }
    lastSocio(userId: string): string | undefined {
        const row = this.db.prepare('SELECT dotId FROM ask_preferences WHERE userId=?').get(userId);
        return row ? String(row.dotId) : undefined;
    }
    /** A preference nothing reads back at once: written soon (CB-110). */
    setLastSocio(userId: string, dotId: string, now = Date.now()) {
        writeSoon(this.db, 'ask socio', () =>
            this.db
                .prepare(
                    `INSERT INTO ask_preferences(userId, dotId, updatedAt) VALUES(?,?,?)
         ON CONFLICT(userId) DO UPDATE SET dotId=excluded.dotId, updatedAt=excluded.updatedAt`,
                )
                .run(userId, dotId, now),
        );
    }
}
