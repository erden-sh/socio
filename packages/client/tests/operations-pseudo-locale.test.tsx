// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Dictionary } from '@socio/i18n/keys';
import { pseudoDictionary } from '@socio/i18n/pseudo';
import ROUTES from '@socio/i18n/route-namespaces.json';
import { COMPUTER_RESOURCE_METRICS } from '@socio/shared/computers/computer-resources';
import { DEPLOYMENT_SERVICE_METRICS, DEPLOYMENT_TOTAL_METRICS } from '@socio/shared/deployment-resources';
import { FAILURE_CATEGORIES } from '@socio/shared/failure-taxonomy';
import { DEFAULT_POOL_WEIGHTS } from '@socio/shared/operations/operations-cost';
import { RESOURCE_DEFAULTS, RESOURCE_METRICS } from '@socio/shared/operations/operations-resources';
import type { State, WorkspaceState } from '@socio/shared/types';
import type { PageI18n } from '@socio/shared/web/web';

import { OPS_SECTIONS, opsPath } from '../src/modules/operations/sections';

import { fetchServices, createTestRouter } from './helpers/app-router';

// Operations (the admins' dashboard) in en-XA, the pseudo-locale, through
// the app's real routes: each loader asks for its route's namespaces
// (route-namespaces.json) and gets them in en-XA, nothing more, and what
// loads on demand comes from this server's files (the fetch below). Text
// that stays plain English was never translated, and a raw key means a
// route doesn't inline what its page shows. Only Operations' own parts of
// each page are read: other modules' (components/, the header's actions)
// aren't its.

vi.mock('@copilotkit/react-core/v2', () => ({
    CopilotKitProvider: ({ children }: { children: unknown }) => children,
}));

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

vi.setConfig({ testTimeout: 30_000 });

const locales = join(import.meta.dirname, '../../i18n/locales/en-US');
const routes = ROUTES as unknown as Record<string, string[]>;
const pseudo = (ns: string) =>
    pseudoDictionary(JSON.parse(readFileSync(join(locales, `${ns}.json`), 'utf8')) as Dictionary);
const inlined = new Set(
    Object.entries(routes)
        .filter(([id]) => !id.startsWith('$'))
        .flatMap(([, namespaces]) => namespaces),
);
const operations = (ns: string) => /^operations(\.|$)/.test(ns);

// What loads on demand: this server's files, which the manifest names and
// the fetch below serves. Only these, named here rather than worked out
// from route-namespaces.json, so a namespace a route should inline but
// doesn't stays missing, and its keys show.
const ON_DEMAND = [
    'operations.chat-grounding',
    'operations.cost-admin',
    'operations.failure-label',
    'operations.health-numbers',
    'operations.knowledge-storage',
    'operations.labeling',
    'operations.reliability-board',
    'operations.resources',
    'operations.room-audit',
];
// Each section's on-demand namespaces (Operations.route.tsx's ON_DEMAND).
const SECTION_ON_DEMAND: Record<string, string[]> = {
    knowledge: ['operations.knowledge-storage'],
    reliability: ['operations.reliability-board', 'operations.failure-label'],
    health: ['operations.health-numbers', 'operations.resources'],
    cost: ['operations.cost-admin'],
    settings: ['operations.labeling'],
};
const SERVED = ON_DEMAND;
const manifest = {
    release: '1.0.0',
    locales: {
        'en-XA': {
            coverage: 1,
            ns: Object.fromEntries(
                readdirSync(locales)
                    .map((name) => name.slice(0, -'.json'.length))
                    .filter((ns) => !inlined.has(ns) || SERVED.includes(ns))
                    .map((ns) => [ns, { hash: 'test', sourceHash: 'test' }]),
            ),
        },
    },
};
const pseudoPage = (namespaces: readonly string[]): PageI18n => ({
    locale: 'en-XA',
    dir: 'ltr',
    manifest,
    resources: { 'en-XA': Object.fromEntries(namespaces.map((ns) => [ns, pseudo(ns)])) },
    offered: ['en-US'],
});

// The page's clock and time zone, fixed: what the fixtures' times read as
// doesn't depend on when or where the test runs (set in beforeEach).
const NOW = Date.UTC(2026, 10, 20, 12);
const TIME_ZONE = 'UTC';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GiB = 1024 ** 3;

// An admin: Operations is admins' only. Socio access is behind its flag.
const user = { id: 'u-ada', name: 'Ada', role: 'admin' as const };
const state = {
    settings: { name: 'Alpha', paused: false, researchAllowed: false, memoryAllowed: true },
    tasks: [],
    memories: [],
    mode: 'live',
    configured: true,
} as unknown as State;
const workspace = {
    user,
    spaces: [{ id: 's1', name: 'Delta', description: '', createdAt: 1 }],
    dots: [{ id: 'd1', name: 'Bob', instructions: '', spaceId: 's1', spaceIds: ['s1'], createdAt: 1 }],
    conversations: [],
    setup: { model: true, voice: false, telegram: 'not_configured', missing: [] },
    calls: [],
    preferences: {},
    flags: { on: ['socio-actor-access'] },
} as unknown as WorkspaceState;

const window_ = {
    from: NOW - 7 * DAY,
    to: NOW,
    bucket: 'day',
    buckets: ['hour', 'day', 'week', 'month'],
    previous: { from: NOW - 14 * DAY, to: NOW - 7 * DAY },
    timeZone: TIME_ZONE,
};
const status = { state: 'ready', asOf: NOW - 60_000, earliest: 0 };
const days = Array.from({ length: 7 }, (_, index) => NOW - (7 - index) * DAY);
const page = <T,>(items: T[]) => ({ items, next: null });
const settings = {
    timeZone: TIME_ZONE,
    sessionGapMinutes: 30,
    defaults: { timeZone: TIME_ZONE, sessionGapMinutes: 30 },
};

// Overview.
const overview = {
    status,
    window: window_,
    tiles: [
        { id: 'turns', value: 120, previous: 100 },
        { id: 'failed', value: 3, previous: 1 },
        { id: 'people', value: 4, previous: 4 },
        { id: 'messages', value: 300, previous: 0 },
        { id: 'chats', value: 12, previous: null },
        { id: 'tokens', value: 144_000, previous: 120_000 },
    ],
};
const turn = (index: number) => ({
    runId: `r${index}`,
    threadId: 't1',
    socioId: 'd1',
    socioName: 'Bob',
    source: 'psi',
    status: index === 1 ? 'failed' : 'finished',
    startedAt: NOW - index * HOUR,
    finishedAt: NOW - index * HOUR + 1000,
    tokens: 1200,
    toolCalls: 1,
    toolErrors: 0,
});

