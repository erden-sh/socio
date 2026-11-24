import { afterEach, expect, it, vi } from 'vitest';

import type { DotTurn } from '@socio/foundation/turns/turn';
import { approvalCardId } from '@socio/shared/approvals';
import type { GoalView } from '@socio/shared/schedule-types';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { scheduleDetailView } from '../src/server/schedules/detail.js';
import { turnGoal } from '../src/server/schedules/goal-tools.js';
import { goalPrompt } from '../src/server/schedules/goals.js';
import { scheduledTaskExecutor } from '../src/server/schedules/scheduled.js';

import { completion } from './fixtures/model-stream.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function fixture() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { store, workspace, platform, dispose } = await makeTestRuntime({
        config: {
            apiKey: 'fixture',
            model: 'custom-model',
            baseUrl: 'https://unused.invalid/v1',
            runtimeUrl: '',
        },
    });
    cleanup.push(dispose);
    for (const user of DEFAULT_MOCK_USERS) {
        workspace.recordUser(user);
    }
    const dot = workspace.updateDot(workspace.dots()[0]!.id, {
        ...workspace.dots()[0]!,
        issuesAllowed: true,
    });
    const chat = workspace.bindThread('chat', dot.id, 'Chat', 'alice');
    const turn = (extra: Partial<DotTurn> = {}): DotTurn => ({
        dot: workspace.dot(dot.id)!,
        userId: 'alice',
        threadId: chat.id,
        channel: false,
        purpose: 'chat',
        check: () => {},
        signal: new AbortController().signal,
        toolNames: () => [],
        ...extra,
    });
    const tool = (name: string, extra: Partial<DotTurn> = {}) => {
        const found = platform.dotExtensions.tools(turn(extra)).find((item) => item.name === name) as unknown as
            | { execute: (input: unknown) => Promise<Record<string, unknown>> }
            | undefined;
        if (!found) {
            throw new Error(`No tool ${name}`);
        }
        return (input: unknown) => found.execute(input);
    };
    const bypass = (userId = 'alice', dotId = dot.id) =>
        platform.approvals.setPolicy(userId, dotId, 'goal.set', 'bypass');
    const goalInput = {
        title: 'Keep the onboarding doc current',
        detail: 'Check it against the latest release notes.',
        cadence: 'every day at 09:00',
    };
    return { store, workspace, platform, dot, chat, tool, bypass, goalInput };
}

it('asks the person before a goal starts, and sets nothing until then', async () => {
    const f = await fixture();
    const result = await f.tool('goal_set')(f.goalInput);
    expect(result).toMatchObject({ status: 'pending_approval' });
    // The chat shows it as an approval card (CB-131).
    expect(approvalCardId(result)).toBe(result.id);
    expect(await f.platform.goals.list('alice')).toEqual([]);
    expect(await f.platform.schedules.list('alice')).toEqual([]);
});

it('returns the goal already waiting for approval, not a second request', async () => {
    const f = await fixture();
    const first = await f.tool('goal_set')(f.goalInput);
    // The same goal, worded with other spacing.
    const again = await f.tool('goal_set')({
        ...f.goalInput,
        title: `  ${f.goalInput.title}  `,
    });
    expect(again).toMatchObject({ status: 'pending_approval', id: first.id });
    expect(await f.platform.approvals.list('alice', { status: 'pending' })).toHaveLength(1);
    // A different goal is its own request.
    const other = await f.tool('goal_set')({ ...f.goalInput, title: 'Other' });
    expect(other.id).not.toBe(first.id);
    // Once approved it is an active goal, so asking again shows it (CB-135);
    // with force it is a new request.
    // The decision's continuation turn (CB-58) gets a fake model's answer.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => completion({ role: 'assistant', content: 'Ok.' }));
    await f.platform.approvals.decide(String(first.id), 'alice', true);
    expect(await f.tool('goal_set')(f.goalInput)).toMatchObject({
        outcome: 'possible_duplicates',
    });
    const later = await f.tool('goal_set')({ ...f.goalInput, force: true });
    expect(later.id).not.toBe(first.id);
    expect(await f.platform.approvals.list('alice', { status: 'pending' })).toHaveLength(2);
});

it('keeps the pending goal of one person from another’s', async () => {
    const f = await fixture();
    const first = await f.tool('goal_set')(f.goalInput);
    const bobs = await f.platform.goals.propose('bob', f.dot.id, f.goalInput);
    expect(bobs).toMatchObject({ status: 'pending_approval' });
    expect((bobs as { id: string }).id).not.toBe(first.id);
});

