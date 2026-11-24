import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it } from 'vitest';

import { migrate } from '@socio/data/migrate';
import { approvalCardId, type ApprovalsState, type ApprovalView } from '@socio/shared/approvals';
import type { DataSpaceState } from '@socio/shared/data-types';

import {
    AUTO_SYSTEM_PROMPT,
    inferenceDecider,
    parseAutoAnswer,
    sanitize,
    type AutoDecider,
} from '../src/server/approvals/auto.js';
import { approvalsSchema } from '../src/server/approvals/migrations.js';
import { approvalNotice } from '../src/server/approvals/notices.js';
import { sqliteApprovals } from '../src/server/approvals/services.js';
import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { fakeByoKind } from '../src/server/inference/fake-byo.js';
import { InferenceService } from '../src/server/inference/service.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const EMAIL = 'bob.private@example.com';
const SECRET = 'sk-live-0123456789abcdefghijklmnop';

type Reply = string | { ok: false } | (() => Promise<{ ok: true; text: string; model: string; backend: string }>);

/** A decision model that answers from a script, recording what it was sent. */
function scripted(...replies: Reply[]) {
    const prompts: Array<{ userId: string; system: string; prompt: string }> = [];
    const decider: AutoDecider = {
        async decide({ userId, system, prompt }) {
            prompts.push({ userId, system, prompt });
            const next = replies.shift();
            if (next === undefined) {
                throw new Error('No scripted reply left.');
            }
            if (typeof next === 'function') {
                return next();
            }
            if (typeof next === 'object') {
                return next;
            }
            return { ok: true, text: next, model: 'fake-judge', backend: 'shared' };
        },
    };
    return { decider, prompts };
}
const reply = (decision: string, risk = 'low', reason = 'Looks routine.') => JSON.stringify({ decision, risk, reason });

interface NotePayload {
    name: string;
    count?: number;
    contact?: string;
    apiKey?: string;
}

function fixture(
    options: {
        decider?: AutoDecider;
        perHour?: number;
        timeoutMs?: number;
    } = {},
) {
    const workspace = new WorkspaceStore(testDatabase());
    workspace.recordUser({ id: 'bob', name: 'Bob Example', role: 'member' });
    workspace.recordUser({ id: 'alice', name: 'Alice', role: 'admin' });
    const dot = workspace.dots()[0];
    const other = workspace.createDot(dot.spaceId, 'Scout', 'Scouts prices.', false, false);
    const approvals = sqliteApprovals(workspace.db, {
        dotName: (id) => workspace.dot(id)?.name,
        auto: {
            decider: options.decider,
            dotRole: (id) => workspace.dot(id)?.instructions,
            perHour: options.perHour,
            timeoutMs: options.timeoutMs,
        },
    });
    const executed: NotePayload[] = [];
    const undone: unknown[] = [];
    let failUndo = false;
    approvals.register<NotePayload>({
        capability: 'test.note',
        label: 'Write notes',
        description: 'Writes a private note for the user.',
        auto: {
            maxRiskForAuto: 'low',
            riskNotes: 'Notes are private to the user.',
            rules: [
                {
                    description: 'At most 10 notes at once',
                    check: ({ payload }) => ((payload.count ?? 1) > 10 ? 'It writes more than 10 notes.' : false),
                },
                {
                    description: 'Never to an outside address',
                    check: ({ payload }) => {
                        if (payload.name === 'explode') {
                            throw new Error('boom');
                        }
                        return false;
                    },
                },
            ],
        },
        execute: ({ payload }) => {
            executed.push(payload);
            return { outcome: `Wrote ${payload.name}.`, undoData: { n: 1 } };
        },
        undo: ({ undoData, outcome }) => {
            if (failUndo) {
                throw new Error('The note is locked.');
            }
            undone.push({ undoData, outcome });
            return 'Removed the note.';
        },
    });
    approvals.register<{ to: string }>({
        capability: 'test.share',
        label: 'Share outside',
        description: 'Shares with someone outside.',
        auto: { allowed: false },
        execute: () => 'Shared.',
    });
    approvals.register({
        capability: 'test.plain',
        label: 'Plain',
        description: 'No auto settings at all.',
        execute: () => 'Done.',
    });
    cleanup.push(() => workspace.close());
    const ask = (payload: NotePayload, extra: { dotId?: string; capability?: string; userId?: string } = {}) =>
        approvals.request<NotePayload>({
            userId: extra.userId ?? 'bob',
            dotId: extra.dotId ?? dot.id,
            capability: extra.capability ?? 'test.note',
            summary: `Socio wants to write the note “${payload.name}”`,
            details: payload.contact ? [`Contact: ${payload.contact}`] : [],
            payload,
        });
    const auto = (capability = 'test.note', dotId = dot.id, userId = 'bob') =>
        approvals.setPolicy(userId, dotId, capability, 'auto');
    return {
        workspace,
        approvals,
        dot,
        other,
        executed,
        undone,
        ask,
        auto,
        failUndo: () => (failUndo = true),
        rows: () =>
            workspace.db.prepare('SELECT * FROM approval_auto_decisions ORDER BY rowid').all() as Array<
                Record<string, unknown>
            >,
    };
}