// Activity and Value.
const activity = {
    status,
    window: window_,
    sessionGapMinutes: 30,
    tiles: [
        { id: 'people', value: 4, previous: 3 },
        { id: 'returning', value: 2, previous: 2 },
        { id: 'stickiness', value: 0.42, previous: 0.5 },
        { id: 'sessions', value: 31, previous: 20 },
        { id: 'chats', value: 9, previous: 9 },
        { id: 'length', value: 6.5, previous: 4 },
    ],
    points: days.map((at, index) => ({ at, people: index, sessions: index * 2, messages: index * 5 })),
    sources: [
        { key: 'psi', label: 'Gamma', kind: 'human', turns: 80, messages: 90, people: 4 },
        { key: 'scheduled', label: 'Epsilon', kind: 'automation', turns: 12, messages: 0, people: 0 },
    ],
    participation: { chats: 9, withSeveralPeople: 2, withSeveralSocios: 1, collaboration: 3 },
    features: [
        {
            id: 'pages',
            label: 'Zeta',
            tools: ['Tau'],
            calls: 40,
            people: 3,
            socios: 1,
            errors: 2,
            refusals: 0,
        },
    ],
    spaces: [
        {
            spaceId: 's1',
            name: 'Delta',
            writesByPeople: 3,
            writesBySocios: 5,
            pages: 4,
            people: 4,
            socios: 1,
            turns: 92,
        },
    ],
};
const value = {
    status,
    window: window_,
    sessionGapMinutes: 30,
    tiles: [
        { id: 'completed', value: 12, previous: 10 },
        { id: 'answered', value: 15, previous: 15 },
        { id: 'abandoned', value: 3, previous: 5 },
        { id: 'completedShare', value: 0.4, previous: 1 / 3 },
        { id: 'resumption', value: 0.25, previous: null },
    ],
    points: days.map((at, index) => ({ at, completed: index, answered: 1, abandoned: 0 })),
    approvals: [
        {
            capability: 'omega',
            requested: 5,
            approved: 3,
            denied: 1,
            expired: 1,
            executed: 3,
            failed: 0,
        },
    ],
    reactions: { socioMessages: 40, reacted: 10, up: 8, down: 1, retry: 1, needsWork: 0 },
    intents: [
        { intent: 'kappa', sessions: 6, people: 3, completed: 4, answered: 1, abandoned: 1 },
        { intent: null, sessions: 4, people: 2, completed: 0, answered: 3, abandoned: 1 },
    ],
};
const person = {
    personId: 'u-ada',
    name: 'Ada',
    messages: 20,
    sessions: 6,
    chats: 2,
    socios: 1,
    activeDays: 4,
    toolCalls: 9,
    completed: 3,
    lastAt: NOW - HOUR,
};
const chatRow = {
    threadId: 't1',
    socioId: 'd1',
    socioName: 'Bob',
    ownerKind: 'team',
    people: 3,
    socios: 2,
    messages: 40,
    sessions: 5,
    activeDays: 3,
    resumed: true,
    lastAt: NOW - HOUR,
};
const socioRow = {
    socioId: 'd1',
    name: 'Bob',
    people: 4,
    sessions: 30,
    chats: 9,
    messages: 90,
    turns: 92,
    perChat: 6.5,
    repeatUse: 0.5,
    collaboration: 3,
    completed: 12,
    answered: 15,
    abandoned: 3,
    returnRate: 0.75,
    lastAt: NOW - HOUR,
};
const session = {
    id: 't1@1',
    threadId: 't1',
    socioId: 'd1',
    socioName: 'Bob',
    source: 'psi',
    startedAt: NOW - HOUR,
    endedAt: NOW - HOUR + 60_000,
    messages: 4,
    people: 1,
    socios: 1,
    outcome: 'abandoned',
};

// Themes.
const themes = {
    status: { ...status, earliest: NOW - 30 * DAY },
    window: { ...window_, bucket: 'week' },
    sessionGapMinutes: 30,
    facts: {
        sessions: 20,
        withIntent: 15,
        withThemes: 10,
        minPeople: 3,
        weeks: [NOW - 14 * DAY, NOW - 7 * DAY],
        weekSessions: [4, 6],
        intents: [
            { intent: 'kappa', sessions: 10, people: 4, completed: 5, answered: 3, abandoned: 2 },
            { intent: null, sessions: 5, people: 3, completed: 0, answered: 4, abandoned: 1 },
        ],
        themes: [
            {
                key: 'theta',
                topic: 'Theta',
                sessions: 8,
                people: 4,
                completed: 4,
                answered: 2,
                abandoned: 2,
                hints: { resolved: 3, unresolved: 1, unclear: 4 },
                weeks: [3, 5],
                intents: [
                    { intent: 'kappa', sessions: 6 },
                    { intent: null, sessions: 2 },
                ],
            },
        ],
        hidden: { themes: 2, sessions: 2 },
        more: 0,
    },
};

