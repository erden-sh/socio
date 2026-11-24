import { EventType, type BaseEvent, type Message } from '@ag-ui/client';
import { defineTool, type ToolDefinition } from '@copilotkit/runtime/v2';
import { Context } from 'effect';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { withheldResult } from '@socio/foundation/context/room-context';
import {
    PERSON_INACTIVE_APPROVAL,
    ROOM_APPROVAL_GONE,
    requesterStanding,
    turnAuthority,
} from '@socio/foundation/rooms/authority';
import type { DotTurn } from '@socio/foundation/turns/turn';
import { senderMetadata } from '@socio/foundation/workspace/client-messages';
import { roomOwnerId, startTurn, type ConversationKind, type TurnContext } from '@socio/shared/rooms/rooms';

import { AppTurns } from '../src/server/composition/app/turns.js';
import type { TurnOutcome } from '../src/server/turns/contract.js';

import { PNG } from './fixtures/media.js';
import { completion } from './fixtures/model-stream.js';
import { matrixChats, roomsFixture } from './fixtures/rooms.js';
import { DotAgent } from './helpers/dot-agent.js';

/** The app's turns edge (`AppTurns`), which the graph's steps run a socio's turn through. */
const appTurns = (f: { edge: { services: unknown } }) =>
    Context.getUnsafe(f.edge.services as Context.Context<never>, AppTurns);

// CB-209: a room turn runs as the person who sent the message, with their
// access, files, connections, approvals and subscription; never as the
// room's creator, a room admin or a socio's owner. When they may not work
// there the socio stops and says so. Another person's private files and
// results never reach their turn; only the requester decides an approval,
// only while they may still work in the room, and the socio carries on in
// the work cycle that asked, on what is left of its budget.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
});

// ---- The rule, alone ---------------------------------------------------------

const ROOM = {
    id: 'room-1',
    kind: 'room' as ConversationKind,
    ownerId: roomOwnerId('room-1'),
};
const COMPANY = { id: 'dot-co', ownerId: null };
/** Olive's own socio: she owns its computer, data and connections. */
const OLIVES = { id: 'dot-olive', ownerId: 'olive' };
/** Ada made the room (its admin), Mo joined; Rex was removed. */
const MAY_SEND = new Set(['ada', 'mo']);

const contextFor = (sender: string, overrides: Partial<TurnContext> = {}) => {
    const start = startTurn({
        conversation: { ...ROOM, archivedAt: null },
        senderId: sender,
        member: { role: 'member', status: 'active' },
        socio: { dotId: COMPANY.id, ownerId: null, roomStatus: 'active' },
        cycleId: 'cycle-1',
        billing: { kind: 'workspace' },
        roomsEnabled: true,
    });
    if (!start.ok) {
        throw new Error(start.reason);
    }
    return { ...start.context, ...overrides };
};

