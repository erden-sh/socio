import type { Message } from '@ag-ui/client';
import { afterEach, expect, it, vi } from 'vitest';

import { endpointOf } from '@socio/foundation/inference/endpoints';
import { LEARNING_INPUT_CHARS, MIN_GOLDEN, type ClassifyUseSettings } from '@socio/shared/classify';

import type { ProviderRequest } from '../src/server/classify/contract.js';
import { evaluateUse } from '../src/server/classify/eval.js';
import { ClassifyService } from '../src/server/classify/service.js';
import { classifySettingsFromEnv } from '../src/server/classify/settings.js';
import { learningModule } from '../src/server/learning/module.js';
import { LearningJob } from '../src/server/learning/tags.js';
import {
    EvidenceTriage,
    INTENT_RECURRENCE,
    LEARNING_USE,
    TRIAGE_CALLS_PER_TICK,
    triageInput,
} from '../src/server/learning/triage.js';
import type { ModuleContext } from '../src/server/modules/contract.js';
import { sqliteSourceReader } from '../src/server/operations/infra/sqlite/source-reader.js';

import { fakeProvider } from './fixtures/classify-fakes.js';
import { testModuleServices } from './helpers/module-services.js';
import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

// Learning on the classification seam (CB-200): with the `learning` use
// off, Learning works as before; on, threads are triaged (scrubbed, under
// the cap), one-off threads in force stay out of the analysis, proposals
// get the model's duplicate and privacy checks after Learning's own, and
// one intent recurring in new sessions starts an analysis. The seam's
// model is a fake provider and the analysis model a fake fetch: nothing
// leaves the machine.

const stores: WorkspaceStore[] = [];
afterEach(() => {
    stores.splice(0).forEach((store) => store.close());
    vi.restoreAllMocks();
});

const VERSION = 'workspace:fake-1/p1';
type Call = { name: string; arguments: unknown };

interface Answers {
    /** The triage answer for a thread, by a word in what people asked. */
    triage?: (user: string) => { answer: string; confidence: number };
    duplicate?: { answer: string; confidence: number };
    private?: { answer: string; confidence: number };
}

function fixture(
    options: {
        settings?: Partial<ClassifyUseSettings>;
        answers?: Answers;
        reply?: (body: Record<string, unknown>) => Call[];
        usage?: Record<string, number>;
    } = {},
) {
    const workspace = new WorkspaceStore(testDatabase());
    stores.push(workspace);
    const dot = workspace.dots()[0];
    workspace.updateDot(dot.id, { ...dot, learningContainerId: 'research' });
    const transcripts = new Map<string, Message[]>();
    const runner = {
        messages: async (id: string) => transcripts.get(id) ?? [],
    };
    // The analysis model: fetch is a fake.
    const requests: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push(body);
        const calls = (options.reply ?? (() => []))(body);
        return Response.json({
            choices: [
                {
                    message: {
                        tool_calls: calls.map((call, i) => ({
                            id: `call-${i}`,
                            type: 'function',
                            function: call,
                        })),
                    },
                },
            ],
            ...(options.usage ? { usage: options.usage } : {}),
        });
    });
    const analysis = workspace.openAnalysis(
        runner,
        () => endpointOf({ baseUrl: 'http://model.test/v1', apiKey: 'k', model: 'qwen' }),
        fetchImpl,
    );
    // The seam's model: a fake provider answering per question.
    const answers = options.answers ?? {};
    const provider = fakeProvider('workspace', (request: ProviderRequest) => {
        if (request.system.includes('"procedure"')) {
            return JSON.stringify({
                procedure: answers.triage?.(request.user) ?? {
                    answer: 'repeatable',
                    confidence: 0.95,
                },
            });
        }
        if (request.system.includes('"duplicate"')) {
            return JSON.stringify({
                duplicate: answers.duplicate ?? { answer: 'new', confidence: 0.95 },
            });
        }
        return JSON.stringify({
            private: answers.private ?? { answer: 'clean', confidence: 0.95 },
        });
    });
    const settings = {
        classify: {
            learning: { enabled: true, ...options.settings },
        },
    } as never;
    const service = new ClassifyService({
        db: workspace.db,
        runs: sqliteSourceReader(workspace.db),
        settings: () => settings,
        providers: [provider],
    });
    const triage = new EvidenceTriage({
        db: workspace.db,
        classifier: service.classifier,
        store: service.store,
        runner,
    });
    analysis.useSeam(() => triage);
    let at = 1_000;
    const seed = (id: string, user: string, owner = 'alice') => {
        workspace.bindThread(id, dot.id, `Title ${id}`, owner);
        transcripts.set(id, [
            { id: `${id}-u`, role: 'user', content: user },
            { id: `${id}-a`, role: 'assistant', content: 'REPLY-CANARY' },
        ]);
        workspace.evidence.record(id, 'finished', ++at);
    };
    /** Records that the seam's version passed an evaluation. */
    const pass = async () => {
        const id = await service.store.startEval('learning', 'workspace', VERSION, 1, 0.9, null);
        await service.store.finishEval(id, {
            status: 'done',
            passed: true,
            finishedAt: Date.now(),
        } as never);
    };
    const calls = () =>
        workspace.db
            .prepare(
                "SELECT use, purpose, subject, outcome FROM classify_calls WHERE use='learning' ORDER BY at, rowid",
            )
            .all() as Array<{ subject: string; outcome: string }>;
    const labels = () =>
        workspace.db
            .prepare(
                "SELECT runId, label, source, applied, input FROM classify_labels WHERE use='learning' ORDER BY seq",
            )
            .all() as Array<{
            runId: string;
            label: string;
            source: string;
            applied: number;
            input: string;
        }>;
    const analysedThreads = () =>
        requests.flatMap((request) =>
            [
                ...String((request.messages as Array<{ content: string }>)[1]!.content).matchAll(
                    /<thread id="([^"]+)">/g,
                ),
            ].map((match) => match[1]),
        );
    return {
        workspace,
        analysis,
        triage,
        service,
        provider,
        requests,
        seed,
        pass,
        calls,
        labels,
        analysedThreads,
        settings: settings as {
            classify: { learning: Partial<ClassifyUseSettings> };
        },
    };
}

