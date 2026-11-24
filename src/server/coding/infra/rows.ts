import type { DatabaseSync } from 'node:sqlite';

import type { CodingRunKind, CodingRunState, CodingSessionState } from '@socio/shared/coding/coding-sessions';

import type { GatewayExchangeRecord, GatewayExchangesShape } from '../contract.js';

/**
 * The SQL of coding sessions (CB-239), on the shared connection. Every
 * write here runs inside the caller's `transaction()` or `writeSoon`
 * (docs/DATA-LAYER.md); nothing here opens one itself.
 */

export interface SessionRecord {
    id: string;
    personId: string;
    socioId: string;
    threadId: string;
    conversationKind: 'private' | 'room';
    repository: string;
    repositoryKey: string;
    base: string;
    branch: string;
    shortId: string;
    model: string;
    push: boolean;
    volumeKey: string;
    grantId: string | null;
    approvalId: string | null;
    opencodeSession: string;
    state: CodingSessionState;
    endReason: string | null;
    createdAt: number;
    endsAt: number;
    lastPromptAt: number;
    endedAt: number | null;
    sandboxGoneAt: number | null;
    volumeGoneAt: number | null;
    prNumber: number | null;
    prUrl: string | null;
    /** The proxy credential's subnet and allow list (JSON), once started. */
    proxySubnet?: string | null;
    proxyAllow?: string | null;
    /** The person's own plan it runs on, e.g. `byo-chatgpt`. */
    plan?: string | null;
    /** The coding harness that runs it (CB-326); null or absent is `opencode`. */
    harness?: string | null;
    /**
     * When the session host started for this session (CB-326 step 3), ms;
     * null for a one-shot `exec`-per-prompt session. Presence is the marker
     * the T3 idle stop keys off.
     */
    hostStartedAt?: number | null;
    /**
     * When the host transitioned to idle (provider stopped, sandbox kept),
     * ms; null while the host is active or the session is one-shot. A new
     * prompt clears it (resume) and refreshes the pin window.
     */
    hostIdleSince?: number | null;
}

type SessionRow = Omit<SessionRecord, 'push'> & { push: number };
const sessionOf = (row: SessionRow): SessionRecord => ({
    ...row,
    push: row.push === 1,
});

export interface RunRecord {
    id: string;
    sessionId: string;
    kind: CodingRunKind;
    state: CodingRunState;
    startedAt: number;
    endedAt: number | null;
    tokensAtStart: number;
    tokens: number | null;
    progress: string[];
    summary: string | null;
    changedFiles: string[];
    error: string | null;
    answered: boolean;
    reportedAt: number | null;
}

type RunRow = Omit<RunRecord, 'progress' | 'changedFiles' | 'answered'> & {
    progress: string;
    changedFiles: string;
    answered: number;
};
const runOf = (row: RunRow): RunRecord => ({
    ...row,
    progress: JSON.parse(row.progress) as string[],
    changedFiles: JSON.parse(row.changedFiles) as string[],
    answered: row.answered === 1,
});

/** Live sessions, counted for the caps. */
export interface LiveCounts {
    person: number;
    socio: number;
    total: number;
}

