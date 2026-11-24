import { afterEach, describe, expect, it, vi } from 'vitest';

import { runFacts } from '@socio/foundation/operations/run-facts';
import { ROOM_USAGE_MIN_PEOPLE, type RoomLimits, type RoomUsageView, type RoomView } from '@socio/shared/rooms/rooms';
import { SENDER_METADATA } from '@socio/shared/types';

import type { WorkCycle } from '../src/server/cycles/contract.js';
import { cycleUsage, roomUsage } from '../src/server/rooms/usage.js';

import { completion } from './fixtures/model-stream.js';
import { matrixChats, roomsFixture } from './fixtures/rooms.js';

// CB-218: a room's use and limits for its people. Room admins always see
// them; members only when an admin turns it on in Settings → Rooms (over
// ROOMS_BUDGET_VISIBLE); spend on another member's own subscription is
// never shown as an amount; a day's total only once enough people wrote
// that it singles nobody out.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const LIMITS: RoomLimits = {
    cycleTimeMs: 600_000,
    cycleTokens: 2_000_000,
    messagesPerMinute: 20,
    maxQueued: 10,
    handoffsPerCycle: 4,
    cycleSpendUsd: null,
};
const NOW = Date.UTC(2026, 9, 20, 12);

const cycle = (fields: Partial<WorkCycle> & { by: string }): WorkCycle => ({
    id: `c-${fields.by}-${fields.startedAt ?? NOW}`,
    conversationId: 'room-1',
    kind: 'room',
    dispatchKey: null,
    initiator: { kind: 'person', id: fields.by },
    actingUserId: fields.by,
    dotId: 'socio-a',
    dotOwnerId: null,
    billing: { kind: 'workspace' },
    status: 'ended',
    runId: null,
    hop: 0,
    steps: 1,
    limits: LIMITS,
    startedAt: NOW - 60_000,
    elapsedMs: 30_000,
    stepStartedAt: null,
    deadlineAt: null,
    tokensReserved: 0,
    tokensUsed: 1000,
    costUsd: 0.02,
    costKnown: true,
    handoffs: 0,
    unstopped: [],
    endedAt: NOW - 30_000,
    endReason: 'completed',
    updatedAt: NOW,
    ...fields,
});

describe('what a room’s people see of a cycle', () => {
    it('shows spend only when the workspace paid or it is the reader’s own', () => {
        const own = cycle({
            by: 'mo',
            billing: { kind: 'person', userId: 'mo' },
            costUsd: 0.5,
        });
        expect(cycleUsage(own, 'mo')).toMatchObject({
            mine: true,
            spend: 'known',
            spendUsd: 0.5,
        });
        // Another member's own subscription: theirs, never an amount.
        expect(cycleUsage(own, 'ada')).toMatchObject({
            mine: false,
            spend: 'private',
            spendUsd: null,
        });
        expect(cycleUsage(cycle({ by: 'mo' }), 'ada')).toMatchObject({
            spend: 'known',
            spendUsd: 0.02,
        });
        // Unknown is unknown, not 0.
        expect(cycleUsage(cycle({ by: 'mo', costUsd: null, costKnown: false }), 'ada')).toMatchObject({
            spend: 'unknown',
            spendUsd: null,
        });
        expect(cycleUsage(cycle({ by: 'mo', endReason: 'tokens' }), 'ada')).toMatchObject({
            stoppedBy: 'tokens',
            tokenLimit: 2_000_000,
        });
    });

    it('totals the day only once enough people started cycles', () => {
        const two = [cycle({ by: 'ada' }), cycle({ by: 'mo', endReason: 'deadline' })];
        const view = roomUsage({
            limits: LIMITS,
            current: two[0],
            recent: two,
            viewer: 'ada',
            now: NOW,
        });
        expect(ROOM_USAGE_MIN_PEOPLE).toBe(3);
        expect(view.day).toBeNull();
        expect(view.current).toMatchObject({ mine: true });
        const three = [...two, cycle({ by: 'carol', tokensUsed: 500 })];
        expect(
            roomUsage({
                limits: LIMITS,
                current: undefined,
                recent: [
                    ...three,
                    // Older than a day: not in the day.
                    cycle({ by: 'zed', startedAt: NOW - 2 * 86_400_000 }),
                ],
                viewer: 'ada',
                now: NOW,
            }),
        ).toEqual({
            limits: LIMITS,
            current: null,
            day: {
                since: NOW - 86_400_000,
                cycles: 3,
                tokens: 2500,
                stopped: { deadline: 1, tokens: 0, handoffs: 0, spend: 0 },
            },
        });
    });
});