it('acts as the room turn’s sender, never its creator or a socio’s owner, and refuses rather than fall back', () => {
    const room = (sender: string | undefined, extra: Partial<Parameters<typeof turnAuthority>[0]> = {}) =>
        turnAuthority({
            conversation: ROOM,
            socio: COMPANY,
            ...(sender ? { trigger: { kind: 'person', id: sender } } : {}),
            maySend: (id) => MAY_SEND.has(id),
            active: () => true,
            ...extra,
        });
    // Requester ≠ creator ≠ socio owner: each acts only as themselves.
    expect(room('mo')).toEqual({ ok: true, actingUserId: 'mo' });
    expect(room('ada')).toEqual({ ok: true, actingUserId: 'ada' });
    // Someone who may not send there now: stopped, not run as Ada (the
    // creator), a room admin or anyone else.
    for (const person of ['rex', 'olive', 'nina']) {
        expect(room(person), person).toEqual({
            ok: false,
            reason: 'room_access',
        });
    }
    // A room turn nobody sent (a system or schedule trigger) runs as nobody.
    expect(room(undefined)).toEqual({ ok: false, reason: 'no_person' });
    expect(room(undefined, { trigger: { kind: 'schedule', id: 'task-1' } })).toEqual({
        ok: false,
        reason: 'no_person',
    });
    // A personal socio is in no room, its owner's resources with it: not
    // for a member, not for its owner either.
    expect(room('mo', { socio: OLIVES })).toEqual({
        ok: false,
        reason: 'personal_socio',
    });
    expect(room('olive', { socio: OLIVES })).toEqual({
        ok: false,
        reason: 'personal_socio',
    });
    // A server-set acting person must be the sender.
    expect(room('mo', { actingUserId: 'ada' })).toEqual({
        ok: false,
        reason: 'not_sender',
    });
    expect(room(undefined, { actingUserId: 'mo' })).toEqual({
        ok: true,
        actingUserId: 'mo',
    });

    // A work cycle's context decides (CB-211), and only one that keeps the
    // rules, for this room and socio.
    const context = contextFor('mo');
    expect(room('ada', { context })).toEqual({ ok: true, actingUserId: 'mo' });
    for (const broken of [
        contextFor('mo', { conversationId: 'room-2' }),
        contextFor('mo', { socio: { dotId: 'dot-other', ownerId: null } }),
        // Acting as someone other than who started the cycle.
        contextFor('mo', { actingUserId: 'ada' }),
        // Billed to another member.
        contextFor('mo', { billing: { kind: 'person', userId: 'ada' } }),
    ]) {
        expect(room('mo', { context: broken })).toEqual({
            ok: false,
            reason: 'context',
        });
    }
    expect(room('mo', { context, actingUserId: 'ada' })).toEqual({
        ok: false,
        reason: 'context',
    });
    // Mo removed while his cycle waited: it doesn't carry on as him.
    expect(room('mo', { context, maySend: () => false })).toEqual({
        ok: false,
        reason: 'room_access',
    });

    // Private chats, as before: their owner, or a channel's linked person;
    // a person's own socio only for them.
    const own = { id: 'olive-chat', kind: 'private' as const, ownerId: 'olive' };
    const chat = (
        socio: { id: string; ownerId: string | null },
        extra: Partial<Parameters<typeof turnAuthority>[0]> = {},
    ) =>
        turnAuthority({
            conversation: own,
            socio,
            trigger: { kind: 'person', id: 'olive' },
            maySend: () => false,
            active: () => true,
            ...extra,
        });
    expect(chat(COMPANY)).toEqual({ ok: true, actingUserId: 'olive' });
    expect(chat(OLIVES)).toEqual({ ok: true, actingUserId: 'olive' });
    expect(chat({ id: 'dot-mo', ownerId: 'mo' })).toEqual({
        ok: false,
        reason: 'personal_socio',
    });
    expect(chat(COMPANY, { actingUserId: 'mo' })).toEqual({
        ok: true,
        actingUserId: 'mo',
    });
    // CB-528: nobody deactivated is acted for, in any conversation or
    // context, whoever started the turn.
    const deactivated = { active: (id: string) => id !== 'olive' && id !== 'mo' };
    expect(chat(OLIVES, deactivated)).toEqual({ ok: false, reason: 'inactive' });
    expect(chat(COMPANY, { ...deactivated, actingUserId: 'mo' })).toEqual({ ok: false, reason: 'inactive' });
    expect(room('mo', deactivated)).toEqual({ ok: false, reason: 'inactive' });
    expect(room('ada', { ...deactivated, context })).toEqual({ ok: false, reason: 'inactive' });
    expect(room('ada', deactivated)).toEqual({ ok: true, actingUserId: 'ada' });
});

it('lets only the requester decide, and in a room only while they may still send there', () => {
    const threads: Record<string, { id: string; kind: ConversationKind }> = {
        'room-1': { id: 'room-1', kind: 'room' },
        'olive-chat': { id: 'olive-chat', kind: 'private' },
    };
    const deactivated = new Set<string>();
    const workspace = {
        thread: (id: string) => threads[id],
        allows: (userId: string) => MAY_SEND.has(userId),
        isDeactivated: (userId: string) => deactivated.has(userId),
    };
    expect(requesterStanding(workspace, { userId: 'mo', threadId: 'room-1' })).toBeUndefined();
    expect(requesterStanding(workspace, { userId: 'rex', threadId: 'room-1' })).toBe(ROOM_APPROVAL_GONE);
    // Private chats and requests from no conversation: unchanged.
    expect(requesterStanding(workspace, { userId: 'rex', threadId: 'olive-chat' })).toBeUndefined();
    expect(requesterStanding(workspace, { userId: 'rex', threadId: null })).toBeUndefined();
    // CB-528: a deactivated person's requests, anywhere, are neither decided nor run.
    deactivated.add('mo');
    for (const threadId of ['room-1', 'olive-chat', null]) {
        expect(requesterStanding(workspace, { userId: 'mo', threadId })).toBe(PERSON_INACTIVE_APPROVAL);
    }
    // Other members see a waiting request as only that.
    const pending = JSON.stringify({
        status: 'pending_approval',
        id: 'req',
        approval: { id: 'req', summary: 'Read MO-CANARY', url: '/approvals/req' },
    });
    const shown = withheldResult('read_private', pending);
    expect(shown).toContain('"status":"waiting_for_approval"');
    expect(shown).not.toContain('MO-CANARY');
});

