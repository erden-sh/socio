import type { DatabaseSync } from 'node:sqlite';

import { EventType, type BaseEvent } from '@ag-ui/client';
import { afterEach, expect, it } from 'vitest';

import type { HistoryPage } from '@socio/shared/chat/chat-history';
import { transcriptProblem } from '@socio/shared/rooms/room-view';
import { ROOM_DISCLOSURE_VERSION } from '@socio/shared/rooms/rooms';
import { TURN_FAILURE_MESSAGES, timeLimitMessage } from '@socio/shared/turn-failures';
import type { TranscriptTurnProblem } from '@socio/shared/types';

import { roomsFixture } from './fixtures/rooms.js';

// CB-406: a failed run in a chat's or room's history (the cold page and
// the `after` pull the phone syncs) carries why it failed, `failure`: the
// code the web reads back from the room's transcript (`turnFailureKind`),
// so the phone needn't read `/transcript` to word it. A run that didn't
// fail has none, nor does one whose error is no fixed text (stored before
// it had one); runs stored before CB-406 get it from their events.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const json = async <T>(response: Response | Promise<Response>) => {
    const answer = await response;
    expect(answer.ok).toBe(true);
    return (await answer.json()) as T;
};

const turn = (threadId: string, runId: string, n: number, end: Record<string, unknown>[]) =>
    [
        {
            type: EventType.RUN_STARTED,
            threadId,
            runId,
            input: { messages: [{ id: `${runId}-u`, role: 'user', content: `Q${n}` }] },
        },
        { type: EventType.TEXT_MESSAGE_START, messageId: `${runId}-a`, role: 'assistant' },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: `${runId}-a`, delta: `A${n}` },
        { type: EventType.TEXT_MESSAGE_END, messageId: `${runId}-a` },
        ...end,
    ] as BaseEvent[];

const error = (message: string, code?: string) => ({ type: EventType.RUN_ERROR, message, ...(code ? { code } : {}) });

it('carries a failed run’s code in a room’s history and its pulls, as the transcript words it', async () => {
    const f = await roomsFixture(cleanup);
    const ada = f.as('ada');
    const ivy = f.as('ivy');
    const { id } = await json<{ id: string }>(ada('/rooms', 'POST', { dotId: f.company.id, title: 'Launch' }));
    await ada(`/rooms/${id}/invites`, 'POST', { userId: 'ivy' });
    await json(ivy(`/rooms/${id}/accept`, 'POST', { disclosureVersion: ROOM_DISCLOSURE_VERSION }));
    const db = (f.platform.runner as unknown as { db: DatabaseSync }).db;
    let at = 1;
    const insert = (runId: string, status: string, end: Record<string, unknown>[]) =>
        db
            .prepare(
                'INSERT INTO agent_runs(threadId, runId, status, events, startedAt, finishedAt) VALUES (?, ?, ?, ?, ?, ?)',
            )
            .run(id, runId, status, JSON.stringify(turn(id, runId, at, end)), at, ++at);

    insert('ok', 'finished', [{ type: EventType.RUN_FINISHED, threadId: id, runId: 'ok' }]);
    insert('tokens', 'failed', [error(TURN_FAILURE_MESSAGES.cycle_tokens, 'cycle_tokens')]);
    insert('limit', 'interrupted', [error(timeLimitMessage(120_000), 'time_limit')]);
    // Stored before its error had a fixed text, with no code.
    insert('old', 'failed', [error('The model failed.')]);
    insert('stopped', 'stopped', [{ type: EventType.RUN_FINISHED, threadId: id, runId: 'stopped' }]);

    const failures = (page: HistoryPage) => Object.fromEntries(page.runs.map((run) => [run.runId, run.failure]));
    const expected = { ok: undefined, tokens: 'cycle_tokens', limit: 'time_limit', old: undefined, stopped: undefined };
    for (const reader of [ada, ivy]) {
        const cold = await json<HistoryPage>(reader(`/conversations/${id}/history`));
        expect(failures(cold)).toEqual(expected);
        // No field at all where there is no code: older clients see what they did.
        expect(cold.runs.filter((run) => 'failure' in run).map((run) => run.runId)).toEqual(['tokens', 'limit']);
        // The pull after a cursor (the delta) says the same.
        const pulled = await json<HistoryPage>(reader(`/conversations/${id}/history?after=0`));
        expect(failures(pulled)).toEqual(expected);
        const tail = await json<HistoryPage>(reader(`/conversations/${id}/history?after=${cold.runs[1].seq}`));
        expect(tail.runs.map((run) => [run.runId, run.failure])).toEqual([
            ['limit', 'time_limit'],
            ['old', undefined],
            ['stopped', undefined],
        ]);
        // The same code the web reads back from the room's transcript.
        const { problems } = await json<{ problems: TranscriptTurnProblem[] }>(
            reader(`/conversations/${id}/transcript`),
        );
        expect(Object.fromEntries(problems.map((problem) => [problem.runId, transcriptProblem(problem).code]))).toEqual(
            { tokens: 'cycle_tokens', limit: 'time_limit', old: undefined },
        );
    }
});

it('carries it in a private chat’s history too', async () => {
    const f = await roomsFixture(cleanup);
    f.workspace.bindThread('mine', f.company.id, 'Mine', 'ada');
    const db = (f.platform.runner as unknown as { db: DatabaseSync }).db;
    db.prepare(
        'INSERT INTO agent_runs(threadId, runId, status, events, startedAt, finishedAt) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
        'mine',
        'spent',
        'failed',
        JSON.stringify(turn('mine', 'spent', 1, [error(TURN_FAILURE_MESSAGES.cycle_spend)])),
        1,
        2,
    );
    const page = await json<HistoryPage>(f.as('ada')('/conversations/mine/history'));
    expect(page.runs.map((run) => run.failure)).toEqual(['cycle_spend']);
});