const proposal = (overrides: Record<string, unknown> = {}) => ({
    name: 'propose_skill',
    arguments: JSON.stringify({
        name: 'weekly-report',
        description: 'Use when asked for the weekly status report.',
        skill_md: '1. Collect wins, risks and next steps.\n2. Keep it short.',
        evidence_thread_ids: ['t1', 't2'],
        rationale: 'Two people asked for the same report format.',
        ...overrides,
    }),
});

it('works as before with the use off: no seam call, every thread analysed', async () => {
    const f = fixture({
        settings: { enabled: false },
        reply: () => [proposal()],
    });
    f.seed('t1', 'Write the weekly report');
    f.seed('t2', 'Weekly report again');
    await (
        await f.analysis.analyze('research', 'manual')
    ).done;
    expect(f.provider.requests).toEqual([]);
    expect(f.calls()).toEqual([]);
    expect(f.analysedThreads()).toEqual(['t1', 't2']);
    expect(f.analysis.runs('research')[0]).toMatchObject({
        status: 'succeeded',
        threads: 2,
        skipped: 0,
        proposals: 1,
        dropped: 0,
        // The fake model reports no usage.
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
    });
    // Nothing to triage on the tick either.
    await f.analysis.triageTick();
    expect(f.provider.requests).toEqual([]);
});

it('keeps the analysis call’s reported tokens and cost on the run', async () => {
    const f = fixture({
        settings: { enabled: false },
        usage: { prompt_tokens: 1200, completion_tokens: 300, cost: 0.0042 },
    });
    f.seed('t1', 'Write the weekly report');
    await (
        await f.analysis.analyze('research', 'manual')
    ).done;
    expect(f.analysis.runs('research')[0]).toMatchObject({
        inputTokens: 1200,
        outputTokens: 300,
        costUsd: 0.0042,
    });
});

