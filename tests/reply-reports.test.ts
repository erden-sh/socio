// AI reply reports (CB-382, docs/specs/REPLY-REPORTS.md): a confirmed
// thumbs-down on a socio's reply, while an admin shares reports, is queued
// in the reaction's unit of work and sent by the leader to the reports
// collector, against a fake issuer and a fake collector. Nothing leaves
// unless sharing is on and the connection grants reports:write.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type { BaseEvent } from '@ag-ui/core';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';

import { noteActorKey } from '@socio/foundation/context/room-context';
import type { AppEnv } from '@socio/foundation/http/app-env';
import { SecretBox } from '@socio/foundation/keys/secret-box';
import { approvalNoteMessagePrefix, approvalNoteSource } from '@socio/shared/approvals';
import {
    REPLY_REPORTS_SETTING,
    REPLY_REPORTS_TEXT_VERSION,
    REPORT_CONFIRMATION,
    REPORT_REASONS,
    answeredMessage,
    fillReportText,
    promptByOther,
    reportTextPlaceholders,
    type ReplyReportsAdminView,
} from '@socio/shared/chat/reply-reports';
import { SENDER_METADATA, type Conversation, type User } from '@socio/shared/types';

import { replyReportsService, cloudService } from '../src/server/cloud/layer.js';
import {
    REPORT_BACKOFF,
    REPORT_BODY_MAX_BYTES,
    reportBody,
    reportHashes,
    type ReplyReportsService,
} from '../src/server/cloud/reply-reports.js';
import { cloudRoutes } from '../src/server/cloud/routes.js';
import type { CloudService } from '../src/server/cloud/service.js';
import { cloudFromEnv, reportsOrigin } from '../src/server/cloud/settings.js';
import type { ReactionReportInput } from '../src/server/context/contract.js';
import { reactionRoutes } from '../src/server/context/reaction-routes.js';
import { messageReactions } from '../src/server/context/reactions.js';
import { replayMessages } from '../src/server/replay/replay.js';
import type { HistoryRow } from '../src/server/turns/contract.js';
import type { WorkspaceAuditEntry } from '../src/server/workspace/contract.js';

import { fakeIssuer, ISSUER, type FakeIssuer } from './fixtures/fake-cloud-issuer.js';
import { fakeCollector, REPORTS, type FakeCollector } from './fixtures/fake-reports-collector.js';
import { Store } from './helpers/stores.js';
import { testDatabaseFile } from './helpers/test-database.js';

const KEY = new Uint8Array(32).fill(7);
const SECRET = 'reply-reports-test-secret-0123456789';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const ADA: User = { id: 'person-ada', name: 'Ada', role: 'admin' };
const BOB: User = { id: 'person-bob', name: 'Bob', role: 'member' };
const USERS = [ADA, BOB];

const SOLO = 'thread-solo-0001';
const ROOM = 'thread-room-0001';
const SOLO_REPLY = 'reply-msg-solo-0001';
const ROOM_REPLY = 'reply-msg-room-0001';
const SOCIO = 'dot-socio-0001';
const APP_UA = 'Socio/0.34.1 (iPhone; iOS 26)';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

