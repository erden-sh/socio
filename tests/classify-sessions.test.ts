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
    INTENT_LABELS,
    MIN_GOLDEN,
    intentLabelsVersion,
    topicKey,
    type ClassifySettings,
    type ClassifyUseView,
    type SessionLabelRow,
    type SessionLabelView,
} from '@socio/shared/classify';
import type { CursorPage } from '@socio/shared/operations/operations';
import type { Settings, User } from '@socio/shared/types';

import type { ClassifyProvider, ProviderRequest } from '../src/server/classify/contract.js';
import { parseEvalArgs } from '../src/server/classify/eval-cli.js';
import { evaluateUse, scoreEvaluation, topicsMatch } from '../src/server/classify/eval.js';
import { classifySchema } from '../src/server/classify/migrations.js';
import { classifyRoutes } from '../src/server/classify/routes.js';
import { ClassifyService } from '../src/server/classify/service.js';
import { SESSION_CALLS_PER_TICK, cleanTopics } from '../src/server/classify/sessions.js';
import { classifySettingsFromEnv, intentLabels } from '../src/server/classify/settings.js';
import { auditor } from '../src/server/operations/access-log.js';
import { sqliteOperationsRepositories } from '../src/server/operations/infra/sqlite/access-log.js';
import { sqliteSourceReader } from '../src/server/operations/infra/sqlite/source-reader.js';
import { operationsSchema } from '../src/server/operations/migrations.js';

import { fakeProvider } from './fixtures/classify-fakes.js';
import { openAppDatabase } from './fixtures/seed-ops-runs.js';

// Sessions' intent and themes (CB-199): which turns open a session and
// when its first messages are in, labeling them through the seam while
// an admin has a use on, admins' labels as each use's golden set, the
// evaluation gate, intent's editable list, and the admin API with the
// access log. The model is a fake provider: nothing leaves the machine.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = Date.UTC(2026, 9, 20, 9);