it('triages each thread through the seam, scrubbed and without replies, and logs every call', async () => {
    const f = fixture();
    f.seed('t1', 'Weekly report for jane.doe@example.com, key sk-live_abcdefghijklmnop');
    f.seed('t2', 'What time is it?');
    await (
        await f.analysis.analyze('research', 'manual')
    ).done;
    expect(f.provider.requests).toHaveLength(2);
    for (const request of f.provider.requests) {
        expect(request.user).not.toContain('jane.doe@example.com');
        expect(request.user).not.toContain('sk-live');
        expect(request.user).not.toContain('REPLY-CANARY');
    }
    expect(f.provider.requests[0]!.user).toContain('<email>');
    // Learning's own definition: its brief, and up to 1,500 characters.
    expect(f.provider.requests[0]!.user).toContain(LEARNING_USE.subject);
    expect(f.service.classifier.definition('learning')).toBe(LEARNING_USE);
    expect(f.calls()).toEqual([
        expect.objectContaining({
            purpose: 'label',
            subject: 'thread:t1@1001',
            outcome: 'ok',
        }),
        expect.objectContaining({
            purpose: 'label',
            subject: 'thread:t2@1002',
            outcome: 'ok',
        }),
    ]);
    // Not evaluated yet: suggestions only, and both threads are analyzed.
    expect(f.labels().map((l) => [l.runId, l.label, l.applied])).toEqual([
        ['t1', 'repeatable', 0],
        ['t2', 'repeatable', 0],
    ]);
    expect(f.analysedThreads()).toEqual(['t1', 't2']);
    expect(f.analysis.runs('research')[0]!.skipped).toBe(0);
    // A thread is asked about once per finish.
    f.seed('t3', 'Another weekly report');
    await (
        await f.analysis.analyze('research', 'manual')
    ).done;
    expect(f.provider.requests).toHaveLength(3);
});

it('leaves one-off threads out once the version passed, and consumes them', async () => {
    const f = fixture({
        answers: {
            triage: (user) =>
                user.includes('weather')
                    ? { answer: 'one-off', confidence: 0.97 }
                    : user.includes('maybe')
                      ? { answer: 'one-off', confidence: 0.6 }
                      : { answer: 'repeatable', confidence: 0.93 },
        },
    });
    await f.pass();
    f.seed('t1', 'Write the weekly report');
    f.seed('t2', 'How is the weather?');
    f.seed('t3', 'maybe a report, maybe not');
    await (
        await f.analysis.analyze('research', 'manual')
    ).done;
    // t2 is surely one-off; t3's one-off is unsure, so it still goes.
    expect(f.analysedThreads()).toEqual(['t1', 't3']);
    expect(f.analysis.runs('research')[0]).toMatchObject({
        status: 'succeeded',
        threads: 3,
        skipped: 1,
    });
    expect(f.workspace.evidence.count('research')).toBe(0);
    // Only one-off threads: no analysis call at all.
    f.seed('t4', 'The weather again');
    const before = f.requests.length;
    await (
        await f.analysis.analyze('research', 'manual')
    ).done;
    expect(f.requests).toHaveLength(before);
    expect(f.analysis.runs('research')[0]).toMatchObject({
        status: 'succeeded',
        threads: 1,
        skipped: 1,
    });
    expect(f.workspace.evidence.count('research')).toBe(0);
});

it('lets an admin’s label overrule the model, and stays out of the way when off', async () => {
    const f = fixture({
        answers: { triage: () => ({ answer: 'one-off', confidence: 0.99 }) },
    });
    await f.pass();
    f.seed('t1', 'Weekly report');
    f.seed('t2', 'Weekly report too');
    await f.triage.triageAll(f.workspace.evidence.pending('research'));
    expect(f.triage.skips('t1')).toBe(true);
    await f.triage.relabel('t1', 'repeatable', 'alice');
    expect(f.triage.skips('t1')).toBe(false);
    expect(f.labels().at(-1)).toMatchObject({
        runId: 't1',
        label: 'repeatable',
        source: 'admin',
        applied: 1,
    });
    // The admin's label keeps the scrubbed input the model reads, never replies.
    expect(f.labels().at(-1)!.input).not.toContain('REPLY-CANARY');
    // Off: the model's one-off labels skip nothing.
    f.settings.classify.learning.enabled = false;
    expect(f.triage.skips('t2')).toBe(false);
    await (
        await f.analysis.analyze('research', 'manual')
    ).done;
    expect(f.analysedThreads()).toEqual(['t1', 't2']);
});