// ---- In the app --------------------------------------------------------------

const MODEL_URL = 'https://model.invalid/v1';
const CAPABILITY = 'test.private_read';

const say = (content: string) =>
    completion({ role: 'assistant', content }, 'stop', {
        prompt_tokens: 1_000,
        completion_tokens: 50,
        total_tokens: 1_050,
    });
/** One model round calling these tools, each with its arguments. */
const calls = (...list: Array<[id: string, name: string, args?: object]>) =>
    completion(
        {
            role: 'assistant',
            tool_calls: list.map(([id, name, args], index) => ({
                index,
                id,
                type: 'function',
                function: { name, arguments: JSON.stringify(args ?? {}) },
            })),
        },
        'tool_calls',
        { prompt_tokens: 2_000, completion_tokens: 100, total_tokens: 2_100 },
    );
const call = (id: string, name: string) => calls([id, name]);

/**
 * Ada's room (Mo a member, Rex removed, Ivy invited), Olive's private
 * chat, a fake model on a loopback-free URL that never leaves the test,
 * and an approval capability whose action records whose it ran as.
 */
async function authority() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const replies: Array<() => Response> = [];
    const bodies: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        // Nothing leaves the test: only the fake model answers.
        if (!String(input).startsWith(MODEL_URL)) {
            throw new Error(`No network in this test: ${String(input)}`);
        }
        const body = String(init?.body ?? '');
        if (body.includes('Write a short title')) {
            return Response.json({ choices: [{ message: { content: 'Title' } }] });
        }
        bodies.push(body);
        return (replies.shift() ?? (() => say('Done.')))();
    });
    const f = await roomsFixture(cleanup, {
        config: {
            baseUrl: MODEL_URL,
            apiKey: 'unused',
            model: 'custom-model',
            modelRetry: { baseMs: 5 },
        },
    });
    const { roomId, privateId } = await matrixChats(f);
    const executed: string[] = [];
    f.platform.approvals.register<{ secret: string }>({
        capability: CAPABILITY,
        label: 'Read a private file',
        description: 'Reads one of your files.',
        execute: (record) => {
            executed.push(record.userId);
            return 'Read it.';
        },
    });
    /** The tool that asks: as the turn's person, always. */
    const ask = (turn: DotTurn) =>
        defineTool({
            name: 'read_private',
            description: 'Read the person’s private file (needs their approval).',
            parameters: z.object({}),
            execute: async () =>
                f.platform.approvals.request({
                    userId: turn.userId,
                    dotId: turn.dot.id,
                    capability: CAPABILITY,
                    summary: `Read ${turn.userId.toUpperCase()}-SUMMARY-CANARY`,
                    payload: { secret: `${turn.userId.toUpperCase()}-PAYLOAD-CANARY` },
                    threadId: turn.threadId,
                }),
        });
    let runs = 0;
    /**
     * A web turn `person` sends in the room, as the runtime runs one: the
     * turns its tools were given and the tools themselves.
     */
    const turn = async (person: string, tools?: (turn: DotTurn) => ToolDefinition[], dotId = f.company.id) => {
        const runId = `run-${person}-${(runs += 1)}`;
        const seen: DotTurn[] = [];
        const agent = new DotAgent(f.store, f.workspace, f.platform.config, dotId, false, undefined, {
            inference: f.platform.inference,
            extensions: {
                ...f.platform.dotExtensions,
                tools: (t) => {
                    seen.push(t);
                    return tools?.(t) ?? f.platform.dotExtensions.tools(t);
                },
            },
            signals: { trigger: { kind: 'person', id: person } },
        });
        const messages = [
            {
                id: `m-${runId}`,
                role: 'user',
                content: 'Please go on.',
                metadata: senderMetadata({ id: person, name: person }),
            } as Message,
        ];
        agent.threadId = roomId;
        agent.setMessages(messages);
        const events = await lastValueFrom(
            f.platform.runner
                .run({
                    threadId: roomId,
                    agent,
                    input: {
                        threadId: roomId,
                        runId,
                        messages,
                        state: {},
                        tools: [],
                        context: [],
                        forwardedProps: {},
                    },
                })
                .pipe(toArray()),
            { defaultValue: [] },
        ).catch((): BaseEvent[] => []);
        await vi.waitFor(() => expect(f.platform.runner.activeRunId(roomId)).toBeUndefined());
        /** What a tool call of the turn returned, as the model got it. */
        const result = (toolCallId: string) =>
            String(
                (
                    events.find(
                        (event) =>
                            event.type === EventType.TOOL_CALL_RESULT &&
                            (event as { toolCallId?: string }).toolCallId === toolCallId,
                    ) as { content?: unknown } | undefined
                )?.content ?? '',
            );
        return { runId, seen, result, trace: f.platform.runner.runTrace(runId) };
    };
    const cycles = () =>
        f.workspace.db
            .prepare(
                'SELECT id, status, endReason, steps, actingUserId FROM work_cycles WHERE conversationId=? ORDER BY startedAt',
            )
            .all(roomId) as Array<{
            id: string;
            status: string;
            endReason: string | null;
            steps: number;
            actingUserId: string;
        }>;
    const requestOf = (userId: string) =>
        f.workspace.db
            .prepare(
                'SELECT id, status, outcome, cycleId, details FROM approval_requests WHERE userId=? AND threadId=? ORDER BY createdAt DESC',
            )
            .get(userId, roomId) as
            | {
                  id: string;
                  status: string;
                  outcome: string | null;
                  cycleId: string | null;
                  details: string;
              }
            | undefined;
    return {
        ...f,
        roomId,
        privateId,
        replies,
        bodies,
        executed,
        ask,
        turn,
        cycles,
        requestOf,
    };
}

