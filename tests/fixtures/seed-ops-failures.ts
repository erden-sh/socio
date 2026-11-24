import type { DatabaseSync } from 'node:sqlite';

import type { FailureCategory } from '@socio/shared/failure-taxonomy';

import type { IssueFact, MessageFact, ToolFact, TurnFact } from '../../src/server/operations/infra/memory/reader.js';

import { openAppDatabase, random } from './seed-ops-runs.js';

// A database as the app leaves it, holding turns that fail in every way the
// failure taxonomy (CB-189) sorts: each scenario says how the runner stores
// the turn and which category the design table gives it, so the facts below
// are what it meant, not the rules run again. Tool calls fail the same way,
// people fail repeatedly (recurring friction), and the board has items filed
// and closed over the span.

const HOUR = 3_600_000;
export const PEOPLE = ['alice', 'bob', 'carol', 'dave', 'erin'];
export const SOCIOS = [
    { id: 'socio-a', name: 'Manny', spaceId: 'space-1' },
    { id: 'socio-b', name: 'Mingo', spaceId: 'space-2' },
];

interface TurnScenario {
    name: string;
    weight: number;
    status: 'finished' | 'failed' | 'stopped' | 'interrupted';
    /** The RUN_ERROR's code; none when the run ended without one. */
    error?: string;
    end: string;
    stop?: string;
    fallback?: boolean;
    detail?: boolean;
    category: FailureCategory | null;
    rule: string;
}

export const TURN_SCENARIOS: TurnScenario[] = [
    {
        name: 'ok',
        weight: 40,
        status: 'finished',
        end: 'completed',
        category: null,
        rule: 'ok',
    },
    {
        name: 'waiting',
        weight: 4,
        status: 'finished',
        end: 'interrupted',
        category: null,
        rule: 'ok',
    },
    {
        name: 'stopped',
        weight: 3,
        status: 'stopped',
        end: 'stopped',
        category: 'stopped',
        rule: 'stopped',
    },
    {
        name: 'force stop',
        weight: 1,
        status: 'interrupted',
        error: 'operator_stopped',
        end: 'interrupted',
        category: 'stopped',
        rule: 'operator_stopped',
    },
    {
        name: 'crash',
        weight: 2,
        status: 'interrupted',
        end: 'interrupted',
        category: 'runtime_error',
        rule: 'interrupted',
    },
    {
        name: 'usage limit',
        weight: 3,
        status: 'failed',
        error: 'chatgpt_usage_limit',
        end: 'error',
        category: 'quotas',
        rule: 'quota_code',
    },
    {
        name: 'time limit',
        weight: 2,
        status: 'failed',
        error: 'time_limit',
        end: 'time_limit',
        stop: 'cancelled',
        category: 'quotas',
        rule: 'limit_end',
    },
    {
        name: 'round cap',
        weight: 2,
        status: 'finished',
        end: 'round_cap',
        stop: 'tool_calls',
        category: 'quotas',
        rule: 'limit_end',
    },
    {
        name: 'no model',
        weight: 2,
        status: 'failed',
        error: 'no_inference',
        end: 'error',
        category: 'not_available',
        rule: 'no_inference',
    },
    {
        name: 'model down',
        weight: 3,
        status: 'failed',
        error: 'model_unavailable',
        end: 'error',
        detail: true,
        category: 'model_provider',
        rule: 'provider_code',
    },
    {
        name: 'filtered',
        weight: 1,
        status: 'finished',
        end: 'completed',
        stop: 'content_filter',
        category: 'model_provider',
        rule: 'content_filter',
    },
    {
        name: 'after fallback',
        weight: 1,
        status: 'failed',
        error: 'failed',
        end: 'error',
        fallback: true,
        detail: true,
        category: 'model_provider',
        rule: 'after_fallback',
    },
    {
        name: 'unreadable',
        weight: 2,
        status: 'failed',
        error: 'tool_call',
        end: 'error',
        category: 'invalid_input',
        rule: 'invalid_code',
    },
    {
        name: 'bare failed',
        weight: 2,
        status: 'failed',
        error: 'failed',
        end: 'error',
        category: 'runtime_error',
        rule: 'failed',
    },
    {
        name: 'failed with detail',
        weight: 3,
        status: 'failed',
        error: 'failed',
        end: 'error',
        detail: true,
        category: 'unclassified',
        rule: 'failed_with_detail',
    },
];

