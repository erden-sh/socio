import { DatabaseSync } from 'node:sqlite';

/**
 * A database shaped like brain.example.test's: what the release-1
 * constructors (5ad719d) ran on an empty file, in boot order, then the
 * columns and tables later deploys added in place (agent_runs.source,
 * agent_runs.errorDetail, the issue tables). Written out here, not taken
 * from the baselines, so the test doesn't check the code against itself.
 */
export const RELEASE_1_SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL, intervalSeconds INTEGER, nextRunAt INTEGER, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, error TEXT, lease TEXT, leaseUntil INTEGER);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, taskId TEXT NOT NULL, status TEXT NOT NULL, startedAt INTEGER NOT NULL, finishedAt INTEGER, result TEXT, error TEXT);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT NOT NULL, runId TEXT, text TEXT NOT NULL, createdAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, createdAt INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS tasks_due ON tasks(status, nextRunAt);
CREATE INDEX IF NOT EXISTS runs_task ON runs(taskId, startedAt);
CREATE INDEX IF NOT EXISTS events_task ON events(taskId, id);
ALTER TABLE tasks ADD COLUMN userId TEXT;
ALTER TABLE memories ADD COLUMN userId TEXT;

CREATE TABLE IF NOT EXISTS spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, createdAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS dots(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL, researchAllowed INTEGER NOT NULL, memoryAllowed INTEGER NOT NULL, createdAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS thread_bindings(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, ownerId TEXT NOT NULL, title TEXT NOT NULL, createdAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS task_threads(taskId TEXT PRIMARY KEY, threadId TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, startedAt INTEGER NOT NULL, endedAt INTEGER, status TEXT NOT NULL, transcript TEXT NOT NULL, error TEXT);
CREATE TABLE IF NOT EXISTS captures(threadId TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','member')), createdAt INTEGER NOT NULL, lastSeenAt INTEGER NOT NULL);
ALTER TABLE dots ADD COLUMN learningContainerId TEXT;
ALTER TABLE dots ADD COLUMN skillDeliveryEnabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE thread_bindings ADD COLUMN learningContainerId TEXT;
ALTER TABLE thread_bindings ADD COLUMN titled INTEGER NOT NULL DEFAULT 0;
CREATE TABLE dot_spaces(dotId TEXT NOT NULL, spaceId TEXT NOT NULL, PRIMARY KEY(dotId, spaceId));
CREATE TABLE IF NOT EXISTS computer_permissions(dotId TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS computer_audit(id TEXT PRIMARY KEY,dotId TEXT NOT NULL,action TEXT NOT NULL,actor TEXT NOT NULL,outcome TEXT NOT NULL,createdAt INTEGER NOT NULL);
ALTER TABLE computer_audit ADD COLUMN userId TEXT;
CREATE TABLE IF NOT EXISTS telegram_link_codes(hash TEXT PRIMARY KEY, userId TEXT NOT NULL, expiresAt INTEGER NOT NULL, usedAt INTEGER);
CREATE TABLE IF NOT EXISTS telegram_links(telegramUserId TEXT PRIMARY KEY, userId TEXT NOT NULL UNIQUE, username TEXT, linkedAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS telegram_members(chatId TEXT NOT NULL, userId TEXT NOT NULL, seenAt INTEGER NOT NULL, PRIMARY KEY (chatId, userId));
CREATE TABLE IF NOT EXISTS telegram_threads(key TEXT PRIMARY KEY, threadId TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, chatId TEXT NOT NULL, topicId TEXT, createdAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS learning_skill_revisions(id TEXT PRIMARY KEY, containerId TEXT NOT NULL, name TEXT NOT NULL, revision INTEGER NOT NULL, description TEXT NOT NULL, files TEXT NOT NULL, createdAt INTEGER NOT NULL, createdBy TEXT NOT NULL, UNIQUE(containerId, name, revision));
CREATE TABLE IF NOT EXISTS learning_container_revisions(containerId TEXT NOT NULL, revision INTEGER NOT NULL, skills TEXT NOT NULL, createdAt INTEGER NOT NULL, createdBy TEXT NOT NULL, PRIMARY KEY (containerId, revision));
CREATE TABLE IF NOT EXISTS learning_container_pins(containerId TEXT PRIMARY KEY, revision INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS learning_evidence(threadId TEXT PRIMARY KEY, containerId TEXT NOT NULL, dotId TEXT NOT NULL, ownerId TEXT NOT NULL, eligible INTEGER NOT NULL, finishedAt INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS learning_evidence_container ON learning_evidence(containerId, eligible, finishedAt);
CREATE TABLE IF NOT EXISTS learning_cursors(containerId TEXT PRIMARY KEY, analyzedThrough INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS page_reviews(threadId TEXT NOT NULL, toolCallId TEXT NOT NULL, pageId TEXT NOT NULL, spaceId TEXT NOT NULL, draft TEXT, PRIMARY KEY(threadId,toolCallId));
CREATE TABLE IF NOT EXISTS pages(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, parentId TEXT, title TEXT NOT NULL, content TEXT NOT NULL, revision INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, sourceThreadId TEXT);
CREATE TABLE IF NOT EXISTS page_threads(pageId TEXT NOT NULL,dotId TEXT NOT NULL,userId TEXT NOT NULL,threadId TEXT NOT NULL UNIQUE,ready INTEGER NOT NULL DEFAULT 0, leaseUntil INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(pageId,dotId,userId));
ALTER TABLE calls ADD COLUMN anchorMessageId TEXT;

CREATE TABLE IF NOT EXISTS agent_runs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  threadId TEXT NOT NULL,
  runId TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  events TEXT NOT NULL,
  startedAt INTEGER NOT NULL,
  finishedAt INTEGER
);
CREATE INDEX IF NOT EXISTS agent_runs_thread ON agent_runs(threadId, seq);

CREATE TABLE IF NOT EXISTS channel_kv(key TEXT PRIMARY KEY, value TEXT NOT NULL, expiresAt INTEGER);
CREATE TABLE IF NOT EXISTS channel_lists(key TEXT PRIMARY KEY, value TEXT NOT NULL, expiresAt INTEGER);
CREATE TABLE IF NOT EXISTS channel_locks(key TEXT PRIMARY KEY, token TEXT NOT NULL, expiresAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS channel_queue(seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS channel_queue_key ON channel_queue(key, seq);

CREATE TABLE IF NOT EXISTS learning_runs(id TEXT PRIMARY KEY, containerId TEXT NOT NULL, trigger TEXT NOT NULL, status TEXT NOT NULL, startedAt INTEGER NOT NULL, finishedAt INTEGER, threads INTEGER NOT NULL, proposals INTEGER NOT NULL, dropped INTEGER NOT NULL, error TEXT, startedBy TEXT);
CREATE TABLE IF NOT EXISTS learning_proposals(id TEXT PRIMARY KEY, containerId TEXT NOT NULL, runId TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, skillMd TEXT NOT NULL, rationale TEXT NOT NULL, evidenceThreadIds TEXT NOT NULL, status TEXT NOT NULL, createdAt INTEGER NOT NULL, reviewedBy TEXT, reviewedAt INTEGER, revisionId TEXT);

ALTER TABLE agent_runs ADD COLUMN source TEXT;
ALTER TABLE agent_runs ADD COLUMN errorDetail TEXT;

CREATE TABLE IF NOT EXISTS issues(id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL CHECK(status IN ('triage','open','ready','in_progress','in_review','blocked','done','wont_fix')), priority TEXT NOT NULL CHECK(priority IN ('critical','high','medium','low')), kind TEXT NOT NULL CHECK(kind IN ('bug','feature','improvement','docs','chore')), area TEXT, reporterId TEXT NOT NULL, assigneeId TEXT, resolution TEXT, source TEXT NOT NULL DEFAULT 'web', createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, closedAt INTEGER);
CREATE TABLE IF NOT EXISTS issue_labels(issueId TEXT NOT NULL, label TEXT NOT NULL, PRIMARY KEY(issueId, label));
CREATE TABLE IF NOT EXISTS issue_comments(id TEXT PRIMARY KEY, issueId TEXT NOT NULL, authorKind TEXT NOT NULL CHECK(authorKind IN ('user','agent','system')), authorId TEXT, body TEXT NOT NULL, createdAt INTEGER NOT NULL, editedAt INTEGER);
CREATE INDEX IF NOT EXISTS issue_comments_issue ON issue_comments(issueId, createdAt);
CREATE TABLE IF NOT EXISTS issue_events(id TEXT PRIMARY KEY, issueId TEXT NOT NULL, actorId TEXT, kind TEXT NOT NULL, fromValue TEXT, toValue TEXT, createdAt INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS issue_events_issue ON issue_events(issueId, createdAt);
CREATE TABLE IF NOT EXISTS issue_attachments(id TEXT PRIMARY KEY, issueId TEXT NOT NULL, commentId TEXT, name TEXT NOT NULL, mediaType TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, data BLOB NOT NULL, uploaderId TEXT NOT NULL, createdAt INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS issue_attachments_issue ON issue_attachments(issueId);
`;

/** Some rows in most tables, including the columns added in place. */
export const RELEASE_1_ROWS = `
INSERT INTO settings VALUES (1, '{"name":"Dot","paused":false,"researchAllowed":true,"memoryAllowed":true}');
INSERT INTO tasks (id, prompt, status, intervalSeconds, nextRunAt, createdAt, updatedAt, userId) VALUES ('task-1', 'Weekly digest', 'scheduled', 604800, 2000, 1000, 1000, 'alice');
INSERT INTO runs VALUES ('run-1', 'task-1', 'completed', 1000, 1500, 'Done', NULL);
INSERT INTO events (taskId, runId, text, createdAt) VALUES ('task-1', 'run-1', 'Started', 1000);
INSERT INTO memories (id, text, createdAt, userId) VALUES ('memory-1', 'Prefers short answers', 1000, 'alice');
INSERT INTO spaces VALUES ('space-1', 'Everyday', 'A little space for your day.', 1000);
INSERT INTO dots (id, spaceId, name, instructions, researchAllowed, memoryAllowed, createdAt, learningContainerId, skillDeliveryEnabled) VALUES ('dot-1', 'space-1', 'Dot', 'Be concise.', 1, 1, 1000, 'research', 1);
INSERT INTO dot_spaces VALUES ('dot-1', 'space-1');
INSERT INTO users VALUES ('alice', 'Alice', 'admin', 1000, 3000), ('bob', 'Bob', 'member', 1000, 3000);
INSERT INTO thread_bindings (id, dotId, ownerId, title, createdAt, learningContainerId, titled) VALUES ('thread-1', 'dot-1', 'alice', 'Planning', 1000, 'research', 1);
INSERT INTO task_threads VALUES ('task-1', 'thread-1');
INSERT INTO calls (id, threadId, startedAt, endedAt, status, transcript, error, anchorMessageId) VALUES ('call-1', 'thread-1', 1000, 1100, 'ended', '[]', NULL, 'message-1');
INSERT INTO computer_audit (id, dotId, action, actor, outcome, createdAt, userId) VALUES ('audit-1', 'dot-1', 'enable', 'user', 'ok', 1000, 'alice');
INSERT INTO telegram_links VALUES ('42', 'bob', 'bobby', 1000);
INSERT INTO telegram_threads VALUES ('dm:42', 'thread-2', 'dm', '42', NULL, 1000);
INSERT INTO learning_evidence VALUES ('thread-1', 'research', 'dot-1', 'alice', 1, 1500);
INSERT INTO learning_runs VALUES ('lrun-1', 'research', 'manual', 'finished', 1000, 1200, 3, 1, 0, NULL, 'alice');
INSERT INTO pages VALUES ('page-1', 'space-1', NULL, 'Notes', '# Notes', 1, 1000, 1000, NULL);
INSERT INTO page_threads VALUES ('page-1', 'dot-1', 'alice', 'thread-3', 1, 0);
INSERT INTO agent_runs (threadId, runId, status, events, startedAt, finishedAt, source, errorDetail) VALUES ('thread-1', 'agent-run-1', 'failed', '[]', 1000, 1400, 'scheduled', 'model_unavailable; upstream 503');
INSERT INTO channel_kv VALUES ('dedup:1', '1', NULL);
INSERT INTO issues (id, number, title, body, status, priority, kind, reporterId, source, createdAt, updatedAt) VALUES ('issue-1', 1, 'Sidebar clips', 'At 1280x720.', 'open', 'medium', 'bug', 'alice', 'import', 1000, 1000);
INSERT INTO issue_labels VALUES ('issue-1', 'ui');
INSERT INTO issue_comments VALUES ('comment-1', 'issue-1', 'user', 'bob', 'Seen it too.', 1100, NULL);
INSERT INTO issue_events VALUES ('event-1', 'issue-1', 'alice', 'created', NULL, 'open', 1000);
INSERT INTO issue_attachments VALUES ('attachment-1', 'issue-1', NULL, 'shot.png', 'image/png', 3, 'abc', X'010203', 'bob', 1000);
`;

export function buildRelease1Database(path: string) {
    const db = new DatabaseSync(path);
    try {
        db.exec('PRAGMA journal_mode=WAL;');
        db.exec(RELEASE_1_SCHEMA);
        db.exec(RELEASE_1_ROWS);
    } finally {
        db.close();
    }
}