it('sets an approved goal on a schedule of its own, in a conversation the person owns', async () => {
    const f = await fixture();
    await f.bypass();
    const result = await f.tool('goal_set')(f.goalInput);
    expect(result).toMatchObject({ status: 'approved' });
    const [goal] = (await f.platform.goals.list('alice', f.dot.id)) as [GoalView];
    expect(goal).toMatchObject({
        id: expect.stringMatching(/^G-[0-9a-f]{8}$/),
        title: 'Keep the onboarding doc current',
        status: 'active',
        progress: null,
        cadence: 'every day at 09:00',
    });
    const schedule = await f.platform.schedules.get('alice', goal.scheduleId);
    expect(schedule.title).toBe('Goal: Keep the onboarding doc current');
    expect(schedule.prompt).toBe(goalPrompt({ id: goal.id, title: goal.title, detail: goal.detail }));
    expect(f.workspace.thread(goal.threadId!)).toMatchObject({
        ownerId: 'alice',
        dotId: f.dot.id,
    });
    expect(await f.platform.goals.byTask(goal.scheduleId)).toEqual({
        id: goal.id,
        userId: 'alice',
        dotId: f.dot.id,
    });
    // Someone else sees none of it, and can't change it.
    expect(await f.platform.goals.list('bob')).toEqual([]);
    await expect(f.platform.goals.update('bob', f.dot.id, goal.id, { status: 'done' })).rejects.toThrow(
        'Goal not found.',
    );
});

it('runs a goal’s turn as its person, and what the socio files carries the goal', async () => {
    const f = await fixture();
    await f.bypass();
    await f.tool('goal_set')(f.goalInput);
    const [goal] = (await f.platform.goals.list('alice')) as [GoalView];
    const call = (name: string, args: unknown) =>
        completion(
            {
                role: 'assistant',
                tool_calls: [
                    {
                        index: 0,
                        id: name,
                        type: 'function',
                        function: { name, arguments: JSON.stringify(args) },
                    },
                ],
            },
            'tool_calls',
        );
    // Title requests get a title; the turn's model calls follow the script.
    const script = [
        call('file_improvement', {
            title: 'Release notes lack an upgrade section',
            kind: 'improvement',
            problem: 'The onboarding doc can’t say how to upgrade.',
        }),
        call('goal_update', { progress: 'Filed the missing upgrade notes.' }),
        completion({ role: 'assistant', content: 'Done.' }),
    ];
    const bodies: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const body = String(init?.body);
        if (body.includes('Write a short title')) {
            return Response.json({ choices: [{ message: { content: 'Title' } }] });
        }
        bodies.push(body);
        return script.shift() ?? completion({ role: 'assistant', content: 'Ok.' });
    });
    const schedule = await f.platform.schedules.get('alice', goal.scheduleId);
    const claim = (await f.store.claim(schedule.nextRunAt! + 1000))!;
    expect(claim.id).toBe(goal.scheduleId);
    await scheduledTaskExecutor(f.platform, () => true)(claim, [], new AbortController().signal, () => {});
    expect(bodies[0]).toContain(goal.id);
    const issue = (await f.platform.board.issues.get(1))!;
    expect(await f.platform.board.filings.filing(issue.id)).toMatchObject({
        dotId: f.dot.id,
        dotOwnerId: null,
        userId: 'alice',
        trigger: 'goal',
        causeId: goal.id,
    });
    expect(await f.platform.goals.get('alice', goal.id)).toMatchObject({
        progress: 'Filed the missing upgrade notes.',
        status: 'active',
    });
});