// Knowledge and Capabilities.
const knowledge = {
    status,
    window: window_,
    knowledge: {
        spaces: [
            { spaceId: 's1', name: 'Delta', pages: 70, chars: 84_000, created: 4, edits: 12, stale: 30 },
            { spaceId: 's2', name: 'Kappa', pages: 0, chars: 0, created: 0, edits: 1, stale: 0 },
        ],
        totals: { pages: 70, chars: 84_000, created: 4, edits: 13, stale: 30, editors: 3 },
        search: {
            queries: 40,
            empty: 6,
            corrected: 1,
            trigram: 2,
            p50: 1.2,
            p95: 8.4,
            maxMs: 20,
            days: [
                { at: NOW - 2 * DAY, queries: 15, empty: 2 },
                { at: NOW - DAY, queries: 25, empty: 4 },
            ],
        },
        access: {
            total: 9,
            denied: 2,
            errors: 0,
            datasets: 2,
            chats: 3,
            actions: [
                { action: 'Rho', outcome: 'ok', count: 7 },
                { action: 'Rho', outcome: 'denied', count: 2 },
            ],
            actors: [{ kind: 'dot', count: 9 }],
        },
    },
};
const storageKinds = ['datasets', 'history', 'files', 'attachments', 'apps'];
const storage = {
    status,
    window: window_,
    storage: {
        kinds: storageKinds.map((kind, index) => ({
            kind,
            items: index + 1,
            bytes: (index + 1) * 1024 * 1024,
            deletedItems: index % 2,
            deletedBytes: (index % 2) * 1024,
        })),
        database: {
            bytes: 80 * 1024 * 1024,
            freeBytes: 0,
            agentRunsBytes: 60 * 1024 * 1024,
            measuredAt: NOW,
        },
        series: storageKinds.map((kind) => ({
            kind,
            points: days.map((at, index) => ({ at, value: index * 1024 * 1024 })),
        })),
        owners: [{ bytes: 45 * 1024 * 1024, datasets: 3 }],
        largestDatasetBytes: 30 * 1024 * 1024,
        largestFileBytes: 1024 * 1024,
    },
    quotas: [
        { key: 'dataUserMaxMb', label: 'Lambda', limit: 50, unit: 'MB', highest: 45, near: 1, at: 0 },
        { key: 'dataMaxDatasets', label: 'Mu', limit: 50, unit: 'datasets', highest: 3, near: 0, at: 0 },
        { key: 'dataDatasetMaxMb', label: 'Nu', limit: 100, unit: 'MB', highest: 30, near: null, at: null },
        { key: 'dataFileMaxMb', label: 'Xi', limit: 25, unit: 'MB', highest: 1, near: null, at: null },
    ],
};
const knowledgePage = {
    pageId: 'p1',
    spaceId: 's1',
    spaceName: 'Delta',
    title: 'Epsilon',
    chars: 1200,
    revision: 2,
    edits: 1,
    createdAt: NOW - 300 * DAY,
    updatedAt: NOW - 200 * DAY,
    usedAt: null,
    activeAt: NOW - 200 * DAY,
    stale: true,
};
const dataset = {
    datasetId: 'ds1',
    name: 'Omicron',
    scratch: false,
    sizeBytes: 30 * 1024 * 1024,
    historyBytes: 1024,
    tables: 3,
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW - DAY,
    accesses: 7,
    denied: 2,
    lastAccessAt: NOW - HOUR,
};
const grounding = {
    status: { ...status, earliest: NOW - 40 * DAY },
    window: window_,
    grounding: {
        runs: 12,
        chats: 5,
        kinds: [
            { kind: 'page', refs: 9, runs: 7 },
            { kind: 'search', refs: 14, runs: 6 },
            { kind: 'context', refs: 3, runs: 3 },
            { kind: 'dataset', refs: 4, runs: 2 },
            { kind: 'recall', refs: 2, runs: 1 },
        ],
        buckets: days,
        spaces: [
            { spaceId: 's1', name: 'Delta', reads: 11, pages: 4, chats: 4 },
            { spaceId: 'gone', name: null, reads: 2, pages: 1, chats: 1 },
        ],
        cells: [
            { spaceId: 's1', at: days[1]!, reads: 1 },
            { spaceId: 's1', at: days[5]!, reads: 10 },
            { spaceId: 'gone', at: days[5]!, reads: 2 },
        ],
        pages: [
            {
                pageId: 'p1',
                spaceId: 's1',
                spaceName: 'Delta',
                title: 'Epsilon',
                reads: 6,
                chats: 4,
                lastAt: NOW - HOUR,
            },
            {
                pageId: 'p-gone',
                spaceId: null,
                spaceName: null,
                title: null,
                reads: 1,
                chats: 1,
                lastAt: NOW - DAY,
            },
        ],
    },
};
const capabilities = {
    status,
    window: window_,
    coverage: {
        modules: [
            { id: 'Alpha', tools: 1, listed: true },
            { id: 'Beta', tools: 1, listed: true },
            { id: 'Gamma', tools: 1, listed: true },
            { id: 'Delta', tools: 0, listed: true },
        ],
        capabilities: [
            { id: 'Zeta', label: 'Zeta', tools: 1, offered: 1, approvals: [] },
            { id: 'Pi', label: 'Pi', tools: 1, offered: 0, approvals: [] },
        ],
        tools: [
            { name: 'Tau', module: 'Alpha', capability: null, offered: true, calls: 2, errors: 0 },
            { name: 'Upsilon', module: null, capability: 'Pi', offered: false, calls: 0, errors: 0 },
            { name: 'Phi', module: 'Gamma', capability: null, offered: true, calls: 0, errors: 0 },
            { name: 'Chi', module: 'Beta', capability: 'Zeta', offered: true, calls: 12, errors: 1 },
        ],
        unregistered: ['Phi'],
        unoffered: ['Upsilon'],
    },
};
const capabilityRequest = {
    issueId: 'i1',
    number: 101,
    title: 'Psi',
    status: 'open',
    capability: 'Psi',
    createdAt: NOW - 9 * DAY,
    requesters: 2,
    socios: 1,
    people: 2,
    lastAt: NOW - HOUR,
};

// Reliability.
const reliability = {
    status,
    window: window_,
    summary: {
        turns: 200,
        failures: 20,
        previousTurns: 100,
        previousFailures: 5,
        stopped: 4,
        interrupted: 2,
        retries: 9,
        retriedTurns: 6,
        fallbacks: 1,
        toolCalls: 300,
        toolFailures: 12,
        categories: FAILURE_CATEGORIES.map((category, index) => ({
            category,
            turns: category === 'stopped' ? 4 : index,
            tools: category === 'unclassified' ? 5 : 0,
        })),
    },
};
const reliabilitySeries = {
    status,
    window: window_,
    points: days.map((at, index) => ({
        at,
        turns: index ? 20 : 0,
        failures: index,
        counts: FAILURE_CATEGORIES.map((_, category) => (category === 2 ? index : 0)),
    })),
};
const breakdown = (by: string) => ({
    status,
    window: window_,
    by,
    rows: [
        {
            key: by === 'tool' ? 'Tau' : by === 'model' ? 'Sigma' : 'd1',
            label: by === 'socio' ? 'Bob' : null,
            total: 40,
            failed: 10,
            category: 'external_service',
            code: 'Rho',
            p50Ms: 820,
            p95Ms: 2400,
        },
    ],
});
const friction = {
    status,
    window: window_,
    from: NOW - 7 * DAY,
    rows: [
        {
            category: 'quotas',
            code: 'Rho',
            tool: null,
            people: 3,
            failures: 8,
            mostForOne: 4,
            lastAt: NOW - HOUR,
        },
    ],
};
const reliabilityIssues = {
    status,
    window: window_,
    issues: {
        reported: 9,
        resolved: 6,
        previousReported: 4,
        previousResolved: 3,
        bugsReported: 5,
        open: 11,
        medianResolveMs: 3 * DAY,
        p90ResolveMs: 9 * DAY,
        failuresReported: 2,
        medianReportMs: 2 * HOUR,
        p90ReportMs: 5 * HOUR,
        points: days.map((at, index) => ({ at, reported: index, resolved: 1 })),
    },
};
const failure = (index: number) => ({
    runId: `r${index}`,
    threadId: 't1',
    socioId: 'd1',
    socioName: 'Bob',
    source: 'psi',
    status: 'failed',
    startedAt: NOW - index * HOUR,
    finishedAt: NOW - index * HOUR + 1000,
    level: index % 2 ? 'turn' : 'tool',
    category: index % 2 ? 'quotas' : 'unclassified',
    rule: index % 2 ? 'quota_code' : 'generic_code',
    code: 'Rho',
    endReason: 'error',
    model: 'Sigma',
    tool: index % 2 ? null : 'Tau',
    toolFailures: index % 2 ? 0 : 1,
});