it('gives every tool the sender’s access, keeps other people’s files out of it, and refuses a personal socio in a room', async () => {
    const f = await authority();
    // Ada's own file, in her data space; her screenshot from a turn in the
    // room.
    await f.platform.data.putFile(
        { kind: 'dot', userId: 'ada', dotId: f.company.id },
        'notes/ada-plans.txt',
        new TextEncoder().encode('ADA-FILE-CANARY'),
        'text/plain',
    );
    const shot = await f.platform.media.saveToolImage(
        { userId: 'ada', dotId: f.company.id, threadId: f.roomId },
        { name: 'screenshot-ada.png', bytes: PNG, width: 1, height: 1 },
    );

    // The model reads files and the room's attachments, in each turn.
    const reads = () =>
        f.replies.push(
            () =>
                calls(
                    ['c-files', 'files_list'],
                    ['c-get', 'files_get', { path: 'notes/ada-plans.txt' }],
                    ['c-attachments', 'attachments_list'],
                    ['c-view', 'attachments_view', { id: shot.id }],
                ),
            () => say('Here is what I found.'),
        );

    // Mo's turn: every module's tools get Mo, never Ada (the creator) or
    // anyone else.
    reads();
    const mo = await f.turn('mo');
    expect(mo.trace?.status).toBe('finished');
    expect(mo.seen.map((turn) => turn.userId)).toEqual(['mo']);
    expect(mo.trace?.trace?.cycle).toMatchObject({ actingUserId: 'mo' });
    for (const id of ['c-files', 'c-get', 'c-attachments', 'c-view']) {
        expect(mo.result(id), id).not.toBe('');
    }
    expect(mo.result('c-files')).not.toContain('ada-plans');
    expect(mo.result('c-get')).not.toContain('ADA-FILE-CANARY');
    // Ada's screenshot is hers: not listed, viewable or served to Mo.
    expect(mo.result('c-attachments')).not.toContain(shot.id);
    expect(mo.result('c-view')).toContain('error');
    const content = `/media/attachments/${shot.id}/content`;
    expect((await f.as('mo')(content)).status).toBe(404);
    expect((await f.as('ada')(content)).status).toBe(200);

    // Ada's own turn there reads her own, as the same tools.
    reads();
    const ada = await f.turn('ada');
    expect(ada.seen.map((turn) => turn.userId)).toEqual(['ada']);
    expect(ada.result('c-files')).toContain('ada-plans');
    expect(ada.result('c-get')).toContain('ADA-FILE-CANARY');
    expect(ada.result('c-attachments')).toContain(shot.id);
    expect(ada.result('c-view')).not.toContain('error');

    // People who may not send there start nothing: their turn fails with
    // the room's own reason, before any tool or model.
    const sent = f.bodies.length;
    for (const person of ['rex', 'ivy', 'olive', 'alice']) {
        const refused = await f.turn(person);
        expect(refused.trace?.status, person).toBe('failed');
        expect(refused.seen, person).toEqual([]);
    }
    expect(f.bodies.length).toBe(sent);

    // A personal socio, even made the room's lead behind the rules' back,
    // never runs there: not for a member, not for its owner.
    const personal = f.workspace.createDot(
        f.company.spaceId,
        'Bo',
        '',
        true,
        true,
        [f.company.spaceId],
        null,
        false,
        null,
        false,
        'mo',
    );
    f.workspace.db.prepare('UPDATE thread_bindings SET dotId=? WHERE id=?').run(personal.id, f.roomId);
    f.workspace.db
        .prepare(
            "INSERT INTO room_socios(roomId, dotId, status, requestedBy, authorizedBy, authorizedAt, updatedAt) VALUES (?, ?, 'active', 'ada', 'alice', 1, 1)",
        )
        .run(f.roomId, personal.id);
    const borrowed = await f.turn('mo', undefined, personal.id);
    expect(borrowed.trace?.status).toBe('failed');
    expect(borrowed.seen).toEqual([]);
    expect(f.bodies.length).toBe(sent);
});