interface ToolScenario {
    tool: string;
    weight: number;
    outcome: string;
    error?: string;
    category: FailureCategory | null;
    rule: string;
}
export const TOOL_SCENARIOS: ToolScenario[] = [
    { tool: 'read_page', weight: 30, outcome: 'ok', category: null, rule: 'ok' },
    { tool: 'http_get', weight: 10, outcome: 'ok', category: null, rule: 'ok' },
    {
        tool: 'http_get',
        weight: 4,
        outcome: 'error',
        error: 'failed',
        category: 'external_service',
        rule: 'web',
    },
    {
        tool: 'http_get',
        weight: 2,
        outcome: 'refused',
        error: 'blocked',
        category: 'permissions',
        rule: 'refused',
    },
    {
        tool: 'read_page',
        weight: 3,
        outcome: 'error',
        error: 'http_404',
        category: 'invalid_input',
        rule: 'http_4xx',
    },
    {
        tool: 'run_query',
        weight: 3,
        outcome: 'error',
        error: 'tool_error',
        category: 'unclassified',
        rule: 'generic_code',
    },
    {
        tool: 'computer_shell',
        weight: 2,
        outcome: 'error',
        error: 'exit_code',
        category: 'runtime_error',
        rule: 'tool_failed',
    },
    {
        tool: 'search_web',
        weight: 2,
        outcome: 'refused',
        error: 'rate_limited',
        category: 'quotas',
        rule: 'quota_code',
    },
];

export interface FailureSeeded {
    db: DatabaseSync;
    turns: TurnFact[];
    messages: MessageFact[];
    tools: ToolFact[];
    issues: IssueFact[];
}