// Health.
const spread = (n: number, p50: number | null, p95: number | null) => ({ n, p50, p95 });
const health = {
    status,
    window: window_,
    facts: {
        tokens: {
            byModel: [{ key: 'Sigma', name: null, turns: 9, input: 9000, output: 900, cached: 0 }],
            bySocio: [{ key: 'd1', name: 'Bob', turns: 9, input: 9000, output: 900, cached: 0 }],
            byPerson: [{ key: 'u-ada', name: 'Ada', turns: 9, input: 9000, output: 900, cached: 0 }],
            byReasoning: [
                { kind: 'summary', turns: 6, output: 600, reportedTurns: 6, reasoning: 1200 },
                { kind: 'unknown', turns: 3, output: 300, reportedTurns: 0, reasoning: null },
            ],
        },
        latency: {
            firstOutput: spread(20, 400, 2400),
            firstOutputByModel: [{ key: 'Sigma', errors: 0, ...spread(20, 400, 2400) }],
            tools: spread(9, 1500, 90_000),
            byTool: [{ key: 'Tau', errors: 1, ...spread(9, 1500, 90_000) }],
        },
        queues: {
            turns: spread(5, 100, 900),
            jobWait: spread(3, 2000, 4000),
            jobWake: spread(0, null, null),
            scheduleLate: spread(4, 1000, 420_000),
        },
        schedules: { failing: 1, paused: 0, overdue: 0, ok: 3, stopped: 1, runs: 12, failedRuns: 2, lateRuns: 1 },
        goals: { stalled: 1, active: 2, done: 1, cancelled: 0, doneInRange: 1, cancelledInRange: 0 },
        longRuns: { running: 1, waiting: 0, deadItems: 0, done: 1, failed: 0, cancelled: 0 },
        jobRuns: { total: 4, failed: 1 },
        coverage: [
            { id: 'trace', covered: 9, total: 9 },
            { id: 'dueAt', covered: 3, total: 12 },
        ],
        sources: [
            { source: 'agent_runs', at: NOW - 30_000 },
            { source: 'job_runs', at: NOW - 2 * HOUR },
        ],
    },
    live: {
        analytics: { mode: 'child', state: 'ready', asOf: NOW - 90_000 },
        staleAfterMs: 300_000,
        backup: {
            intervalHours: 24,
            offsite: true,
            running: false,
            lastSuccessAt: NOW - 3 * HOUR,
            lastSizeBytes: 40 * 1024 * 1024,
            offsiteSuccessAt: NOW - 2 * DAY,
        },
        deployment: { state: 'ok', measuredAt: NOW - 60_000, services: 9, unlimitedServices: 2 },
        apps: {
            watched: 3,
            unhealthy: [
                {
                    appId: 'a1',
                    name: 'Omega',
                    status: 'promoted',
                    state: 'degraded',
                    reason: 'Omega',
                    attempts: 1,
                    maxAttempts: 3,
                    nextAttemptAt: NOW + 5 * 60_000,
                    lastRecoveryAt: NOW - DAY,
                    lastRecoveryReason: 'Omega',
                    lastError: 'Omega',
                    escalatedAt: null,
                    updatedAt: NOW - 60_000,
                },
            ],
            recoveredLastDay: 1,
            check: { lastRunAt: NOW - 60_000, lastOkAt: NOW - 60_000, lastError: null, failingSince: null },
        },
    },
};
const healthSeries = (metric: string) => ({
    status,
    window: window_,
    metric,
    points: days.map((at, index) => ({ at, n: index, p95: index ? index * 400 : null })),
});
const schedule = {
    id: 'sc1',
    title: 'Iota',
    socioId: 'd1',
    socioName: 'Bob',
    personId: 'u-ada',
    state: 'failing',
    status: 'scheduled',
    cadence: 'daily',
    nextRunAt: NOW + HOUR,
    lastRunAt: NOW - DAY,
    updatedAt: NOW,
    error: 'Iota',
};
const scheduledRun = {
    id: 'sr1',
    taskId: 'sc1',
    title: 'Iota',
    socioId: 'd1',
    socioName: 'Bob',
    status: 'failed',
    dueAt: NOW - 2 * HOUR,
    startedAt: NOW - 2 * HOUR + 90_000,
    finishedAt: NOW - 2 * HOUR + 120_000,
    lateMs: 90_000,
};
const longRun = {
    id: 'lr1',
    jobId: 'j1',
    jobName: 'Kappa',
    socioId: 'd1',
    socioName: 'Bob',
    personId: 'u-ada',
    status: 'running',
    batches: 2,
    retries: 1,
    itemsDone: 3,
    itemsDead: 0,
    itemsPending: 7,
    createdAt: NOW - 3 * HOUR,
    updatedAt: NOW - 60_000,
    finishedAt: null,
    waitReason: null,
    lastError: null,
};
const history = (metrics: Record<string, string>, values: Record<string, number | null>) => {
    const full = Object.fromEntries(Object.keys(metrics).map((key) => [key, values[key] ?? null]));
    return {
        latest: { at: NOW - 60_000, values: full },
        hourly: [
            {
                at: NOW - HOUR,
                samples: 1,
                values: full,
                observedAt: Object.fromEntries(Object.keys(full).map((key) => [key, NOW - HOUR])),
            },
        ],
        gaps: [],
        collectedEverySeconds: 300,
    };
};
const deployment = {
    state: 'ok',
    failedAt: null,
    totals: history(DEPLOYMENT_TOTAL_METRICS, {
        cpuPercent: 71,
        memoryBytes: 4 * GiB,
        memoryLimitBytes: 8 * GiB,
        limitedMemoryBytes: 3 * GiB,
        services: 2,
        unlimitedServices: 1,
        restarts: 2,
        nodeCpus: 16,
        nodeMemoryBytes: 64 * GiB,
    }),
    services: [
        {
            kind: 'stack',
            stack: 'Alpha',
            service: 'Beta',
            node: 'Gamma',
            noLimit: true,
            history: history(DEPLOYMENT_SERVICE_METRICS, {
                cpuPercent: 40,
                memoryBytes: 1.5 * GiB,
                memoryLimitBytes: null,
                restarts: 2,
                containers: 1,
                unlimitedContainers: 1,
            }),
        },
    ],
};
const resources = history(
    RESOURCE_METRICS,
    Object.fromEntries(Object.keys(RESOURCE_METRICS).map((key, index) => [key, (index + 1) * 1048576])),
);
const computers = {
    from: NOW - DAY,
    to: NOW,
    more: false,
    disk: { state: 'ok', measuredAt: NOW - 60_000, everyMinutes: 15 },
    rows: [
        {
            dotId: 'd1',
            name: 'Bob',
            running: true,
            appOoms: 3,
            lastAppOomAt: NOW - HOUR,
            history: history(COMPUTER_RESOURCE_METRICS, {
                cpuPercent: 12,
                memoryBytes: GiB,
                memoryLimitBytes: 2 * GiB,
                volumeBytes: 1048576,
                containerBytes: 1048576,
            }),
        },
    ],
};