it('lets only the requester see and decide a room approval, and carries on in the cycle that asked', async () => {
    const f = await authority();
    f.replies.push(
        () => call('call-1', 'read_private'),
        () => say('Waiting for Mo’s approval.'),
    );
    const asked = await f.turn('mo', (turn) => [f.ask(turn)]);
    expect(asked.trace?.status).toBe('finished');
    const cycleId = asked.trace!.trace!.cycle!.id;
    // The step waits for the decision rather than ending (CB-211's waiting).
    expect(f.cycles()).toEqual([expect.objectContaining({ id: cycleId, status: 'waiting', steps: 1 })]);
    const request = f.requestOf('mo')!;
    expect(request).toMatchObject({ status: 'pending', cycleId });
    // Its person is told where it was asked and who reads the reply.
    expect(JSON.parse(request.details)).toContainEqual(expect.stringContaining('Asked in the room “Launch”'));

    // Nobody else sees or decides it: not Ada (the room's creator and
    // admin), not a workspace admin, not anyone outside.
    for (const person of ['ada', 'alice', 'rex', 'nina']) {
        expect((await f.as(person)(`/approvals/${request.id}`)).status, person).toBe(404);
        expect(
            (
                await f.as(person)(`/approvals/${request.id}/decision`, 'POST', {
                    decision: 'approve',
                })
            ).status,
            person,
        ).toBe(404);
        const list = JSON.stringify(await (await f.as(person)('/approvals')).json());
        expect(list, person).not.toContain('MO-SUMMARY-CANARY');
    }
    expect(f.executed).toEqual([]);
    // The room sees a safe status, never the request or its payload.
    const forAda = JSON.stringify(await (await f.as('ada')(`/conversations/${f.roomId}/history`)).json());
    expect(forAda).toContain('waiting_for_approval');
    expect(forAda).not.toContain('MO-SUMMARY-CANARY');
    expect(forAda).not.toContain('MO-PAYLOAD-CANARY');
    const forMo = JSON.stringify(await (await f.as('mo')(`/approvals/${request.id}`)).json());
    expect(forMo).toContain('MO-SUMMARY-CANARY');

    // Mo approves: it runs as Mo, and the socio carries on in the same
    // cycle, one more step, as Mo.
    f.replies.push(() => say('Carried on.'));
    const decided = await f.as('mo')(`/approvals/${request.id}/decision`, 'POST', { decision: 'approve' });
    expect(decided.status).toBe(200);
    expect(f.executed).toEqual(['mo']);
    await vi.waitFor(
        async () =>
            expect(
                (
                    (await (await f.as('mo')(`/approvals/${request.id}`)).json()) as {
                        continuation: { status: string };
                    }
                ).continuation.status,
            ).toBe('done'),
        { timeout: 10_000, interval: 20 },
    );
    expect(f.cycles()).toEqual([
        expect.objectContaining({
            id: cycleId,
            status: 'ended',
            endReason: 'completed',
            steps: 2,
            actingUserId: 'mo',
        }),
    ]);
});