export class SessionRows {
    constructor(private db: DatabaseSync) {}
    insert(record: SessionRecord) {
        this.db
            .prepare(
                `INSERT INTO coding_sessions(id, personId, socioId, threadId, conversationKind, repository, repositoryKey, base, branch, shortId, model, push, volumeKey, grantId, approvalId, opencodeSession, state, createdAt, endsAt, lastPromptAt, plan, harness)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                record.id,
                record.personId,
                record.socioId,
                record.threadId,
                record.conversationKind,
                record.repository,
                record.repositoryKey,
                record.base,
                record.branch,
                record.shortId,
                record.model,
                record.push ? 1 : 0,
                record.volumeKey,
                record.grantId,
                record.approvalId,
                record.opencodeSession,
                record.state,
                record.createdAt,
                record.endsAt,
                record.lastPromptAt,
                record.plan ?? null,
                record.harness ?? 'opencode',
            );
    }
    get(id: string): SessionRecord | undefined {
        const row = this.db.prepare('SELECT * FROM coding_sessions WHERE id=?').get(id) as SessionRow | undefined;
        return row && sessionOf(row);
    }
    byGrant(grantId: string): SessionRecord | undefined {
        const row = this.db.prepare('SELECT * FROM coding_sessions WHERE grantId=?').get(grantId) as
            | SessionRow
            | undefined;
        return row && sessionOf(row);
    }
    /** Sessions not ended, oldest first. */
    live(): SessionRecord[] {
        return (
            this.db
                .prepare("SELECT * FROM coding_sessions WHERE state<>'ended' ORDER BY createdAt, id")
                .all() as unknown as SessionRow[]
        ).map(sessionOf);
    }
    /** A person's sessions, newest first (their own, any state). */
    ofPerson(personId: string, limit = 50): SessionRecord[] {
        return (
            this.db
                .prepare('SELECT * FROM coding_sessions WHERE personId=? ORDER BY createdAt DESC, id LIMIT ?')
                .all(personId, limit) as unknown as SessionRow[]
        ).map(sessionOf);
    }
    /**
     * Sessions for the Computer panel's list, newest first: one socio's,
     * and one person's unless `personId` is undefined (an admin's view).
     * Live ones, and ended ones whose workspace is still kept.
     */
    listed(input: { socioId: string; personId?: string; limit: number }): SessionRecord[] {
        const mine = input.personId !== undefined;
        return (
            this.db
                .prepare(
                    `SELECT * FROM coding_sessions
           WHERE socioId=? ${mine ? 'AND personId=?' : ''}
             AND (state<>'ended' OR volumeGoneAt IS NULL)
           ORDER BY createdAt DESC, id LIMIT ?`,
                )
                .all(
                    ...(mine ? [input.socioId, input.personId!, input.limit] : [input.socioId, input.limit]),
                ) as unknown as SessionRow[]
        ).map(sessionOf);
    }
    liveCounts(personId: string, socioId: string): LiveCounts {
        const row = this.db
            .prepare(
                `SELECT COALESCE(SUM(personId=?), 0) AS person, COALESCE(SUM(socioId=?), 0) AS socio, COUNT(*) AS total
         FROM coding_sessions WHERE state<>'ended'`,
            )
            .get(personId, socioId) as {
            person: number;
            socio: number;
            total: number;
        };
        return {
            person: Number(row.person),
            socio: Number(row.socio),
            total: Number(row.total),
        };
    }
    /** Whether a short id or branch is taken in a repository. */
    taken(repositoryKey: string, shortId: string, branch: string) {
        return !!this.db
            .prepare('SELECT 1 FROM coding_sessions WHERE repositoryKey=? AND (shortId=? OR branch=?)')
            .get(repositoryKey, shortId, branch);
    }
    setGrant(id: string, grantId: string) {
        this.db.prepare('UPDATE coding_sessions SET grantId=? WHERE id=? AND grantId IS NULL').run(grantId, id);
    }
    /** `starting` → `ready`, once; false when it wasn't starting. */
    markReady(id: string) {
        return (
            Number(
                this.db.prepare("UPDATE coding_sessions SET state='ready' WHERE id=? AND state='starting'").run(id)
                    .changes,
            ) > 0
        );
    }
    /** Ends a live session, once; false when it had ended already. */
    end(id: string, reason: string, at: number) {
        return (
            Number(
                this.db
                    .prepare(
                        "UPDATE coding_sessions SET state='ended', endReason=?, endedAt=? WHERE id=? AND state<>'ended'",
                    )
                    .run(reason, at, id).changes,
            ) > 0
        );
    }
    prompted(id: string, at: number) {
        this.db.prepare('UPDATE coding_sessions SET lastPromptAt=? WHERE id=?').run(at, id);
    }
    /**
     * Marks a session host-backed (CB-326 step 3): sets `hostStartedAt`, the
     * marker the T3 idle stop keys off. Idempotent; the pin window starts here.
     */
    markHosted(id: string, at: number) {
        this.db.prepare('UPDATE coding_sessions SET hostStartedAt=? WHERE id=? AND hostStartedAt IS NULL').run(at, id);
    }
    /**
     * Marks a host-backed session's provider stopped (CB-326 step 3): sets
     * `hostIdleSince`; `state` stays `ready` (the sandbox is kept). Only
     * host-backed sessions take this; the one-shot path ends on idle instead.
     * Returns whether it transitioned.
     */
    markIdle(id: string, at: number) {
        return (
            Number(
                this.db
                    .prepare(
                        "UPDATE coding_sessions SET hostIdleSince=? WHERE id=? AND state='ready' AND hostStartedAt IS NOT NULL AND hostIdleSince IS NULL",
                    )
                    .run(at, id).changes,
            ) > 0
        );
    }
    /**
     * Resumes a host-backed session's provider (CB-326 step 3): a new prompt
     * on an idle host-backed session restarts the provider in the kept
     * sandbox. Clears `hostIdleSince` and refreshes the pin window
     * (`hostStartedAt`), so the 4 h pin restarts. Returns whether it resumed.
     */
    resumeIdle(id: string, at: number) {
        return (
            Number(
                this.db
                    .prepare(
                        "UPDATE coding_sessions SET hostIdleSince=NULL, hostStartedAt=? WHERE id=? AND state='ready' AND hostIdleSince IS NOT NULL",
                    )
                    .run(at, id).changes,
            ) > 0
        );
    }
    setOpencodeSession(id: string, value: string) {
        this.db.prepare('UPDATE coding_sessions SET opencodeSession=? WHERE id=?').run(value, id);
    }
    /** What the sandbox's proxy credential is signed for. */
    setProxy(id: string, subnet: string, allow: readonly string[]) {
        this.db
            .prepare('UPDATE coding_sessions SET proxySubnet=?, proxyAllow=? WHERE id=?')
            .run(subnet, JSON.stringify(allow), id);
    }
    setPullRequest(id: string, number: number, url: string) {
        this.db.prepare('UPDATE coding_sessions SET prNumber=?, prUrl=? WHERE id=?').run(number, url, id);
    }
    sandboxGone(id: string, at: number) {
        this.db.prepare('UPDATE coding_sessions SET sandboxGoneAt=? WHERE id=? AND sandboxGoneAt IS NULL').run(at, id);
    }
    /** Ended sessions whose sandbox may still exist (the reaper retries). */
    endedWithSandbox(limit = 50): SessionRecord[] {
        return (
            this.db
                .prepare(
                    "SELECT * FROM coding_sessions WHERE state='ended' AND sandboxGoneAt IS NULL ORDER BY endedAt LIMIT ?",
                )
                .all(limit) as unknown as SessionRow[]
        ).map(sessionOf);
    }
    /**
     * Workspace volumes, by key, with what the reaper needs to decide
     * whether one goes: whether a live session uses it, when it was last
     * used, and one of its sessions.
     */
    volumes(): Array<{
        volumeKey: string;
        live: number;
        lastUsedAt: number;
        personId: string;
        socioId: string;
        repositoryKey: string;
    }> {
        return (
            this.db
                .prepare(
                    `SELECT volumeKey, SUM(state<>'ended') AS live, MAX(COALESCE(endedAt, lastPromptAt)) AS lastUsedAt,
             MAX(personId) AS personId, MAX(socioId) AS socioId, MAX(repositoryKey) AS repositoryKey
           FROM coding_sessions WHERE volumeGoneAt IS NULL GROUP BY volumeKey`,
                )
                .all() as Array<{
                volumeKey: string;
                live: number;
                lastUsedAt: number;
                personId: string;
                socioId: string;
                repositoryKey: string;
            }>
        ).map((row) => ({
            ...row,
            live: Number(row.live),
            lastUsedAt: Number(row.lastUsedAt),
        }));
    }
    /**
     * Whether a live session uses a workspace volume: one at a time, as two
     * sessions on one volume would share (and clobber) one workspace.
     */
    volumeInUse(volumeKey: string) {
        return !!this.db
            .prepare("SELECT 1 FROM coding_sessions WHERE volumeKey=? AND state<>'ended' LIMIT 1")
            .get(volumeKey);
    }
    /**
     * Marks a removed volume's ended sessions, unless a live session uses
     * the key by now: false then, and nothing marked.
     */
    volumeGone(volumeKey: string, at: number) {
        if (this.volumeInUse(volumeKey)) {
            return false;
        }
        this.db
            .prepare(
                "UPDATE coding_sessions SET volumeGoneAt=? WHERE volumeKey=? AND state='ended' AND volumeGoneAt IS NULL",
            )
            .run(at, volumeKey);
        return true;
    }
}

export class RunRows {
    constructor(private db: DatabaseSync) {}
    insert(record: Pick<RunRecord, 'id' | 'sessionId' | 'kind' | 'startedAt' | 'tokensAtStart'>) {
        this.db
            .prepare(
                "INSERT INTO coding_runs(id, sessionId, kind, state, startedAt, tokensAtStart) VALUES (?, ?, ?, 'running', ?, ?)",
            )
            .run(record.id, record.sessionId, record.kind, record.startedAt, record.tokensAtStart);
    }
    get(id: string): RunRecord | undefined {
        const row = this.db.prepare('SELECT * FROM coding_runs WHERE id=?').get(id) as RunRow | undefined;
        return row && runOf(row);
    }
    /** The session's running run, if any (at most one). */
    running(sessionId: string): RunRecord | undefined {
        const row = this.db
            .prepare("SELECT * FROM coding_runs WHERE sessionId=? AND state='running' ORDER BY startedAt DESC LIMIT 1")
            .get(sessionId) as RunRow | undefined;
        return row && runOf(row);
    }
    latest(sessionId: string): RunRecord | undefined {
        const row = this.db
            .prepare('SELECT * FROM coding_runs WHERE sessionId=? ORDER BY startedAt DESC, rowid DESC LIMIT 1')
            .get(sessionId) as RunRow | undefined;
        return row && runOf(row);
    }
    /** Every running run (adoption after a drain or a death). */
    allRunning(): RunRecord[] {
        return (
            this.db
                .prepare("SELECT * FROM coding_runs WHERE state='running' ORDER BY startedAt")
                .all() as unknown as RunRow[]
        ).map(runOf);
    }
    setProgress(id: string, progress: readonly string[]) {
        this.db
            .prepare("UPDATE coding_runs SET progress=? WHERE id=? AND state='running'")
            .run(JSON.stringify(progress), id);
    }
    /** Ends a running run, once; false when it had ended. */
    finish(
        id: string,
        outcome: {
            state: Exclude<CodingRunState, 'running'>;
            at: number;
            tokens?: number | null;
            progress?: readonly string[];
            summary?: string | null;
            changedFiles?: readonly string[];
            error?: string | null;
        },
    ) {
        return (
            Number(
                this.db
                    .prepare(
                        `UPDATE coding_runs SET state=?, endedAt=?, tokens=?, progress=COALESCE(?, progress), summary=?, changedFiles=?, error=?
             WHERE id=? AND state='running'`,
                    )
                    .run(
                        outcome.state,
                        outcome.at,
                        outcome.tokens ?? null,
                        outcome.progress ? JSON.stringify(outcome.progress) : null,
                        outcome.summary ?? null,
                        JSON.stringify(outcome.changedFiles ?? []),
                        outcome.error ?? null,
                        id,
                    ).changes,
            ) > 0
        );
    }
    /** Ends every running run of a session (the session ended). */
    stopAll(sessionId: string, at: number): string[] {
        const ids = (
            this.db
                .prepare("SELECT id FROM coding_runs WHERE sessionId=? AND state='running'")
                .all(sessionId) as Array<{ id: string }>
        ).map((row) => row.id);
        this.db
            .prepare("UPDATE coding_runs SET state='stopped', endedAt=? WHERE sessionId=? AND state='running'")
            .run(at, sessionId);
        return ids;
    }
    /** The tool returned the result within its turn: no report later. */
    answered(id: string) {
        this.db.prepare('UPDATE coding_runs SET answered=1 WHERE id=?').run(id);
    }
    /** Claims the report of an ended run, once. */
    claimReport(id: string, at: number) {
        return (
            Number(
                this.db
                    .prepare(
                        "UPDATE coding_runs SET reportedAt=? WHERE id=? AND state<>'running' AND answered=0 AND reportedAt IS NULL",
                    )
                    .run(at, id).changes,
            ) > 0
        );
    }
    /**
     * Forgets what the agent said (its final message, progress lines, file
     * names, and errors, which quote its output) of runs that ended before
     * `before`: kept only for the session's card and report, never as a
     * record.
     */
    forgetOutput(before: number) {
        return Number(
            this.db
                .prepare(
                    `UPDATE coding_runs SET summary=NULL, progress='[]', changedFiles='[]', error=NULL
           WHERE state<>'running' AND endedAt<? AND (summary IS NOT NULL OR progress<>'[]' OR changedFiles<>'[]' OR error IS NOT NULL)`,
                )
                .run(before).changes,
        );
    }
    /** Ended prompt runs nobody reported yet (a restart in between). */
    unreported(limit = 20): RunRecord[] {
        return (
            this.db
                .prepare(
                    "SELECT * FROM coding_runs WHERE kind='prompt' AND state<>'running' AND answered=0 AND reportedAt IS NULL ORDER BY endedAt LIMIT ?",
                )
                .all(limit) as unknown as RunRow[]
        ).map(runOf);
    }
}

export class DenialRows {
    constructor(private db: DatabaseSync) {}
    /**
     * Records a host's count; true the first time this session and host
     * are seen, on any runtime (the caller writes its audit row then).
     */
    note(sessionId: string, target: string, count: number, at: number) {
        const fresh =
            Number(
                this.db
                    .prepare(
                        'INSERT OR IGNORE INTO coding_denials(sessionId, target, firstAt, count) VALUES (?, ?, ?, ?)',
                    )
                    .run(sessionId, target, at, count).changes,
            ) > 0;
        if (!fresh) {
            this.db
                .prepare('UPDATE coding_denials SET count=MAX(count, ?) WHERE sessionId=? AND target=?')
                .run(count, sessionId, target);
        }
        return fresh;
    }
    of(sessionId: string): Array<{ target: string; count: number }> {
        return this.db
            .prepare('SELECT target, count FROM coding_denials WHERE sessionId=? ORDER BY count DESC, target LIMIT 50')
            .all(sessionId) as Array<{ target: string; count: number }>;
    }
}

/** An admin's sandbox settings over the environment's (Settings → Coding). */
export class SandboxSettingRows {
    constructor(private db: DatabaseSync) {}
    all(): Record<string, string> {
        return Object.fromEntries(
            (
                this.db.prepare('SELECT key, value FROM coding_settings').all() as Array<{
                    key: string;
                    value: string;
                }>
            ).map((row) => [row.key, row.value]),
        );
    }
    /** Saves a value, or removes it (`null`: back to the default). */
    set(key: string, value: string | null, by: string, at: number) {
        if (value === null) {
            this.db.prepare('DELETE FROM coding_settings WHERE key=?').run(key);
        } else {
            this.db
                .prepare(
                    `INSERT INTO coding_settings(key, value, updatedAt, updatedBy) VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt, updatedBy=excluded.updatedBy`,
                )
                .run(key, value, at, by);
        }
    }
}

/**
 * The session host's thread events (CB-326 step 3): one row per
 * `ProviderAdapterV2Event` the host streams out, written as the host emits
 * them. The `payload` is the event's data, bounded and redacted; `ordinal` is
 * the event's place in the stream so the UI orders and pages it. Soft-deleted
 * with the session (CB-64): a session's events go when it does.
 */
export interface ThreadEventRecord {
    id: string;
    sessionId: string;
    personId: string;
    requesterId: string;
    kind: string;
    ordinal: number;
    nativeThreadId: string | null;
    nativeTurnId: string | null;
    nativeItemId: string | null;
    payload: string;
    createdAt: number;
    deletedAt: number | null;
    deletedBy: string | null;
    deletedWith: string | null;
}

export class ThreadEventRows {
    constructor(private db: DatabaseSync) {}

    /** Appends one event; the id and ordinal are the caller's to assign. */
    insert(event: ThreadEventRecord) {
        this.db
            .prepare(
                `INSERT INTO coding_thread_events(
          id, sessionId, personId, requesterId, kind, ordinal,
          nativeThreadId, nativeTurnId, nativeItemId, payload, createdAt,
          deletedAt, deletedBy, deletedWith)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                event.id,
                event.sessionId,
                event.personId,
                event.requesterId,
                event.kind,
                event.ordinal,
                event.nativeThreadId,
                event.nativeTurnId,
                event.nativeItemId,
                event.payload,
                event.createdAt,
                event.deletedAt,
                event.deletedBy,
                event.deletedWith,
            );
    }