it('shows a room’s use to its admins, and to members only when Settings lets them', async () => {
    const f = await roomsFixture(cleanup, {
        config: {
            baseUrl: 'https://model.invalid/v1',
            apiKey: 'unused',
            model: 'test-model',
        },
    });
    const { roomId } = await matrixChats(f);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // The model's endpoint is answered here; nothing leaves the process.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const body = String(init?.body ?? '');
        if (body.includes('Write a short title')) {
            return Response.json({ choices: [{ message: { content: '"T."' } }] });
        }
        return completion({ role: 'assistant', content: 'Noted.' }, 'stop', {
            prompt_tokens: 120,
            completion_tokens: 8,
        });
    });
    const send = async (person: string, id: string) => {
        const response = await f.platform.handle(
            new Request(`http://localhost/api/copilotkit/agent/${f.company.id}/run`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    threadId: roomId,
                    runId: `run-${id}`,
                    messages: [
                        {
                            id,
                            role: 'user',
                            content: 'Plan the launch.',
                            metadata: { [SENDER_METADATA]: person },
                        },
                    ],
                    tools: [],
                    context: [],
                    state: {},
                    forwardedProps: {},
                }),
            }),
            person,
        );
        await response.text();
        expect(response.status).toBe(200);
        await vi.waitFor(async () => expect(await f.platform.runner.isRunning({ threadId: roomId })).toBe(false));
    };
    await send('ada', 'm-ada');
    await send('mo', 'm-mo');

    // Each turn's facts: the room, its cycle, and the sender as acting
    // person; the workspace's model paid.
    for (const person of ['ada', 'mo']) {
        const run = f.platform.runner
            .recentRuns({ only: [roomId] })
            .find((row) => row.trigger?.kind === 'person' && row.trigger.id === person)!;
        const stored = f.platform.runner.runTrace(run.runId)!;
        const facts = runFacts({
            seq: 1,
            runId: run.runId,
            threadId: roomId,
            status: 'finished',
            source: 'web',
            startedAt: run.startedAt,
            finishedAt: run.finishedAt ?? null,
            trace: JSON.stringify(stored.trace),
            events: '[]',
            socioId: f.company.id,
            ownerId: `room:${roomId}`,
            chatKind: 'room',
            createdBy: 'ada',
        });
        expect(facts.turn).toMatchObject({
            containerKind: 'room',
            triggerId: person,
            actingId: person,
            payerKind: 'workspace',
            payerId: null,
            socioId: f.company.id,
        });
        expect(facts.turn.cycleId).toBe(stored.trace!.cycle!.id);
    }

    const ada = f.as('ada');
    const mo = f.as('mo');
    // Off by default: Ada, the room's admin, sees it; Mo doesn't.
    const viewOf = async (call: typeof ada) => (await (await call(`/rooms/${roomId}`)).json()) as RoomView;
    expect((await viewOf(ada)).usageVisible).toBe(true);
    expect((await viewOf(mo)).usageVisible).toBe(false);
    const hidden = await mo(`/rooms/${roomId}/usage`);
    expect(hidden.status).toBe(403);
    expect(await hidden.json()).toMatchObject({ code: 'usage_hidden' });
    expect((await mo(`/rooms/${roomId}/limits`)).status).toBe(403);
    const seen = await ada(`/rooms/${roomId}/usage`);
    expect(seen.status).toBe(200);
    const usage = (await seen.json()) as RoomUsageView;
    expect(usage.limits.cycleTokens).toBeGreaterThan(0);
    // The last cycle is Mo's: Ada sees its use, the workspace's model paid.
    expect(usage.current).toMatchObject({
        status: 'ended',
        mine: false,
        tokenLimit: usage.limits.cycleTokens,
    });
    expect(usage.current!.tokensUsed).toBeGreaterThan(0);
    expect(usage.current!.spend).not.toBe('private');
    // Two people: no day's total, which would show one person's use.
    expect(usage.day).toBeNull();
    // Nothing of the conversation in it.
    expect(JSON.stringify(usage)).not.toContain('Plan the launch');
    expect(JSON.stringify(usage)).not.toContain('Noted');

    // Someone outside the room learns nothing, as for a room not there.
    const stranger = await f.as('nina')(`/rooms/${roomId}/usage`);
    const nowhere = await f.as('nina')('/rooms/no-such-room/usage');
    expect(stranger.status).toBe(404);
    expect({ status: stranger.status, body: await stranger.text() }).toEqual({
        status: nowhere.status,
        body: await nowhere.text(),
    });

    // A workspace admin shows it to members.
    expect(
        (
            await f.as('alice')('/settings', 'PATCH', {
                rooms: { budgetVisible: true },
            })
        ).status,
    ).toBe(200);
    expect((await viewOf(mo)).usageVisible).toBe(true);
    const shown = await mo(`/rooms/${roomId}/usage`);
    expect(shown.status).toBe(200);
    expect(((await shown.json()) as RoomUsageView).current).toMatchObject({
        mine: true,
    });
    expect((await mo(`/rooms/${roomId}/limits`)).status).toBe(200);
    // Rooms are still on: the switch beside it kept its value.
    expect(
        (
            (await (await mo('/state')).json()) as {
                settings: { rooms: unknown };
            }
        ).settings.rooms,
    ).toEqual({ enabled: true, budgetVisible: true });
});