it('stays within the use’s daily cap: untriaged threads go to the analysis', async () => {
    const f = fixture({
        settings: { perDay: 1 },
        answers: { triage: () => ({ answer: 'one-off', confidence: 0.99 }) },
    });
    await f.pass();
    f.seed('t1', 'a');
    f.seed('t2', 'b');
    f.seed('t3', 'c');
    await (
        await f.analysis.analyze('research', 'manual')
    ).done;
    expect(f.provider.requests).toHaveLength(1);
    expect(f.analysedThreads()).toEqual(['t2', 't3']);
    expect(f.analysis.runs('research')[0]!.skipped).toBe(1);
});

it('checks proposals for repeats and private details after Learning’s own checks', async () => {
    const reply = () => [
        // Learning's own privacy check drops this first: no model check.
        proposal({ name: 'leaky', skill_md: 'Email jane.doe@example.com weekly.' }),
        proposal(),
    ];
    // Not evaluated: a sure duplicate is not dropped, a sure private is.
    const f = fixture({
        reply,
        answers: {
            duplicate: { answer: 'rejected', confidence: 0.99 },
            private: { answer: 'private', confidence: 0.95 },
        },
    });
    f.workspace.db
        .prepare(
            "INSERT INTO learning_proposals VALUES ('old', 'research', 'r0', 'status-digest', 'A weekly digest.', 'x', 'y', '[]', 'rejected', 1, 'alice', 1, NULL)",
        )
        .run();
    f.seed('t1', 'Weekly report');
    f.seed('t2', 'Weekly report too');
    await (
        await f.analysis.analyze('research', 'manual')
    ).done;
    expect(f.analysis.runs('research')[0]).toMatchObject({
        proposals: 0,
        dropped: 2,
        dropReasons: { 'private-data': 1, 'model-private': 1 },
    });
    const subjects = f.calls().map((call) => call.subject);
    expect(subjects.filter((s) => s.startsWith('proposal:'))).toEqual([
        expect.stringMatching(/^proposal:.+:1:duplicate$/),
        expect.stringMatching(/^proposal:.+:1:private$/),
    ]);
    // The duplicate check saw the reviewed list.
    const duplicate = f.provider.requests.find((r) => r.system.includes('"duplicate"'))!;
    expect(duplicate.user).toContain('status-digest');

    // Evaluated: the sure duplicate drops it before the privacy check.
    const g = fixture({
        reply: () => [proposal()],
        answers: { duplicate: { answer: 'published', confidence: 0.99 } },
    });
    await g.pass();
    g.workspace.db
        .prepare(
            "INSERT INTO learning_proposals VALUES ('old', 'research', 'r0', 'status-digest', 'A weekly digest.', 'x', 'y', '[]', 'rejected', 1, 'alice', 1, NULL)",
        )
        .run();
    g.seed('t1', 'Weekly report');
    g.seed('t2', 'Weekly report too');
    await (
        await g.analysis.analyze('research', 'manual')
    ).done;
    expect(g.analysis.runs('research')[0]).toMatchObject({
        proposals: 0,
        dropReasons: { 'model-duplicate': 1 },
    });
    expect(g.provider.requests.filter((r) => r.system.includes('"private"'))).toEqual([]);

    // Unsure answers keep the proposal; no reviewed list, no duplicate check.
    const h = fixture({
        reply: () => [proposal()],
        answers: { private: { answer: 'private', confidence: 0.6 } },
    });
    await h.pass();
    h.seed('t1', 'Weekly report');
    h.seed('t2', 'Weekly report too');
    await (
        await h.analysis.analyze('research', 'manual')
    ).done;
    expect(h.analysis.runs('research')[0]).toMatchObject({
        proposals: 1,
        dropped: 0,
    });
    expect(h.provider.requests.filter((r) => r.system.includes('"duplicate"'))).toEqual([]);
});