    /** A session's live events in stream order, paged by ordinal (`after` exclusive). */
    page(sessionId: string, after: number, limit: number): ThreadEventRecord[] {
        return this.db
            .prepare(
                `SELECT * FROM coding_thread_events
          WHERE sessionId=? AND ordinal>? AND deletedAt IS NULL
          ORDER BY ordinal LIMIT ?`,
            )
            .all(sessionId, after, limit) as unknown as ThreadEventRecord[];
    }

    /** The next ordinal for a session (0 if none yet). */
    nextOrdinal(sessionId: string): number {
        const row = this.db
            .prepare('SELECT MAX(ordinal) AS max FROM coding_thread_events WHERE sessionId=?')
            .get(sessionId) as { max: number | null } | undefined;
        return (row?.max ?? -1) + 1;
    }

    /** Soft-deletes a session's events when the session ends (CB-64). */
    softDelete(sessionId: string, by: string, withKind: string, at: number) {
        this.db
            .prepare(
                `UPDATE coding_thread_events
          SET deletedAt=?, deletedBy=?, deletedWith=?
          WHERE sessionId=? AND deletedAt IS NULL`,
            )
            .run(at, by, `${withKind}:${sessionId}`, sessionId);
    }
}

/**
 * The coding session gateway exchange log (CB-326 step 6); the record is
 * `GatewayExchangeRecord` in `coding/contract.ts`.
 */