export function seedFailureDatabase(
    path: string,
    options: { turns: number; start: number; spanMs: number; seed?: number },
): FailureSeeded {
    const db = openAppDatabase(path);
    const rand = random(options.seed ?? 11);
    const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)]!;
    const weighted = <T extends { weight: number }>(list: readonly T[]) => {
        let roll = rand() * list.reduce((sum, item) => sum + item.weight, 0);
        for (const item of list) {
            if ((roll -= item.weight) < 0) {
                return item;
            }
        }
        return list.at(-1)!;
    };
    const now = options.start;
    db.exec('BEGIN');
    for (const space of ['space-1', 'space-2']) {
        db.prepare('INSERT INTO spaces (id, name, description, createdAt) VALUES (?, ?, ?, ?)').run(
            space,
            space.toUpperCase(),
            '',
            now - 100 * HOUR,
        );
    }
    for (const socio of SOCIOS) {
        db.prepare(
            'INSERT INTO dots (id, spaceId, name, instructions, researchAllowed, memoryAllowed, createdAt) VALUES (?, ?, ?, ?, 0, 0, ?)',
        ).run(socio.id, socio.spaceId, socio.name, '', now - 100 * HOUR);
    }
    for (const person of PEOPLE) {
        db.prepare("INSERT INTO users (id, name, role, createdAt, lastSeenAt) VALUES (?, ?, 'member', ?, ?)").run(
            person,
            person,
            now,
            now,
        );
    }
    const chats: {
        id: string;
        socio: (typeof SOCIOS)[number];
        person: string | null;
        source: string;
    }[] = [];
    for (const person of PEOPLE) {
        for (const socio of SOCIOS) {
            chats.push({
                id: `web-${person}-${socio.id}`,
                socio,
                person,
                source: 'web',
            });
        }
    }
    chats.push({
        id: 'schedule-1',
        socio: SOCIOS[0]!,
        person: null,
        source: 'scheduled',
    });
    for (const chat of chats) {
        db.prepare('INSERT INTO thread_bindings (id, dotId, ownerId, title, createdAt) VALUES (?, ?, ?, ?, ?)').run(
            chat.id,
            chat.socio.id,
            chat.person ?? 'alice',
            'A chat',
            now - 50 * HOUR,
        );
    }

    const turns: TurnFact[] = [];
    const messages: MessageFact[] = [];
    const tools: ToolFact[] = [];
    const insert = db.prepare(
        'INSERT INTO agent_runs (threadId, runId, status, events, startedAt, finishedAt, source, trace, errorDetail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const times = Array.from({ length: options.turns }, () => Math.floor(options.start + rand() * options.spanMs)).sort(
        (a, b) => a - b,
    );
    for (const [n, startedAt] of times.entries()) {
        const runId = `run-${String(n).padStart(6, '0')}`;
        // Alice fails most: recurring friction for one person.
        const chat = rand() < 0.3 ? chats.find((c) => c.person === 'alice')! : pick(chats);
        const scenario = weighted(TURN_SCENARIOS);
        const finishedAt = startedAt + 1000 + Math.floor(rand() * 60_000);
        const model = rand() < 0.1 ? null : pick(['qwen3-32b', 'gpt-5']);
        const retries = rand() < 0.15 ? 1 + Math.floor(rand() * 2) : 0;
        // Now and then a turn that went through moved to the shared model.
        const fallback = scenario.fallback ?? (scenario.category === null && rand() < 0.05);
        const calls = Array.from({ length: Math.floor(rand() * 4) }, (_, idx) => ({
            idx,
            scenario: weighted(TOOL_SCENARIOS),
            startedAt: startedAt + 100 + idx * 500,
            durationMs: 20 + Math.floor(rand() * 3000),
        }));
        const trigger = chat.person ? { kind: 'person', id: chat.person } : { kind: 'schedule', id: 'task-1' };
        const userId = `u-${runId}`;
        const events = [
            {
                type: 'RUN_STARTED',
                threadId: chat.id,
                runId,
                timestamp: startedAt,
                input: {
                    messages: [{ id: userId, role: 'user', content: 'Please.' }],
                },
            },
            scenario.error
                ? {
                      type: 'RUN_ERROR',
                      message: 'Something failed.',
                      code: scenario.error,
                      timestamp: finishedAt,
                  }
                : { type: 'RUN_FINISHED', runId, timestamp: finishedAt },
        ];
        const trace = {
            ...(model
                ? {
                      turn: { label: 'Homelab', model, source: 'shared', cap: 12 },
                  }
                : {}),
            rounds: [
                {
                    kind: 'round',
                    round: 1,
                    startedAt,
                    endedAt: startedAt + 900,
                    inputTokens: 100,
                    outputTokens: 20,
                    stop: scenario.stop ?? 'stop',
                },
            ],
            tools: calls.map((call) => ({
                kind: 'tool',
                round: 1,
                name: call.scenario.tool,
                startedAt: call.startedAt,
                endedAt: call.startedAt + call.durationMs,
                outcome: call.scenario.outcome,
                ...(call.scenario.error ? { error: call.scenario.error } : {}),
            })),
            waits: [],
            retries: Array.from({ length: retries }, (_, i) => ({
                kind: 'retry',
                round: 1,
                at: startedAt + 10,
                reason: 'rate_limited',
                waitMs: 100,
                attempt: i + 1,
            })),
            ...(fallback
                ? {
                      fallback: {
                          kind: 'fallback',
                          round: 1,
                          at: startedAt + 50,
                          from: 'Own',
                          to: 'Homelab',
                          reason: 'usage_limit',
                      },
                  }
                : {}),
            end: { reason: scenario.end, rounds: 1, cap: 12 },
            totals: { rounds: 1, inputTokens: 100, outputTokens: 20 },
            trigger,
            messages: [{ id: userId, author: trigger, at: startedAt }],
        };
        insert.run(
            chat.id,
            runId,
            scenario.status,
            JSON.stringify(events),
            startedAt,
            finishedAt,
            chat.source === 'web' ? null : chat.source,
            JSON.stringify(trace),
            scenario.detail ? 'Provider said no (sanitized).' : null,
        );
        turns.push({
            runId,
            threadId: chat.id,
            socioId: chat.socio.id,
            socioName: chat.socio.name,
            spaceId: chat.socio.spaceId,
            personId: chat.person,
            source: chat.source,
            status: scenario.status,
            startedAt,
            finishedAt,
            inputTokens: 100,
            outputTokens: 20,
            toolCalls: calls.length,
            toolErrors: calls.filter((call) => call.scenario.outcome === 'error' || call.scenario.outcome === 'timeout')
                .length,
            failureCategory: scenario.category,
            failureRule: scenario.rule,
            failureCode: scenario.error ?? null,
            endReason: scenario.end,
            model,
            retries,
            fallback,
        });
        messages.push({
            messageId: userId,
            threadId: chat.id,
            socioId: chat.socio.id,
            spaceId: chat.socio.spaceId,
            source: chat.source,
            at: startedAt,
            authorKind: chat.person ? 'person' : ('schedule' as 'person'),
            authorId: chat.person ?? 'task-1',
        });
        for (const call of calls) {
            tools.push({
                runId,
                idx: call.idx,
                tool: call.scenario.tool,
                code: call.scenario.error ?? null,
                category: call.scenario.category,
                rule: call.scenario.rule,
                startedAt: call.startedAt,
                durationMs: call.durationMs,
            });
        }
    }

    // The board: items filed over the span, most closed some days later.
    const issues: IssueFact[] = [];
    const add = db.prepare(
        `INSERT INTO issues (id, number, title, body, status, priority, kind, reporterId, source, createdAt, updatedAt, closedAt, deletedAt)
    VALUES (?, ?, ?, '', ?, 'medium', ?, ?, 'web', ?, ?, ?, ?)`,
    );
    for (let number = 1; number <= 60; number++) {
        const createdAt = Math.floor(options.start + rand() * options.spanMs);
        const closed = rand() < 0.6;
        const closedAt = closed ? createdAt + Math.floor(rand() * 10 * 24 * HOUR) : null;
        const deletedAt = rand() < 0.05 ? createdAt + HOUR : null;
        const kind = rand() < 0.5 ? 'bug' : 'feature';
        const reporterId = pick(PEOPLE);
        add.run(
            `issue-${number}`,
            number,
            `Item ${number}`,
            closed ? 'done' : 'open',
            kind,
            reporterId,
            createdAt,
            closedAt ?? createdAt,
            closedAt,
            deletedAt,
        );
        issues.push({ kind, reporterId, createdAt, closedAt, deletedAt });
    }
    db.exec('COMMIT');
    return { db, turns, messages, tools, issues };
}