function databasePath() {
    const dir = mkdtempSync(join(tmpdir(), 'reply-reports-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return testDatabaseFile(join(dir, 'workspace.db'));
}

/** One finished turn: `sender` asked `prompt`, the socio answered `reply` as `replyId`. */
function turn(threadId: string, runId: string, sender: string, prompt: string, replyId: string, reply: string) {
    let at = Date.UTC(2026, 10, 20, 14, 0, 0);
    const stamp = <T extends object>(event: T) => ({ ...event, timestamp: (at += 1_000) }) as unknown as BaseEvent;
    return [
        stamp({
            type: 'RUN_STARTED',
            threadId,
            runId,
            input: {
                threadId,
                runId,
                state: {},
                tools: [],
                context: [],
                forwardedProps: {},
                messages: [
                    { id: `user-msg-${runId}`, role: 'user', content: prompt, metadata: { [SENDER_METADATA]: sender } },
                ],
            },
        }),
        stamp({ type: 'TEXT_MESSAGE_START', messageId: replyId, role: 'assistant' }),
        stamp({ type: 'TEXT_MESSAGE_CONTENT', messageId: replyId, delta: reply }),
        stamp({ type: 'TEXT_MESSAGE_END', messageId: replyId }),
        stamp({ type: 'RUN_FINISHED', threadId, runId }),
    ];
}

interface Clock {
    now: () => number;
    advance(ms: number): void;
}

function clock(): Clock {
    let at = Date.now();
    return { now: () => at, advance: (ms) => void (at += ms) };
}

interface Options {
    issuer?: FakeIssuer;
    collector?: FakeCollector;
    path?: string;
    clock?: Clock;
    /** Enroll with a new provisioning token (the default for the first runtime). */
    enroll?: boolean;
    env?: Record<string, string>;
    /** The answered messages' text, by thread. */
    prompts?: { solo?: string; room?: string };
    replies?: { solo?: string; room?: string };
    /**
     * In the room, after the first reply: an approval's continuation turn
     * for `actor`, whose note quotes their private result, and the socio's
     * next reply (`ROOM_NEXT_REPLY`).
     */
    continuation?: { actor: string };
}

const ROOM_NEXT_REPLY = 'reply-msg-room-0002';
const NOTE_ID = `${approvalNoteMessagePrefix}note-0001`;
const PRIVATE_RESULT = 'PRIVATE-RESULT: the payroll export for person-bob';

/** The continuation turn: the room's messages so far, an approval's note, then the socio's next reply. */
function continuation(threadId: string, prompt: string, reply: string) {
    let at = Date.UTC(2026, 10, 20, 15, 0, 0);
    const stamp = <T extends object>(event: T) => ({ ...event, timestamp: (at += 1_000) }) as unknown as BaseEvent;
    return [
        stamp({
            type: 'RUN_STARTED',
            threadId,
            runId: 'run-room-continued',
            input: {
                threadId,
                runId: 'run-room-continued',
                state: {},
                tools: [],
                context: [],
                forwardedProps: {},
                messages: [
                    { id: 'user-msg-run-room', role: 'user', content: prompt, metadata: { [SENDER_METADATA]: ADA.id } },
                    { id: ROOM_REPLY, role: 'assistant', content: reply },
                    {
                        id: NOTE_ID,
                        role: 'user',
                        content: `The approval was decided. Result: ${PRIVATE_RESULT}`,
                        metadata: { socioSource: approvalNoteSource },
                    },
                ],
            },
        }),
        stamp({ type: 'TEXT_MESSAGE_START', messageId: ROOM_NEXT_REPLY, role: 'assistant' }),
        stamp({ type: 'TEXT_MESSAGE_CONTENT', messageId: ROOM_NEXT_REPLY, delta: 'The export is ready.' }),
        stamp({ type: 'TEXT_MESSAGE_END', messageId: ROOM_NEXT_REPLY }),
        stamp({ type: 'RUN_FINISHED', threadId, runId: 'run-room-continued' }),
    ];
}

/** One server runtime: the cloud connection, the reply reports and the reactions' routes on one database. */
async function runtime(options: Options = {}) {
    const issuer = options.issuer ?? fakeIssuer();
    const collector = options.collector ?? fakeCollector(issuer);
    const path = options.path ?? databasePath();
    const time = options.clock ?? clock();
    const store = new Store(path);
    cleanup.push(() => store.close());
    const db: DatabaseSync = store.connection;
    const box = new SecretBox({ current: KEY, legacy: SECRET }, 'settings-secrets');
    const enrollment = options.enroll === false ? {} : { SOCIO_CLOUD_ENROLLMENT_TOKEN: issuer.provision().token };
    const config = { cloud: cloudFromEnv({ SOCIO_CLOUD_ISSUER: ISSUER, ...enrollment, ...options.env }) };
    const logs: string[] = [];
    const log = console.log;
    console.log = (line: string) => void logs.push(line);
    cleanup.push(() => (console.log = log));
    const cloud: CloudService = cloudService({
        config,
        settings: store,
        secrets: store,
        releases: { data: () => ({ version: '0.55.0', commit: 'abc', releases: [] }) },
        host: { box, origin: 'https://brain.example.test', notifyAdmins: async () => {} },
        transport: collector.fetch,
        now: time.now,
    });
    const audits: WorkspaceAuditEntry[] = [];
    const reports: ReplyReportsService = replyReportsService({
        config,
        cloud,
        settings: store,
        secrets: store,
        audit: { audit: (entry) => void audits.push(entry) },
        host: { box, db },
        transport: collector.fetch,
        now: time.now,
    });
    messageReactions(db).attachReports(reports);
    await cloud.work();

    const rows = new Map<string, HistoryRow[]>([
        [
            SOLO,
            [
                {
                    seq: 1,
                    runId: 'run-solo',
                    status: 'finished',
                    startedAt: 1,
                    finishedAt: 2,
                    events: turn(
                        SOLO,
                        'run-solo',
                        ADA.id,
                        options.prompts?.solo ?? 'What is on the agenda?',
                        SOLO_REPLY,
                        options.replies?.solo ?? 'The offsite agenda: talks, then lunch.',
                    ),
                },
            ],
        ],
        [
            ROOM,
            [
                {
                    seq: 1,
                    runId: 'run-room',
                    status: 'finished',
                    startedAt: 1,
                    finishedAt: 2,
                    events: turn(
                        ROOM,
                        'run-room',
                        ADA.id,
                        options.prompts?.room ?? 'Who brings the snacks?',
                        ROOM_REPLY,
                        options.replies?.room ?? 'Bob brings the snacks.',
                    ),
                },
                ...(options.continuation
                    ? [
                          {
                              seq: 2,
                              runId: 'run-room-continued',
                              status: 'finished' as const,
                              startedAt: 3,
                              finishedAt: 4,
                              events: continuation(
                                  ROOM,
                                  options.prompts?.room ?? 'Who brings the snacks?',
                                  options.replies?.room ?? 'Bob brings the snacks.',
                              ),
                          },
                      ]
                    : []),
            ],
        ],
    ]);
    // Whose turn each stored result and note was, as the runner records it.
    const actors = new Map<string, string>(
        options.continuation ? [[noteActorKey(NOTE_ID), options.continuation.actor]] : [],
    );
    const threads: Record<string, Conversation & { members: string[] }> = {
        [SOLO]: { id: SOLO, dotId: SOCIO, ownerId: ADA.id, title: 'Plans', createdAt: 1, members: [ADA.id] },
        [ROOM]: {
            id: ROOM,
            dotId: SOCIO,
            ownerId: 'room:room-1',
            kind: 'room',
            title: 'Offsite',
            createdAt: 1,
            members: [ADA.id, BOB.id],
        },
    };
    const routes = reactionRoutes(
        {
            workspace: {
                db,
                readableThread: async (userId, id) => {
                    const thread = threads[id];
                    return thread?.members.includes(userId) ? thread : undefined;
                },
                access: () => ({ decision: { allowed: true } }) as never,
                users: () => USERS,
            },
            runner: {
                rowsMentioning: (threadId, text) =>
                    (rows.get(threadId) ?? []).filter((row) => JSON.stringify(row.events).includes(text)),
                messages: (threadId) =>
                    replayMessages(
                        threadId,
                        (rows.get(threadId) ?? []).flatMap((row) => row.events),
                    ),
                toolActors: () => new Map(actors),
                runTrace: (runId) => ({
                    runId,
                    threadId: '',
                    status: 'finished',
                    startedAt: 1,
                    finishedAt: 2,
                    trace: {
                        turn: { label: 'Test', model: 'model-test', source: 'shared', cap: 8 },
                        rounds: [],
                        tools: [],
                        waits: [],
                    },
                }),
            },
            reports,
            version: () => '0.55.0',
        },
        { messages: replayMessages },
    );
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
        c.set(
            'user',
            USERS.find((user) => user.id === c.req.header('x-test-user'))!,
        );
        await next();
    });
    app.route('/api', routes);
    app.route('/api', cloudRoutes(cloud, reports));

    const call = async (
        user: User,
        path: string,
        method = 'GET',
        body?: unknown,
        headers: Record<string, string> = {},
    ) => {
        const response = await app.request(`/api${path}`, {
            method,
            headers: {
                'x-test-user': user.id,
                ...(body === undefined ? {} : { 'content-type': 'application/json' }),
                ...headers,
            },
            ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
        });
        // oxlint-disable-next-line typescript/no-explicit-any -- the answers' JSON, read loosely by each test
        return { status: response.status, body: (await response.json()) as Record<string, any> };
    };
    const reaction = (thread: string, reply: string, kind = 'down') =>
        `/conversations/${thread}/messages/${reply}/reactions/${kind}`;
    const outbox = () =>
        db.prepare('SELECT * FROM cloud_outbox ORDER BY createdAt, id').all() as unknown as Array<{
            id: string;
            messageId: string;
            userId: string;
            payload: string | null;
            attempts: number;
            nextAt: number;
            sentAt: number | null;
            failedAt: number | null;
            lastError: string | null;
            withdrawnAt: number | null;
        }>;
    /** Turns sharing on, as an admin, and gives back the consent. */
    const share = async () => (await reports.setSharing(true, ADA.id)).consent!;
    /** Ada's confirmed thumbs-down on her own chat's reply. */
    const report = (
        consent: string,
        extra: Record<string, unknown> = {},
        user = ADA,
        thread = SOLO,
        reply = SOLO_REPLY,
    ) =>
        call(user, reaction(thread, reply), 'PUT', {
            report: { reason: 'wrong', consent, shownByOther: true, ...extra },
        });
    return {
        issuer,
        collector,
        path,
        clock: time,
        store,
        db,
        cloud,
        reports,
        audits,
        logs,
        call,
        reaction,
        outbox,
        share,
        report,
    };
}

type Runtime = Awaited<ReturnType<typeof runtime>>;

const flat = (value: unknown): unknown[] =>
    value && typeof value === 'object' ? Object.values(value).flatMap(flat) : [value];

describe('the confirmation’s text', () => {
    it('fills every placeholder of every string, and names the reasons', () => {
        const values = { socio: 'Sebas', author: 'Bob' };
        for (const text of [...Object.values(REPORT_CONFIRMATION), ...Object.values(REPLY_REPORTS_SETTING)]) {
            for (const name of reportTextPlaceholders(text)) {
                expect(Object.keys(values)).toContain(name);
            }
            expect(fillReportText(text, values)).not.toMatch(/[{}]/);
        }
        expect(fillReportText(REPORT_CONFIRMATION.byOther, values)).toBe("Bob's message goes to Ingenio too.");
        expect(fillReportText('{missing} stays', {})).toBe('{missing} stays');
        expect(REPORT_REASONS.map((reason) => reason.id)).toEqual(['offensive', 'harmful', 'wrong', 'other']);
        // What the person typed goes as written: the texts say so, and don't promise names stay.
        for (const text of [REPORT_CONFIRMATION.body, REPLY_REPORTS_SETTING.body]) {
            expect(text).toContain('as written, with any names, emails or other details in them');
            expect(text).not.toMatch(/^(Names|Your name), /m);
        }
    });
});

