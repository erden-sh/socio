import type { DatabaseSync } from 'node:sqlite';

import type { ChatNameSuggestion, ChatNameSuggestionRepository } from './contract.js';

interface Row {
    threadId: string;
    suggestedName: string;
    trigger: string;
    status: string;
    suggestedAtMessageIndex: number;
    rejectedAtMessageIndex: number;
    createdAt: number;
    settledAt: number | null;
}

const fromRow = (row: Row): ChatNameSuggestion => ({
    threadId: row.threadId,
    suggestedName: row.suggestedName,
    trigger: row.trigger as ChatNameSuggestion['trigger'],
    status: row.status as ChatNameSuggestion['status'],
    suggestedAtMessageIndex: row.suggestedAtMessageIndex,
    rejectedAtMessageIndex: row.rejectedAtMessageIndex,
    createdAt: row.createdAt,
    settledAt: row.settledAt,
});

export function sqliteChatNameSuggestionRepository(db: DatabaseSync): ChatNameSuggestionRepository {
    const getStmt = db.prepare('SELECT * FROM chat_name_suggestions WHERE threadId=?');
    const pendingStmt = db.prepare("SELECT * FROM chat_name_suggestions WHERE threadId=? AND status='pending'");
    const insertStmt = db.prepare(
        `INSERT INTO chat_name_suggestions
         (threadId, suggestedName, trigger, status, suggestedAtMessageIndex, rejectedAtMessageIndex, createdAt, settledAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(threadId) DO UPDATE SET
           suggestedName=excluded.suggestedName,
           trigger=excluded.trigger,
           status=excluded.status,
           suggestedAtMessageIndex=excluded.suggestedAtMessageIndex,
           rejectedAtMessageIndex=excluded.rejectedAtMessageIndex,
           createdAt=excluded.createdAt,
           settledAt=excluded.settledAt`,
    );
    const settleStmt = db.prepare(
        `UPDATE chat_name_suggestions
         SET status=?, settledAt=?, rejectedAtMessageIndex=COALESCE(?, rejectedAtMessageIndex)
         WHERE threadId=?`,
    );
    const clearStmt = db.prepare('DELETE FROM chat_name_suggestions WHERE threadId=?');
    return {
        get(threadId) {
            const row = getStmt.get(threadId) as Row | undefined;
            return row ? fromRow(row) : undefined;
        },
        pending(threadId) {
            const row = pendingStmt.get(threadId) as Row | undefined;
            return row ? fromRow(row) : undefined;
        },
        insert(suggestion) {
            insertStmt.run(
                suggestion.threadId,
                suggestion.suggestedName,
                suggestion.trigger,
                suggestion.status,
                suggestion.suggestedAtMessageIndex,
                suggestion.rejectedAtMessageIndex,
                suggestion.createdAt,
            );
        },
        settle(threadId, resolution, at, rejectedAtMessageIndex) {
            settleStmt.run(resolution, at, rejectedAtMessageIndex ?? null, threadId);
        },
        clear(threadId) {
            clearStmt.run(threadId);
        },
    };
}
