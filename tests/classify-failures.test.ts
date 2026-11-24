import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';

import { migrate } from '@socio/data/migrate';
import { sqliteData } from '@socio/data/open';
import type { AppEnv } from '@socio/foundation/http/app-env';
import {
    FAILURE_LABELS,
    MIN_GOLDEN,
    type ClassifySettings,
    type ClassifyUseView,
    type FailureLabelView,
} from '@socio/shared/classify';
import type { Settings, User } from '@socio/shared/types';

import type { ClassifyProvider } from '../src/server/classify/contract.js';
import { formatEvalReport, parseEvalArgs } from '../src/server/classify/eval-cli.js';
import { EvalRefused, evaluateFailures, scoreEvaluation } from '../src/server/classify/eval.js';
import { CALLS_PER_TICK } from '../src/server/classify/failures.js';
import { classifySchema } from '../src/server/classify/migrations.js';
import { classifyRoutes } from '../src/server/classify/routes.js';
import { ClassifyService } from '../src/server/classify/service.js';
import { auditor } from '../src/server/operations/access-log.js';
import { sqliteOperationsRepositories } from '../src/server/operations/infra/sqlite/access-log.js';
import { sqliteSourceReader } from '../src/server/operations/infra/sqlite/source-reader.js';
import { operationsSchema } from '../src/server/operations/migrations.js';

import { categoryAnswer, fakeProvider } from './fixtures/classify-fakes.js';
import { openAppDatabase } from './fixtures/seed-ops-runs.js';

// The `failures` use (CB-198): labeling what the rules leave Unclassified
// while an admin has it on, admins' relabels as the golden set, the
// evaluation that lets the model's labels count, and the admin API. The
// model is a fake provider: nothing leaves the machine.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const HOUR = 3_600_000;