// Cost.
const T0 = NOW - DAY;
const pricing = {
    sync: {
        enabled: true,
        serverDefault: true,
        saved: false,
        watched: ['Sigma'],
        runs: [
            { source: 'openrouter', at: T0, ok: true, fetched: 300, matched: 2, stored: 2, error: null },
            { source: 'azure', at: T0, ok: false, fetched: 0, matched: 0, stored: 0, error: 'Sigma' },
        ],
        nextAt: T0 + DAY,
        running: false,
    },
    prices: [
        {
            id: 'p1',
            provider: 'Chi',
            model: 'Sigma',
            modelKey: 'sigma',
            inputPerM: 0.15,
            cachedInputPerM: null,
            outputPerM: 0.6,
            reasoningPerM: null,
            currency: 'USD',
            effectiveFrom: T0,
            source: 'sync:openrouter',
            fetchedAt: T0,
        },
        {
            id: 'p2',
            provider: '*',
            model: 'Sigma',
            modelKey: 'sigma',
            inputPerM: 0,
            cachedInputPerM: null,
            outputPerM: 0,
            reasoningPerM: null,
            currency: 'USD',
            effectiveFrom: T0,
            source: 'admin',
            fetchedAt: T0,
        },
    ],
    backends: [
        { id: 'local', label: 'Rho', kind: 'shared', model: 'Sigma', provider: 'Chi', enabled: true },
        { id: 'byo:b1', label: 'Tau', kind: 'byo', model: 'Sigma', provider: 'Chi', enabled: true },
    ],
    pools: [
        {
            id: 'pool-1',
            name: 'Upsilon',
            kind: 'fixed',
            category: 'hardware',
            amount: 3600,
            currency: 'USD',
            period: 'month',
            depreciationMonths: 36,
            startsAt: T0,
            endsAt: null,
            backendIds: ['local'],
            allocation: 'tokens',
            weights: DEFAULT_POOL_WEIGHTS,
            createdAt: T0,
            updatedAt: T0,
        },
        {
            id: 'pool-2',
            name: 'Phi',
            kind: 'fixed',
            category: 'subscription',
            amount: 200,
            currency: 'USD',
            period: 'month',
            depreciationMonths: null,
            startsAt: T0,
            endsAt: null,
            backendIds: ['byo:b1'],
            allocation: 'tokens',
            weights: DEFAULT_POOL_WEIGHTS,
            createdAt: T0,
            updatedAt: T0,
        },
    ],
    readings: [],
};
const costRow = (key: string, name: string | null) => ({
    key,
    name,
    turns: 40,
    tokens: 100_000,
    costUsd: 12.5,
    unpriced: 5,
});
const cost = {
    status,
    window: { ...window_, bucket: 'hour', buckets: ['hour'], from: T0, to: NOW, previous: null },
    cost: {
        totals: {
            costUsd: 12.5,
            previousCostUsd: null,
            turns: 40,
            priced: 20,
            pooled: 15,
            unpriced: 5,
            tokens: 100_000,
            idleUsd: 3.25,
        },
        series: [{ at: T0, priceUsd: 2.5, poolUsd: 10 }],
        byModel: [costRow('Sigma', null)],
        bySocio: [costRow('d1', 'Bob')],
        byPerson: [costRow('u-ada', 'Ada')],
        byPayer: [costRow('workspace', null), costRow('u-ada', 'Ada'), costRow('', null)],
        byRoom: [
            {
                ...costRow('room-1', 'Gamma'),
                cycles: 9,
                handoffs: 3,
                exhausted: 2,
                people: 3,
                socios: 2,
            },
        ],
        cycles: {
            cycles: 20,
            inRooms: 9,
            steps: 24,
            handoffs: 3,
            exhausted: { deadline: 1, tokens: 1, handoffs: 0, spend: 0 },
            stopped: 2,
            spendUnknown: 4,
            runningMs: 90_000,
            wallMs: 600_000,
        },
        backends: [
            {
                backend: 'local',
                turns: 15,
                inputTokens: 50_000,
                cachedTokens: 0,
                outputTokens: 10_000,
                costUsd: 10,
                poolUsd: 10,
                pooledTokens: 60_000,
                referenceUsd: 0.012,
                unpriced: 0,
            },
        ],
        pools: [{ poolId: 'pool-1', costUsd: 13.25, allocatedUsd: 10, idleUsd: 3.25, turns: 15 }],
        unpricedModels: [{ model: 'Sigma', backend: 'local', turns: 5 }],
    },
};