it('starts an analysis when one intent recurs in new sessions, once per new evidence', async () => {
    const f = fixture();
    let seq = 0;
    const session = (threadId: string, intent: string, applied = 1) => {
        const runId = `run-${++seq}`;
        f.workspace.db
            .prepare(
                "INSERT INTO agent_runs(runId, threadId, status, events, startedAt) VALUES (?, ?, 'finished', '[]', 1)",
            )
            .run(runId, threadId);
        f.workspace.db
            .prepare(
                "INSERT INTO classify_labels(use, labelsVersion, runId, idx, label, source, provider, version, confidence, applied, input, actorId, at) VALUES ('intent', 1, ?, -1, ?, 'model', 'workspace', 'v', 0.9, ?, '{}', NULL, 1)",
            )
            .run(runId, intent, applied);
    };
    for (let i = 1; i < INTENT_RECURRENCE; i++) {
        f.seed(`t${i}`, 'Weekly report');
        session(`t${i}`, 'write');
    }
    // "other" and suggestions don't count.
    session('t1', 'other');
    session('t2', 'other');
    session('t3', 'write', 0);
    await f.analysis.maybeAnalyze('research');
    expect(f.analysis.runs('research')).toEqual([]);
    f.seed('t9', 'Weekly report');
    session('t9', 'write');
    // Off: no intent trigger.
    f.settings.classify.learning.enabled = false;
    await f.analysis.maybeAnalyze('research');
    expect(f.analysis.runs('research')).toEqual([]);
    f.settings.classify.learning.enabled = true;
    expect(f.triage.recurringIntent(['t1', 't2', 't3', 't4', 't9'])).toEqual({
        intent: 'write',
        sessions: INTENT_RECURRENCE,
    });
    await f.analysis.maybeAnalyze('research');
    await vi.waitFor(() =>
        expect(f.analysis.runs('research')[0]).toMatchObject({
            trigger: 'intent',
            status: 'succeeded',
        }),
    );
});

it('does not start the intent trigger again for evidence a run already started on', async () => {
    const f = fixture({ reply: () => [] });
    for (let i = 1; i <= INTENT_RECURRENCE; i++) {
        f.seed(`t${i}`, 'Weekly report');
        f.workspace.db
            .prepare(
                "INSERT INTO agent_runs(runId, threadId, status, events, startedAt) VALUES (?, ?, 'finished', '[]', 1)",
            )
            .run(`run-${i}`, `t${i}`);
        f.workspace.db
            .prepare(
                "INSERT INTO classify_labels(use, labelsVersion, runId, idx, label, source, provider, version, confidence, applied, input, actorId, at) VALUES ('intent', 1, ?, -1, 'write', 'admin', NULL, NULL, NULL, 1, '{}', 'alice', 1)",
            )
            .run(`run-${i}`);
    }
    // A failed attempt after the newest evidence: wait for new evidence.
    f.workspace.db
        .prepare(
            "INSERT INTO learning_runs(id, containerId, trigger, status, startedAt, finishedAt, threads, proposals, dropped, dropReasons, error, startedBy) VALUES ('r1', 'research', 'intent', 'failed', ?, ?, 5, 0, 0, '{}', 'x', NULL)",
        )
        .run(Date.now(), Date.now());
    await f.analysis.triageTick();
    await f.analysis.maybeAnalyze('research');
    expect(f.analysis.runs('research')).toHaveLength(1);
});

