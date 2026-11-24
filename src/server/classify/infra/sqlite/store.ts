import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { transaction } from '@socio/data/open';
import type { ClassifyEvalReport, ClassifyUse } from '@socio/shared/classify';

import type { ClassifyUsage, LabelsShape, NewLabel, StoredLabel } from '../../contract.js';

/** One model call, as `classify_calls` keeps it. */
export interface ClassifyCall {
    at: number;
    use: string;
    purpose: 'label' | 'eval';
    provider: string;
    version: string;
    subject: string | null;
    outcome: 'ok' | 'invalid' | 'error';
    answer: string | null;
    confidence: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
    durationMs: number;
}

const DAY = 86_400_000;

const labelOf = (row: unknown): StoredLabel => {
    const stored = row as Omit<StoredLabel, 'applied'> & { applied: number };
    return { ...stored, applied: !!stored.applied };
};

/**
 * The seam's tables (CB-198), on the workspace connection. Reads are
 * single statements; writes go through the unit of work (`transaction`),
 * queued behind any open one.
 */
export class ClassifyStore implements LabelsShape {
    constructor(private db: DatabaseSync) {}

    /** Logs a call; `id` is made here. */
    recordCall(call: ClassifyCall) {
        return transaction(this.db, 'classify call', () => {
            this.db
                .prepare(
                    `INSERT INTO classify_calls(id, at, use, purpose, provider, version, subject, outcome, answer, confidence, inputTokens, outputTokens, costUsd, durationMs)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                    randomUUID(),
                    call.at,
                    call.use,
                    call.purpose,
                    call.provider,
                    call.version,
                    call.subject,
                    call.outcome,
                    call.answer,
                    call.confidence,
                    call.inputTokens,
                    call.outputTokens,
                    call.costUsd,
                    call.durationMs,
                );
        });
    }

    /** Labeling calls of `use` since `since` (the daily cap counts these). */
    labelCallsSince(use: string, since: number) {
        const row = this.db
            .prepare("SELECT count(*) AS n FROM classify_calls WHERE use=? AND purpose='label' AND at>=?")
            .get(use, since) as { n: number };
        return row.n;
    }

    /** The last 24 hours' calls of `use`: counts, tokens and the known cost. */
    usage(use: string, now = Date.now()) {
        const row = this.db
            .prepare(
                `SELECT count(*) FILTER (WHERE purpose='label') AS label,
          count(*) FILTER (WHERE purpose='eval') AS eval,
          COALESCE(sum(COALESCE(inputTokens,0) + COALESCE(outputTokens,0)), 0) AS tokens,
          sum(costUsd) AS cost,
          count(*) FILTER (WHERE costUsd IS NULL) AS unknown
        FROM classify_calls WHERE use=? AND at>=?`,
            )
            .get(use, now - DAY) as ClassifyUsage;
        return row;
    }

    /** Whether a labeling call was made for this subject before. */
    triedSubject(use: string, subject: string) {
        return !!this.db
            .prepare("SELECT 1 FROM classify_calls WHERE use=? AND subject=? AND purpose='label' LIMIT 1")
            .get(use, subject);
    }

    addLabel(label: NewLabel) {
        return transaction(this.db, 'classify label', () => {
            const result = this.db
                .prepare(
                    `INSERT INTO classify_labels(use, labelsVersion, runId, idx, label, source, provider, version, confidence, applied, input, actorId, at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                    label.use,
                    label.labelsVersion,
                    label.runId,
                    label.idx,
                    label.label,
                    label.source,
                    label.provider,
                    label.version,
                    label.confidence,
                    label.applied ? 1 : 0,
                    label.input,
                    label.actorId,
                    label.at,
                );
            return Number(result.lastInsertRowid);
        });
    }

    /** A subject's labels, newest first. */
    labels(use: string, runId: string, idx: number): StoredLabel[] {
        return this.db
            .prepare('SELECT * FROM classify_labels WHERE use=? AND runId=? AND idx=? ORDER BY seq DESC')
            .all(use, runId, idx)
            .map(labelOf);
    }

    /** Whether the subject has any label, an admin's or the model's. */
    labelled(use: string, runId: string, idx: number) {
        return !!this.db
            .prepare('SELECT 1 FROM classify_labels WHERE use=? AND runId=? AND idx=? LIMIT 1')
            .get(use, runId, idx);
    }

    /**
     * The golden set: each subject's newest admin label for this list of
     * labels, oldest first.
     */
    golden(use: string, labelsVersion: number): StoredLabel[] {
        return this.db
            .prepare(
                `SELECT l.* FROM classify_labels l
        WHERE l.use=? AND l.source='admin' AND l.labelsVersion=?
          AND l.seq = (SELECT max(seq) FROM classify_labels x
            WHERE x.use=l.use AND x.runId=l.runId AND x.idx=l.idx AND x.source='admin')
        ORDER BY l.seq`,
            )
            .all(use, labelsVersion)
            .map(labelOf);
    }
    goldenCount(use: string, labelsVersion: number) {
        const row = this.db
            .prepare(
                `SELECT count(DISTINCT runId || ':' || idx) AS n FROM classify_labels
        WHERE use=? AND source='admin' AND labelsVersion=?`,
            )
            .get(use, labelsVersion) as { n: number };
        return row.n;
    }

    /**
     * Whether this provider version passed an evaluation for this label
     * list at a threshold no lower than `threshold`: a pass at 0.9 says
     * nothing about answers the model is only 0.8 sure of.
     */
    passed(use: string, provider: string, version: string, labelsVersion: number, threshold: number) {
        return !!this.db
            .prepare(
                `SELECT 1 FROM classify_evals WHERE use=? AND provider=? AND version=? AND labelsVersion=?
          AND status='done' AND passed=1 AND threshold <= ? LIMIT 1`,
            )
            .get(use, provider, version, labelsVersion, threshold + 1e-9);
    }

    startEval(
        use: ClassifyUse,
        provider: string,
        version: string,
        labelsVersion: number,
        threshold: number,
        startedBy: string | null,
        now = Date.now(),
    ) {
        const id = randomUUID();
        return transaction(this.db, 'classify evaluation', () => {
            this.db
                .prepare(
                    `INSERT INTO classify_evals(id, use, provider, version, labelsVersion, threshold, status, startedAt, startedBy)
          VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
                )
                .run(id, use, provider, version, labelsVersion, threshold, now, startedBy);
            return id;
        });
    }

    finishEval(id: string, report: ClassifyEvalReport) {
        return transaction(this.db, 'classify evaluation', () => {
            this.db
                .prepare('UPDATE classify_evals SET status=?, passed=?, finishedAt=?, report=? WHERE id=?')
                .run(report.status, report.passed ? 1 : 0, report.finishedAt, JSON.stringify(report), id);
        });
    }

    /** Evaluations a stopped server left running end as failed. */
    failRunningEvals(now = Date.now()) {
        return transaction(this.db, 'classify evaluation', () => {
            this.db
                .prepare(
                    `UPDATE classify_evals SET status='failed', finishedAt=?,
            report=json_set(report, '$.status', 'failed', '$.error', 'The server stopped before it finished.')
          WHERE status='running'`,
                )
                .run(now);
        });
    }

    /** The newest evaluation of `use`, of this version when there is one. */
    latestEval(use: string, version: string | null): ClassifyEvalReport | null {
        const row =
            (version
                ? this.db
                      .prepare(
                          'SELECT report FROM classify_evals WHERE use=? AND version=? ORDER BY startedAt DESC LIMIT 1',
                      )
                      .get(use, version)
                : undefined) ??
            this.db.prepare('SELECT report FROM classify_evals WHERE use=? ORDER BY startedAt DESC LIMIT 1').get(use);
        if (!row) {
            return null;
        }
        return JSON.parse((row as { report: string }).report) as ClassifyEvalReport;
    }

    /**
     * After a pass: the version's earlier sure suggestions are applied,
     * each as a new label row (labels are append-only), unless an admin
     * labeled the subject since. Returns how many.
     */
    promote(
        use: string,
        provider: string,
        version: string,
        labelsVersion: number,
        threshold: number,
        now = Date.now(),
    ) {
        return transaction(this.db, 'classify promote', () => {
            const result = this.db
                .prepare(
                    `INSERT INTO classify_labels(use, labelsVersion, runId, idx, label, source, provider, version, confidence, applied, input, actorId, at)
          SELECT l.use, l.labelsVersion, l.runId, l.idx, l.label, 'model', l.provider, l.version, l.confidence, 1, l.input, NULL, ?
          FROM classify_labels l
          WHERE l.use=? AND l.provider=? AND l.version=? AND l.labelsVersion=? AND l.applied=0
            AND l.confidence >= ? AND l.label <> 'unclassified'
            AND l.seq = (SELECT max(seq) FROM classify_labels x WHERE x.use=l.use AND x.runId=l.runId AND x.idx=l.idx)`,
                )
                .run(now, use, provider, version, labelsVersion, threshold - 1e-9);
            return Number(result.changes);
        });
    }

    /**
     * The subjects of `use` with a label (an admin's or the model's), the
     * newest labeled first: their `runId` and newest `seq`, before
     * `before`; only those no admin labeled yet when `unreviewed`.
     */
    labelledSubjects(
        use: string,
        { before, limit, unreviewed }: { before?: number; limit: number; unreviewed?: boolean },
    ): { runId: string; seq: number }[] {
        return this.db
            .prepare(
                `SELECT runId, max(seq) AS seq FROM classify_labels WHERE use=? AND idx=-1
        GROUP BY runId
        HAVING (? = 0 OR sum(source = 'admin') = 0) AND max(seq) < ?
        ORDER BY seq DESC LIMIT ?`,
            )
            .all(use, unreviewed ? 1 : 0, before ?? Number.MAX_SAFE_INTEGER, limit) as { runId: string; seq: number }[];
    }

    cursor(use: string): string | null {
        const row = this.db.prepare('SELECT cursor FROM classify_cursors WHERE use=?').get(use) as
            | { cursor: string }
            | undefined;
        return row?.cursor ?? null;
    }
    setCursor(use: string, cursor: string) {
        return transaction(this.db, 'classify cursor', () => {
            this.db
                .prepare(
                    'INSERT INTO classify_cursors(use, cursor) VALUES (?, ?) ON CONFLICT(use) DO UPDATE SET cursor=excluded.cursor',
                )
                .run(use, cursor);
        });
    }
}