// Access log, a chat's transcript and Socio access.
const accessEntry = (index: number) => ({
    id: `e${index}`,
    at: NOW - index * HOUR,
    viewerId: 'u-ada',
    viewerName: 'Ada',
    surface: index % 2 ? 'turns' : 'chat',
    subjectKind: index % 2 ? 'person' : 'chat',
    subjectId: index % 2 ? 'u-bob' : 't1',
    subjectName: index % 2 ? 'Bob' : 'Gamma',
    content: !(index % 2),
    filters: index % 2 ? { person: 'u-bob', range: '30d' } : { via: 'overview' },
    filterNames: index % 2 ? { person: 'Bob' } : {},
    requestId: `q${index}`,
});
const chat = {
    id: 't1',
    title: 'Gamma',
    socioId: 'd1',
    socioName: 'Bob',
    ownerId: 'u-ada',
    ownerName: 'Ada',
    createdAt: NOW - 30 * HOUR,
    archivedAt: null,
    team: false,
    room: null,
};
const transcriptRun = (index: number) => ({
    seq: index + 1,
    prev: index ? index : null,
    runId: `run-${index}`,
    status: 'finished',
    startedAt: NOW - (3 - index) * HOUR,
    finishedAt: NOW - (3 - index) * HOUR + 1000,
    messages: [
        { id: `u${index}`, role: 'user', content: 'Mu', metadata: { author: { name: 'Ada', you: false } } },
        { id: `a${index}`, role: 'assistant', content: 'Nu' },
    ],
    times: { messages: [], tools: [], reasoning: [] },
    light: {},
    size: 100,
});
const grant = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    socioId: 'd1',
    socioName: 'Bob',
    audience: 'app:crm',
    app: { label: 'Omega', origin: 'https://omega.test' },
    access: 'read',
    scopes: ['app:read'],
    task: 'Omega',
    conversation: { kind: 'private', title: 'Gamma' },
    createdAt: NOW - HOUR,
    expiresAt: NOW + HOUR,
    lastUsedAt: NOW - 60_000,
    idleMinutes: 30,
    state: 'live',
    ended: null,
    grantedBy: { id: 'u-ada', name: 'Ada' },
    ...extra,
});

// Settings.
const classify = (use: string) => ({
    use,
    enabled: use === 'intent',
    provider: 'workspace',
    threshold: 0.8,
    perDay: 300,
    defaults: { enabled: false, provider: 'workspace', threshold: 0.8, perDay: 300 },
    available: true,
    version: 'Sigma:Tau',
    versionPassed: false,
    golden: 2,
    callsToday: 1,
    evalCallsToday: 0,
    tokensToday: 100,
    costToday: null,
    unknownCostCalls: 1,
    evaluating: false,
    lastEval: null,
    labelsVersion: 1,
    ...(use === 'intent'
        ? {
              labels: [
                  { value: 'ask', hint: 'Kappa' },
                  { value: 'write', hint: 'Lambda' },
              ],
              defaultLabels: [
                  { value: 'ask', hint: 'Kappa' },
                  { value: 'write', hint: 'Lambda' },
              ],
          }
        : {}),
});

const labelRow = {
    runId: 'r9',
    threadId: 't1',
    socioId: 'd1',
    startedAt: NOW - HOUR,
    intent: {
        label: null,
        suggestion: {
            value: 'kappa',
            confidence: 0.86,
            provider: 'workspace',
            version: 'Sigma:Tau',
            applied: false,
            at: NOW,
        },
    },
    themes: {
        label: null,
        suggestion: {
            topics: ['Theta'],
            outcome: 'resolved',
            confidence: 0.7,
            provider: 'workspace',
            version: 'Sigma:Tau',
            applied: false,
            at: NOW,
        },
    },
};

/** The data words: names, model and tool names, codes and ids in the fixtures. */
const FIXTURE_TEXT: (string | RegExp)[] = [
    'Alpha',
    'Beta',
    'Gamma',
    'Delta',
    'Epsilon',
    'Zeta',
    'Theta',
    'Iota',
    'Kappa',
    'Lambda',
    'Mu',
    'Nu',
    'Xi',
    'Omicron',
    'Pi',
    'Rho',
    'Sigma',
    'Tau',
    'Upsilon',
    'Phi',
    'Chi',
    'Psi',
    'Omega',
    'Bob',
    'Ada',
    // An issue's key (CB-101).
    'CB',
    // Ids shown as they are: a source key, an intent, a capability, an app's origin.
    'https://omega.test',
    'psi',
    'kappa',
    'omega',
    // Codes shown as they are, as the translators' notes say: a dataset
    // access's outcome (Knowledge).
    /\b(?:ok|denied)\b/g,
];
/**
 * Shared components' words, not translated yet: the SeriesChart's own
 * description ("Bar chart of … by day, 7 points, from 0 to 18.", with the
 * raw bucket id the dashboard passes it as its x axis) in
 * components/charts, the cursor lists' status line ("Showing 2, all of
 * them.") in components/infinite-list, the sidebar's toggle and the
 * breadcrumb's landmark (components/ui), the mascot's label and the Ctrl
 * key (components/).
 */