it('shares the cycle’s budget: a decision never carries on past what the cycle had left', async () => {
    const f = await authority();
    f.replies.push(
        () => call('call-1', 'read_private'),
        () => say('Waiting.'),
    );
    const asked = await f.turn('mo', (turn) => [f.ask(turn)]);
    const cycleId = asked.trace!.trace!.cycle!.id;
    // The cycle spent its tokens before it waited.
    f.workspace.db
        .prepare("UPDATE work_cycles SET tokensUsed = json_extract(limits, '$.cycleTokens') WHERE id=?")
        .run(cycleId);
    const request = f.requestOf('mo')!;
    const sent = f.bodies.length;
    expect(
        (
            await f.as('mo')(`/approvals/${request.id}/decision`, 'POST', {
                decision: 'approve',
            })
        ).status,
    ).toBe(200);
    await vi.waitFor(
        async () =>
            expect(
                (
                    (await (await f.as('mo')(`/approvals/${request.id}`)).json()) as {
                        continuation: { status: string };
                    }
                ).continuation.status,
            ).toBe('failed'),
        { timeout: 10_000, interval: 20 },
    );
    // No fresh cycle, no model call: the cycle ended at its limit.
    expect(f.cycles()).toEqual([
        expect.objectContaining({
            id: cycleId,
            status: 'ended',
            endReason: 'tokens',
        }),
    ]);
    expect(f.bodies.length).toBe(sent);
});

it('ends a cycle at once when every request it waited for expires, not at the week’s tidy-up (CB-212)', async () => {
    const f = await authority();
    f.replies.push(
        () => call('call-1', 'read_private'),
        () => say('Waiting.'),
    );
    const asked = await f.turn('mo', (turn) => [f.ask(turn)]);
    const cycleId = asked.trace!.trace!.cycle!.id;
    expect(f.cycles()).toEqual([expect.objectContaining({ id: cycleId, status: 'waiting' })]);
    const sent = f.bodies.length;
    // Its only request runs out: nothing carries the cycle on, so it ends.
    expect(await f.platform.approvals.expire(Date.now() + 8 * 86_400_000)).toBe(1);
    await vi.waitFor(() =>
        expect(f.cycles()).toEqual([
            expect.objectContaining({
                id: cycleId,
                status: 'ended',
                endReason: 'expired',
            }),
        ]),
    );
    expect(f.requestOf('mo')).toMatchObject({ status: 'expired' });
    expect(f.bodies.length).toBe(sent);

    // Ended with its person leaving the room: the same, at once.
    f.replies.push(
        () => call('call-2', 'read_private'),
        () => say('Waiting again.'),
    );
    const again = await f.turn('mo', (turn) => [f.ask(turn)]);
    const second = again.trace!.trace!.cycle!.id;
    expect(f.cycles().find((cycle) => cycle.id === second)?.status).toBe('waiting');
    expect((await f.as('mo')(`/rooms/${f.roomId}/leave`, 'POST')).status).toBe(200);
    await vi.waitFor(() =>
        expect(f.cycles().find((cycle) => cycle.id === second)).toMatchObject({
            status: 'ended',
            endReason: 'expired',
        }),
    );
});

it('keeps a cycle waiting while one of its requests is decided and not yet carried on', async () => {
    const f = await authority();
    f.replies.push(
        () => call('call-1', 'read_private'),
        () => say('Waiting.'),
    );
    const asked = await f.turn('mo', (turn) => [f.ask(turn)]);
    const cycleId = asked.trace!.trace!.cycle!.id;
    // A settle that finds the request still pending changes nothing.
    expect(await f.platform.cycles.settleWaiting(f.roomId)).toBe(0);
    expect(f.cycles()).toEqual([expect.objectContaining({ id: cycleId, status: 'waiting' })]);
});

