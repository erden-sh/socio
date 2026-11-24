import type { SchemaSet } from '@socio/data/migrate';
import { MODULE_IDS } from '@socio/shared/modules';

/**
 * The issue tracker; the baseline is the former IssueStore constructor DDL.
 * Version 2 (CB-39): the last number handed out, so deleting the newest
 * issue never lets the next one reuse its number (and its `/issues/CB-n`
 * links). One row per database, which is one workspace; seeded from the
 * highest number in use.
 * Version 3: the `request` kind. SQLite can't change a CHECK
 * constraint in place, so the table is rebuilt with the same columns.
 * Version 4: capability requests from Dots. `dot_requests` keys an
 * issue by its normalized capability; `dot_request_requesters` holds each
 * Dot and user pair that asked (one row per pair, the demand count), and
 * when the Dot was last told the outcome; `dot_request_notices` is what
 * each user who asked is told once the issue closes.
 * Version 5 (CB-64): deleting an issue, comment or attachment hides it and
 * keeps the row (attachments keep their bytes). Comments and attachments
 * that went with a parent record it in `deletedWith`. A deleted issue
 * keeps its number, so numbers are still never reused.
 * Version 6 (CB-31): items a Dot files on the board (`file_improvement`).
 * Each row is one Dot action on an issue, with the Dot and the person it
 * acted for, both required, and what started the turn (a chat, Telegram,
 * a scheduled task). The issue's `reporterId` stays `dot:<id>`.
 * Version 7: the cause too (a goal's id, or a schedule's task id; required
 * for those triggers) and the Dot's owner when it was a person's own Dot,
 * who must then be the person it acted for. The table is rebuilt for the
 * new CHECKs; older scheduled rows get the cause `unrecorded`.
 * Version 8 (CB-83, CB-84): Dots also comment on items and vote on them
 * for the person they act for. `issue_dot_actions` takes the actions
 * `comment`, `vote` and `unvote`, each naming what it made or changed
 * (`targetId`: the comment, or the vote); the table is rebuilt for the new
 * CHECKs. `issue_votes` holds one live vote per person per item (a partial
 * unique index); withdrawing stamps `withdrawnAt` and keeps the row. A vote
 * a Dot cast for the person records the Dot.
 * Version 9 (CB-90): connected agents (Claude Code, Cursor, ...) act on
 * the board for the person who approved their grant. The records stay the
 * person's (reporter, comment author, vote, history actor); each action
 * also writes an `issue_agent_actions` row with the OAuth client, the
 * grant, the person's label for it and the person, all required, naming
 * what it made or changed (`targetId`: the comment, the vote, or the
 * history row of an update; none for a filing).
 * Version 10 (CB-29, CB-30): `issue_links` holds blocked-by links (`fromId`
 * waits for `toId`; removing one stamps `removedAt` and keeps the row, a
 * partial unique index allows one live link per pair). `issue_triage` is
 * the automatic triage of a new issue by the workspace's model: one row per
 * issue, whose state is `pending` while the model is asked, `proposed`
 * with the proposed fields (checked: a proposal has them all), then
 * `applied` or `ignored` by an admin (who is recorded), or `failed` with
 * why. A row is never retried, and the day's rows are the daily cap.
 * Version 11 (CB-110): `issue_events.seq` orders the history and is
 * the cursor a connected agent's update reads its rows by, instead of the
 * rowid. Filled from the rowid; new rows get the next one. An expand step:
 * a build from before still writes rows without it, and the trigger gives
 * those the next `seq` too.
 * Version 12 (CB-246): socio relationship mutations record each new history
 * event as an `update` action, with its acting person, thread and cause.
 * Existing action rows are copied unchanged; legacy events are not backfilled.
 * Version 15 (CB-274): `issue_relations` holds related links, which have no
 * direction, so a pair is stored once, in id order (`fromId < toId`).
 * Removing one stamps it, as for `issue_links`. A new table, so an older
 * build that never reads it is unaffected; one live link per pair is kept
 * by the store, inside its unit of work.
 */