it('shows a goal’s schedule in full: its progress, and each run’s answer, turn and filings (CB-88)', async () => {
    const f = await fixture();
    await f.bypass();
    await f.tool('goal_set')(f.goalInput);
    const [goal] = (await f.platform.goals.list('alice')) as [GoalView];
    const call = (name: string, args: unknown) =>
        completion(
            {
                role: 'assistant',
                tool_calls: [
                    {
                        index: 0,
                        id: name,
                        type: 'function',
                        function: { name, arguments: JSON.stringify(args) },
                    },
                ],
            },
            'tool_calls',
        );
    const script = [
        call('file_improvement', {
            title: 'Release notes lack an upgrade section',
            kind: 'improvement',
            problem: 'The onboarding doc can’t say how to upgrade.',
        }),
        call('goal_update', { progress: 'Filed the missing upgrade notes.' }),
        completion({ role: 'assistant', content: '**Done**: filed CB-1.' }),
    ];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
        String(init?.body).includes('Write a short title')
            ? Response.json({ choices: [{ message: { content: 'Title' } }] })
            : (script.shift() ?? completion({ role: 'assistant', content: 'Ok.' })),
    );
    // Run now, as the person would from the page.
    await f.platform.schedules.act('alice', goal.scheduleId, 'run');
    const claim = (await f.store.claim())!;
    expect(claim.id).toBe(goal.scheduleId);
    const result = await scheduledTaskExecutor(f.platform, () => true)(
        claim,
        [],
        new AbortController().signal,
        () => {},
    );
    await f.store.finish(claim, result);
    const detail = await scheduleDetailView(f.platform, 'alice', goal.scheduleId);
    expect(detail.goal).toMatchObject({
        id: goal.id,
        title: 'Keep the onboarding doc current',
        progress: 'Filed the missing upgrade notes.',
    });
    // The turn links to its first message, the goal's prompt.
    const prompt = (await f.platform.runner.messages(goal.threadId!)).find((message) => message.role === 'user')!;
    expect(detail.runs).toEqual([
        expect.objectContaining({
            status: 'completed',
            summary: 'Done: filed CB-1.',
            turnPath: `/chats/${goal.threadId}#message-${prompt.id}`,
            board: [
                {
                    issue: 'CB-1',
                    title: 'Release notes lack an upgrade section',
                    action: 'create',
                },
            ],
        }),
    ]);
    expect(detail.moreRuns).toBe(false);
    // Nobody else's.
    await expect(scheduleDetailView(f.platform, 'bob', goal.scheduleId)).rejects.toThrow('Schedule not found.');
});

it('knows a turn’s goal only from its task, for that person and socio', async () => {
    const f = await fixture();
    await f.bypass();
    await f.tool('goal_set')(f.goalInput);
    const [goal] = (await f.platform.goals.list('alice')) as [GoalView];
    const base = {
        dot: f.workspace.dot(f.dot.id)!,
        threadId: goal.threadId!,
        channel: false,
        check: () => {},
        signal: new AbortController().signal,
        toolNames: () => [],
    };
    const cause = { kind: 'schedule' as const, id: goal.scheduleId };
    expect(
        (
            await turnGoal(f.platform.goals, {
                ...base,
                userId: 'alice',
                purpose: 'scheduled',
                cause,
            })
        )?.id,
    ).toBe(goal.id);
    expect(
        await turnGoal(f.platform.goals, {
            ...base,
            userId: 'bob',
            purpose: 'scheduled',
            cause,
        }),
    ).toBeUndefined();
    expect(
        await turnGoal(f.platform.goals, {
            ...base,
            userId: 'alice',
            purpose: 'chat',
        }),
    ).toBeUndefined();
});

it('follows its schedule when paused, and ends it when done', async () => {
    const f = await fixture();
    await f.bypass();
    await f.tool('goal_set')(f.goalInput);
    const [goal] = (await f.platform.goals.list('alice')) as [GoalView];
    await f.platform.schedules.act('alice', goal.scheduleId, 'pause');
    expect((await f.platform.goals.get('alice', goal.id))?.status).toBe('paused');
    await f.platform.schedules.act('alice', goal.scheduleId, 'resume');
    expect((await f.platform.goals.get('alice', goal.id))?.status).toBe('active');
    const done = await f.tool('goal_update')({
        goalId: goal.id,
        status: 'done',
        progress: 'Up to date with 1.4.',
    });
    expect(done).toMatchObject({ status: 'done', closedAt: expect.any(Number) });
    expect((await f.platform.schedules.get('alice', goal.scheduleId)).status).toBe('cancelled');
    expect(await f.tool('goal_update')({ goalId: goal.id })).toEqual({
        error: 'This goal is done.',
        code: 'http_409',
    });
    // Canceling the schedule elsewhere cancels the goal.
    await f.tool('goal_set')({ ...f.goalInput, title: 'Second goal' });
    const second = (await f.platform.goals.list('alice')).find((item) => item.title === 'Second goal')!;
    await f.platform.schedules.act('alice', second.scheduleId, 'cancel');
    expect((await f.platform.goals.get('alice', second.id))?.status).toBe('cancelled');
});

it('sets a goal on a person’s own socio only for that person', async () => {
    const f = await fixture();
    const own = f.workspace.createDot(
        f.workspace.spaces()[0]!.id,
        'Bob’s helper',
        'Help Bob.',
        false,
        false,
        undefined,
        null,
        false,
        null,
        false,
        'bob',
    );
    await f.bypass('bob', own.id);
    await expect(f.platform.goals.propose('alice', own.id, f.goalInput)).rejects.toThrow('The socio no longer exists.');
    const outcome = await f.platform.goals.propose('bob', own.id, f.goalInput);
    expect(outcome).toMatchObject({ status: 'approved' });
    const [goal] = (await f.platform.goals.list('bob', own.id)) as [GoalView];
    expect(f.workspace.thread(goal.threadId!)?.ownerId).toBe('bob');
});