function database() {
    const dir = mkdtempSync(join(tmpdir(), 'classify-sessions-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const db = openAppDatabase(join(dir, 'company-brain.sqlite'));
    migrate(db, [operationsSchema, classifySchema]);
    cleanup.push(() => db.close());
    return db;
}

function chat(db: DatabaseSync, id: string, title: string) {
    db.prepare('INSERT INTO thread_bindings (id, dotId, ownerId, title, createdAt) VALUES (?, ?, ?, ?, ?)').run(
        id,
        'socio-1',
        'alice',
        title,
        T0 - HOUR,
    );
}

let runs = 0;
/** A turn a person started in `thread` with `text` (none: no message). */
function turn(
    db: DatabaseSync,
    thread: string,
    at: number,
    text: string | null,
    options: { status?: string; source?: string; runId?: string } = {},
) {
    const runId = options.runId ?? `r${++runs}`;
    const status = options.status ?? 'finished';
    db.prepare(
        'INSERT INTO agent_runs (threadId, runId, status, events, startedAt, finishedAt, source, trace) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
        thread,
        runId,
        status,
        JSON.stringify([
            {
                type: 'RUN_STARTED',
                timestamp: at,
                input: {
                    messages: text
                        ? [
                              {
                                  id: `m-${runId}`,
                                  role: 'user',
                                  content: [{ type: 'text', text }],
                              },
                          ]
                        : [],
                },
            },
        ]),
        at,
        status === 'running' ? null : at + MINUTE,
        options.source ?? 'web',
        JSON.stringify({ end: { reason: 'completed' } }),
    );
    return runId;
}

/** The fake model: intent from a word in the text, themes from `topics`. */
function model(
    options: {
        intent?: (text: string) => [string, number];
        themes?: (text: string) => Record<string, unknown>;
    } = {},
) {
    return fakeProvider('workspace', (request: ProviderRequest) => {
        if (request.use === 'intent') {
            const [answer, confidence] = options.intent?.(request.user) ?? ['write', 0.95];
            return JSON.stringify({ intent: { answer, confidence } });
        }
        return JSON.stringify(
            options.themes?.(request.user) ?? {
                topic1: 'March invoices',
                topic2: 'invoice for March',
                topic3: null,
                outcome: 'resolved',
                confidence: 0.9,
            },
        );
    });
}

function service(
    db: DatabaseSync,
    providers: ClassifyProvider[],
    classify: ClassifySettings = {
        intent: { enabled: true },
        themes: { enabled: true },
    },
    clock = { now: T0 + 6 * HOUR },
) {
    const settings = { classify } as Pick<Settings, 'classify' | 'operations'>;
    return {
        settings,
        clock,
        service: new ClassifyService({
            db,
            runs: sqliteSourceReader(db),
            settings: () => settings,
            providers,
            now: () => clock.now,
        }),
    };
}

/** Two sessions in one chat, and a turn inside the first. */
function seedChat(db: DatabaseSync) {
    chat(db, 't1', 'Invoices for March');
    const first = turn(db, 't1', T0, 'Draft the March invoices email to ana@example.com please');
    turn(db, 't1', T0 + 5 * MINUTE, 'Make it shorter');
    turn(db, 't1', T0 + 10 * MINUTE, 'Thanks, that is perfect');
    turn(db, 't1', T0 + 12 * MINUTE, 'One more thing');
    const second = turn(db, 't1', T0 + 3 * HOUR, 'Summarise the onboarding list');
    return { first, second };
}

const labels = (db: DatabaseSync, use: string) =>
    db
        .prepare('SELECT runId, label, source, applied, input FROM classify_labels WHERE use=? ORDER BY seq')
        .all(use) as {
        runId: string;
        label: string;
        source: string;
        applied: number;
        input: string;
    }[];

describe('sessions and their first messages', () => {
    it('labels each session once, from its title and first three person messages, scrubbed', async () => {
        const db = database();
        const { first, second } = seedChat(db);
        const fake = model();
        const { service: s } = service(db, [fake]);
        await s.tick();
        // Two sessions, each asked once per use.
        expect(fake.requests.map((r) => r.use).sort()).toEqual(['intent', 'intent', 'themes', 'themes']);
        const intent = labels(db, 'intent');
        expect(intent.map((l) => l.runId)).toEqual([first, second]);
        expect(intent[0]).toMatchObject({
            label: 'write',
            source: 'model',
            // No version has passed an evaluation yet.
            applied: 0,
        });
        const state = JSON.parse(intent[0]!.input) as Record<string, string>;
        expect(state).toMatchObject({
            title: 'Invoices for March',
            second: 'Make it shorter',
            third: 'Thanks, that is perfect',
        });
        expect(state.first).toContain('Draft the March invoices email');
        // Never the address, here or in what the model was sent.
        expect(intent[0]!.input).not.toContain('ana@example.com');
        for (const request of fake.requests) {
            expect(request.user).not.toContain('ana@example.com');
            expect(request.user).not.toContain('One more thing');
        }
        const themes = labels(db, 'themes');
        // One topic per key: "March invoices" and "invoice for March" are one.
        expect(JSON.parse(themes[0]!.label)).toEqual({
            topics: ['March invoices'],
            outcome: 'resolved',
        });
        await s.tick();
        expect(fake.requests).toHaveLength(4);
    });

    it('waits for a session’s messages until three are in or it has ended', async () => {
        const db = database();
        chat(db, 't2', 'New chat');
        const clock = { now: T0 + 2 * MINUTE };
        const opener = turn(db, 't2', T0, 'Analyse the churn numbers');
        const fake = model();
        const { service: s } = service(db, [fake], undefined, clock);
        await s.tick();
        expect(fake.requests).toHaveLength(0);
        // A turn still running keeps it open too.
        turn(db, 't2', T0 + 5 * MINUTE, 'Split by region', { status: 'running' });
        clock.now = T0 + 2 * HOUR;
        await s.tick();
        expect(fake.requests).toHaveLength(0);
        db.prepare("UPDATE agent_runs SET status='finished', finishedAt=? WHERE status='running'").run(T0 + 6 * MINUTE);
        await s.tick();
        expect(labels(db, 'intent').map((l) => l.runId)).toEqual([opener]);
        expect(fake.requests[0]!.user).toContain('Split by region');
    });

    it('leaves automation and turns without a person’s words alone', async () => {
        const db = database();
        chat(db, 't3', 'Weekly report');
        turn(db, 't3', T0, 'Run the weekly report.', { source: 'scheduled' });
        turn(db, 't3', T0 + 2 * HOUR, null);
        const fake = model();
        const { service: s } = service(db, [fake]);
        await s.tick();
        expect(fake.requests).toHaveLength(0);
    });

    it('does nothing while off, keeps to the daily cap and a few calls a tick', async () => {
        const db = database();
        for (let i = 0; i < SESSION_CALLS_PER_TICK + 2; i++) {
            chat(db, `c${i}`, `Chat ${i}`);
            turn(db, `c${i}`, T0 + i * MINUTE, `Question ${i}`);
        }
        const fake = model();
        const { service: off } = service(db, [fake], {});
        await off.tick();
        expect(fake.requests).toHaveLength(0);
        const { service: s, settings } = service(db, [fake], {
            intent: { enabled: true, perDay: 2 },
        });
        await s.tick();
        await s.tick();
        expect(fake.requests).toHaveLength(2);
        settings.classify = { intent: { enabled: true, perDay: 100 } };
        await s.tick();
        expect(fake.requests).toHaveLength(2 + SESSION_CALLS_PER_TICK);
        await s.tick();
        expect(labels(db, 'intent')).toHaveLength(SESSION_CALLS_PER_TICK + 2);
    });
});

describe('the golden set and the evaluation gate', () => {
    /** Admin intents whose text names them, and a model that reads it. */
    async function golden(s: ClassifyService, db: DatabaseSync, n: number) {
        const values = INTENT_LABELS.map((label) => label.value);
        for (let i = 0; i < n; i++) {
            chat(db, `g${i}`, `Golden ${i}`);
            const runId = turn(db, `g${i}`, T0 - 30 * HOUR, `I came to ${values[i % values.length]}`);
            await s.sessions.relabelIntent(s.sessions.subject(runId)!, values[i % values.length]!, 'alice');
            await s.sessions.relabelThemes(
                s.sessions.subject(runId)!,
                { topics: [`topic ${values[i % values.length]}`], outcome: 'resolved' },
                'alice',
            );
        }
    }
    const reading = (text: string): [string, number] => [/I came to (\w+)/.exec(text)?.[1] ?? 'write', 0.97];

    it('applies the model’s intents only once its version passed, the earlier sure ones included', async () => {
        const db = database();
        const { first } = seedChat(db);
        const fake = model({ intent: reading });
        const { service: s } = service(db, [fake]);
        await s.tick();
        expect(labels(db, 'intent')[0]).toMatchObject({ applied: 0 });
        await golden(s, db, MIN_GOLDEN);
        expect(s.store.goldenCount('intent', 1)).toBe(MIN_GOLDEN);
        const report = await evaluateUse(
            {
                classifier: s.classifier,
                store: s.store,
                intentLabels: () => s.intentLabels(),
            },
            'intent',
        );
        expect(report).toMatchObject({
            use: 'intent',
            status: 'done',
            passed: true,
            golden: MIN_GOLDEN,
            answered: MIN_GOLDEN,
        });
        // The confusion matrix has a column for abstentions.
        expect(report.labels.map((l) => l.label)).toContain('(unsure)');
        const promoted = labels(db, 'intent').filter((l) => l.runId === first && l.applied);
        expect(promoted.map((l) => [l.label, l.source])).toEqual([['write', 'model']]);
        expect((await s.view('intent')).versionPassed).toBe(true);
    });

    it('scores themes by outcome and a topic in common', async () => {
        const db = database();
        const fake = model({
            themes: (text) => {
                const word = /I came to (\w+)/.exec(text)?.[1] ?? 'x';
                return {
                    topic1: `${word} topics`,
                    topic2: null,
                    topic3: null,
                    outcome: word === 'ask' ? 'unclear' : 'resolved',
                    confidence: 0.9,
                };
            },
        });
        const { service: s } = service(db, [fake]);
        await golden(s, db, MIN_GOLDEN);
        const report = await evaluateUse({ classifier: s.classifier, store: s.store }, 'themes');
        // Every "ask" item has the wrong outcome hint: 3 of 20.
        expect(report).toMatchObject({ status: 'done', answered: MIN_GOLDEN });
        expect(report.correct).toBe(MIN_GOLDEN - 3);
        expect(report.passed).toBe(report.precision! >= 0.7);
        expect(report.confusion.resolved?.unclear).toBe(3);
    });

    it('matches topics by their words, not their wording', () => {
        expect(topicKey('Invoices for March')).toBe(topicKey('march invoice'));
        expect(topicsMatch(['March invoices'], ['invoice approval'])).toBe(true);
        expect(topicsMatch(['March invoices'], ['onboarding'])).toBe(false);
        expect(cleanTopics([' a  b ', 'A B', null, 'c', 'd', 'e'])).toEqual(['a b', 'c', 'd']);
        const scored = scoreEvaluation(
            [
                { gold: 'resolved', predicted: 'resolved', right: false },
                { gold: 'resolved', predicted: 'resolved', right: true },
                { gold: 'unclear', predicted: '(unsure)' },
            ],
            ['resolved', 'unclear', '(unsure)'],
            0.5,
            '(unsure)',
        );
        expect(scored).toMatchObject({ answered: 2, correct: 1, precision: 0.5 });
    });
});

describe('intent’s list', () => {
    it('is the default until an admin saves one, and each list is its own version', () => {
        expect(intentLabels({})).toEqual(INTENT_LABELS);
        expect(intentLabelsVersion(INTENT_LABELS)).toBe(1);
        const mine = [
            { value: 'ask', hint: 'A question.' },
            { value: 'sell', hint: 'Sales work.' },
        ];
        expect(intentLabels({ classify: { intent: { labels: mine } } })).toEqual(mine);
        const version = intentLabelsVersion(mine);
        expect(version).toBeGreaterThan(1);
        expect(intentLabelsVersion([...mine])).toBe(version);
        expect(intentLabelsVersion([mine[0]!, { ...mine[1]!, hint: 'Selling.' }])).not.toBe(version);
        // A broken saved list falls back to the default.
        expect(
            intentLabels({
                classify: { intent: { labels: [{ value: 'X Y', hint: '' }] } },
            }),
        ).toEqual(INTENT_LABELS);
    });

    it('reads CLASSIFY_INTENT* and CLASSIFY_THEMES* from the environment', () => {
        expect(
            classifySettingsFromEnv({
                CLASSIFY_INTENT: 'true',
                CLASSIFY_THEMES_DAILY: '50',
                CLASSIFY_THEMES_THRESHOLD: '0.75',
            }),
        ).toEqual({
            intent: { enabled: true },
            themes: { perDay: 50, threshold: 0.75 },
        });
        expect(() => classifySettingsFromEnv({ CLASSIFY_THEMES: 'on' })).toThrow(
            /CLASSIFY_THEMES must be true or false/,
        );
        expect(parseEvalArgs(['--use=themes'], {}).use).toBe('themes');
    });
});

describe('the review routes', () => {
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
    const json = (method: string, body: unknown) => ({
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    it('lists labelled sessions and opens one on the access log, taking an admin’s labels', async () => {
        const db = database();
        const { first, second } = seedChat(db);
        const settings = {
            classify: { intent: { enabled: true }, themes: { enabled: true } },
        } as Settings;
        const s = new ClassifyService({
            db,
            runs: sqliteSourceReader(db),
            settings: () => settings,
            providers: [model()],
            now: () => T0 + 6 * HOUR,
        });
        await s.tick();
        const { outer } = app(db, s, settings);
        const list = (await (
            await outer.request('/api/classify/sessions?use=intent&unreviewed=1&limit=1&via=themes')
        ).json()) as CursorPage<SessionLabelRow>;
        expect(list.items.map((row) => row.runId)).toEqual([second]);
        expect(list.items[0]!.intent.suggestion).toMatchObject({
            value: 'write',
            applied: false,
        });
        expect(list.next).not.toBeNull();
        const opened = await outer.request(`/api/classify/sessions/${first}`);
        expect(opened.status).toBe(200);
        const view = (await opened.json()) as SessionLabelView;
        expect(view.input.title).toBe('Invoices for March');
        expect(view.input.messages).toHaveLength(3);
        expect(JSON.stringify(view)).not.toContain('ana@example.com');
        expect(db.prepare('SELECT surface, subjectKind, subjectId, content FROM access_log ORDER BY at').all()).toEqual(
            [
                {
                    surface: 'session-labels',
                    subjectKind: 'workspace',
                    subjectId: null,
                    content: 1,
                },
                {
                    surface: 'session-label',
                    subjectKind: 'run',
                    subjectId: first,
                    content: 1,
                },
            ],
        );

        const intent = await outer.request(`/api/classify/sessions/${first}/intent`, json('PUT', { value: 'analyse' }));
        expect(intent.status).toBe(200);
        expect(((await intent.json()) as SessionLabelView).intent.label).toMatchObject({
            value: 'analyse',
            source: 'admin',
            by: 'Alice',
        });
        const themes = await outer.request(
            `/api/classify/sessions/${first}/themes`,
            json('PUT', { topics: ['Invoices', 'email'], outcome: 'resolved' }),
        );
        expect(((await themes.json()) as SessionLabelView).themes.label).toMatchObject({
            topics: ['Invoices', 'email'],
            outcome: 'resolved',
            source: 'admin',
        });
        for (const [use, body] of [
            ['intent', { value: 'dance' }],
            ['themes', { topics: [], outcome: 'resolved' }],
            ['themes', { topics: ['x'], outcome: 'great' }],
        ] as const) {
            expect((await outer.request(`/api/classify/sessions/${first}/${use}`, json('PUT', body))).status).toBe(400);
        }
        expect((await outer.request('/api/classify/sessions/nope/intent', json('PUT', { value: 'ask' }))).status).toBe(
            404,
        );
        expect((await outer.request('/api/classify/sessions?use=failures')).status).toBe(400);
        // Reviewed: no longer waiting.
        const waiting = (await (
            await outer.request('/api/classify/sessions?use=intent&unreviewed=1')
        ).json()) as CursorPage<SessionLabelRow>;
        expect(waiting.items.map((row) => row.runId)).toEqual([second]);
    });

    it('saves intent’s list, refusing a list for another use, and starts a new golden set', async () => {
        const db = database();
        const { first } = seedChat(db);
        const settings = {} as Settings;
        const s = new ClassifyService({
            db,
            runs: sqliteSourceReader(db),
            settings: () => settings,
            providers: [model()],
        });
        const { outer, audits } = app(db, s, settings);
        await s.sessions.relabelIntent(s.sessions.subject(first)!, 'write', 'alice');
        const before = (await (await outer.request('/api/classify/uses/intent')).json()) as ClassifyUseView;
        expect(before).toMatchObject({
            labelsVersion: 1,
            golden: 1,
            threshold: 0.8,
        });
        expect(before.labels).toEqual(INTENT_LABELS);
        const mine = [
            { value: 'ask', hint: 'A question.' },
            { value: 'sell', hint: 'Sales work.' },
        ];
        const saved = await outer.request('/api/classify/uses/intent', json('PUT', { labels: mine }));
        expect(saved.status).toBe(200);
        expect(await saved.json()).toMatchObject({ labels: mine, golden: 0 });
        expect(audits).toEqual([expect.objectContaining({ targetId: 'classify:intent' })]);
        for (const body of [
            { labels: [{ value: 'ask', hint: 'x' }] },
            { labels: [...mine, { value: 'ask', hint: 'again' }] },
            { labels: [{ value: 'Ask', hint: 'x' }, mine[1]] },
        ]) {
            expect((await outer.request('/api/classify/uses/intent', json('PUT', body))).status).toBe(400);
        }
        expect((await outer.request('/api/classify/uses/themes', json('PUT', { labels: mine }))).status).toBe(400);
        // The old value is no longer one to pick.
        expect(
            (await outer.request(`/api/classify/sessions/${first}/intent`, json('PUT', { value: 'write' }))).status,
        ).toBe(400);
        const reset = await outer.request('/api/classify/uses/intent', json('PUT', { labels: null }));
        expect(await reset.json()).toMatchObject({ labelsVersion: 1, golden: 1 });
    });
});
