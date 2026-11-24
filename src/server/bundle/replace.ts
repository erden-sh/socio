/**
 * Deleted issues the import may replace (CB-380): a bundle's issue keeps
 * its number, and an issue deleted here that holds that number, filed here
 * (never imported), would otherwise block it for good, as Socio has no
 * permanent delete for issues. The import removes such an issue, and every
 * row that belongs to it, in the transaction that starts it (with the
 * numbers it reserves), before any record is written. Issue attachments are stored in their rows (`issue_attachments.data`),
 * so no file outside the database goes with it.
 */
import type { DatabaseSync } from 'node:sqlite';

/**
 * Every column that names one issue by id, in a row that belongs to that
 * issue and goes with it (tests/bundle.test.ts fails on an `issueId`
 * column of a migrated database missing here). History kept elsewhere
 * (audit logs, notifications already sent) names no issue id.
 */
export const ISSUE_ROWS: ReadonlyArray<{ table: string; column: string }> = [
    { table: 'issue_labels', column: 'issueId' },
    { table: 'issue_components', column: 'issueId' },
    { table: 'issue_component_names', column: 'issueId' },
    { table: 'issue_comments', column: 'issueId' },
    { table: 'issue_attachments', column: 'issueId' },
    { table: 'issue_votes', column: 'issueId' },
    { table: 'issue_events', column: 'issueId' },
    { table: 'issue_links', column: 'fromId' },
    { table: 'issue_links', column: 'toId' },
    { table: 'issue_relations', column: 'fromId' },
    { table: 'issue_relations', column: 'toId' },
    { table: 'issue_triage', column: 'issueId' },
    { table: 'issue_agent_actions', column: 'issueId' },
    { table: 'issue_dot_actions', column: 'issueId' },
    { table: 'issue_runs', column: 'issueId' },
    { table: 'issue_watch_members', column: 'issueId' },
    { table: 'dot_requests', column: 'issueId' },
    { table: 'dot_request_requesters', column: 'issueId' },
    { table: 'dot_request_notices', column: 'issueId' },
    { table: 'dispatch_runs', column: 'issueId' },
];

/** A deleted issue here the import replaces: the number's holder. */
export interface Replaceable {
    id: string;
    deletedAt: number;
}

const tableExists = (db: DatabaseSync, table: string) =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);

/**
 * The issue here holding `number`, when the import may replace it: it is
 * deleted, it isn't an import's copy (`import_map` from any source, or
 * `source='import'`), no issue of the bundle has its id, and no dispatch
 * run of it is still queued or running. Undefined otherwise.
 */
export function replaceableAt(
    db: DatabaseSync,
    number: number,
    bundleIds: ReadonlySet<string>,
): Replaceable | undefined {
    const row = db.prepare('SELECT id, source, deletedAt FROM issues WHERE number=?').get(number) as
        | { id: string; source: string; deletedAt: number | null }
        | undefined;
    if (!row || row.deletedAt === null || row.source === 'import' || bundleIds.has(row.id)) {
        return undefined;
    }
    if (db.prepare("SELECT 1 FROM import_map WHERE kind='issue' AND targetId=? LIMIT 1").get(row.id)) {
        return undefined;
    }
    if (
        tableExists(db, 'dispatch_runs') &&
        db.prepare("SELECT 1 FROM dispatch_runs WHERE issueId=? AND status IN ('queued','running') LIMIT 1").get(row.id)
    ) {
        return undefined;
    }
    return { id: row.id, deletedAt: Number(row.deletedAt) };
}

/**
 * Removes a deleted issue for good, with every row of it: its own rows
 * (ISSUE_ROWS), its dispatch runs' events and credentials, and the status
 * watches left with no issue to watch, with their pending notices (one
 * still watching other issues too is cancelled, as the board does when a
 * watched issue is gone; watch cursors past the history left move back to
 * its end). Runs inside the caller's transaction. Resolves
 * the rows removed (or, for watches, ended or moved back), per table.
 */
export function removeIssue(db: DatabaseSync, id: string, now: number): Record<string, number> {
    const removed: Record<string, number> = {};
    const note = (table: string, changes: number | bigint) => {
        if (Number(changes)) {
            removed[table] = (removed[table] ?? 0) + Number(changes);
        }
    };
    /** Every write of the removal: `DELETE FROM <table> WHERE <where>`, or an UPDATE `set`. */
    const write = (table: string, where: string, values: (string | number)[], set?: string) => {
        const sql = set ? `UPDATE ${table} SET ${set} WHERE ${where}` : `DELETE FROM ${table} WHERE ${where}`;
        note(table, db.prepare(sql).run(...values).changes);
    };

    // Rows under the issue's own rows, first, while those still name them.
    if (tableExists(db, 'dispatch_runs')) {
        for (const table of ['dispatch_run_events', 'gateway_dispatch_credentials']) {
            if (tableExists(db, table)) {
                write(table, 'runId IN (SELECT id FROM dispatch_runs WHERE issueId=?)', [id]);
            }
        }
    }
    const watches = (
        db.prepare('SELECT DISTINCT watchId FROM issue_watch_members WHERE issueId=?').all(id) as { watchId: string }[]
    ).map((row) => row.watchId);

    // A watch still waiting on it, or matched and not yet sent, ends as the
    // board ends it when a watched issue is gone (its replay and its flush),
    // before its member row goes: its notice is never sent.
    for (const watchId of watches) {
        write(
            'issue_watches',
            "id=? AND state IN ('watching','ready')",
            [now, watchId],
            "state='cancelled', cancelledAt=?, cancelReason='issue_unavailable'",
        );
    }
    for (const { table, column } of ISSUE_ROWS) {
        if (tableExists(db, table)) {
            write(table, `${column}=?`, [id]);
        }
    }
    // A watch of this issue alone has nothing left to watch: it goes, with
    // its pending notice. One that also watches other issues stays.
    for (const watchId of watches) {
        if (!db.prepare('SELECT 1 FROM issue_watch_members WHERE watchId=? LIMIT 1').get(watchId)) {
            write('issue_watch_outbox', 'watchId=?', [watchId]);
            write('issue_watches', 'id=?', [watchId]);
        }
    }
    write('issues', 'id=? AND deletedAt IS NOT NULL', [id]);
    // History numbers are the next after the highest, and watches keep a
    // cursor into them: one past the highest left would see numbers again,
    // given to new events, as already read. Nothing lies between, so it is
    // moved back to the highest left.
    const last = Number(
        (db.prepare('SELECT MAX(seq) AS seq FROM issue_events').get() as { seq: number | null }).seq ?? 0,
    );
    write('issue_watches', 'cursor > ?', [last, last], 'cursor=?');
    return removed;
}
