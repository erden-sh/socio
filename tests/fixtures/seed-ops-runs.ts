import { DatabaseSync } from 'node:sqlite';

import type { ToolFact } from '../../src/server/operations/infra/memory/activity.js';
import type { MessageFact, TurnFact } from '../../src/server/operations/infra/memory/reader.js';
import { testDatabaseFile } from '../helpers/test-database.js';

// A database as the app leaves it (its own migrations, WAL), holding turns
// for the Operations ETL (CB-187): web chats, a DM and a shared team topic
// on Telegram with several people, schedules and a source
// nobody registered; turns from before CB-185 (no trigger or message
// authors in the trace) and after; finished, failed, stopped and running.
// It returns the facts it wrote, in CB-184's MemoryOpsReader shape, made
// from what it meant rather than by reading the rows back.

const HOUR = 3_600_000;

/** A small seeded random generator (mulberry32), so runs are repeatable. */
export function random(seed: number) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export const PEOPLE = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank'];
export const SOCIOS = [
    { id: 'socio-a', name: 'Manny', spaceId: 'space-1' },
    { id: 'socio-b', name: 'Mingo', spaceId: 'space-1' },
    { id: 'socio-c', name: 'Sebas', spaceId: 'space-2' },
];
export const TEAM = 'telegram-team:-1001';

interface Chat {
    id: string;
    socioId: string;
    ownerId: string;
    /** The run's recorded source; null: as the app stores web and Telegram turns. */
    recorded: string | null;
    /** The source analytics should read. */
    source: string;
    /** Who writes in it: one person, a team, or an automation. */
    members: string[];
    automation?: 'schedule';
}

export interface SeedOptions {
    turns: number;
    /** The first turn's time; turns are spread over `spanMs` after it. */
    start: number;
    spanMs: number;
    seed?: number;
    /** Text per answer, for the events' size. */
    answerChars?: number;
}

export interface Seeded {
    db: DatabaseSync;
    turns: TurnFact[];
    messages: MessageFact[];
    /** Every tool call, as `f_tool` keeps it (CB-190, CB-191). */
    tools: ToolFact[];
    chats: Chat[];
    /** Adds more turns after the last (catch-up), returning their facts. */
    more(count: number, options?: { from?: number; spanMs?: number }): void;
    /** Finishes a running turn, as the runner does. */
    finish(runId: string, at: number): void;
}

export function openAppDatabase(path: string) {
    const db = new DatabaseSync(testDatabaseFile(path));
    db.exec('PRAGMA journal_mode=WAL');
    return db;
}