const SHARED_TEXT: (string | RegExp)[] = [
    /(?:Bar|Line) chart of\s+by\s+(?:hour|day|week|month)?\s*,\s+(?:\d+ points, from \S+ to \S+|no values)\./g,
    /Showing \d+(?:; more to load|, all of them)\./g,
    // A chart's x label cut short by the chart (`shorten`), its closing
    // bracket with it.
    /\[[^[\]]*…/g,
    'Toggle Sidebar',
    'Collapse sidebar',
    'breadcrumb',
    'Close',
    'Socio is idle',
    'is idle',
    'Ctrl',
];

/**
 * Byte units written next to a number, which Intl has no binary units for:
 * "MB" and "KB" from modules/dataspace's `formatBytes` (Knowledge's
 * storage and datasets), "MiB" and "GiB" from the Health panels' own
 * `bytes` (DeploymentResourcesPanel, ResourcePanel,
 * ComputerResourcesPanel). Symbols, not words; whether they get keys is
 * left open.
 */
const UNIT_SYMBOLS = [/\b\d+(?:[.,]\d+)? (?:B|KB|MB|GB|MiB|GiB)\b/g];

const respond = (path: string): [number, unknown] => {
    switch (path) {
        case '/api/workspace':
            return [200, workspace];
        case '/api/state':
            return [200, state];
        case '/api/operations/settings':
            return [200, settings];
        case '/api/operations/overview':
            return [200, overview];
        case '/api/operations/turns':
            return [200, page([turn(0), turn(1)])];
        case '/api/operations/activity':
            return [200, activity];
        case '/api/operations/activity/people':
            return [200, page([person, { ...person, personId: 'telegram-team:-1', name: null }])];
        case '/api/operations/activity/chats':
            return [200, page([chatRow])];
        case '/api/operations/activity/socios':
            return [200, page([socioRow])];
        case '/api/operations/value':
            return [200, value];
        case '/api/operations/value/sessions':
            return [200, page([session])];
        case '/api/operations/themes':
            return [200, themes];
        case '/api/operations/knowledge':
            return [200, knowledge];
        case '/api/operations/storage':
            return [200, storage];
        case '/api/data/shared':
            return [200, []];
        case '/api/operations/knowledge/grounding':
            return [200, grounding];
        case '/api/operations/knowledge/pages':
            return [200, page([knowledgePage])];
        case '/api/operations/knowledge/datasets':
            return [200, page([dataset])];
        case '/api/operations/capabilities':
            return [200, capabilities];
        case '/api/operations/capabilities/requests':
            return [200, page([capabilityRequest])];
        case '/api/operations/reliability':
            return [200, reliability];
        case '/api/operations/reliability/series':
            return [200, reliabilitySeries];
        case '/api/operations/reliability/friction':
            return [200, friction];
        case '/api/operations/reliability/issues':
            return [200, reliabilityIssues];
        case '/api/operations/reliability/failures':
            return [200, page([failure(0), failure(1)])];
        case '/api/operations/health':
            return [200, health];
        case '/api/operations/health/schedules':
            return [200, page([schedule])];
        case '/api/operations/health/runs':
            return [200, page([scheduledRun])];
        case '/api/operations/health/long-runs':
            return [200, page([longRun])];
        case '/api/operations/resources/deployment':
            return [200, deployment];
        case '/api/operations/resources':
            return [200, resources];
        case '/api/operations/resources/computers':
            return [200, computers];
        case '/api/operations/cost':
            return [200, cost];
        case '/api/operations/pricing':
            return [200, pricing];
        case '/api/operations/retention':
            return [200, { policy: { ...RESOURCE_DEFAULTS }, defaults: { ...RESOURCE_DEFAULTS } }];
        case '/api/operations/access-log':
            return [200, page([accessEntry(0), accessEntry(1)])];
        case '/api/actors/admin/grants':
            return [
                200,
                {
                    grants: [
                        grant('g1'),
                        grant('g0', { state: 'ended', ended: { at: NOW - DAY, reason: 'Omega', by: 'admin' } }),
                    ],
                },
            ];
        case '/api/classify/sessions':
            return [200, page([labelRow])];
        case '/api/operations/chats/t1':
            return [200, chat];
        case '/api/operations/chats/t1/history':
            return [200, page([transcriptRun(2), transcriptRun(1)])];
    }
    if (path.startsWith('/api/operations/series/')) {
        return [200, { status, window: window_, metric: 'turns', points: days.map((at, i) => ({ at, value: i * 3 })) }];
    }
    if (path.startsWith('/api/operations/health/series/')) {
        return [200, healthSeries(path.split('/').at(-1)!)];
    }
    if (path.startsWith('/api/operations/reliability/breakdown/')) {
        return [200, breakdown(path.split('/').at(-1)!)];
    }
    if (path.startsWith('/api/classify/uses/')) {
        return [200, classify(path.split('/').at(-1)!)];
    }
    // Whatever else a page asks: nothing to show, in no words.
    return [404, { error: '—' }];
};

let fetched: string[] = [];
let host: HTMLElement;
let root: Root | undefined;
const zone = process.env.TZ;
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    process.env.TZ = TIME_ZONE;
    // Only Date: the router and the settle loop keep their real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    fetched = [];
    Element.prototype.scrollIntoView ??= () => {};
    window.matchMedia = (query: string) =>
        ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as never;
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    vi.stubGlobal(
        'IntersectionObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    vi.stubGlobal('EventSource', undefined);
    vi.stubGlobal('fetch', async (input: string) => {
        fetched.push(String(input));
        const file = /^\/i18n\/en-XA\/(.+)\.test\.json$/.exec(String(input));
        if (file) {
            return SERVED.includes(file[1]!) ? Response.json(pseudo(file[1]!)) : new Response('', { status: 404 });
        }
        const [status, body] = respond(new URL(input, 'http://app.test').pathname);
        return Response.json(body, { status });
    });
    host = document.createElement('div');
    document.body.append(host);
});
afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    host.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    if (zone === undefined) {
        delete process.env.TZ;
    } else {
        process.env.TZ = zone;
    }
});

/**
 * The words Intl itself writes for en-XA: month and weekday names and day
 * periods (AM, PM) in dates, units in durations ("3.2 sec", "4.5 min",
 * "2.1 hr"), how long ago ("4 minutes ago") and currencies. They are the
 * locale's data, as `{{when, datetime}}`, `LocalTime` and the dashboard's
 * formatters write them, not copy to translate. Taken from Intl, not
 * listed, so they follow the engine's CLDR.
 */