export const issuesSchema: SchemaSet = {
    id: MODULE_IDS.issues,
    migrations: [
        {
            version: 1,
            name: 'baseline',
            baseline: true,
            up: (db) => {
                db.exec(`CREATE TABLE IF NOT EXISTS issues(id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL CHECK(status IN ('triage','open','ready','in_progress','in_review','blocked','done','wont_fix')), priority TEXT NOT NULL CHECK(priority IN ('critical','high','medium','low')), kind TEXT NOT NULL CHECK(kind IN ('bug','feature','improvement','docs','chore')), area TEXT, reporterId TEXT NOT NULL, assigneeId TEXT, resolution TEXT, source TEXT NOT NULL DEFAULT 'web', createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, closedAt INTEGER);
      CREATE TABLE IF NOT EXISTS issue_labels(issueId TEXT NOT NULL, label TEXT NOT NULL, PRIMARY KEY(issueId, label));
      CREATE TABLE IF NOT EXISTS issue_comments(id TEXT PRIMARY KEY, issueId TEXT NOT NULL, authorKind TEXT NOT NULL CHECK(authorKind IN ('user','agent','system')), authorId TEXT, body TEXT NOT NULL, createdAt INTEGER NOT NULL, editedAt INTEGER);
      CREATE INDEX IF NOT EXISTS issue_comments_issue ON issue_comments(issueId, createdAt);
      CREATE TABLE IF NOT EXISTS issue_events(id TEXT PRIMARY KEY, issueId TEXT NOT NULL, actorId TEXT, kind TEXT NOT NULL, fromValue TEXT, toValue TEXT, createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS issue_events_issue ON issue_events(issueId, createdAt);
      CREATE TABLE IF NOT EXISTS issue_attachments(id TEXT PRIMARY KEY, issueId TEXT NOT NULL, commentId TEXT, name TEXT NOT NULL, mediaType TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, data BLOB NOT NULL, uploaderId TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS issue_attachments_issue ON issue_attachments(issueId);`);
            },
        },
        {
            version: 2,
            name: 'number counter',
            up: `CREATE TABLE issue_counter(id INTEGER PRIMARY KEY CHECK(id = 1), last INTEGER NOT NULL);
      INSERT INTO issue_counter(id, last) SELECT 1, COALESCE(MAX(number), 0) FROM issues;`,
        },
        {
            version: 3,
            name: 'request kind',
            up: `CREATE TABLE issues_v3(id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL CHECK(status IN ('triage','open','ready','in_progress','in_review','blocked','done','wont_fix')), priority TEXT NOT NULL CHECK(priority IN ('critical','high','medium','low')), kind TEXT NOT NULL CHECK(kind IN ('bug','feature','improvement','docs','chore','request')), area TEXT, reporterId TEXT NOT NULL, assigneeId TEXT, resolution TEXT, source TEXT NOT NULL DEFAULT 'web', createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, closedAt INTEGER);
      INSERT INTO issues_v3(id, number, title, body, status, priority, kind, area, reporterId, assigneeId, resolution, source, createdAt, updatedAt, closedAt) SELECT id, number, title, body, status, priority, kind, area, reporterId, assigneeId, resolution, source, createdAt, updatedAt, closedAt FROM issues;
      DROP TABLE issues;
      ALTER TABLE issues_v3 RENAME TO issues;`,
        },
        {
            version: 4,
            name: 'dot requests',
            up: `CREATE TABLE dot_requests(issueId TEXT PRIMARY KEY, key TEXT NOT NULL, capability TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE INDEX dot_requests_key ON dot_requests(key);
      CREATE TABLE dot_request_requesters(id TEXT PRIMARY KEY, issueId TEXT NOT NULL, dotId TEXT NOT NULL, userId TEXT NOT NULL, why TEXT NOT NULL, example TEXT NOT NULL, createdAt INTEGER NOT NULL, announcedAt INTEGER, UNIQUE(issueId, dotId, userId));
      CREATE INDEX dot_request_requesters_dot ON dot_request_requesters(dotId, createdAt);
      CREATE INDEX dot_request_requesters_user ON dot_request_requesters(userId, createdAt);
      CREATE TABLE dot_request_notices(id TEXT PRIMARY KEY, issueId TEXT NOT NULL, userId TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('done','wont_fix')), resolution TEXT, createdAt INTEGER NOT NULL, seenAt INTEGER);
      CREATE INDEX dot_request_notices_user ON dot_request_notices(userId, seenAt);`,
        },
        {
            version: 5,
            name: 'soft delete',
            up: `ALTER TABLE issues ADD COLUMN deletedAt INTEGER;
      ALTER TABLE issues ADD COLUMN deletedBy TEXT;
      ALTER TABLE issue_comments ADD COLUMN deletedAt INTEGER;
      ALTER TABLE issue_comments ADD COLUMN deletedBy TEXT;
      ALTER TABLE issue_comments ADD COLUMN deletedWith TEXT;
      ALTER TABLE issue_attachments ADD COLUMN deletedAt INTEGER;
      ALTER TABLE issue_attachments ADD COLUMN deletedBy TEXT;
      ALTER TABLE issue_attachments ADD COLUMN deletedWith TEXT;`,
        },
        {
            version: 6,
            name: 'dot filings',
            up: `CREATE TABLE issue_dot_actions(id TEXT PRIMARY KEY, issueId TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('create')), dotId TEXT NOT NULL CHECK(length(dotId) > 0), userId TEXT NOT NULL CHECK(length(userId) > 0), trigger TEXT NOT NULL CHECK(trigger IN ('chat','telegram','scheduled')), threadId TEXT, createdAt INTEGER NOT NULL);
      CREATE INDEX issue_dot_actions_issue ON issue_dot_actions(issueId, createdAt);
      CREATE INDEX issue_dot_actions_dot ON issue_dot_actions(dotId, createdAt);
      CREATE INDEX issue_dot_actions_user ON issue_dot_actions(userId, createdAt);`,
        },
        {
            version: 7,
            name: 'dot action causes',
            up: `CREATE TABLE issue_dot_actions_v7(id TEXT PRIMARY KEY, issueId TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('create')), dotId TEXT NOT NULL CHECK(length(dotId) > 0), dotOwnerId TEXT CHECK(dotOwnerId IS NULL OR length(dotOwnerId) > 0), userId TEXT NOT NULL CHECK(length(userId) > 0), trigger TEXT NOT NULL CHECK(trigger IN ('chat','telegram','scheduled','goal')), causeId TEXT, threadId TEXT, createdAt INTEGER NOT NULL, CHECK(trigger IN ('chat','telegram') OR (causeId IS NOT NULL AND length(causeId) > 0)), CHECK(dotOwnerId IS NULL OR dotOwnerId = userId));
      INSERT INTO issue_dot_actions_v7(id, issueId, action, dotId, dotOwnerId, userId, trigger, causeId, threadId, createdAt) SELECT id, issueId, action, dotId, NULL, userId, trigger, CASE WHEN trigger = 'scheduled' THEN 'unrecorded' END, threadId, createdAt FROM issue_dot_actions;
      DROP TABLE issue_dot_actions;
      ALTER TABLE issue_dot_actions_v7 RENAME TO issue_dot_actions;
      CREATE INDEX issue_dot_actions_issue ON issue_dot_actions(issueId, createdAt);
      CREATE INDEX issue_dot_actions_dot ON issue_dot_actions(dotId, createdAt);
      CREATE INDEX issue_dot_actions_user ON issue_dot_actions(userId, createdAt);`,
        },
        {
            version: 8,
            name: 'votes and dot comments',
            up: `CREATE TABLE issue_dot_actions_v8(id TEXT PRIMARY KEY, issueId TEXT NOT NULL, action TEXT NOT NULL CHECK(action IS NOT NULL AND action IN ('create','comment','vote','unvote')), targetId TEXT CHECK(targetId IS NULL OR length(targetId) > 0), dotId TEXT NOT NULL CHECK(dotId IS NOT NULL AND length(dotId) > 0), dotOwnerId TEXT CHECK(dotOwnerId IS NULL OR length(dotOwnerId) > 0), userId TEXT NOT NULL CHECK(userId IS NOT NULL AND length(userId) > 0), trigger TEXT NOT NULL CHECK(trigger IS NOT NULL AND trigger IN ('chat','telegram','scheduled','goal')), causeId TEXT, threadId TEXT, createdAt INTEGER NOT NULL, CHECK(trigger IN ('chat','telegram') OR (causeId IS NOT NULL AND length(causeId) > 0)), CHECK(dotOwnerId IS NULL OR dotOwnerId = userId), CHECK(action = 'create' OR targetId IS NOT NULL));
      INSERT INTO issue_dot_actions_v8(id, issueId, action, targetId, dotId, dotOwnerId, userId, trigger, causeId, threadId, createdAt) SELECT id, issueId, action, NULL, dotId, dotOwnerId, userId, trigger, causeId, threadId, createdAt FROM issue_dot_actions;
      DROP TABLE issue_dot_actions;
      ALTER TABLE issue_dot_actions_v8 RENAME TO issue_dot_actions;
      CREATE INDEX issue_dot_actions_issue ON issue_dot_actions(issueId, createdAt);
      CREATE INDEX issue_dot_actions_dot ON issue_dot_actions(dotId, createdAt);
      CREATE INDEX issue_dot_actions_user ON issue_dot_actions(userId, createdAt);
      CREATE TABLE issue_votes(id TEXT PRIMARY KEY, issueId TEXT NOT NULL CHECK(issueId IS NOT NULL AND length(issueId) > 0), userId TEXT NOT NULL CHECK(userId IS NOT NULL AND length(userId) > 0), dotId TEXT CHECK(dotId IS NULL OR length(dotId) > 0), createdAt INTEGER NOT NULL CHECK(createdAt IS NOT NULL), withdrawnAt INTEGER CHECK(withdrawnAt IS NULL OR withdrawnAt >= createdAt));
      CREATE UNIQUE INDEX issue_votes_live ON issue_votes(issueId, userId) WHERE withdrawnAt IS NULL;
      CREATE INDEX issue_votes_user ON issue_votes(userId) WHERE withdrawnAt IS NULL;`,
        },
        {
            version: 9,
            name: 'agent actions',
            up: `CREATE TABLE issue_agent_actions(id TEXT PRIMARY KEY, issueId TEXT NOT NULL CHECK(issueId IS NOT NULL AND length(issueId) > 0), action TEXT NOT NULL CHECK(action IS NOT NULL AND action IN ('create','comment','vote','unvote','update')), targetId TEXT CHECK(targetId IS NULL OR length(targetId) > 0), grantId TEXT NOT NULL CHECK(grantId IS NOT NULL AND length(grantId) > 0), clientId TEXT NOT NULL CHECK(clientId IS NOT NULL AND length(clientId) > 0), clientName TEXT NOT NULL CHECK(clientName IS NOT NULL AND length(clientName) > 0), label TEXT NOT NULL CHECK(label IS NOT NULL AND length(label) > 0), userId TEXT NOT NULL CHECK(userId IS NOT NULL AND length(userId) > 0), createdAt INTEGER NOT NULL CHECK(createdAt IS NOT NULL), CHECK(action = 'create' OR targetId IS NOT NULL));
      CREATE INDEX issue_agent_actions_issue ON issue_agent_actions(issueId, createdAt);
      CREATE INDEX issue_agent_actions_grant ON issue_agent_actions(grantId, createdAt);
      CREATE INDEX issue_agent_actions_user ON issue_agent_actions(userId, createdAt);`,
        },
        {
            version: 10,
            name: 'blocked-by links and triage proposals',
            up: `CREATE TABLE issue_links(id TEXT PRIMARY KEY, fromId TEXT NOT NULL CHECK(fromId IS NOT NULL AND length(fromId) > 0), toId TEXT NOT NULL CHECK(toId IS NOT NULL AND length(toId) > 0), kind TEXT NOT NULL CHECK(kind IS NOT NULL AND kind IN ('blocked_by')), createdBy TEXT NOT NULL CHECK(createdBy IS NOT NULL AND length(createdBy) > 0), createdAt INTEGER NOT NULL CHECK(createdAt IS NOT NULL), removedAt INTEGER CHECK(removedAt IS NULL OR removedAt >= createdAt), removedBy TEXT CHECK(removedBy IS NULL OR length(removedBy) > 0), CHECK(fromId <> toId), CHECK((removedAt IS NULL) = (removedBy IS NULL)));
      CREATE UNIQUE INDEX issue_links_live ON issue_links(fromId, toId, kind) WHERE removedAt IS NULL;
      CREATE INDEX issue_links_to ON issue_links(toId) WHERE removedAt IS NULL;
      CREATE TABLE issue_triage(issueId TEXT PRIMARY KEY CHECK(issueId IS NOT NULL AND length(issueId) > 0), state TEXT NOT NULL CHECK(state IS NOT NULL AND state IN ('pending','proposed','applied','ignored','failed')), kind TEXT, area TEXT, priority TEXT, labels TEXT, reason TEXT, commentId TEXT, error TEXT, createdAt INTEGER NOT NULL CHECK(createdAt IS NOT NULL), decidedAt INTEGER, decidedBy TEXT CHECK(decidedBy IS NULL OR length(decidedBy) > 0), CHECK(state IN ('pending','failed') OR (kind IS NOT NULL AND priority IS NOT NULL AND labels IS NOT NULL AND reason IS NOT NULL)), CHECK(state NOT IN ('applied','ignored') OR (decidedAt IS NOT NULL AND decidedBy IS NOT NULL)), CHECK(state <> 'failed' OR error IS NOT NULL));
      CREATE INDEX issue_triage_created ON issue_triage(createdAt);`,
        },
        {
            version: 11,
            name: 'history order',
            up: `ALTER TABLE issue_events ADD COLUMN seq INTEGER;
      UPDATE issue_events SET seq = rowid;
      CREATE UNIQUE INDEX issue_events_seq ON issue_events(seq);
      CREATE TRIGGER issue_events_seq_fill AFTER INSERT ON issue_events WHEN NEW.seq IS NULL BEGIN UPDATE issue_events SET seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM issue_events) WHERE id = NEW.id; END;`,
        },
        {
            version: 12,
            name: 'attributed socio history updates',
            up: `CREATE TABLE issue_dot_actions_v12(id TEXT PRIMARY KEY, issueId TEXT NOT NULL, action TEXT NOT NULL CHECK(action IS NOT NULL AND action IN ('create','comment','vote','unvote','update')), targetId TEXT CHECK(targetId IS NULL OR length(targetId) > 0), dotId TEXT NOT NULL CHECK(dotId IS NOT NULL AND length(dotId) > 0), dotOwnerId TEXT CHECK(dotOwnerId IS NULL OR length(dotOwnerId) > 0), userId TEXT NOT NULL CHECK(userId IS NOT NULL AND length(userId) > 0), trigger TEXT NOT NULL CHECK(trigger IS NOT NULL AND trigger IN ('chat','telegram','scheduled','goal')), causeId TEXT, threadId TEXT, createdAt INTEGER NOT NULL, CHECK(trigger IN ('chat','telegram') OR (causeId IS NOT NULL AND length(causeId) > 0)), CHECK(dotOwnerId IS NULL OR dotOwnerId = userId), CHECK(action = 'create' OR targetId IS NOT NULL));
      INSERT INTO issue_dot_actions_v12(id, issueId, action, targetId, dotId, dotOwnerId, userId, trigger, causeId, threadId, createdAt) SELECT id, issueId, action, targetId, dotId, dotOwnerId, userId, trigger, causeId, threadId, createdAt FROM issue_dot_actions ORDER BY rowid;
      DROP TABLE issue_dot_actions;
      ALTER TABLE issue_dot_actions_v12 RENAME TO issue_dot_actions;
      CREATE INDEX issue_dot_actions_issue ON issue_dot_actions(issueId, createdAt);
      CREATE INDEX issue_dot_actions_dot ON issue_dot_actions(dotId, createdAt);
      CREATE INDEX issue_dot_actions_user ON issue_dot_actions(userId, createdAt);`,
        },
        {
            version: 13,
            name: 'one-shot issue status subscriptions',
            up: `CREATE TABLE issue_watches(id TEXT PRIMARY KEY, userId TEXT NOT NULL, targetStatus TEXT NOT NULL CHECK(targetStatus IN ('triage','open','ready','in_progress','in_review','blocked','done','wont_fix')), state TEXT NOT NULL CHECK(state IN ('watching','ready','triggered','cancelled')), fingerprint TEXT NOT NULL, cursor INTEGER NOT NULL CHECK(cursor >= 0), createdAt INTEGER NOT NULL, triggeredAt INTEGER, cancelledAt INTEGER, cancelReason TEXT CHECK(cancelReason IN ('unsubscribed','issue_unavailable','person_unavailable')), sourceKind TEXT NOT NULL CHECK(sourceKind IN ('person','socio','agent')), sourceId TEXT NOT NULL CHECK(length(sourceId)>0), threadId TEXT, causeId TEXT, cancelSourceKind TEXT CHECK(cancelSourceKind IN ('person','socio','agent')), cancelSourceId TEXT, cancelThreadId TEXT, cancelCauseId TEXT, CHECK((state='triggered') = (triggeredAt IS NOT NULL)), CHECK((state='cancelled') = (cancelledAt IS NOT NULL)), CHECK((state='cancelled') = (cancelReason IS NOT NULL)), CHECK((cancelSourceKind IS NULL) = (cancelSourceId IS NULL)));
      CREATE INDEX issue_watches_user ON issue_watches(userId,createdAt);
      CREATE UNIQUE INDEX issue_watches_active ON issue_watches(userId,fingerprint) WHERE state IN ('watching','ready');
      CREATE TABLE issue_watch_members(watchId TEXT NOT NULL,issueId TEXT NOT NULL,number INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('triage','open','ready','in_progress','in_review','blocked','done','wont_fix')),PRIMARY KEY(watchId,issueId));
      CREATE INDEX issue_watch_members_issue ON issue_watch_members(issueId,watchId);
      CREATE TABLE issue_watch_outbox(id TEXT PRIMARY KEY,watchId TEXT NOT NULL UNIQUE,userId TEXT NOT NULL,title TEXT NOT NULL,message TEXT NOT NULL,path TEXT NOT NULL,createdAt INTEGER NOT NULL,claimedAt INTEGER);
      CREATE INDEX issue_watch_outbox_pending ON issue_watch_outbox(claimedAt,createdAt);`,
        },
        {
            // CB-194: the turn an item was filed from: a person's "File issue"
            // under a failed run (`report`), or a socio's filing during its turn
            // (`socio`). Operations measures failure-to-report time by it.
            version: 14,
            name: 'issue runs',
            up: `CREATE TABLE issue_runs(issueId TEXT NOT NULL CHECK(length(issueId) > 0), runId TEXT NOT NULL CHECK(length(runId) > 0), threadId TEXT NOT NULL CHECK(length(threadId) > 0), via TEXT NOT NULL CHECK(via IN ('report','socio')), linkedBy TEXT NOT NULL CHECK(length(linkedBy) > 0), createdAt INTEGER NOT NULL, PRIMARY KEY(issueId, runId));
      CREATE INDEX issue_runs_run ON issue_runs(runId);`,
        },
        {
            version: 15,
            name: 'related issue links',
            phase: 'expand',
            up: `CREATE TABLE issue_relations(id TEXT PRIMARY KEY, fromId TEXT NOT NULL CHECK(length(fromId) > 0), toId TEXT NOT NULL CHECK(length(toId) > 0), kind TEXT NOT NULL CHECK(kind IN ('related')), createdBy TEXT NOT NULL CHECK(length(createdBy) > 0), createdAt INTEGER NOT NULL, removedAt INTEGER CHECK(removedAt IS NULL OR removedAt >= createdAt), removedBy TEXT CHECK(removedBy IS NULL OR length(removedBy) > 0), CHECK(fromId < toId), CHECK((removedAt IS NULL) = (removedBy IS NULL)));
      CREATE INDEX issue_relations_from ON issue_relations(fromId, toId) WHERE removedAt IS NULL;
      CREATE INDEX issue_relations_to ON issue_relations(toId) WHERE removedAt IS NULL;`,
        },
        {
            // CB-442: the plugins and apps an issue is about, each with the
            // name it had when tagged; and a triage proposal's suggestions.
            version: 16,
            name: 'issue components',
            phase: 'expand',
            up: `CREATE TABLE issue_components(issueId TEXT NOT NULL CHECK(length(issueId) > 0), ref TEXT NOT NULL CHECK(length(ref) > 0), kind TEXT NOT NULL CHECK(kind IN ('plugin','app','plugins','apps')), targetId TEXT CHECK(targetId IS NULL OR length(targetId) > 0), generation INTEGER, label TEXT NOT NULL CHECK(length(label) > 0), audience TEXT CHECK(audience IS NULL OR audience IN ('admins','members')), addedBy TEXT NOT NULL CHECK(length(addedBy) > 0), addedAt INTEGER NOT NULL, PRIMARY KEY(issueId, ref), CHECK((kind IN ('plugins','apps')) = (targetId IS NULL)), CHECK(kind = 'app' OR generation IS NULL));
      CREATE INDEX issue_components_ref ON issue_components(ref, issueId);
      CREATE TABLE issue_component_names(issueId TEXT NOT NULL CHECK(length(issueId) > 0), ref TEXT NOT NULL CHECK(length(ref) > 0), label TEXT NOT NULL CHECK(length(label) > 0), audience TEXT CHECK(audience IS NULL OR audience IN ('admins','members')), PRIMARY KEY(issueId, ref));
      ALTER TABLE issue_triage ADD COLUMN components TEXT;
      ALTER TABLE issue_triage ADD COLUMN reasonAudience TEXT CHECK(reasonAudience IS NULL OR reasonAudience = 'admins');`,
        },
    ],
};