describe('the collector’s origin', () => {
    it('is the issuer’s sibling, or the variable, https only but on loopback', () => {
        expect(reportsOrigin(cloudFromEnv({}))).toBe('https://reports.socio.sh');
        expect(reportsOrigin(cloudFromEnv({ SOCIO_CLOUD_ISSUER: 'https://cloud-staging.socio.sh' }))).toBe(
            'https://reports-staging.socio.sh',
        );
        expect(reportsOrigin(cloudFromEnv({ SOCIO_CLOUD_ISSUER: ISSUER }))).toBe(REPORTS);
        expect(reportsOrigin(cloudFromEnv({ SOCIO_CLOUD_ISSUER: 'http://127.0.0.1:8787' }))).toBeUndefined();
        expect(
            reportsOrigin(
                cloudFromEnv({
                    SOCIO_CLOUD_ISSUER: 'http://127.0.0.1:8787',
                    SOCIO_CLOUD_REPORTS_ORIGIN: 'http://127.0.0.1:8788',
                }),
            ),
        ).toBe('http://127.0.0.1:8788');
        for (const bad of ['http://reports.example.test', 'https://reports.example.test/v1']) {
            expect(() => cloudFromEnv({ SOCIO_CLOUD_REPORTS_ORIGIN: bad })).toThrow(/SOCIO_CLOUD_REPORTS_ORIGIN/);
        }
    });
});