it('ends a goal met in its own turn after that turn, without cutting it off', async () => {
    const f = await fixture();
    await f.bypass();
    await f.tool('goal_set')(f.goalInput);
    const [goal] = (await f.platform.goals.list('alice')) as [GoalView];
    const schedule = await f.platform.schedules.get('alice', goal.scheduleId);
    const claim = (await f.store.claim(schedule.nextRunAt! + 1000))!;
    // The goal's turn marks it done while its task runs.
    await f.platform.goals.update('alice', f.dot.id, goal.id, { status: 'done' });
    // The run keeps its lease (no abort), then nothing is scheduled after it.
    expect(await f.store.owns(claim)).toBe(true);
    expect(await f.store.finish(claim, { text: 'Done.', sources: [], sample: false })).toBe(true);
    const task = (await f.store.ownedTask(goal.scheduleId, 'alice'))!;
    expect(task).toMatchObject({ status: 'completed', nextRunAt: null });
    expect(await f.store.claim(Date.now() + 10 * 86_400_000)).toBeNull();
    expect((await f.platform.goals.get('alice', goal.id))?.status).toBe('done');
});

it('cancels a goal schedule left without its goal, at start', async () => {
    const f = await fixture();
    const orphan = await f.platform.schedules.create('alice', f.dot.id, {
        title: 'Goal: lost',
        cadence: 'every day at 09:00',
        timezone: 'UTC',
        action: {
            kind: 'turn',
            prompt: goalPrompt({ id: 'G-deadbeef', title: 'lost' }),
        },
    });
    await f.bypass();
    await f.tool('goal_set')(f.goalInput);
    const [kept] = (await f.platform.goals.list('alice')) as [GoalView];
    expect(await f.platform.goals.reconcile()).toBe(1);
    expect((await f.platform.schedules.get('alice', orphan.id)).status).toBe('cancelled');
    expect((await f.platform.schedules.get('alice', kept.scheduleId)).status).not.toBe('cancelled');
});

it('sets nothing for a goal like one the person has, and lists it instead (CB-135)', async () => {
    const f = await fixture();
    await f.bypass();
    await f.tool('goal_set')(f.goalInput);
    const [goal] = (await f.platform.goals.list('alice')) as [GoalView];
    // The same goal, worded a little differently.
    const result = await f.tool('goal_set')({
        ...f.goalInput,
        title: 'keep our onboarding doc current',
    });
    expect(result).toMatchObject({
        outcome: 'possible_duplicates',
        matches: [{ goal: goal.id, status: 'active', title: goal.title }],
    });
    expect(await f.platform.goals.list('alice')).toHaveLength(1);
    expect(await f.platform.schedules.list('alice')).toHaveLength(1);
    // A paused goal is still open.
    await f.platform.schedules.act('alice', goal.scheduleId, 'pause');
    expect(
        await f.tool('goal_set')({
            ...f.goalInput,
            title: 'Onboarding doc, current',
        }),
    ).toMatchObject({
        outcome: 'possible_duplicates',
        matches: [{ goal: goal.id, status: 'paused' }],
    });
    // Another goal, another person's or another Dot's, or a done one, is not a match.
    expect(await f.tool('goal_set')({ ...f.goalInput, title: 'Plan the offsite' })).toMatchObject({
        status: 'approved',
    });
    await f.bypass('bob');
    expect(await f.platform.goals.propose('bob', f.dot.id, f.goalInput)).toMatchObject({ status: 'approved' });
    await f.platform.schedules.act('alice', goal.scheduleId, 'resume');
    await f.tool('goal_update')({ goalId: goal.id, status: 'done' });
    expect(await f.tool('goal_set')(f.goalInput)).toMatchObject({
        status: 'approved',
    });
});

it('also finds a similar goal still waiting for approval, which can’t be commented on', async () => {
    const f = await fixture();
    const first = await f.tool('goal_set')(f.goalInput);
    expect(first).toMatchObject({ status: 'pending_approval' });
    const result = await f.tool('goal_set')({
        ...f.goalInput,
        title: 'Keep the onboarding docs up to date',
        cadence: 'every week',
    });
    expect(result).toMatchObject({
        outcome: 'possible_duplicates',
        matches: [{ goal: null, status: 'pending_approval', approval: first.id }],
    });
    expect(await f.platform.approvals.list('alice', { status: 'pending' })).toHaveLength(1);
    expect(await f.tool('goal_comment')({ goalId: 'G-0000beef', comment: 'More.' })).toEqual({
        error: 'Goal not found.',
        code: 'http_404',
    });
});