export function seedOpsDatabase(path: string, options: SeedOptions): Seeded {
    const db = openAppDatabase(path);
    const rand = random(options.seed ?? 7);
    const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)]!;
    const now = options.start;
    db.exec('BEGIN');
    for (const space of ['space-1', 'space-2']) {
        db.prepare('INSERT OR IGNORE INTO spaces (id, name, description, createdAt) VALUES (?, ?, ?, ?)').run(
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
            person[0]!.toUpperCase() + person.slice(1),
            now,
            now,
        );
    }
    const chats: Chat[] = [];
    const addChat = (chat: Chat, telegram?: string) => {
        chats.push(chat);
        db.prepare('INSERT INTO thread_bindings (id, dotId, ownerId, title, createdAt) VALUES (?, ?, ?, ?, ?)').run(
            chat.id,
            chat.socioId,
            chat.ownerId,
            'A chat',
            now - 50 * HOUR,
        );
        if (telegram) {
            db.prepare(
                'INSERT INTO telegram_threads (key, threadId, kind, chatId, topicId, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
            ).run(telegram, chat.id, telegram.includes('topic') ? 'topic' : 'dm', '-1001', null, now);
        }
    };
    for (const person of PEOPLE) {
        for (const socio of SOCIOS) {
            addChat({
                id: `web-${person}-${socio.id}`,
                socioId: socio.id,
                ownerId: person,
                recorded: null,
                source: 'web',
                members: [person],
            });
        }
    }
    addChat(
        {
            id: 'tg-dm-bob',
            socioId: 'socio-a',
            ownerId: 'bob',
            recorded: null,
            source: 'telegram',
            members: ['bob'],
        },
        'tg:-1001#bob',
    );
    // A shared topic: the team owns it, several people write in it.
    addChat(
        {
            id: 'tg-topic',
            socioId: 'socio-b',
            ownerId: TEAM,
            recorded: null,
            source: 'telegram',
            members: ['alice', 'carol', 'erin'],
        },
        'tg:-1001:topic:7',
    );
    addChat({
        id: 'schedule-alice',
        socioId: 'socio-c',
        ownerId: 'alice',
        recorded: 'scheduled',
        source: 'scheduled',
        members: [],
        automation: 'schedule',
    });
    addChat({
        id: 'zap-frank',
        socioId: 'socio-b',
        ownerId: 'frank',
        recorded: 'zapier',
        source: 'zapier',
        members: ['frank'],
    });
    db.exec('COMMIT');

    const turns: TurnFact[] = [];
    const messages: MessageFact[] = [];
    const toolFacts: ToolFact[] = [];
    const insert = db.prepare(
        'INSERT INTO agent_runs (threadId, runId, status, events, startedAt, finishedAt, source, trace) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const answer = 'x'.repeat(options.answerChars ?? 400);
    let made = 0;
    const write = (count: number, from: number, spanMs: number, total: number) => {
        const times = Array.from({ length: count }, () => Math.floor(from + rand() * spanMs)).sort((a, b) => a - b);
        db.exec('BEGIN');
        for (const [index, startedAt] of times.entries()) {
            const n = made++;
            const chat = pick(chats);
            const socio = SOCIOS.find((s) => s.id === chat.socioId)!;
            const runId = `run-${String(n).padStart(6, '0')}`;
            // The newer half recorded who started it and wrote (CB-185).
            const signals = n >= total / 2;
            const roll = rand();
            const running = index >= count - 2 && count > 4;
            const status = running ? 'running' : roll < 0.08 ? 'failed' : roll < 0.11 ? 'stopped' : 'finished';
            const person = chat.automation ? null : signals ? pick(chat.members) : chat.ownerId;
            const queue = signals ? Math.floor(rand() * 4000) : 0;
            const finishedAt = running ? null : startedAt + 2000 + Math.floor(rand() * 60_000);
            const input = 100 + Math.floor(rand() * 5000);
            const output = 20 + Math.floor(rand() * 900);
            const tools = Math.floor(rand() * 4);
            const outcomes = Array.from({ length: tools }, () => {
                const r = rand();
                return r < 0.15 ? 'error' : r < 0.2 ? 'refused' : 'ok';
            });
            const toolNames = outcomes.map(() => pick(['search_pages', 'read_page', 'web_fetch', 'run_query']));
            const userId = `u-${runId}`;
            const answerId = `a-${runId}`;
            // Now and then another socio answers in the chat too (CB-185 only).
            const guest = signals && rand() < 0.05 ? pick(SOCIOS.filter((s) => s.id !== socio.id)) : undefined;
            const events: unknown[] = [
                {
                    type: 'RUN_STARTED',
                    threadId: chat.id,
                    runId,
                    timestamp: startedAt,
                    input: {
                        threadId: chat.id,
                        runId,
                        messages: [
                            {
                                id: userId,
                                role: 'user',
                                content: chat.automation
                                    ? 'Run the weekly report.'
                                    : [{ type: 'text', text: 'Please help with this.' }],
                            },
                        ],
                        tools: [],
                        context: [],
                    },
                },
                {
                    type: 'TEXT_MESSAGE_START',
                    messageId: answerId,
                    role: 'assistant',
                    timestamp: startedAt + 900,
                },
                {
                    type: 'TEXT_MESSAGE_CONTENT',
                    messageId: answerId,
                    delta: answer,
                    timestamp: startedAt + 1000,
                },
                {
                    type: 'TEXT_MESSAGE_END',
                    messageId: answerId,
                    timestamp: startedAt + 1100,
                },
                ...(guest
                    ? [
                          {
                              type: 'TEXT_MESSAGE_START',
                              messageId: `g-${runId}`,
                              role: 'assistant',
                              timestamp: startedAt + 1200,
                          },
                          {
                              type: 'TEXT_MESSAGE_CONTENT',
                              messageId: `g-${runId}`,
                              delta: 'Also this.',
                              timestamp: startedAt + 1300,
                          },
                      ]
                    : []),
                ...(status === 'failed'
                    ? [
                          {
                              type: 'RUN_ERROR',
                              message: 'Model error',
                              code: 'model_unavailable',
                              timestamp: finishedAt,
                          },
                      ]
                    : running
                      ? []
                      : [
                            {
                                type: 'RUN_FINISHED',
                                threadId: chat.id,
                                runId,
                                timestamp: finishedAt,
                            },
                        ]),
            ];
            const trigger = chat.automation
                ? { kind: chat.automation, id: `${chat.automation}-1` }
                : { kind: 'person', id: person! };
            const trace = {
                turn: {
                    label: 'Homelab',
                    model: 'qwen3-32b',
                    source: 'shared',
                    cap: 12,
                },
                rounds: [
                    {
                        kind: 'round',
                        round: 1,
                        startedAt,
                        endedAt: startedAt + 900,
                        inputTokens: input,
                        outputTokens: output,
                        stop: 'stop',
                        ...(signals ? { reasoningKind: 'raw' } : {}),
                    },
                ],
                tools: outcomes.map((outcome, i) => ({
                    kind: 'tool',
                    round: 1,
                    name: toolNames[i]!,
                    startedAt: startedAt + 100 * i,
                    endedAt: startedAt + 100 * i + 50,
                    outcome,
                    ...(outcome === 'error' ? { error: 'http_500' } : {}),
                })),
                waits: [],
                ...(running
                    ? {}
                    : {
                          end: {
                              reason: status === 'failed' ? 'error' : status === 'stopped' ? 'stopped' : 'completed',
                              rounds: 1,
                              cap: 12,
                          },
                          totals: {
                              rounds: 1,
                              inputTokens: input,
                              outputTokens: output,
                              ...(signals ? { reasoningKind: 'raw' } : {}),
                          },
                      }),
                ...(signals
                    ? {
                          receivedAt: startedAt - queue,
                          trigger,
                          messages: [
                              { id: userId, author: trigger, at: startedAt - queue },
                              {
                                  id: answerId,
                                  author: { kind: 'socio', id: socio.id },
                                  at: startedAt + 900,
                              },
                              ...(guest
                                  ? [
                                        {
                                            id: `g-${runId}`,
                                            author: { kind: 'socio', id: guest.id },
                                            at: startedAt + 1200,
                                        },
                                    ]
                                  : []),
                          ],
                      }
                    : {}),
            };
            insert.run(
                chat.id,
                runId,
                status,
                JSON.stringify(events),
                startedAt,
                finishedAt,
                chat.recorded,
                JSON.stringify(trace),
            );
            turns.push({
                runId,
                threadId: chat.id,
                socioId: socio.id,
                socioName: socio.name,
                spaceId: socio.spaceId,
                personId: person,
                source: chat.source,
                status: status as TurnFact['status'],
                startedAt,
                finishedAt,
                inputTokens: input,
                outputTokens: output,
                toolCalls: tools,
                toolErrors: outcomes.filter((o) => o === 'error').length,
                endReason: running
                    ? null
                    : status === 'failed'
                      ? 'error'
                      : status === 'stopped'
                        ? 'stopped'
                        : 'completed',
            });
            toolFacts.push(
                ...outcomes.map((outcome, i) => ({
                    runId,
                    threadId: chat.id,
                    socioId: socio.id,
                    spaceId: socio.spaceId,
                    source: chat.source,
                    personId: person,
                    tool: toolNames[i]!,
                    outcome,
                    startedAt: startedAt + 100 * i,
                })),
            );
            const base = {
                runId,
                threadId: chat.id,
                socioId: socio.id,
                spaceId: socio.spaceId,
                source: chat.source,
            };
            messages.push(
                chat.automation
                    ? ({
                          ...base,
                          messageId: userId,
                          at: startedAt - queue,
                          authorKind: chat.automation,
                          authorId: signals ? `${chat.automation}-1` : '',
                      } as unknown as MessageFact)
                    : {
                          ...base,
                          messageId: userId,
                          at: startedAt - queue,
                          authorKind: 'person',
                          authorId: person!,
                      },
                {
                    ...base,
                    messageId: answerId,
                    at: startedAt + 900,
                    authorKind: 'socio',
                    authorId: socio.id,
                },
                ...(guest
                    ? [
                          {
                              ...base,
                              messageId: `g-${runId}`,
                              at: startedAt + 1200,
                              authorKind: 'socio' as const,
                              authorId: guest.id,
                          },
                      ]
                    : []),
            );
        }
        db.exec('COMMIT');
    };
    write(options.turns, options.start, options.spanMs, options.turns);
    return {
        db,
        turns,
        messages,
        tools: toolFacts,
        chats,
        more(count, extra = {}) {
            const last = Math.max(...turns.map((turn) => turn.startedAt));
            write(count, extra.from ?? last + 1000, extra.spanMs ?? HOUR, made + count);
        },
        finish(runId, at) {
            const row = db.prepare('SELECT events, trace FROM agent_runs WHERE runId=?').get(runId) as {
                events: string;
                trace: string;
            };
            const events = JSON.parse(row.events) as unknown[];
            events.push({ type: 'RUN_FINISHED', runId, timestamp: at });
            db.prepare("UPDATE agent_runs SET status='finished', finishedAt=?, events=? WHERE runId=?").run(
                at,
                JSON.stringify(events),
                runId,
            );
            const turn = turns.find((t) => t.runId === runId)!;
            turn.status = 'finished';
            turn.finishedAt = at;
        },
    };
}