it('approves a low-risk request automatically, runs it and records the review', async () => {
    const { decider, prompts } = scripted(reply('approve', 'low', 'Routine.'));
    const f = fixture({ decider });
    await f.auto();
    const result = await f.ask({ name: 'Groceries' });
    expect(result).toMatchObject({
        status: 'approved',
        via: 'auto',
        outcome: 'Wrote Groceries.',
        reason: 'Routine.',
    });
    expect(f.executed).toEqual([{ name: 'Groceries' }]);
    const view = await f.approvals.get(result.id, 'bob');
    expect(view).toMatchObject({
        status: 'approved',
        decidedVia: 'auto',
        auto: {
            verdict: 'approved',
            cause: 'model',
            risk: 'low',
            reason: 'Routine.',
            model: 'fake-judge',
            backend: 'shared',
            undoable: true,
            undoneAt: null,
        },
    });
    expect(view.auto!.latencyMs).toBeGreaterThanOrEqual(0);
    const [row] = f.rows();
    expect(row.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(prompts[0].system).toBe(AUTO_SYSTEM_PROMPT);
    expect(prompts[0].userId).toBe('bob');
    const events = (await f.approvals.auditFor('bob')).map((entry) => entry.event);
    expect(events).toEqual(expect.arrayContaining(['requested', 'auto_approved', 'executed']));
    expect((await f.approvals.auditFor('bob')).find((e) => e.event === 'auto_approved')).toMatchObject({
        actor: 'auto:fake-judge',
        detail: 'Risk low. Routine.',
    });
});

it('denies when the model says deny, without running the action', async () => {
    const { decider } = scripted(reply('deny', 'high', 'The user said never to do this.'));
    const f = fixture({ decider });
    await f.auto();
    const result = await f.ask({ name: 'Spam' });
    expect(result).toMatchObject({ status: 'denied', via: 'auto' });
    if (result.status !== 'denied') {
        throw new Error('expected denied');
    }
    expect(result.message).toMatch(/Do not retry/);
    expect(result.outcome).toBe('Denied by auto review: The user said never to do this.');
    expect(f.executed).toEqual([]);
    expect(await f.approvals.get(result.id, 'bob')).toMatchObject({
        status: 'denied',
        decidedVia: 'auto',
        auto: { verdict: 'denied', undoable: false },
    });
    // The user can't decide it again.
    await expect(f.approvals.decide(result.id, 'bob', true)).rejects.toThrow(/already decided/);
});

it('escalates to the user when the model is unsure, with its reason on the request and the notice', async () => {
    const { decider } = scripted(reply('escalate', 'medium', 'Unusual for this socio.'));
    const f = fixture({ decider });
    await f.auto();
    const seen: unknown[] = [];
    f.approvals.onPending((view) => seen.push(view.auto?.reason));
    const result = await f.ask({ name: 'Odd' });
    expect(result.status).toBe('pending_approval');
    if (result.status !== 'pending_approval') {
        throw new Error('pending');
    }
    expect(result.message).toContain('An automatic review passed it to them: Unusual for this socio. (risk medium)');
    expect(seen).toEqual(['Unusual for this socio.']);
    const view = await f.approvals.get(result.id, 'bob');
    expect(view.auto).toMatchObject({ verdict: 'escalated', cause: 'model' });
    expect(approvalNotice(view, 'https://brain.example')).toBe(
        `Approval needed: Socio wants to write the note “Odd”.\nAuto review passed it to you: Unusual for this socio. (risk medium)\nApprove or deny it below, or in Socio: https://brain.example/approvals/${result.id}\nThe socio carries on here once you decide.`,
    );
    // Asked in a group or topic: the reply goes there, not to the DM.
    expect(approvalNotice(view, 'https://brain.example', 'topic')).toMatch(
        /The socio carries on in the topic once you decide\.$/,
    );
    // The normal manual flow from here.
    expect((await f.approvals.decide(result.id, 'bob', true)).status).toBe('approved');
    expect(f.executed).toEqual([{ name: 'Odd' }]);
});

it('escalates malformed answers', async () => {
    const answers = [
        'Sure, approve it.',
        '{"decision":"approve"}',
        '{"decision":"yes","risk":"low","reason":"ok"}',
        '{"decision":"approve","risk":"tiny","reason":"ok"}',
        '{"decision":"approve","risk":"low","reason":"  "}',
        '{"decision": "approve", "risk": "low", "reason": "unterminated',
        '',
    ];
    const { decider } = scripted(...answers);
    const f = fixture({ decider });
    await f.auto();
    for (const answer of answers) {
        const result = await f.ask({ name: `Note ${answers.indexOf(answer)}` });
        expect(result.status).toBe('pending_approval');
    }
    expect(f.rows().map((row) => row.cause)).toEqual(answers.map(() => 'malformed'));
    expect(f.executed).toEqual([]);
    // Prose, fences and reasoning blocks around a valid object are fine.
    expect(
        parseAutoAnswer(
            '<think>{"decision":"deny"}</think>Here:\n```json\n{"decision":"approve","risk":"low","reason":"Fine {really}."}\n```',
        ),
    ).toEqual({ decision: 'approve', risk: 'low', reason: 'Fine {really}.' });
    expect(parseAutoAnswer(undefined)).toBeUndefined();
});

it('escalates approvals above the capability’s risk threshold', async () => {
    const { decider } = scripted(
        reply('approve', 'medium', 'Probably fine.'),
        reply('approve', 'high', 'Probably fine.'),
    );
    const f = fixture({ decider });
    await f.auto();
    const first = await f.ask({ name: 'A' });
    const second = await f.ask({ name: 'B' });
    expect([first.status, second.status]).toEqual(['pending_approval', 'pending_approval']);
    const view = await f.approvals.get(first.id, 'bob');
    expect(view.auto).toMatchObject({
        verdict: 'escalated',
        cause: 'risk',
        risk: 'medium',
    });
    expect(f.executed).toEqual([]);
    expect(f.approvals.capabilities()[0].auto).toEqual({
        allowed: true,
        maxRisk: 'low',
        rules: ['At most 10 notes at once', 'Never to an outside address'],
        undo: true,
    });
});

it('applies hard rules before asking the model, and capabilities that never allow auto', async () => {
    const { decider, prompts } = scripted();
    const f = fixture({ decider });
    await f.auto();
    const many = await f.ask({ name: 'Bulk', count: 11 });
    expect(many.status).toBe('pending_approval');
    expect((await f.approvals.get(many.id, 'bob')).auto).toMatchObject({
        cause: 'rule',
        reason: 'It writes more than 10 notes.',
    });
    // A rule that can't be checked escalates too.
    const broken = await f.ask({ name: 'explode' });
    expect((await f.approvals.get(broken.id, 'bob')).auto).toMatchObject({
        cause: 'rule',
        reason: 'This request could not be checked against “Never to an outside address”.',
    });
    expect(prompts).toEqual([]);
    await expect(f.auto('test.share')).rejects.toThrow(/never decided automatically/);
    expect(f.approvals.capabilities()[1].auto?.allowed).toBe(false);
});

it('escalates on a timeout, a failing model and without inference', async () => {
    const slow = scripted(() => new Promise<never>(() => {}));
    const f = fixture({ decider: slow.decider, timeoutMs: 50 });
    await f.auto();
    const timedOut = await f.ask({ name: 'Slow' });
    expect((await f.approvals.get(timedOut.id, 'bob')).auto).toMatchObject({
        verdict: 'escalated',
        cause: 'timeout',
    });

    const failing = scripted(() => Promise.reject(new Error(`401 ${SECRET}`)));
    const g = fixture({ decider: failing.decider });
    await g.auto();
    const failed = await g.ask({ name: 'Fails' });
    expect((await g.approvals.get(failed.id, 'bob')).auto?.cause).toBe('error');
    expect(JSON.stringify(g.rows())).not.toContain(SECRET);

    const none = scripted({ ok: false });
    const h = fixture({ decider: none.decider });
    await h.auto();
    const noModel = await h.ask({ name: 'None' });
    expect((await h.approvals.get(noModel.id, 'bob')).auto?.cause).toBe('no_inference');

    const bare = fixture();
    await bare.auto();
    const noDecider = await bare.ask({ name: 'None' });
    expect(noDecider.status).toBe('pending_approval');
    expect((await bare.approvals.get(noDecider.id, 'bob')).auto?.cause).toBe('no_inference');
    for (const each of [f, g, h, bare]) {
        expect(each.executed).toEqual([]);
    }
});

it('limits auto approvals per socio per hour', async () => {
    const { decider, prompts } = scripted(reply('approve'), reply('approve'), reply('approve'));
    const f = fixture({ decider, perHour: 2 });
    await f.auto();
    await f.auto('test.note', f.other.id);
    const statuses = [];
    for (const name of ['1', '2', '3']) {
        statuses.push((await f.ask({ name })).status);
    }
    expect(statuses).toEqual(['approved', 'approved', 'pending_approval']);
    expect(f.rows().at(-1)).toMatchObject({ cause: 'rate_limit' });
    expect(prompts).toHaveLength(2);
    // Another Dot has its own allowance.
    expect((await f.ask({ name: '4' }, { dotId: f.other.id })).status).toBe('approved');
});

it('keeps secrets and email addresses out of the model input and the audit', async () => {
    const { decider, prompts } = scripted(reply('approve', 'low', `Fine for ${EMAIL} with ${SECRET}.`));
    const f = fixture({ decider });
    await f.auto();
    await f.approvals.setGuidance('bob', `Approve notes. Mail me at ${EMAIL}.`);
    const result = await f.ask({
        name: 'Contacts',
        contact: EMAIL,
        apiKey: SECRET,
    });
    expect(result.status).toBe('approved');
    const prompt = prompts[0].prompt;
    expect(prompt).not.toContain(EMAIL);
    expect(prompt).not.toContain(SECRET);
    expect(prompt).not.toContain('Bob Example');
    expect(prompt).toContain('[email]');
    expect(prompt).toContain('Approve notes.');
    expect(prompt).toContain('Be thoughtful, practical, and concise.');
    expect(prompt).toContain('Notes are private to the user.');
    const stored = JSON.stringify([
        f.rows(),
        await f.approvals.auditFor('bob'),
        (await f.approvals.get(result.id, 'bob')).auto,
    ]);
    expect(stored).not.toContain(EMAIL);
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain('Approve notes.');
    expect(f.rows()[0]).toMatchObject({ model: 'fake-judge', backend: 'shared' });
    // The executed action still gets its whole payload.
    expect(f.executed[0].apiKey).toBe(SECRET);
    expect(sanitize({ password: 'x', nested: { token: 'y' }, ok: 1 })).toEqual({
        password: '[redacted]',
        nested: { token: '[redacted]' },
        ok: 1,
    });
});

it('gives the model recent decisions for the same capability', async () => {
    const { decider, prompts } = scripted(reply('escalate'), reply('approve'));
    const f = fixture({ decider });
    const first = await f.ask({ name: 'Manual one' });
    await f.approvals.decide(first.id, 'bob', false);
    await f.auto();
    await f.ask({ name: 'Second' });
    await f.ask({ name: 'Third' });
    expect(prompts[0].prompt).toContain('Manual one');
    expect(prompts[0].prompt).toContain('"decidedBy": "user"');
    // Pending requests aren't decisions yet.
    expect(prompts[1].prompt).not.toContain('Second');
});

it('undoes an auto approval once, where the capability supports it', async () => {
    const { decider } = scripted(reply('approve'), reply('approve'), reply('approve'));
    const f = fixture({ decider });
    await f.auto();
    const result = await f.ask({ name: 'Undo me' });
    await expect(f.approvals.undo(result.id, 'alice')).rejects.toThrow(/not found/);
    const view = await f.approvals.undo(result.id, 'bob');
    expect(view.auto).toMatchObject({
        undoOutcome: 'Removed the note.',
        undoable: false,
    });
    expect(view.auto?.undoneAt).toBeTypeOf('number');
    expect(f.undone).toEqual([{ undoData: { n: 1 }, outcome: 'Wrote Undo me.' }]);
    await expect(f.approvals.undo(result.id, 'bob')).rejects.toThrow(/already undone/);
    // A failing undo is recorded and can be tried again.
    const second = await f.ask({ name: 'Locked' });
    f.failUndo();
    await expect(f.approvals.undo(second.id, 'bob')).rejects.toThrow(/locked/);
    expect((await f.approvals.get(second.id, 'bob')).auto).toMatchObject({
        undoneAt: null,
        undoable: true,
    });
    expect((await f.approvals.auditFor('bob')).map((entry) => entry.event)).toEqual(
        expect.arrayContaining(['undone', 'undo_failed']),
    );
    // Requests the user approved themselves aren't undone here.
    await f.approvals.setPolicy('bob', f.dot.id, 'test.note', 'manual');
    const manual = await f.ask({ name: 'Mine' });
    await f.approvals.decide(manual.id, 'bob', true);
    await expect(f.approvals.undo(manual.id, 'bob')).rejects.toThrow(/approved automatically/);
    // Nor capabilities without an undo hook.
    await f.auto('test.plain');
    const plain = await f.ask({ name: 'Plain' }, { capability: 'test.plain' });
    expect(plain.status).toBe('approved');
    expect((await f.approvals.get(plain.id, 'bob')).auto?.undoable).toBe(false);
    await expect(f.approvals.undo(plain.id, 'bob')).rejects.toThrow(/can’t be undone/);
});

it('stores guidance per user, audited without its text, and lists auto reviews on request', async () => {
    const { decider } = scripted(reply('approve'));
    const f = fixture({ decider });
    expect(await f.approvals.guidance('bob')).toBe('');
    await f.approvals.setGuidance('bob', '  Only small notes.  ');
    expect(await f.approvals.guidance('bob')).toBe('Only small notes.');
    expect(await f.approvals.guidance('alice')).toBe('');
    await expect(f.approvals.setGuidance('bob', 'x'.repeat(1001))).rejects.toThrow(/under 1000/);
    await f.approvals.setGuidance('bob', '');
    expect(await f.approvals.guidance('bob')).toBe('');
    const audit = await f.approvals.auditFor('bob');
    expect(audit.filter((e) => e.event === 'guidance_changed')).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain('small notes');
    const manual = await f.ask({ name: 'Manual' });
    await f.auto();
    const auto = await f.ask({ name: 'Auto' });
    expect((await f.approvals.list('bob')).map((v) => v.id)).toEqual([auto.id, manual.id]);
    expect((await f.approvals.list('bob', { auto: true })).map((v) => v.id)).toEqual([auto.id]);
});

it('migrates the earlier policies into the table that allows auto', () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [{ ...approvalsSchema, migrations: approvalsSchema.migrations!.slice(0, 1) }]);
    db.prepare("INSERT INTO approval_policies VALUES ('bob', 'd1', 'data.create_dataset', 'bypass', 5)").run();
    db.prepare(
        "INSERT INTO approval_requests (id, userId, dotId, capability, summary, payload, status, createdAt, expiresAt) VALUES ('r1', 'bob', 'd1', 'data.create_dataset', 'Old', 'null', 'approved', 1, 2)",
    ).run();
    expect(() =>
        db.prepare("INSERT INTO approval_policies VALUES ('bob', 'd1', 'grant.change', 'auto', 5)").run(),
    ).toThrow();
    migrate(db, [approvalsSchema]);
    expect(db.prepare('SELECT * FROM approval_policies').all()).toEqual([
        {
            userId: 'bob',
            dotId: 'd1',
            capability: 'data.create_dataset',
            policy: 'bypass',
            updatedAt: 5,
        },
    ]);
    db.prepare("INSERT INTO approval_policies VALUES ('bob', 'd1', 'grant.change', 'auto', 5)").run();
    expect(db.prepare("SELECT undoData FROM approval_requests WHERE id='r1'").get()).toEqual({ undoData: null });
});