it('sets the goal anyway with force', async () => {
    const f = await fixture();
    await f.bypass();
    await f.tool('goal_set')(f.goalInput);
    const again = await f.tool('goal_set')({ ...f.goalInput, force: true });
    expect(again).toMatchObject({ status: 'approved' });
    expect(await f.platform.goals.list('alice')).toHaveLength(2);
    // A forced request waiting for approval is not asked twice either.
    const g = await fixture();
    const first = await g.tool('goal_set')(g.goalInput);
    expect(await g.tool('goal_set')({ ...g.goalInput, force: true })).toMatchObject({
        status: 'pending_approval',
        id: first.id,
    });
    // And force isn't kept in what the person approves.
    const [pending] = await g.platform.approvals.list('alice', {
        status: 'pending',
    });
    expect(JSON.stringify(pending)).not.toContain('force');
});

it('adds a comment to the right goal, read back in goal_list', async () => {
    const f = await fixture();
    await f.bypass();
    await f.tool('goal_set')(f.goalInput);
    await f.tool('goal_set')({ ...f.goalInput, title: 'Plan the offsite' });
    const [offsite, onboarding] = (await f.platform.goals.list('alice')) as [GoalView, GoalView];
    const result = await f.tool('goal_comment')({
        goalId: onboarding.id,
        comment: '  Also cover the security training.  ',
    });
    expect(result).toEqual({
        outcome: 'commented',
        goal: onboarding.id,
        comments: 1,
    });
    const listed = (await f.tool('goal_list')({})) as { goals: GoalView[] };
    const byId = Object.fromEntries(listed.goals.map((goal) => [goal.id, goal]));
    expect(byId[onboarding.id]!.comments).toEqual([
        {
            id: expect.stringMatching(/^GC-/),
            author: 'dot',
            body: 'Also cover the security training.',
            createdAt: expect.any(Number),
        },
    ]);
    expect(byId[offsite.id]!.comments).toEqual([]);
    // The person's own comment, in order.
    await f.platform.goals.comment('alice', undefined, onboarding.id, 'Thanks.');
    expect((await f.platform.goals.get('alice', onboarding.id))!.comments.map((c) => c.author)).toEqual([
        'dot',
        'person',
    ]);
    // In a goal's own turn, the goal is the default.
    expect(
        await f.tool('goal_comment', {
            cause: { kind: 'schedule', id: onboarding.scheduleId },
            purpose: 'scheduled',
        })({ comment: 'Done with step one.' }),
    ).toMatchObject({ goal: onboarding.id, comments: 3 });
    // The goal's turn is told to read them.
    expect(goalPrompt(onboarding)).toContain('comments');
});

it('keeps comments to the person’s own open goals, in length and number', async () => {
    const f = await fixture();
    await f.bypass();
    await f.tool('goal_set')(f.goalInput);
    const [goal] = (await f.platform.goals.list('alice')) as [GoalView];
    // Another person's goal is not found, by the person or by their Dot.
    await expect(f.platform.goals.comment('bob', undefined, goal.id, 'Mine now.')).rejects.toThrow('Goal not found.');
    expect(
        await f.tool('goal_comment', { userId: 'bob' })({
            goalId: goal.id,
            comment: 'Mine now.',
        }),
    ).toEqual({ error: 'Goal not found.', code: 'http_404' });
    expect((await f.platform.goals.get('alice', goal.id))!.comments).toEqual([]);
    // Another Dot of the same person can't reach it either.
    await expect(f.platform.goals.comment('alice', 'another-dot', goal.id, 'Hello.')).rejects.toThrow(
        'Goal not found.',
    );
    await expect(f.platform.goals.comment('alice', undefined, goal.id, '   ')).rejects.toThrow(/1 to 1000 characters/);
    await expect(f.platform.goals.comment('alice', undefined, goal.id, 'x'.repeat(1001))).rejects.toThrow(
        /1 to 1000 characters/,
    );
    for (let i = 1; i <= 50; i++) {
        await f.platform.goals.comment('alice', undefined, goal.id, `Note ${i}`);
    }
    await expect(f.platform.goals.comment('alice', undefined, goal.id, 'One more')).rejects.toThrow(/50 comments/);
    // A closed goal takes none.
    await f.tool('goal_update')({ goalId: goal.id, status: 'cancelled' });
    await expect(f.platform.goals.comment('alice', undefined, goal.id, 'Late')).rejects.toThrow(
        'This goal is cancelled.',
    );
});