function database() {
    const dir = mkdtempSync(join(tmpdir(), 'classify-failures-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const db = openAppDatabase(join(dir, 'company-brain.sqlite'));
    migrate(db, [operationsSchema, classifySchema]);
    cleanup.push(() => db.close());
    return db;
}

interface RunSeed {
    runId: string;
    status: 'finished' | 'failed' | 'running';
    code?: string;
    detail?: string;
    tools?: { name: string; outcome: string; error?: string; result?: string }[];
    startedAt?: number;
}

function addRun(db: DatabaseSync, run: RunSeed) {
    const startedAt = run.startedAt ?? Date.now() - HOUR;
    const events: object[] = [];
    const tools = (run.tools ?? []).map((tool, i) => {
        if (tool.result !== undefined) {
            events.push({
                type: 'TOOL_CALL_RESULT',
                toolCallId: `${run.runId}-c${i}`,
                content: tool.result,
            });
        }
        return {
            kind: 'tool',
            round: 1,
            name: tool.name,
            callId: `${run.runId}-c${i}`,
            outcome: tool.outcome,
            ...(tool.error ? { error: tool.error } : {}),
            startedAt: startedAt + 100,
            endedAt: startedAt + 200,
        };
    });
    if (run.code) {
        events.push({ type: 'RUN_ERROR', code: run.code });
    }
    db.prepare(
        'INSERT INTO agent_runs (threadId, runId, status, events, startedAt, finishedAt, source, trace, errorDetail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
        't1',
        run.runId,
        run.status,
        JSON.stringify(events),
        startedAt,
        run.status === 'running' ? null : startedAt + 1000,
        'web',
        JSON.stringify({
            tools,
            end: { reason: run.status === 'failed' ? 'error' : 'completed' },
        }),
        run.detail ?? null,
    );
}

/** The workspace's fake model: it reads the text and answers. */
function model(answer: (text: string) => [string, number] = () => ['external_service', 0.95]) {
    return fakeProvider('workspace', (request) => {
        const text = /"text": "(.*)"/.exec(request.user)?.[1] ?? '';
        const [label, confidence] = answer(text);
        return categoryAnswer(label, confidence);
    });
}

function service(
    db: DatabaseSync,
    providers: ClassifyProvider[],
    classify: ClassifySettings = { failures: { enabled: true } },
) {
    const settings: Pick<Settings, 'classify'> = { classify };
    return {
        settings,
        service: new ClassifyService({
            db,
            runs: sqliteSourceReader(db),
            settings: () => settings,
            providers,
        }),
    };
}

function seedFailures(db: DatabaseSync) {
    // The rules can't tell: a bare failure with an operator detail.
    addRun(db, {
        runId: 'r-detail',
        status: 'failed',
        code: 'failed',
        detail: 'Upstream answered 502 for ana@example.com',
    });
    // A generic tool error with its result.
    addRun(db, {
        runId: 'r-tool',
        status: 'finished',
        tools: [
            {
                name: 'run_command',
                outcome: 'error',
                error: 'tool_error',
                result: 'connect ECONNREFUSED 10.0.0.5:5432',
            },
        ],
    });
    // The rules sort this one: never asked about.
    addRun(db, { runId: 'r-sorted', status: 'failed', code: 'rate_limited' });
    // Unclassified, but there is no text to go on.
    addRun(db, {
        runId: 'r-silent',
        status: 'finished',
        tools: [{ name: 'run_command', outcome: 'error', error: 'tool_error' }],
    });
    addRun(db, { runId: 'r-running', status: 'running' });
}

describe('labelling Unclassified failures', () => {
    it('asks about each Unclassified part with text once, and keeps its answer as a suggestion', async () => {
        const db = database();
        seedFailures(db);
        const fake = model();
        const { service: s } = service(db, [fake]);
        await s.tick();
        expect(fake.requests).toHaveLength(2);
        const labels = db
            .prepare('SELECT runId, idx, label, source, applied, input FROM classify_labels ORDER BY seq')
            .all() as { runId: string; idx: number; input: string }[];
        expect(labels.map(({ runId, idx }) => [runId, idx])).toEqual([
            ['r-detail', -1],
            ['r-tool', 0],
        ]);
        expect(labels[0]).toMatchObject({
            label: 'external_service',
            source: 'model',
            // No version has passed an evaluation yet.
            applied: 0,
        });
        // What it was given is kept scrubbed, never the address.
        expect(labels[0]!.input).not.toContain('ana@example.com');
        expect(JSON.parse(labels[1]!.input)).toMatchObject({
            level: 'tool',
            tool: 'run_command',
            code: 'tool_error',
            text: 'connect ECONNREFUSED 10.0.0.5:5432',
        });
        // Nothing is asked twice.
        await s.tick();
        expect(fake.requests).toHaveLength(2);
        // The running turn is read again once it ends.
        db.prepare(
            "UPDATE agent_runs SET status='failed', finishedAt=?, events=?, errorDetail='Socket hang up' WHERE runId='r-running'",
        ).run(Date.now(), JSON.stringify([{ type: 'RUN_ERROR', code: 'failed' }]));
        await s.tick();
        expect(fake.requests).toHaveLength(3);
        expect(fake.requests[2]!.user).toContain('Socket hang up');
    });

    it('does nothing while off, and stops at the daily cap without skipping a turn', async () => {
        const db = database();
        seedFailures(db);
        const fake = model();
        const { service: off } = service(db, [fake], {});
        await off.tick();
        expect(fake.requests).toHaveLength(0);
        const { service: capped, settings } = service(db, [fake], {
            failures: { enabled: true, perDay: 1 },
        });
        await capped.tick();
        await capped.tick();
        expect(fake.requests).toHaveLength(1);
        settings.classify = { failures: { enabled: true, perDay: 10 } };
        await capped.tick();
        expect(fake.requests).toHaveLength(2);
    });

    it('asks at most a few times a tick', async () => {
        const db = database();
        for (let i = 0; i < CALLS_PER_TICK + 3; i++) {
            addRun(db, {
                runId: `r-${i}`,
                status: 'failed',
                code: 'failed',
                detail: `Failure ${i}`,
            });
        }
        const fake = model();
        const { service: s } = service(db, [fake]);
        await s.tick();
        expect(fake.requests).toHaveLength(CALLS_PER_TICK);
        await s.tick();
        expect(fake.requests).toHaveLength(CALLS_PER_TICK + 3);
    });
});

describe('admins’ labels and the evaluation', () => {
    /** Admin labels whose text names their category, for a model that reads it. */
    async function golden(s: ClassifyService, db: DatabaseSync, n: number) {
        const labels = FAILURE_LABELS.filter((label) => label !== 'unclassified');
        for (let i = 0; i < n; i++) {
            const label = labels[i % labels.length]!;
            addRun(db, {
                runId: `g-${i}`,
                status: 'failed',
                code: 'failed',
                detail: `the cause is ${label}`,
                startedAt: Date.now() - 30 * 86_400_000,
            });
            const subject = s.failures.subject(`g-${i}`, 'turn')!;
            await s.failures.relabel(subject, label, 'alice');
        }
    }
    const reading = (text: string): [string, number] => {
        const found = /the cause is (\w+)/.exec(text)?.[1];
        return found ? [found, 0.97] : ['external_service', 0.95];
    };

    it('labels a failure, in force at once, and shows what the model reads and said', async () => {
        const db = database();
        seedFailures(db);
        const { service: s } = service(db, [model()]);
        await s.tick();
        const subject = s.failures.subject('r-detail', 'turn')!;
        expect(subject).toMatchObject({
            rulesCategory: 'unclassified',
            rule: 'failed_with_detail',
        });
        await s.failures.relabel(subject, 'model_provider', 'alice');
        const view = s.failures.view(subject, (id) => (id === 'alice' ? 'Alice' : undefined));
        expect(view).toMatchObject({
            runId: 'r-detail',
            level: 'turn',
            idx: null,
            labelable: true,
            label: { label: 'model_provider', source: 'admin', by: 'Alice' },
            suggestion: { label: 'external_service', applied: false },
        });
        expect(view.input).toContain('Upstream answered 502');
        expect(view.input).not.toContain('ana@example.com');
        expect(s.failures.subject('r-sorted', 'turn')!.rulesCategory).toBe('quotas');
        expect(s.store.goldenCount('failures', 1)).toBe(1);
    });

    it('refuses to evaluate without a model or enough labels', async () => {
        const db = database();
        const { service: none } = service(db, [fakeProvider('workspace', () => '{}', null)]);
        await expect(evaluateFailures({ classifier: none.classifier, store: none.store })).rejects.toBeInstanceOf(
            EvalRefused,
        );
        const { service: s } = service(db, [model(reading)]);
        await golden(s, db, MIN_GOLDEN - 1);
        await expect(evaluateFailures({ classifier: s.classifier, store: s.store })).rejects.toThrow(
            /needs at least 20/,
        );
    });

    it('passes a version that is right often enough, which then applies its sure labels', async () => {
        const db = database();
        seedFailures(db);
        const fake = model(reading);
        const { service: s } = service(db, [fake]);
        await s.tick();
        await golden(s, db, 21);
        const before = fake.requests.length;
        const report = await evaluateFailures({
            classifier: s.classifier,
            store: s.store,
        });
        expect(fake.requests.length - before).toBe(21);
        expect(report).toMatchObject({
            status: 'done',
            golden: 21,
            answered: 21,
            correct: 21,
            precision: 1,
            passed: true,
            version: 'workspace:fake-1/p1',
        });
        expect(report.confusion.quotas!.quotas).toBe(3);
        // Eval calls are logged apart and not capped.
        expect(s.store.usage('failures').eval).toBe(21);
        // The suggestion it made before the pass now counts, as a new row.
        const tool = s.store.labels('failures', 'r-tool', 0);
        expect(tool[0]).toMatchObject({ source: 'model', applied: true });
        expect(tool[1]).toMatchObject({ source: 'model', applied: false });
        // An admin's label is never overridden by the promotion.
        expect(s.store.labels('failures', 'r-detail', -1)[0]!.source).toBe('model');
        const view = await s.view('failures');
        expect(view).toMatchObject({
            versionPassed: true,
            golden: 21,
            lastEval: { passed: true },
        });
        // New answers from the version count at once when sure.
        addRun(db, {
            runId: 'r-new',
            status: 'failed',
            code: 'failed',
            detail: 'the cause is quotas',
        });
        await s.tick();
        expect(s.store.labels('failures', 'r-new', -1)[0]).toMatchObject({
            label: 'quotas',
            applied: true,
        });
    });

    it('evaluates in the background, one at a time', async () => {
        const db = database();
        const { service: s } = service(db, [model(reading)]);
        await golden(s, db, 20);
        expect(await s.evaluate('alice')).toBe(true);
        expect(s.evaluating).toBe(true);
        expect(await s.evaluate('alice')).toBe(false);
        await s.idle();
        expect(s.evaluating).toBe(false);
        expect(await s.view('failures')).toMatchObject({
            versionPassed: true,
            evaluating: false,
            lastEval: { status: 'done', passed: true, golden: 20 },
        });
        // One left running by a stopped server ends as failed.
        await s.store.startEval('failures', 'workspace', 'v', 1, 0.9, null);
        await s.start();
        expect(db.prepare("SELECT count(*) AS n FROM classify_evals WHERE status='running'").get()).toEqual({ n: 0 });
    });

    it('fails a version that is wrong too often, and keeps its labels as suggestions', async () => {
        const db = database();
        const { service: s } = service(db, [model(() => ['quotas', 0.99])]);
        await golden(s, db, 21);
        const report = await evaluateFailures({
            classifier: s.classifier,
            store: s.store,
        });
        expect(report).toMatchObject({ status: 'done', passed: false });
        expect(report.precision).toBeLessThan(0.9);
        expect((await s.view('failures')).versionPassed).toBe(false);
        expect(formatEvalReport(report)).toMatch(/Did not pass/);
    });
});

describe('scoring', () => {
    it('counts abstentions as Unclassified, and precision over what was answered', () => {
        const scored = scoreEvaluation(
            [
                ...Array.from({ length: 15 }, () => ({
                    gold: 'quotas',
                    predicted: 'quotas',
                })),
                { gold: 'quotas', predicted: 'unclassified' },
                { gold: 'runtime_error', predicted: 'quotas' },
                { gold: 'runtime_error', predicted: 'runtime_error' },
                { gold: 'unclassified', predicted: 'unclassified' },
                { gold: 'unclassified', predicted: 'runtime_error' },
            ],
            FAILURE_LABELS,
            0.85,
        );
        expect(scored).toMatchObject({
            golden: 20,
            answered: 18,
            correct: 17,
            precision: 16 / 18,
            accuracy: 17 / 20,
            passed: true,
        });
        const quotas = scored.labels.find((label) => label.label === 'quotas')!;
        expect(quotas).toMatchObject({
            support: 16,
            predicted: 16,
            correct: 15,
            precision: 15 / 16,
            recall: 15 / 16,
        });
        expect(scored.confusion.runtime_error!.quotas).toBe(1);
        expect(scoreEvaluation([], FAILURE_LABELS, 0.9)).toMatchObject({
            passed: false,
            precision: null,
        });
    });
});

describe('the evaluation command', () => {
    it('reads --use and --provider, and refuses what it doesn’t know', () => {
        expect(
            parseEvalArgs(['--', '--use=failures', '--provider=workspace'], {
                DATABASE_PATH: '/data/x.sqlite',
            }),
        ).toEqual({
            use: 'failures',
            provider: 'workspace',
            database: '/data/x.sqlite',
        });
        expect(() => parseEvalArgs(['--use=skills'], {})).toThrow(/no use/);
        expect(parseEvalArgs(['--use=learning'], {}).use).toBe('learning');
        expect(() => parseEvalArgs(['--rows=3'], {})).toThrow(/Unknown option/);
        expect(() => parseEvalArgs(['failures'], {})).toThrow(/Unknown argument/);
    });
});

describe('the routes', () => {
    const alice: User = { id: 'alice', name: 'Alice', role: 'admin' };
    function app(db: DatabaseSync, s: ClassifyService, settings: Settings) {
        const audits: unknown[] = [];
        const context = {
            db,
            store: {
                settings: () => settings,
                updateSettings: async (patch: Partial<Settings>) => Object.assign(settings, patch),
            },
            workspace: {
                users: () => [alice],
                audit: (entry: unknown) => audits.push(entry),
            },
        } as never;
        const outer = new Hono<AppEnv>();
        outer.use(async (c, next) => {
            c.set('user', alice);
            await next();
        });
        outer.route(
            '/api',
            classifyRoutes(context, s, {
                audit: auditor({ log: sqliteOperationsRepositories(sqliteData(db)).accessLog }),
            }),
        );
        return { outer, audits };
    }

    it('reads and saves a use’s settings, auditing the change', async () => {
        const db = database();
        const settings = {} as Settings;
        const s = new ClassifyService({
            db,
            runs: sqliteSourceReader(db),
            settings: () => settings,
            providers: [model()],
        });
        const { outer, audits } = app(db, s, settings);
        const first = (await (await outer.request('/api/classify/uses/failures')).json()) as ClassifyUseView;
        expect(first).toMatchObject({
            enabled: false,
            threshold: 0.9,
            available: true,
            version: 'workspace:fake-1/p1',
            versionPassed: false,
            golden: 0,
        });
        const saved = await outer.request('/api/classify/uses/failures', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: true, perDay: 20 }),
        });
        expect(saved.status).toBe(200);
        expect(await saved.json()).toMatchObject({ enabled: true, perDay: 20 });
        expect(settings.classify).toEqual({
            failures: { enabled: true, perDay: 20 },
        });
        expect(audits).toEqual([
            expect.objectContaining({
                targetKind: 'operations_settings',
                targetId: 'classify:failures',
            }),
        ]);
        for (const body of [{ threshold: 1 }, { provider: 'jev' }, { x: 1 }]) {
            expect(
                (
                    await outer.request('/api/classify/uses/failures', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body),
                    })
                ).status,
            ).toBe(400);
        }
        expect((await outer.request('/api/classify/uses/skills')).status).toBe(404);
        const evaluate = await outer.request('/api/classify/uses/failures/evaluate', { method: 'POST' });
        expect(evaluate.status).toBe(409);
        expect(await evaluate.json()).toMatchObject({
            error: expect.stringMatching(/golden set has 0/),
        });
    });

    it('opens a failure’s label on the access log, and takes an admin’s label', async () => {
        const db = database();
        seedFailures(db);
        const settings = {} as Settings;
        const s = new ClassifyService({
            db,
            runs: sqliteSourceReader(db),
            settings: () => settings,
            providers: [model()],
        });
        const { outer } = app(db, s, settings);
        const opened = await outer.request('/api/classify/failures/r-tool?level=tool&via=reliability');
        expect(opened.status).toBe(200);
        expect(await opened.json()).toMatchObject({
            level: 'tool',
            idx: 0,
            tool: 'run_command',
            labelable: true,
            input: 'connect ECONNREFUSED 10.0.0.5:5432',
            label: null,
        });
        expect(db.prepare('SELECT surface, subjectKind, subjectId, content, filters FROM access_log').all()).toEqual([
            {
                surface: 'failure-label',
                subjectKind: 'run',
                subjectId: 'r-tool',
                content: 1,
                filters: JSON.stringify({ via: 'reliability' }),
            },
        ]);
        const put = (runId: string, body: unknown) =>
            outer.request(`/api/classify/failures/${runId}/label`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
        const labelled = await put('r-tool', {
            level: 'tool',
            label: 'external_service',
        });
        expect(labelled.status).toBe(200);
        expect(((await labelled.json()) as FailureLabelView).label).toMatchObject({
            label: 'external_service',
            source: 'admin',
            by: 'Alice',
        });
        expect((await put('r-sorted', { level: 'turn', label: 'quotas' })).status).toBe(409);
        expect((await put('r-tool', { level: 'tool', label: 'stopped' })).status).toBe(400);
        expect((await put('nope', { level: 'turn', label: 'quotas' })).status).toBe(404);
        expect((await outer.request('/api/classify/failures/r-tool?level=x')).status).toBe(400);
        // A refused open isn't logged.
        expect(db.prepare('SELECT count(*) AS n FROM access_log').get()).toEqual({
            n: 1,
        });
    });
});