// ---- the decider on the workspace's inference ---------------------------------

/** A local OpenAI-compatible server answering with `replies` in turn (the last repeats). */
async function fakeModel(...replies: string[]) {
    const bodies: Array<Record<string, unknown>> = [];
    const headers: IncomingMessage['headers'][] = [];
    const server = createServer((request, response) => {
        let raw = '';
        request.on('data', (chunk) => (raw += chunk));
        request.on('end', () => {
            const body = JSON.parse(raw || '{}') as Record<string, unknown>;
            bodies.push(body);
            const text = replies.length > 1 ? replies.shift()! : replies[0];
            headers.push(request.headers);
            const base = { id: 'c1', created: 1, model: String(body.model) };
            if (body.stream) {
                response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                for (const choice of [
                    { index: 0, delta: { role: 'assistant', content: text } },
                    { index: 0, delta: {}, finish_reason: 'stop' },
                ]) {
                    response.write(
                        `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [choice] })}\n\n`,
                    );
                }
                response.end('data: [DONE]\n\n');
            } else {
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(
                    JSON.stringify({
                        ...base,
                        object: 'chat.completion',
                        choices: [
                            {
                                index: 0,
                                message: { role: 'assistant', content: text },
                                finish_reason: 'stop',
                            },
                        ],
                    }),
                );
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    cleanup.push(() => new Promise((resolve) => server.close(resolve)));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}/v1`, bodies, headers };
}

it('decides on the default backend with one tool-less completion at temperature 0', async () => {
    const model = await fakeModel(reply('approve', 'low', 'Routine note.'));
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    const inference = new InferenceService(workspace.db, {
        secret: 'secret-0123456789abcdef-xyz',
        log: () => {},
    });
    const decider = inferenceDecider(inference);
    const signal = new AbortController().signal;
    const input = { userId: 'bob', system: 'SYSTEM', prompt: 'PROMPT', signal };
    // Nothing configured: no inference, nothing sent.
    expect(await decider.decide(input)).toEqual({ ok: false });
    expect(model.bodies).toEqual([]);
    await inference.createBackend({
        label: 'Local',
        baseUrl: model.url,
        model: 'judge-1',
        apiKey: 'backend-key',
    });
    const result = await decider.decide(input);
    expect(result).toEqual({
        ok: true,
        text: reply('approve', 'low', 'Routine note.'),
        model: 'judge-1',
        backend: 'shared',
    });
    expect(model.bodies).toHaveLength(1);
    const body = model.bodies[0];
    expect(body).toMatchObject({ model: 'judge-1', temperature: 0 });
    expect(body.tools).toBeUndefined();
    expect(JSON.stringify(body.messages)).toContain('SYSTEM');
    expect(JSON.stringify(body.messages)).toContain('PROMPT');
    expect(String(model.headers[0]['user-agent'] ?? '')).not.toMatch(/@/);
});

it('decides on the user’s own connection first', async () => {
    const shared = await fakeModel(reply('deny'));
    const own = await fakeModel(reply('approve'));
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    const inference = new InferenceService(workspace.db, {
        secret: 'secret-0123456789abcdef-xyz',
        log: () => {},
    });
    await inference.createBackend({
        label: 'Shared',
        baseUrl: shared.url,
        model: 'm',
    });
    const kind = fakeByoKind({ baseUrl: own.url, model: 'own-model' });
    inference.register(kind);
    await inference.updateSettings({ allowedByoKinds: [kind.id] });
    await inference.connect('bob', kind.id, {});
    await inference.connect('bob', kind.id, {});
    const decider = inferenceDecider(inference);
    const signal = new AbortController().signal;
    expect(await decider.decide({ userId: 'bob', system: 'S', prompt: 'P', signal })).toMatchObject({
        ok: true,
        model: 'own-model',
        backend: 'byo-fake',
    });
    expect(await decider.decide({ userId: 'alice', system: 'S', prompt: 'P', signal })).toMatchObject({
        ok: true,
        model: 'm',
        backend: 'shared',
    });
    expect([own.bodies.length, shared.bodies.length]).toEqual([1, 1]);
});

// ---- end to end: the platform, the routes and the data capabilities ----------

async function platformFixture(...replies: string[]) {
    const model = await fakeModel(...replies);
    const dir = mkdtempSync(join(tmpdir(), 'cb-approvals-auto-'));
    const secret = 'secret-0123456789abcdef-xyz';
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const { app, workspace, platform, dispose } = await makeTestRuntime({
        config: { sessionSecret: secret, data: { userDataDir: dir } },
        app: {
            config: { mode: 'live', baseUrl: '' },
            auth: {
                provider: new MockAuthProvider(DEFAULT_MOCK_USERS, secret),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    await platform.inference.createBackend({
        label: 'Local judge',
        baseUrl: model.url,
        model: 'judge-1',
    });
    for (const user of DEFAULT_MOCK_USERS) {
        workspace.recordUser(user);
    }
    const as = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0];
        return (path: string, method = 'GET', body?: unknown) =>
            app.request(`/api${path}`, {
                method,
                headers: {
                    cookie,
                    ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
    };
    const dot = workspace.dots()[0];
    return {
        model,
        platform,
        workspace,
        dot,
        actor: { kind: 'dot' as const, userId: 'bob', dotId: dot.id },
        bob: await as('bob'),
        alice: await as('alice'),
    };
}
const json = async <T>(response: Response | Promise<Response>) => (await response).json() as Promise<T>;

it('runs auto policies, guidance and undo through the routes, on the default backend', async () => {
    const f = await platformFixture(
        reply('approve', 'medium', 'A new private dataset.'),
        reply('escalate', 'medium', 'Unclear why it needs this.'),
    );
    for (const capability of ['data.create_dataset', 'grant.change']) {
        expect(
            (
                await f.bob('/approvals/policies', 'PUT', {
                    dotId: f.dot.id,
                    capability,
                    policy: 'auto',
                })
            ).status,
        ).toBe(200);
    }
    expect((await f.bob('/approvals/guidance', 'PUT', { guidance: 'Datasets: fine.' })).status).toBe(200);
    expect(
        (
            await f.bob('/approvals/guidance', 'PUT', {
                guidance: 'x'.repeat(1001),
            })
        ).status,
    ).toBe(400);
    const state = await json<ApprovalsState>(f.bob('/approvals'));
    expect(state.guidance).toBe('Datasets: fine.');
    expect((await json<ApprovalsState>(f.alice('/approvals'))).guidance).toBe('');
    expect(state.capabilities.find((c) => c.id === 'data.create_dataset')?.auto).toEqual({
        allowed: true,
        maxRisk: 'medium',
        rules: [],
        undo: true,
    });

    // Medium risk is within create_dataset's threshold: approved and created.
    const created = await f.platform.data.requestDataset(f.actor, {
        name: 'Watchlist',
        description: '',
    });
    expect(created).toMatchObject({ status: 'approved', via: 'auto' });
    expect((await json<DataSpaceState>(f.bob('/data'))).datasets.map((d) => d.name)).toContain('Watchlist');
    const prompt = JSON.stringify(f.model.bodies[0].messages);
    expect(prompt).toContain('Datasets: fine.');
    expect(prompt).not.toMatch(/\bBob\b/);
    // The model escalates the grant: it waits for Bob, with the reason.
    const grant = await f.platform.data.requestAccess(f.actor, {
        dataset: 'Watchlist',
        access: 'read',
        reason: 'To read it.',
    });
    expect(grant.status).toBe('pending_approval');
    const auto = await json<ApprovalsState>(f.bob('/approvals?review=auto'));
    expect(auto.pending.map((item) => item.auto?.reason)).toEqual(['Unclear why it needs this.']);
    expect(auto.recent.map((item) => item.id)).toEqual([created.id]);
    expect(auto.recent[0].auto).toMatchObject({
        verdict: 'approved',
        model: 'judge-1',
        backend: 'shared',
        undoable: true,
    });

    // Undo: Alice can't, Bob can, once; the dataset is gone.
    expect((await f.alice(`/approvals/${created.id}/undo`, 'POST')).status).toBe(404);
    const undone = await json<ApprovalView>(f.bob(`/approvals/${created.id}/undo`, 'POST'));
    expect(undone.auto?.undoOutcome).toBe('Deleted dataset “Watchlist”.');
    expect((await json<DataSpaceState>(f.bob('/data'))).datasets.map((d) => d.name)).not.toContain('Watchlist');
    expect((await f.bob(`/approvals/${created.id}/undo`, 'POST')).status).toBe(409);
    expect(f.model.bodies).toHaveLength(2);
});

it('keeps the data hard rules: write access to shared data and big shared writes go to the user', async () => {
    const f = await platformFixture(reply('approve'), reply('deny', 'medium', 'Not this socio’s job.'));
    const space = f.platform.data;
    const dataset = space.createDataset('bob', {
        name: 'Team',
        description: '',
    });
    // The table exists before the dataset is shared with the Space.
    const setup = space.setGrant('bob', {
        dotId: f.dot.id,
        datasetId: dataset.id,
        access: 'write',
    });
    await space.write(f.actor, dataset.id, {
        op: 'create_table',
        input: { table: 't', columns: [{ name: 'n', type: 'INTEGER' }] },
    });
    await space.revokeGrant('bob', setup.id);
    // Only a Space's editors place a dataset in it (CB-451): Bob edits this one.
    f.workspace.db
        .prepare(
            "INSERT INTO space_members(spaceId, userId, role, addedBy, addedAt, updatedAt) VALUES (?, 'bob', 'editor', 'alice', 1, 1)",
        )
        .run(f.dot.spaceId);
    space.updateDataset('bob', dataset.id, { sharedSpaceId: f.dot.spaceId });
    for (const capability of ['grant.change', 'data.write_shared']) {
        await f.platform.approvals.setPolicy('bob', f.dot.id, capability, 'auto');
    }
    const write = await space.requestAccess(f.actor, {
        dataset: 'Team',
        access: 'write',
        reason: 'To keep it up to date.',
    });
    expect(write.status).toBe('pending_approval');
    expect((await f.platform.approvals.get(write.id, 'bob')).auto).toMatchObject({
        cause: 'rule',
    });
    expect(f.model.bodies).toEqual([]);
    // A read grant is the model's to decide: approved, and undone back to none.
    const read = await space.requestAccess(f.actor, {
        dataset: 'Team',
        access: 'read',
        reason: 'To read it.',
    });
    expect(read).toMatchObject({ status: 'approved', via: 'auto' });
    expect(space.grants('bob').map((g) => g.access)).toEqual(['read']);
    const undone = await f.platform.approvals.undo(read.id, 'bob');
    expect(undone.auto?.undoOutcome).toMatch(/Removed Sebas’s access/);
    expect(space.grants('bob')).toEqual([]);
    // Writes to the shared dataset: more than 50 rows always need Bob; the
    // model denies the small one, and the Dot is told.
    space.setGrant('bob', {
        dotId: f.dot.id,
        datasetId: dataset.id,
        access: 'write',
    });
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ n: i }));
    const big = await space.write(f.actor, dataset.id, {
        op: 'insert',
        table: 't',
        rows: rows(51),
    });
    expect(big.status).toBe('pending_approval');
    const small = await space.write(f.actor, dataset.id, {
        op: 'insert',
        table: 't',
        rows: rows(2),
    });
    expect(small).toMatchObject({
        status: 'denied',
        outcome: 'Denied by auto review: Not this socio’s job.',
    });
    expect(f.model.bodies).toHaveLength(2);
    const sent = f.model.bodies[1].messages as Array<{ content: string }>;
    expect(sent.at(-1)!.content).toContain('"rowCount": 2');
});

it('shows a chat card for pending and auto-decided tool results only', () => {
    const pending = {
        status: 'pending_approval',
        approval: { id: 'p1', summary: 'S', url: '/approvals/p1' },
        message: 'Wait.',
    };
    expect(approvalCardId(pending)).toBe('p1');
    expect(approvalCardId(JSON.stringify({ status: 'denied', via: 'auto', id: 'a1' }))).toBe('a1');
    expect(approvalCardId({ status: 'approved', via: 'auto', id: 'a2' })).toBe('a2');
    expect(approvalCardId({ status: 'approved', via: 'bypass', id: 'b1' })).toBeUndefined();
    expect(approvalCardId('not json')).toBeUndefined();
    // A result carrying the outcome under `outcome` (goal_set did, CB-131).
    expect(approvalCardId({ outcome: pending, goals: [] })).toBe('p1');
    expect(
        approvalCardId(
            JSON.stringify({
                outcome: { status: 'denied', via: 'auto', id: 'a3' },
                goals: [],
            }),
        ),
    ).toBe('a3');
    expect(approvalCardId({ outcome: 'Goal set.', goals: [] })).toBeUndefined();
});