it('ends a request when its person leaves the room, re-checks it while Rooms is off, and as it runs', async () => {
    const f = await authority();
    f.replies.push(
        () => call('call-1', 'read_private'),
        () => say('Waiting.'),
    );
    await f.turn('mo', (turn) => [f.ask(turn)]);
    const request = f.requestOf('mo')!;
    const sent = f.bodies.length;

    // Rooms switched off: the room is read-only, so the request can't be
    // decided for now, and stays.
    f.store.updateSettings({ rooms: { enabled: false } });
    const off = await f.as('mo')(`/approvals/${request.id}/decision`, 'POST', {
        decision: 'approve',
    });
    expect(off.status).toBe(409);
    expect(((await off.json()) as { error: string }).error).toBe(ROOM_APPROVAL_GONE);
    expect(f.requestOf('mo')).toMatchObject({ status: 'pending' });
    f.store.updateSettings({ rooms: { enabled: true } });

    // Mo leaves: what he was asked there ends at once, nothing runs.
    expect((await f.as('mo')(`/rooms/${f.roomId}/leave`, 'POST')).status).toBe(200);
    expect(f.requestOf('mo')).toMatchObject({
        status: 'expired',
        outcome: ROOM_APPROVAL_GONE,
    });
    expect(
        (
            await f.as('mo')(`/approvals/${request.id}/decision`, 'POST', {
                decision: 'approve',
            })
        ).status,
    ).toBe(409);
    expect(f.executed).toEqual([]);
    expect(f.bodies.length).toBe(sent);

    // An action is checked again as it runs: Ada, removed behind the
    // rules' back, with a policy that runs her requests at once.
    await f.platform.approvals.setPolicy('ada', f.company.id, CAPABILITY, 'bypass');
    f.workspace.db.prepare("UPDATE room_members SET status='removed' WHERE roomId=? AND userId='ada'").run(f.roomId);
    await expect(
        f.platform.approvals.request({
            userId: 'ada',
            dotId: f.company.id,
            capability: CAPABILITY,
            summary: 'Read it',
            payload: { secret: 'ADA' },
            threadId: f.roomId,
        }),
    ).rejects.toThrow(ROOM_APPROVAL_GONE);
    expect(f.executed).toEqual([]);
    expect(f.requestOf('ada')).toMatchObject({ status: 'failed' });
});

it('reports a long run in a room as the person who started it, while they may still send there', async () => {
    const f = await authority();
    // A socio's turn, as the graph's steps reach it: `AppTurns`.
    const turns = vi.spyOn(appTurns(f), 'turnOutcome').mockResolvedValue({ text: '' } as TurnOutcome);
    vi.spyOn(f.platform.approvals, 'recordNote').mockResolvedValue(undefined);
    vi.spyOn(f.platform.longRuns, 'reported').mockResolvedValue(undefined as never);
    vi.spyOn(f.platform.longRuns, 'view').mockRejectedValue(new Error('none'));
    vi.spyOn(f.platform.jobs, 'job').mockRejectedValue(new Error('none'));
    const row = (userId: string, threadId: string) =>
        ({
            id: `long-${userId}`,
            userId,
            dotId: f.company.id,
            threadId,
            jobId: 'job',
            status: 'done',
            outcome: 'Done.',
        }) as unknown as Parameters<typeof f.platform.longRunReports.report>[0];
    await f.platform.longRunReports.report(row('mo', f.roomId));
    expect(turns).toHaveBeenCalledTimes(1);
    // Its trigger is Mo (a room turn is a person's), acting as Mo.
    expect(turns.mock.calls[0]?.[3]).toMatchObject({
        actingUserId: 'mo',
        trigger: { kind: 'person', id: 'mo' },
    });
    // In a private chat the job's end still starts it (CB-185).
    await f.platform.longRunReports.report(row('olive', f.privateId));
    expect(turns.mock.calls[1]?.[3]).toMatchObject({
        trigger: { kind: 'system' },
    });
});