describe('the report', () => {
    it('sends exactly the collector’s fields: nothing names the person, the conversation or the workspace', async () => {
        const server = await runtime();
        const consent = await server.share();
        const answer = await server.report(consent, { note: '  Not what I asked.  ' }, ADA, SOLO, SOLO_REPLY);
        expect(answer.status).toBe(200);
        expect(answer.body.report).toBe('queued');
        expect(answer.body.messages[SOLO_REPLY]).toMatchObject({ mine: ['down'], report: 'queued' });
        await server.reports.send();
        expect(server.collector.posts).toHaveLength(1);
        const [post] = server.collector.posts;
        const body = post!.body;
        expect(Object.keys(body).sort()).toEqual(
            [
                'appVersion',
                'id',
                'model',
                'note',
                'prompt',
                'promptByOther',
                'reason',
                'reply',
                'reportedAt',
                'socio',
                'surface',
                'threadHash',
            ].sort(),
        );
        expect(Object.keys(body.reply as object).sort()).toEqual(['at', 'text', 'truncated']);
        expect(Object.keys(body.prompt as object).sort()).toEqual(['text', 'truncated']);
        expect(body).toMatchObject({
            reason: 'wrong',
            note: 'Not what I asked.',
            reply: { text: 'The offsite agenda: talks, then lunch.', truncated: false },
            prompt: { text: 'What is on the agenda?', truncated: false },
            promptByOther: false,
            model: 'model-test',
            surface: 'web',
            appVersion: '0.55.0',
        });
        expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(body.socio).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(body.threadHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(body.socio).not.toBe(body.threadHash);
        const deploymentId = server.cloud.status().deploymentId!;
        for (const named of [
            ADA.id,
            SOLO,
            SOLO_REPLY,
            'user-msg-run-solo',
            SOCIO,
            'brain.example.test',
            deploymentId,
        ]) {
            expect(post!.raw).not.toContain(named);
        }
        expect(flat(body)).not.toContain(ADA.name);
        expect(post!.token).toMatch(/^at_/);
        expect(server.issuer.issued.at(-1)?.audience).toBe(REPORTS);
        // Sent: the body is no longer kept.
        expect(server.outbox()[0]).toMatchObject({ id: body.id, payload: null });
        expect((await server.call(ADA, `/conversations/${SOLO}/reactions`)).body.messages[SOLO_REPLY].report).toBe(
            'shared',
        );
        expect(server.logs.join('\n')).not.toMatch(/at_|offsite|agenda/);
    });

    it('says the app and its version for the mobile app', async () => {
        const server = await runtime();
        const consent = await server.share();
        await server.call(
            ADA,
            server.reaction(SOLO, SOLO_REPLY),
            'PUT',
            { report: { reason: 'offensive', consent, shownByOther: false } },
            { 'user-agent': APP_UA },
        );
        await server.reports.send();
        const body = server.collector.posts[0]!.body;
        expect(body).toMatchObject({ surface: 'mobile', appVersion: '0.34.1', reason: 'offensive' });
        expect(body).not.toHaveProperty('note');
    });

    it('redacts a socio token and an API key in the reply, the prompt and the note', async () => {
        const socioToken = `cbsa_${'A1b2C3d4'.repeat(4)}`;
        const apiKey = `sk-${'q7W'.repeat(10)}`;
        const server = await runtime({
            prompts: { solo: `Use ${socioToken} and ${apiKey} for the call.` },
            replies: { solo: `Calling with ${apiKey}; the data token is cbdt_${'Z9y8'.repeat(6)}.` },
        });
        const consent = await server.share();
        await server.report(consent, { note: `It printed ${socioToken}` });
        await server.reports.send();
        const { raw, body } = server.collector.posts[0]!;
        expect(raw).not.toContain(socioToken);
        expect(raw).not.toContain(apiKey);
        expect(raw).not.toContain('cbdt_');
        expect((body.reply as { text: string }).text).toContain('[redacted]');
        expect((body.prompt as { text: string }).text).toBe('Use [redacted] and [redacted] for the call.');
        expect(body.note).toBe('It printed [redacted]');
    });

    it('sends names and addresses typed into the texts as written, as the confirmation says', () => {
        const body = reportBody(
            {
                threadId: SOLO,
                messageId: SOLO_REPLY,
                userId: ADA.id,
                consent: 'c',
                reason: 'other',
                reply: { text: 'Write to ada@example.test.' },
                prompt: { text: 'Ask Bob for it.', byOther: false },
            },
            reportHashes(randomBytes(32)),
            'id',
            1,
        );
        expect(body.reply.text).toBe('Write to ada@example.test.');
        expect(body.prompt?.text).toBe('Ask Bob for it.');
    });

    it('redacts a credential’s whole quoted value in the reply, the prompt and the note, as sent', async () => {
        const server = await runtime({
            prompts: { solo: 'Log in with {"password": "say \\"open\\" sesame", "user": "ada"} please.' },
            replies: { solo: 'Use {"password":"demo passphrase with spaces"}\nand token=abcdef123456 then.' },
        });
        const consent = await server.share();
        await server.report(consent, { note: "It said password='two words here' to me." });
        await server.reports.send();
        const { raw, body } = server.collector.posts[0]!;
        for (const secret of ['passphrase with spaces', 'demo', 'open', 'sesame', 'two words', 'abcdef123456']) {
            expect(raw).not.toContain(secret);
        }
        expect((body.reply as { text: string }).text).toBe('Use {"password":"[redacted]"}\nand token=[redacted] then.');
        expect((body.prompt as { text: string }).text).toBe(
            'Log in with {"password": "[redacted]", "user": "ada"} please.',
        );
        expect(body.note).toBe("It said password='[redacted]' to me.");
    });

    it('redacts the values of camelCase credential keys in the reply, the prompt and the note', async () => {
        const server = await runtime({
            prompts: {
                solo: 'My config is {"dbPassword": "open sesame now", "secretAccessKey": "demo-credential-value", "user": "ada"} today.',
            },
            replies: { solo: "Set stripeSecretKey='two words here' and githubToken=abcdef123456 then." },
        });
        const consent = await server.share();
        await server.report(consent, {
            note: 'It printed UserPassword: hunter2222 and SecretAccessKey=abcdef9876 to me.',
        });
        await server.reports.send();
        const { raw, body } = server.collector.posts[0]!;
        for (const secret of [
            'open sesame',
            'demo-credential-value',
            'two words',
            'abcdef123456',
            'hunter2222',
            'abcdef9876',
        ]) {
            expect(raw).not.toContain(secret);
        }
        expect((body.prompt as { text: string }).text).toBe(
            'My config is {"dbPassword": "[redacted]", "secretAccessKey": "[redacted]", "user": "ada"} today.',
        );
        expect((body.reply as { text: string }).text).toBe(
            "Set stripeSecretKey='[redacted]' and githubToken=[redacted] then.",
        );
        expect(body.note).toBe('It printed UserPassword: [redacted] and SecretAccessKey=[redacted] to me.');
    });

    it('redacts a secret on an inner line of a multi-line JSON blob in the prompt, and an unquoted one in the note', async () => {
        const blob = '{\n  "user": "ada",\n  "client_secret": "inner line value",\n  "n": 1\n}';
        const server = await runtime({ prompts: { solo: `Here is my config:\n${blob}` } });
        const consent = await server.share();
        await server.report(consent, { note: 'passwd=letmein99 was in it' });
        await server.reports.send();
        const { raw, body } = server.collector.posts[0]!;
        expect(raw).not.toContain('inner line value');
        expect(raw).not.toContain('letmein99');
        expect((body.prompt as { text: string }).text).toBe(
            'Here is my config:\n{\n  "user": "ada",\n  "client_secret": "[redacted]",\n  "n": 1\n}',
        );
        expect(body.note).toBe('passwd=[redacted] was in it');
    });

    it('keeps a note within 1,000 code points after redaction lengthens it', () => {
        const note = `${'x'.repeat(990)} token=a`;
        expect([...note].length).toBeLessThanOrEqual(1000);
        const body = reportBody(
            {
                threadId: SOLO,
                messageId: SOLO_REPLY,
                userId: ADA.id,
                consent: 'c',
                reason: 'other',
                note,
                reply: { text: 'ok' },
            },
            reportHashes(randomBytes(32)),
            'id',
            1,
        );
        expect(body.note).toMatch(/^x{990} token=/);
        expect([...body.note!].length).toBe(1000);
    });

    it('cuts the texts to the collector’s caps and keeps the body under 64 KiB', () => {
        const hashes = reportHashes(randomBytes(32));
        const input: ReactionReportInput = {
            threadId: SOLO,
            messageId: SOLO_REPLY,
            userId: ADA.id,
            consent: 'c',
            reason: 'other',
            reply: { text: 'r'.repeat(40_000) },
            prompt: { text: 'p'.repeat(20_000), byOther: true },
        };
        const plain = reportBody(input, hashes, 'id', 1);
        expect(plain.reply).toEqual({ text: 'r'.repeat(32_000), truncated: true });
        expect(plain.prompt).toEqual({ text: 'p'.repeat(16_000), truncated: true });
        expect(plain.promptByOther).toBe(true);
        // Four bytes each: the caps alone would make a body of about 190 KB.
        const wide = reportBody(
            { ...input, reply: { text: '😀'.repeat(32_000) }, prompt: { text: '😀'.repeat(16_000), byOther: false } },
            hashes,
            'id',
            1,
        );
        expect(Buffer.byteLength(JSON.stringify(wide))).toBeLessThanOrEqual(REPORT_BODY_MAX_BYTES);
        expect(wide.reply.truncated && wide.prompt!.truncated).toBe(true);
        expect([...wide.reply.text].every((point) => point === '😀')).toBe(true);
        const short = reportBody({ ...input, reply: { text: 'ok', at: 5 }, prompt: undefined }, hashes, 'id', 1);
        expect(short).not.toHaveProperty('prompt');
        expect(short).not.toHaveProperty('promptByOther');
        expect(short.reply).toEqual({ text: 'ok', truncated: false, at: 5 });
    });
});

describe('nothing leaves unless an admin shares and the connection allows it', () => {
    async function expectNothing(server: Runtime, consent = 'any-consent') {
        const answer = await server.report(consent, { note: 'Kept nowhere' });
        expect(answer.status).toBe(200);
        expect(answer.body.report).toBe('not-sharing');
        // A plain thumbs-down: stored, with no reason or note anywhere.
        expect(answer.body.messages[SOLO_REPLY]).toEqual({ counts: { down: 1 }, mine: ['down'] });
        expect(server.outbox()).toEqual([]);
        expect(JSON.stringify(server.db.prepare('SELECT * FROM message_reactions').all())).not.toContain(
            'Kept nowhere',
        );
        server.clock.advance(MINUTE);
        await server.reports.send();
        expect(server.collector.posts).toEqual([]);
        expect(server.reports.state()).toBeNull();
    }

    it('with sharing off', async () => {
        const server = await runtime();
        expect(server.reports.admin()).toMatchObject({ available: true, sharing: false, queued: 0, failed: 0 });
        await expectNothing(server);
    });

    it('without the reports:write scope, and sharing can’t be turned on', async () => {
        const issuer = fakeIssuer();
        issuer.scopes = 'push:send updates:read';
        const server = await runtime({ issuer });
        expect(server.reports.admin().available).toBe(false);
        await expect(server.reports.setSharing(true, ADA.id)).rejects.toMatchObject({
            _tag: 'ReplyReportsUnavailable',
        });
        expect((await server.call(ADA, '/cloud/reply-reports', 'PUT', { sharing: true })).status).toBe(409);
        await expectNothing(server);
    });

    it('when not connected', async () => {
        const server = await runtime({ enroll: false });
        expect(server.cloud.status().connection).toBe('not-connected');
        expect(server.reports.admin().available).toBe(false);
        await expectNothing(server);
        expect(server.issuer.requests).toEqual([]);
    });

    it('once the connection is revoked, even with sharing on and a report queued', async () => {
        const server = await runtime();
        const consent = await server.share();
        expect((await server.report(consent)).body.report).toBe('queued');
        expect(await server.cloud.token(REPORTS)).toMatch(/^at_/);
        server.issuer.revoke(server.cloud.status().deploymentId!);
        // The collector refuses the token, and renewing it is refused for good.
        server.collector.answers.push(401);
        await server.reports.send();
        expect(server.cloud.status().connection).toBe('revoked');
        expect(server.reports.state()).toBeNull();
        const posts = server.collector.posts.length;
        server.clock.advance(10 * MINUTE);
        await server.reports.send();
        expect(server.collector.posts).toHaveLength(posts);
        expect(server.reports.admin()).toMatchObject({ available: false, queued: 1 });
    });
});

describe('the setting', () => {
    it('is for admins only: members get 403', async () => {
        const server = await runtime();
        expect((await server.call(BOB, '/cloud/reply-reports')).status).toBe(403);
        expect((await server.call(BOB, '/cloud/reply-reports', 'PUT', { sharing: true })).status).toBe(403);
        expect(server.reports.admin().sharing).toBe(false);
        expect((await server.call(ADA, '/cloud/reply-reports')).body).toEqual({
            available: true,
            sharing: false,
            queued: 0,
            failed: 0,
        } satisfies ReplyReportsAdminView);
    });

    it('records who turned it on, when and the text’s version, with a new consent each time', async () => {
        const server = await runtime();
        const on = await server.call(ADA, '/cloud/reply-reports', 'PUT', { sharing: true });
        expect(on.status).toBe(200);
        expect(on.body).toMatchObject({ available: true, sharing: true, by: ADA.id, since: server.clock.now() });
        const first = on.body.consent as string;
        expect(server.reports.state()).toEqual({ sharing: true, consent: first });
        expect(server.audits).toEqual([
            {
                actor: ADA.id,
                action: 'update',
                targetKind: 'reply_reports',
                targetId: 'sharing',
                detail: `sharing on, consent ${first}, text ${REPLY_REPORTS_TEXT_VERSION}`,
            },
        ]);
        // Again while on: nothing changes.
        await server.call(ADA, '/cloud/reply-reports', 'PUT', { sharing: true });
        expect(server.reports.state()?.consent).toBe(first);
        expect(server.audits).toHaveLength(1);
        await server.call(ADA, '/cloud/reply-reports', 'PUT', { sharing: false });
        const again = (await server.call(ADA, '/cloud/reply-reports', 'PUT', { sharing: true })).body.consent;
        expect(again).not.toBe(first);
        for (const bad of [{ sharing: 'yes' }, { sharing: true, extra: 1 }, 'not json']) {
            expect((await server.call(ADA, '/cloud/reply-reports', 'PUT', bad)).status).toBe(400);
        }
    });

    it('turned off, empties the queue', async () => {
        const server = await runtime();
        const consent = await server.share();
        expect((await server.report(consent)).body.report).toBe('queued');
        expect((await server.report(consent, {}, BOB, ROOM, ROOM_REPLY)).body.report).toBe('queued');
        expect(server.reports.admin().queued).toBe(2);
        const off = await server.call(ADA, '/cloud/reply-reports', 'PUT', { sharing: false });
        expect(off.body).toEqual({ available: true, sharing: false, queued: 0, failed: 0 });
        expect(server.outbox()).toEqual([]);
        expect(server.audits.at(-1)?.detail).toBe('sharing off, 2 unsent dropped');
        await server.reports.send();
        expect(server.collector.posts).toEqual([]);
        // The thumbs-downs stay.
        expect((await server.call(ADA, `/conversations/${SOLO}/reactions`)).body.messages[SOLO_REPLY]).toEqual({
            counts: { down: 1 },
            mine: ['down'],
        });
    });
});

describe('consent', () => {
    it('a stale consent makes a plain thumbs-down: consent-changed', async () => {
        const server = await runtime();
        const old = await server.share();
        await server.reports.setSharing(false, ADA.id);
        await server.share();
        const answer = await server.report(old);
        expect(answer.body.report).toBe('consent-changed');
        expect(answer.body.messages[SOLO_REPLY]).toEqual({ counts: { down: 1 }, mine: ['down'] });
        expect(server.outbox()).toEqual([]);
    });

    it('a retry, or a second report on the same reply, is already there', async () => {
        const server = await runtime();
        const consent = await server.share();
        expect((await server.report(consent)).body.report).toBe('queued');
        expect((await server.report(consent)).body.report).toBe('already');
        expect(server.outbox()).toHaveLength(1);
        await server.reports.send();
        expect((await server.report(consent, { reason: 'harmful' })).body.report).toBe('already');
        expect(server.collector.posts).toHaveLength(1);
    });

    it('a report on a thumbs-down already given makes the report', async () => {
        const server = await runtime();
        const consent = await server.share();
        const plain = await server.call(ADA, server.reaction(SOLO, SOLO_REPLY), 'PUT');
        expect(plain.body).not.toHaveProperty('report');
        expect(plain.body.messages[SOLO_REPLY].mine).toEqual(['down']);
        const answer = await server.report(consent);
        expect(answer.body.report).toBe('queued');
        expect(answer.body.messages[SOLO_REPLY]).toEqual({ counts: { down: 1 }, mine: ['down'], report: 'queued' });
    });
});

describe('removing the thumbs-down', () => {
    it('before it is sent: the report is withdrawn and never goes; a new one gets a new id', async () => {
        const server = await runtime();
        const consent = await server.share();
        await server.report(consent);
        const [first] = server.outbox();
        const removed = await server.call(ADA, server.reaction(SOLO, SOLO_REPLY), 'DELETE');
        expect(removed.body.report).toBe('withdrawn');
        expect(server.outbox()).toEqual([]);
        await server.reports.send();
        expect(server.collector.posts).toEqual([]);
        expect((await server.report(consent)).body.report).toBe('queued');
        const [second] = server.outbox();
        expect(second!.id).not.toBe(first!.id);
    });

    it('after it is sent: the report is kept, and a new one is already there', async () => {
        const server = await runtime();
        const consent = await server.share();
        await server.report(consent);
        await server.reports.send();
        const removed = await server.call(ADA, server.reaction(SOLO, SOLO_REPLY), 'DELETE');
        expect(removed.body.report).toBe('kept');
        expect(removed.body.messages).toEqual({});
        expect(server.outbox()).toHaveLength(1);
        expect(server.outbox()[0]!.sentAt).not.toBeNull();
        const again = await server.report(consent);
        expect(again.body.report).toBe('already');
        expect(again.body.messages[SOLO_REPLY].report).toBe('shared');
    });

    it('a thumbs-up in its place removes the report the same way', async () => {
        const server = await runtime();
        const consent = await server.share();
        await server.report(consent);
        const up = await server.call(ADA, server.reaction(SOLO, SOLO_REPLY, 'up'), 'PUT');
        expect(up.body.report).toBe('withdrawn');
        expect(up.body.messages[SOLO_REPLY]).toEqual({ counts: { up: 1 }, mine: ['up'] });
        expect(server.outbox()).toEqual([]);
        await server.report(consent);
        await server.reports.send();
        const upAgain = await server.call(ADA, server.reaction(SOLO, SOLO_REPLY, 'up'), 'PUT');
        expect(upAgain.body.report).toBe('kept');
        // A thumbs-up with nothing to replace says nothing of reports.
        const plain = await server.call(BOB, server.reaction(ROOM, ROOM_REPLY, 'up'), 'PUT');
        expect(plain.body).not.toHaveProperty('report');
    });

    it('from Telegram’s path too (the store itself withdraws it)', async () => {
        const server = await runtime();
        const consent = await server.share();
        await server.report(consent);
        expect(messageReactions(server.db).remove(SOLO, SOLO_REPLY, ADA.id, 'down')).toBe('withdrawn');
        expect(server.outbox()).toEqual([]);
    });

    it('while it is being sent: kept, and dropped if that send doesn’t go through', async () => {
        const server = await runtime();
        const consent = await server.share();
        await server.report(consent);
        const hold = holdNextPost(server.collector);
        server.collector.answers.push(503);
        const sending = server.reports.send();
        await hold.arrived;
        expect((await server.call(ADA, server.reaction(SOLO, SOLO_REPLY), 'DELETE')).body.report).toBe('kept');
        hold.release();
        await sending;
        expect(server.outbox()).toEqual([]);
    });

    it('while it is being sent and then refused for good: dropped, so a new report is a new one', async () => {
        const server = await runtime();
        const consent = await server.share();
        await server.report(consent);
        const hold = holdNextPost(server.collector);
        server.collector.answers.push(400);
        const sending = server.reports.send();
        await hold.arrived;
        expect((await server.call(ADA, server.reaction(SOLO, SOLO_REPLY), 'DELETE')).body.report).toBe('kept');
        hold.release();
        await sending;
        expect(server.outbox()).toEqual([]);
        expect((await server.report(consent)).body.report).toBe('queued');
    });
});

describe('sharing turned off while a batch is sending', () => {
    it('sends nothing more of it', async () => {
        const server = await runtime();
        const consent = await server.share();
        await server.report(consent);
        await server.report(consent, {}, BOB, ROOM, ROOM_REPLY);
        const hold = holdNextPost(server.collector);
        const sending = server.reports.send();
        await hold.arrived;
        await server.reports.setSharing(false, ADA.id);
        hold.release();
        await sending;
        // The one in flight could not be called back; the other never started.
        expect(server.collector.posts).toHaveLength(1);
        expect(server.outbox().filter((row) => row.sentAt === null)).toEqual([]);
        server.clock.advance(MINUTE);
        await server.reports.send();
        expect(server.collector.posts).toHaveLength(1);
    });
});

describe('what changes while a send waits', () => {
    it('sharing turned off during a token renewal: the retry never goes', async () => {
        const server = await runtime();
        const consent = await server.share();
        await server.report(consent);
        server.collector.answers.push(401);
        const token = server.cloud.token.bind(server.cloud);
        server.cloud.token = async (audience, options) => {
            if (options?.renew) {
                await server.reports.setSharing(false, ADA.id);
            }
            return token(audience, options);
        };
        await server.reports.send();
        expect(server.collector.posts).toHaveLength(1);
        expect(server.collector.stored.size).toBe(0);
        expect(server.outbox()).toEqual([]);
    });

    it('another runtime’s Retry-After holds a batch already claimed', async () => {
        const first = await runtime();
        const second = await runtime({
            issuer: first.issuer,
            collector: first.collector,
            path: first.path,
            clock: first.clock,
            enroll: false,
        });
        const consent = await first.share();
        await first.report(consent);
        // The first claims its row, then waits for a token while the second hears a 429.
        const token = first.cloud.token.bind(first.cloud);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let reached!: () => void;
        const waiting = new Promise<void>((resolve) => (reached = resolve));
        first.cloud.token = async (audience, options) => {
            reached();
            await gate;
            return token(audience, options);
        };
        const sending = first.reports.send();
        await waiting;
        await first.report(consent, {}, BOB, ROOM, ROOM_REPLY);
        second.collector.answers.push({ status: 429, headers: { 'retry-after': '600' } });
        await second.reports.send();
        expect(first.collector.posts).toHaveLength(1);
        release();
        await sending;
        expect(first.collector.posts).toHaveLength(1);
        expect(first.reports.admin().queued).toBe(2);
    });
});

describe('the collector’s wait', () => {
    it('keeps the longer Retry-After when two answers cross', async () => {
        const first = await runtime();
        const second = await runtime({
            issuer: first.issuer,
            collector: first.collector,
            path: first.path,
            clock: first.clock,
            enroll: false,
        });
        const consent = await first.share();
        await first.report(consent);
        const hold = holdNextPost(first.collector);
        const sending = first.reports.send();
        await hold.arrived;
        await first.report(consent, {}, BOB, ROOM, ROOM_REPLY);
        // The second's answer comes first (10 minutes), the held one's after (1 second).
        first.collector.answers.push(
            { status: 429, headers: { 'retry-after': '600' } },
            { status: 429, headers: { 'retry-after': '1' } },
        );
        await second.reports.send();
        hold.release();
        await sending;
        expect(first.collector.posts).toHaveLength(2);
        first.clock.advance(2_000);
        await first.reports.send();
        await second.reports.send();
        expect(first.collector.posts).toHaveLength(2);
        first.clock.advance(600_000);
        await first.reports.send();
        expect(first.collector.stored.size).toBe(2);
    });
});

describe('when the report can’t be made', () => {
    it('keeps the thumbs-down and says so', async () => {
        const server = await runtime();
        const consent = await server.share();
        server.reports.prepare = () => Promise.reject(new Error('replay timed out'));
        const answer = await server.report(consent);
        expect(answer.status).toBe(200);
        expect(answer.body.report).toBe('unavailable');
        expect(answer.body.messages[SOLO_REPLY]).toEqual({ counts: { down: 1 }, mine: ['down'] });
        expect(server.outbox()).toEqual([]);
    });
});

describe('what the server refuses', () => {
    it('a reason outside the list, a long note, unknown fields, bad JSON, a report on another kind', async () => {
        const server = await runtime();
        const consent = await server.share();
        const put = (body: unknown, kind = 'down') =>
            server.call(ADA, server.reaction(SOLO, SOLO_REPLY, kind), 'PUT', body);
        expect((await put({ report: { reason: 'rude', consent, shownByOther: false } })).status).toBe(400);
        // shownByOther is required, and a boolean.
        expect((await put({ report: { reason: 'wrong', consent } })).status).toBe(400);
        expect((await put({ report: { reason: 'wrong', consent, shownByOther: 'no' } })).status).toBe(400);
        expect((await put({ report: { reason: 'wrong', consent, shownByOther: null } })).status).toBe(400);
        expect(
            (await put({ report: { reason: 'wrong', consent, shownByOther: false, note: '😀'.repeat(1001) } })).status,
        ).toBe(400);
        expect((await put({ report: { reason: 'wrong', consent, shownByOther: false, user: 'someone' } })).status).toBe(
            400,
        );
        expect((await put({ report: { reason: 'wrong' } })).status).toBe(400);
        expect((await put({ report: { reason: 'wrong', consent, shownByOther: false }, extra: true })).status).toBe(
            400,
        );
        expect((await put('{"report":')).status).toBe(400);
        expect((await put({ report: { reason: 'wrong', consent, shownByOther: false } }, 'up')).status).toBe(400);
        // Refused before anything is written.
        expect((await server.call(ADA, `/conversations/${SOLO}/reactions`)).body.messages).toEqual({});
        expect(server.outbox()).toEqual([]);
        // 1,000 code points (2,000 UTF-16 units), with spaces trimmed around them: accepted.
        const fits = await put({
            report: { reason: 'wrong', consent, shownByOther: false, note: `  ${'😀'.repeat(1000)}  ` },
        });
        expect(fits.body.report).toBe('queued');
        // Another person's chat is not found, as for reactions.
        expect((await server.report(consent, {}, BOB, SOLO, SOLO_REPLY)).status).toBe(404);
        expect((await server.report(consent, {}, ADA, SOLO, 'no-such-reply')).status).toBe(404);
    });
});

describe('in a room', () => {
    it('marks the prompt as another person’s exactly when the reactor didn’t write it', async () => {
        const server = await runtime();
        const consent = await server.share();
        const preview = (user: User) => server.call(user, `/conversations/${ROOM}/messages/${ROOM_REPLY}/report`);
        // Bob reacting to Ada's message: her name fills `{author}`; Ada's own has none.
        expect((await preview(BOB)).body).toEqual({ sharing: true, consent, promptByOther: true, author: 'Ada' });
        expect((await preview(ADA)).body).toEqual({ sharing: true, consent, promptByOther: false });
        await server.report(consent, {}, BOB, ROOM, ROOM_REPLY);
        await server.report(consent, {}, ADA, ROOM, ROOM_REPLY);
        await server.reports.send();
        const bodies = server.collector.posts.map((post) => post.body);
        expect(bodies.map((body) => body.promptByOther)).toEqual([true, false]);
        for (const body of bodies) {
            expect(body.prompt).toEqual({ text: 'Who brings the snacks?', truncated: false });
            // One room, one hash: the reports group without naming it.
            expect(body.threadHash).toBe(bodies[0]!.threadHash);
        }
        await server.reports.setSharing(false, ADA.id);
        expect((await preview(BOB)).body).toEqual({ sharing: false, promptByOther: true, author: 'Ada' });
    });

    it('never sends another member’s approval continuation, and the next reply answers the person’s message', async () => {
        // The stored messages do hold the note, right before the next reply.
        const stored = await replayMessages(
            ROOM,
            continuation(ROOM, 'Who brings the snacks?', 'Bob brings the snacks.'),
        );
        expect(stored.map((message) => message.id).slice(-2)).toEqual([NOTE_ID, ROOM_NEXT_REPLY]);
        const server = await runtime({ continuation: { actor: BOB.id } });
        const consent = await server.share();
        const preview = (user: User) => server.call(user, `/conversations/${ROOM}/messages/${ROOM_NEXT_REPLY}/report`);
        // Ada wrote the message the next reply answers: for her it is her own, for Bob another person's.
        expect((await preview(ADA)).body.promptByOther).toBe(false);
        expect((await preview(ADA)).body).not.toHaveProperty('author');
        expect((await preview(BOB)).body.promptByOther).toBe(true);
        // The note the server wrote for Bob's approval is never named: the author is Ada's.
        expect((await preview(BOB)).body.author).toBe('Ada');
        expect((await server.report(consent, { shownByOther: false }, ADA, ROOM, ROOM_NEXT_REPLY)).body.report).toBe(
            'queued',
        );
        await server.reports.send();
        const { raw, body } = server.collector.posts[0]!;
        expect(raw).not.toContain('PRIVATE-RESULT');
        expect(raw).not.toContain('payroll');
        expect(raw).not.toContain('approval was decided');
        expect(body).toMatchObject({
            reply: { text: 'The export is ready.' },
            prompt: { text: 'Who brings the snacks?' },
            promptByOther: false,
        });
    });

    it('never sends the reactor’s own continuation as the prompt either', async () => {
        const server = await runtime({ continuation: { actor: BOB.id } });
        const consent = await server.share();
        expect((await server.report(consent, { shownByOther: true }, BOB, ROOM, ROOM_NEXT_REPLY)).body.report).toBe(
            'queued',
        );
        await server.reports.send();
        const { raw, body } = server.collector.posts[0]!;
        expect(raw).not.toContain('PRIVATE-RESULT');
        expect(raw).not.toContain('approval was decided');
        expect(body).toMatchObject({ prompt: { text: 'Who brings the snacks?' }, promptByOther: true });
    });

    it('reports nothing when another person’s message would go and the confirmation didn’t say so', async () => {
        const server = await runtime();
        const consent = await server.share();
        const answer = await server.report(consent, { shownByOther: false }, BOB, ROOM, ROOM_REPLY);
        expect(answer.body.report).toBe('consent-changed');
        expect(answer.body.messages[ROOM_REPLY]).toEqual({ counts: { down: 1 }, mine: ['down'] });
        expect(server.outbox()).toEqual([]);
        // The other way round, the person agreed to more than goes: it is reported.
        const own = await server.report(consent, { shownByOther: true }, ADA, ROOM, ROOM_REPLY);
        expect(own.body.report).toBe('queued');
        await server.reports.send();
        expect(server.collector.posts[0]!.body.promptByOther).toBe(false);
    });

    it('finds the answered message in the stored messages the server replays', async () => {
        const messages = await replayMessages(ROOM, turn(ROOM, 'run-room', ADA.id, 'Who?', ROOM_REPLY, 'Bob.'));
        const answered = answeredMessage(messages, ROOM_REPLY, 'room:room-1');
        expect(answered).toMatchObject({ author: ADA.id, message: { id: 'user-msg-run-room', role: 'user' } });
        expect(promptByOther(answered, BOB.id)).toBe(true);
        expect(promptByOther(answered, ADA.id)).toBe(false);
        // A message stored without a sender is the conversation's owner's.
        const unsigned = [
            { id: 'u', role: 'user', content: 'Hi' },
            { id: 'r', role: 'assistant', content: 'Hello' },
        ];
        expect(answeredMessage(unsigned, 'r', ADA.id)?.author).toBe(ADA.id);
        // Notes the server wrote are never the answered message: approval notes, receipts, hand-offs.
        const noted = [
            { id: 'u', role: 'user', content: 'Hi', metadata: { [SENDER_METADATA]: ADA.id } },
            { id: NOTE_ID, role: 'user', content: 'Approved.' },
            { id: 'n2', role: 'user', content: 'Decided.', metadata: { socioSource: approvalNoteSource } },
            { id: 'socio:voice_receipt:1', role: 'user', content: 'Call ended.' },
            { id: 'n3', role: 'user', content: 'Handed off.', metadata: { socioSource: 'room_handoff' } },
            { id: 'r', role: 'assistant', content: 'Hello' },
        ];
        expect(answeredMessage(noted, 'r', 'room:room-1')?.message.id).toBe('u');
        expect(promptByOther(answeredMessage(noted, 'r', 'room:room-1'), BOB.id)).toBe(true);
        expect(answeredMessage(unsigned, 'u', ADA.id)).toBeUndefined();
        expect(promptByOther(undefined, ADA.id)).toBe(false);
    });
});

/** Holds the collector's next POST until the returned release is called. */
function holdNextPost(collector: FakeCollector) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => (reached = resolve));
    let armed = true;
    collector.before = async () => {
        if (armed) {
            armed = false;
            reached();
            await gate;
        }
    };
    return { arrived, release };
}