it('triages a few threads a tick, beside the daily tick', async () => {
    const f = fixture();
    for (let i = 1; i <= TRIAGE_CALLS_PER_TICK + 2; i++) {
        f.seed(`t${i}`, `Report ${i}`);
    }
    await f.analysis.triageTick();
    expect(f.provider.requests).toHaveLength(TRIAGE_CALLS_PER_TICK);
    await f.analysis.triageTick();
    expect(f.provider.requests).toHaveLength(TRIAGE_CALLS_PER_TICK + 2);
    await f.analysis.triageTick();
    expect(f.provider.requests).toHaveLength(TRIAGE_CALLS_PER_TICK + 2);
    // Triage never started an analysis by itself (no intents).
    expect(f.analysis.runs('research')).toEqual([]);

    // The module's tick runs both; a failing triage never stops the daily one.
    const tick = vi.fn(async () => undefined);
    const triageTick = vi.fn(async () => {
        throw new Error('seam down');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await learningModule.tick!.run({
        services: testModuleServices({}, [[LearningJob, { tick, triageTick }]]),
    } as unknown as ModuleContext);
    expect(tick).toHaveBeenCalledOnce();
    expect(triageTick).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
});

it('evaluates triage against admins’ labels, and a pass applies the sure suggestions', async () => {
    const f = fixture({
        answers: {
            triage: (user) =>
                user.includes('weather')
                    ? { answer: 'one-off', confidence: 0.95 }
                    : { answer: 'repeatable', confidence: 0.95 },
        },
    });
    for (let i = 0; i < MIN_GOLDEN; i++) {
        const id = `g${i}`;
        f.seed(id, i % 2 ? 'How is the weather?' : 'Weekly report');
        await f.triage.relabel(id, i % 2 ? 'one-off' : 'repeatable', 'alice');
    }
    f.seed('s1', 'The weather today');
    await f.triage.triageAll(f.workspace.evidence.pending('research').slice(-1));
    expect(f.triage.skips('s1')).toBe(false);
    const report = await evaluateUse({ classifier: f.service.classifier, store: f.service.store }, 'learning');
    expect(report).toMatchObject({
        use: 'learning',
        status: 'done',
        golden: MIN_GOLDEN,
        passed: true,
        precision: 1,
    });
    expect(report.labels.map((l) => l.label)).toEqual(['repeatable', 'one-off', '(unsure)']);
    // The earlier sure one-off suggestion now counts.
    expect(f.triage.skips('s1')).toBe(true);
    const view = await f.triage.view('research', 0);
    expect(view).toMatchObject({
        enabled: true,
        available: true,
        version: VERSION,
        passed: true,
        golden: MIN_GOLDEN,
        intentRecurrence: INTENT_RECURRENCE,
    });
    expect(view.threads[0]).toMatchObject({
        threadId: 's1',
        pending: true,
        label: { value: 'one-off', source: 'model' },
        applied: true,
    });
    expect(view.threads[0]!.score).toBeCloseTo(0.05);
});

it('reads CLASSIFY_LEARNING* and keeps stored input within the table’s limit', () => {
    expect(
        classifySettingsFromEnv({
            CLASSIFY_LEARNING: 'true',
            CLASSIFY_LEARNING_DAILY: '50',
            CLASSIFY_LEARNING_THRESHOLD: '0.95',
        }),
    ).toEqual({ learning: { enabled: true, perDay: 50, threshold: 0.95 } });
    const { state, input } = triageInput({
        title: 'T'.repeat(500),
        asked: '"\n'.repeat(5_000),
    });
    expect(input.length).toBeLessThanOrEqual(4_000);
    expect(String(state.title).length).toBeLessThanOrEqual(200);
    expect(String(state.asked).length).toBeLessThanOrEqual(LEARNING_INPUT_CHARS);
});

it('keeps an admin’s label in force and in the golden set when the model triages the conversation again', async () => {
    const f = fixture({
        reply: () => [],
        answers: { triage: () => ({ answer: 'one-off', confidence: 0.99 }) },
    });
    await f.pass();
    f.seed('t1', 'Weekly report');
    await f.triage.relabel('t1', 'repeatable', 'alice');
    // The conversation finishes again after the admin's label: re-triage
    // refreshes the model's suggestion (sure, from a passed version)…
    const later = Date.now() + 60_000;
    f.workspace.evidence.record('t1', 'finished', later);
    await f.triage.triageAll([{ threadId: 't1', dotId: '', ownerId: 'alice', finishedAt: later }]);
    expect(f.labels().map((l) => [l.label, l.source, l.applied])).toEqual([
        ['repeatable', 'admin', 1],
        ['one-off', 'model', 1],
    ]);
    // …but the admin's label stays in force: not skipped, still analyzed.
    const verdict = f.triage.verdict('t1');
    expect(verdict.label).toMatchObject({ label: 'repeatable', source: 'admin' });
    expect(verdict.suggestion).toMatchObject({ label: 'one-off', applied: true });
    expect(f.triage.skips('t1')).toBe(false);
    const [row] = f.triage.threads('research', 0);
    expect(row).toMatchObject({
        threadId: 't1',
        label: { value: 'repeatable', source: 'admin' },
        applied: true,
    });
    expect(row!.score).toBeCloseTo(0.01);
    // It stays in the golden set, as the admin said it.
    expect(f.service.store.golden('learning', 1).map((l) => [l.runId, l.label])).toEqual([['t1', 'repeatable']]);
    await (
        await f.analysis.analyze('research', 'manual')
    ).done;
    expect(f.analysedThreads()).toEqual(['t1']);
    expect(f.analysis.runs('research')[0]!.skipped).toBe(0);
    // Only an admin changes it.
    await f.triage.relabel('t1', 'one-off', 'alice');
    expect(f.triage.skips('t1')).toBe(true);
    expect(f.service.store.golden('learning', 1).map((l) => [l.runId, l.label])).toEqual([['t1', 'one-off']]);
});