const INTL_WORDS = (() => {
    const words = new Set<string>();
    const addWords = (text: string) => {
        for (const match of text.matchAll(/\p{L}{2,}/gu)) {
            words.add(match[0]);
        }
    };
    const add = (options: Intl.DateTimeFormatOptions, at: number) => {
        for (const part of new Intl.DateTimeFormat('en-XA', { timeZone: TIME_ZONE, ...options }).formatToParts(at)) {
            if (part.type === 'month' || part.type === 'weekday' || part.type === 'dayPeriod') {
                words.add(part.value);
            }
        }
    };
    for (let day = 0; day < 366; day += 1) {
        const at = Date.UTC(2026, 0, 1 + day);
        add({ month: 'long', weekday: 'long' }, at);
        add({ month: 'short', weekday: 'short' }, at);
    }
    for (let hour = 0; hour < 24; hour += 1) {
        add({ hour: 'numeric', hour12: true }, Date.UTC(2026, 0, 1, hour));
        add({ hour: 'numeric', hour12: true, dayPeriod: 'short' }, Date.UTC(2026, 0, 1, hour));
    }
    const amounts = [0, 1, 1.5, 2, 42];
    for (const unit of ['millisecond', 'second', 'minute', 'hour', 'day'] as const) {
        for (const unitDisplay of ['short', 'long', 'narrow'] as const) {
            const format = new Intl.NumberFormat('en-XA', { style: 'unit', unit, unitDisplay });
            for (const amount of amounts) {
                addWords(format.format(amount));
            }
        }
    }
    for (const numeric of ['always', 'auto'] as const) {
        const format = new Intl.RelativeTimeFormat('en-XA', { numeric });
        for (const unit of ['second', 'minute', 'hour', 'day', 'week', 'month', 'year'] as const) {
            for (const amount of [-2, -1, 0, 1, 2]) {
                addWords(format.format(amount, unit));
            }
        }
    }
    for (const style of ['percent', 'decimal'] as const) {
        addWords(new Intl.NumberFormat('en-XA', { style }).format(0.42));
    }
    for (const currencyDisplay of ['symbol', 'narrowSymbol', 'code'] as const) {
        addWords(new Intl.NumberFormat('en-XA', { style: 'currency', currency: 'USD', currencyDisplay }).format(3.25));
    }
    return words;
})();

/** What a person reads in `node`, without the parts `skip` names (other modules'). */
function readable(node: Element, skip: readonly string[] = []) {
    const copy = node.cloneNode(true) as Element;
    for (const selector of skip) {
        for (const element of copy.querySelectorAll(selector)) {
            element.remove();
        }
    }
    const attributes = [...copy.querySelectorAll('[aria-label], [title], [placeholder], [alt]')].flatMap((element) =>
        ['aria-label', 'title', 'placeholder', 'alt']
            .map((name) => element.getAttribute(name))
            .filter((value): value is string => !!value),
    );
    // Text node by text node: an SVG's tick ("9K") and label ("Nov 13")
    // don't run together into one word.
    const texts: string[] = [];
    const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        texts.push(node.textContent ?? '');
    }
    return [texts.join(' '), ...attributes];
}

/** The English left once every pseudo-locale string (in brackets) and the fixtures' words are taken out. */
function untranslated(texts: readonly string[]) {
    return texts.flatMap((text) => {
        let rest = text;
        for (let before = ''; before !== rest;) {
            before = rest;
            rest = rest.replace(/\[[^[\]]*\]/g, ' ');
        }
        for (const fixture of [...SHARED_TEXT, ...UNIT_SYMBOLS, ...FIXTURE_TEXT]) {
            rest = rest.replaceAll(fixture, ' ');
        }
        return [...rest.matchAll(/\p{L}{2,}/gu)].map((match) => match[0]).filter((word) => !INTL_WORDS.has(word));
    });
}

async function settle(ticks = 12) {
    for (let tick = 0; tick < ticks; tick++) {
        await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    }
}

async function open(path: string, asked?: string[][]) {
    const router = createTestRouter(path, {
        services: () => ({
            ...fetchServices(),
            i18n: async (namespaces) => {
                asked?.push([...namespaces]);
                return pseudoPage(namespaces);
            },
        }),
    });
    root = createRoot(host);
    await act(async () => root!.render(<RouterProvider router={router} />));
    await settle();
    return router;
}

const $ = (selector: string) => {
    const found = document.querySelector(selector);
    expect(found, selector).not.toBeNull();
    return found!;
};

// The header's slots hold other modules' buttons (Ask a socio, Report issue).
const HEADER_SKIP = ['[data-slot="header-actions"]'];
// Each section's path and a word of its data, there once its cards show rows.
const DATA_WORD: Record<(typeof OPS_SECTIONS)[number], string> = {
    overview: 'Bob',
    activity: 'Delta',
    value: 'Bob',
    themes: 'Theta',
    knowledge: 'Epsilon',
    reliability: 'Bob',
    capabilities: 'Psi',
    health: 'Iota',
    cost: 'Upsilon',
    'access-log': 'Gamma',
    'socio-access': 'Omega',
    settings: 'Sigma',
};
const SECTIONS = OPS_SECTIONS.map((id) => [opsPath(id), DATA_WORD[id]] as const);

it('loads on demand only what no route inlines, and every Operations namespace and section has a home', () => {
    const own = readdirSync(locales)
        .map((name) => name.slice(0, -'.json'.length))
        .filter(operations);
    expect(own.filter((ns) => !inlined.has(ns)).sort()).toEqual(ON_DEMAND);
    for (const id of OPS_SECTIONS.filter((section) => section !== 'overview')) {
        expect(routes[`operations:section:${id}`], id).toBeDefined();
    }
    expect(routes.operations).toBeDefined();
    expect(routes['operations:chat']).toBeDefined();
});

it.each(SECTIONS)('renders %s in en-XA with its data', async (path, data) => {
    await open(path);
    await settle(20);
    expect($('[data-slot="app-body"]').textContent).toContain(data);
    expect(untranslated(readable($('[data-slot="app-header"]'), HEADER_SKIP))).toEqual([]);
    expect(untranslated(readable($('[data-slot="app-body"]')))).toEqual([]);
});

it('renders a chat’s transcript in en-XA', async () => {
    await open('/operations/chats/t1?via=overview');
    await settle(20);
    expect($('[data-slot="app-body"]').textContent).toContain('Mu');
    expect(untranslated(readable($('[data-slot="app-header"]'), HEADER_SKIP))).toEqual([]);
    expect(untranslated(readable($('[data-slot="app-body"]')))).toEqual([]);
});

it('loads a section’s namespaces and its on-demand words with its data when moving between sections', async () => {
    const asked: string[][] = [];
    const router = await open('/operations/activity', asked);
    expect(asked).toContainEqual(routes['operations:section:activity']);
    asked.length = 0;
    fetched = [];
    await act(async () => router.navigate('/operations/health'));
    await settle(20);
    // Only the section's loader runs: the root's and the gate's hold.
    expect(asked).toEqual([routes['operations:section:health']]);
    const words = fetched.filter((url) => url.startsWith('/i18n/'));
    expect(words.sort()).toEqual(SECTION_ON_DEMAND.health!.map((ns) => `/i18n/en-XA/${ns}.test.json`).sort());
    expect(fetched).toContain('/api/operations/health');
    expect(untranslated(readable($('[data-slot="app-body"]')))).toEqual([]);
});