describe('sending', () => {
    async function queued(count = 1) {
        const server = await runtime();
        const consent = await server.share();
        await server.report(consent);
        if (count > 1) {
            await server.report(consent, {}, BOB, ROOM, ROOM_REPLY);
        }
        return server;
    }

    it('201 and 200 (already stored) are sent', async () => {
        for (const status of [201, 200]) {
            const server = await queued();
            server.collector.answers.push(status);
            await server.reports.send();
            expect(server.reports.mark(SOLO, SOLO_REPLY, ADA.id)).toBe('shared');
            expect(server.outbox()[0]).toMatchObject({ attempts: 1, payload: null, lastError: null });
        }
    });

    it('401: renews the token once, then sends', async () => {
        const server = await queued();
        server.collector.answers.push(401);
        await server.reports.send();
        expect(server.collector.posts).toHaveLength(2);
        expect(server.collector.posts[0]!.token).not.toBe(server.collector.posts[1]!.token);
        expect(server.issuer.issued.filter((entry) => entry.audience === REPORTS)).toHaveLength(2);
        expect(server.reports.mark(SOLO, SOLO_REPLY, ADA.id)).toBe('shared');
    });

    it('401 twice: tried again later, like a server error', async () => {
        const server = await queued();
        server.collector.answers.push(401, 401);
        await server.reports.send();
        expect(server.outbox()[0]).toMatchObject({
            attempts: 1,
            lastError: 'http 401',
            nextAt: server.clock.now() + MINUTE,
        });
    });

    it('429 and 503 hold every report back for Retry-After, across ticks and for new ones too', async () => {
        const server = await queued(2);
        const start = server.clock.now();
        server.collector.answers.push({ status: 429, headers: { 'retry-after': '120' } });
        await server.reports.send();
        expect(server.collector.posts).toHaveLength(1);
        const [first, second] = server.outbox();
        expect(first).toMatchObject({ nextAt: start + 120_000, lastError: 'http 429', attempts: 1 });
        expect(second).toMatchObject({ attempts: 0 });
        // A minute on, nothing goes: neither the second nor one queued meanwhile.
        const consent = server.reports.state()!.consent;
        await server.report(consent, {}, ADA, ROOM, ROOM_REPLY);
        server.clock.advance(MINUTE);
        await server.reports.send();
        expect(server.collector.posts).toHaveLength(1);
        // After the wait, the oldest goes and is answered 503 with a date: all wait again.
        server.clock.advance(MINUTE + 1_000);
        server.collector.answers.push({
            status: 503,
            headers: { 'retry-after': new Date(server.clock.now() + 300_000).toUTCString() },
        });
        await server.reports.send();
        expect(server.collector.posts).toHaveLength(2);
        expect(server.outbox()[0]).toMatchObject({ lastError: 'http 503', attempts: 2 });
        server.clock.advance(4 * MINUTE);
        await server.reports.send();
        expect(server.collector.posts).toHaveLength(2);
        server.clock.advance(MINUTE + 1_000);
        await server.reports.send();
        expect(server.reports.admin()).toMatchObject({ queued: 0, failed: 0 });
        expect(server.collector.stored.size).toBe(3);
    });

    it('network errors and other 5xx back off 1 min, 5 min, 30 min, 2 h, then every 6 h', async () => {
        const server = await queued();
        const waits: number[] = [];
        for (const answer of ['network', 500, 'network', 502, 'network', 'network'] as const) {
            server.collector.answers.push(answer);
            await server.reports.send();
            const [row] = server.outbox();
            waits.push(row!.nextAt - server.clock.now());
            server.clock.advance(row!.nextAt - server.clock.now());
        }
        expect(waits).toEqual([...REPORT_BACKOFF, REPORT_BACKOFF.at(-1)]);
        expect(server.outbox()[0]).toMatchObject({ attempts: 6, failedAt: null });
        await server.reports.send();
        expect(server.reports.mark(SOLO, SOLO_REPLY, ADA.id)).toBe('shared');
    });

    it('400, 403 and 413 fail for good: never sent again', async () => {
        for (const status of [400, 403, 413]) {
            const server = await queued();
            server.collector.answers.push(status);
            await server.reports.send();
            expect(server.outbox()[0]).toMatchObject({ lastError: `http ${status}`, payload: null, attempts: 1 });
            expect(server.outbox()[0]!.failedAt).not.toBeNull();
            for (const wait of [MINUTE, 6 * 60 * MINUTE, 2 * DAY]) {
                server.clock.advance(wait);
                await server.reports.send();
            }
            expect(server.collector.posts).toHaveLength(1);
            expect(server.reports.admin()).toMatchObject({ queued: 0, failed: 1 });
            const view = await server.call(ADA, `/conversations/${SOLO}/reactions`);
            expect(view.body.messages[SOLO_REPLY].report).toBe('failed');
            // Removing the thumbs-down says nothing of a report that never went; it stays for the count.
            expect(await server.call(ADA, server.reaction(SOLO, SOLO_REPLY), 'DELETE')).toMatchObject({
                body: { messages: {} },
            });
            expect(server.reports.admin().failed).toBe(1);
            // A new report on that reply: there is one already.
            const consent = server.reports.state()!.consent;
            expect((await server.report(consent)).body.report).toBe('already');
        }
    });

    it('fails what stayed unsent for 7 days, and forgets sent and failed rows after 30', async () => {
        const server = await queued(2);
        server.collector.answers.push(201, 'network');
        await server.reports.send();
        for (let day = 0; day < 7; day++) {
            server.collector.answers.push('network');
            server.clock.advance(DAY);
            await server.reports.send();
        }
        const failed = server.outbox().find((row) => row.messageId === ROOM_REPLY)!;
        expect(failed).toMatchObject({ lastError: 'unsent for 7 days', payload: null });
        expect(server.reports.admin()).toMatchObject({ queued: 0, failed: 1 });
        server.clock.advance(31 * DAY);
        await server.reports.send();
        expect(server.outbox()).toEqual([]);
    });
});