export class GatewayExchangeRows implements GatewayExchangesShape {
    constructor(private db: DatabaseSync) {}

    /** Inserts one exchange row; the id and hashes are the caller's to assign. */
    insert(exchange: GatewayExchangeRecord) {
        this.db
            .prepare(
                `INSERT INTO gateway_exchanges(
          id, usageId, sessionId, holderId, requesterId, harness, api, route,
          model, upstreamKind, requestAt, responseAt, status, bodyPath,
          requestBytes, responseBytes, requestHash, responseHash,
          deletedAt, deletedBy, deletedWith)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                exchange.id,
                exchange.usageId,
                exchange.sessionId,
                exchange.holderId,
                exchange.requesterId,
                exchange.harness,
                exchange.api,
                exchange.route,
                exchange.model,
                exchange.upstreamKind,
                exchange.requestAt,
                exchange.responseAt,
                exchange.status,
                exchange.bodyPath,
                exchange.requestBytes,
                exchange.responseBytes,
                exchange.requestHash,
                exchange.responseHash,
                exchange.deletedAt,
                exchange.deletedBy,
                exchange.deletedWith,
            );
    }

    /** A session's live exchanges in request order, paged by `after` (exclusive). */
    page(sessionId: string, after: number, limit: number): GatewayExchangeRecord[] {
        return this.db
            .prepare(
                `SELECT * FROM gateway_exchanges
          WHERE sessionId=? AND requestAt>? AND deletedAt IS NULL
          ORDER BY requestAt LIMIT ?`,
            )
            .all(sessionId, after, limit) as unknown as GatewayExchangeRecord[];
    }

    /** Soft-deletes a session's exchanges when the session ends (CB-64). */
    softDelete(sessionId: string, by: string, withKind: string, at: number) {
        this.db
            .prepare(
                `UPDATE gateway_exchanges
          SET deletedAt=?, deletedBy=?, deletedWith=?
          WHERE sessionId=? AND deletedAt IS NULL`,
            )
            .run(at, by, `${withKind}:${sessionId}`, sessionId);
    }
}