describe('two runtimes on one database', () => {
    it('never send one row twice', async () => {
        const first = await runtime();
        const second = await runtime({
            issuer: first.issuer,
            collector: first.collector,
            path: first.path,
            clock: first.clock,
            enroll: false,
        });
        expect(second.cloud.status().connection).toBe('connected');
        const consent = await first.share();
        // Five reports on five replies (the outbox doesn't care which).
        for (let index = 0; index < 5; index++) {
            const prepared = await first.reports.prepare({
                threadId: SOLO,
                messageId: `${SOLO_REPLY}-${index}`,
                userId: ADA.id,
                consent,
                reason: 'other',
                reply: { text: `Reply ${index}` },
            });
            expect(first.reports.file(prepared)).toBe('queued');
        }
        // One holds its first send; the other finds every row leased.
        const hold = holdNextPost(first.collector);
        const sending = first.reports.send();
        await hold.arrived;
        await second.reports.send();
        expect(first.collector.posts).toHaveLength(1);
        hold.release();
        await sending;
        // Both at once, again and again: still once each.
        await Promise.all([first.reports.send(), second.reports.send(), first.reports.send(), second.reports.send()]);
        const ids = first.collector.posts.map((post) => post.body.id as string);
        expect(ids).toHaveLength(5);
        expect(new Set(ids).size).toBe(5);
        expect(first.collector.stored.size).toBe(5);
        expect(second.reports.admin()).toMatchObject({ queued: 0, failed: 0 });
    });

    it('take over rows a runtime that died left leased, once the lease is over', async () => {
        const first = await runtime();
        const second = await runtime({
            issuer: first.issuer,
            collector: first.collector,
            path: first.path,
            clock: first.clock,
            enroll: false,
        });
        const consent = await first.share();
        await first.report(consent);
        // The first never hears back: a process that died mid-send.
        first.collector.before = () => new Promise<never>(() => {});
        void first.reports.send();
        await new Promise((resolve) => setTimeout(resolve, 20));
        first.collector.before = undefined;
        await second.reports.send();
        expect(first.collector.posts).toHaveLength(1);
        second.clock.advance(16 * MINUTE);
        await second.reports.send();
        expect(first.collector.posts).toHaveLength(2);
        expect(second.reports.mark(SOLO, SOLO_REPLY, ADA.id)).toBe('shared');
    });
});

describe('shutting down', () => {
    it('drain waits for a send in flight, and sends nothing more until resumed', async () => {
        const server = await runtime();
        const consent = await server.share();
        await server.report(consent);
        const hold = holdNextPost(server.collector);
        const sending = server.reports.send();
        await hold.arrived;
        let drained = false;
        const draining = server.reports.drain().then(() => (drained = true));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(drained).toBe(false);
        hold.release();
        await draining;
        await sending;
        expect(server.reports.mark(SOLO, SOLO_REPLY, ADA.id)).toBe('shared');
        await server.report(consent, {}, BOB, ROOM, ROOM_REPLY);
        await server.reports.send();
        expect(server.collector.posts).toHaveLength(1);
        server.reports.resume();
        await server.reports.send();
        expect(server.collector.posts).toHaveLength(2);
    });
});

describe('the data key', () => {
    it('counts and reseals the hash key and the unsent bodies', async () => {
        const server = await runtime();
        const consent = await server.share();
        await server.report(consent);
        expect(server.reports.sealStates()).toEqual({ current: 2, previous: 0, legacy: 0, unknown: 0 });
        expect(await server.reports.reseal()).toEqual({ resealed: 0, unreadable: 0 });
    });
});
