import { EventType, type RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import { filingCause } from '@socio/foundation/issues/filing-cause';
import type { DotTurn } from '@socio/foundation/turns/turn';
import type { IssueDetail } from '@socio/shared/issues/issue-types';
import type { Dot } from '@socio/shared/types';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { filingTools } from '../src/server/issues/filing-tools.js';

import { completion } from './fixtures/model-stream.js';
import { boardOf } from './helpers/board.js';
import { DotAgent } from './helpers/dot-agent.js';
import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

function workspaceFixture() {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    for (const user of DEFAULT_MOCK_USERS) {
        workspace.recordUser(user);
    }
    const dot = workspace.dots()[0]!;
    return { workspace, dot };
}
const item = (title: string, extra: Record<string, unknown> = {}) => ({
    title,
    kind: 'feature' as const,
    problem: 'People copy chat findings into the board by hand.',
    ...extra,
});
const chat = (dotId: string, userId = 'bob') => ({
    dotId,
    userId,
    trigger: 'chat' as const,
    causeId: null,
    threadId: 'thread-1',
});
const limits = { perDot: 2, perUser: 2, windowMs: 60_000 };

// --- The store ----------------------------------------------------------------

it('files an item in triage with the socio as reporter and records the socio and the person together', async () => {
    const { workspace, dot } = workspaceFixture();
    const result = await boardOf(workspace).filings.file(
        chat(dot.id),
        item('Let socios file board items', {
            observed: 'The capability report lists no board tool.',
            suspectedCause: 'No first-party integration yet.',
        }),
    );
    expect(result).toMatchObject({
        outcome: 'filed',
        issue: 'CB-1',
        url: '/issues/CB-1',
        status: 'triage',
    });
    const issue = (await boardOf(workspace).issues.get(1))!;
    expect(issue).toMatchObject({
        reporterId: `dot:${dot.id}`,
        source: 'dot',
        status: 'triage',
        kind: 'feature',
        priority: 'medium',
        assigneeId: null,
    });
    expect(issue.body).toContain('**Observed (as reported)**');
    expect(issue.body).toContain('**Suspected cause (not confirmed)**');
    expect(await boardOf(workspace).filings.filing(issue.id)).toEqual({
        dotId: dot.id,
        dotOwnerId: null,
        userId: 'bob',
        trigger: 'chat',
        causeId: null,
        createdAt: expect.any(Number),
    });
    expect((await boardOf(workspace).issues.events(issue.id))[0]).toMatchObject({
        kind: 'created',
        actorId: `dot:${dot.id}`,
    });
});

it('refuses a filing without a live socio or a real person, and the schema refuses one without either id', async () => {
    const { workspace, dot } = workspaceFixture();
    await expect(boardOf(workspace).filings.file(chat(dot.id, ''), item('No person here'))).rejects.toThrow(
        /person the socio acts for/,
    );
    await expect(boardOf(workspace).filings.file(chat(dot.id, 'nobody'), item('Unknown person'))).rejects.toThrow(
        /person the socio acts for/,
    );
    await expect(boardOf(workspace).filings.file(chat('missing-dot'), item('Unknown socio'))).rejects.toThrow(
        /live socio/,
    );
    expect(await boardOf(workspace).issues.titles()).toEqual([]);
    const insert = (
        dotId: string,
        userId: string,
        trigger = 'chat',
        causeId: string | null = null,
        dotOwnerId: string | null = null,
    ) =>
        workspace.db
            .prepare(
                "INSERT INTO issue_dot_actions (id, issueId, action, dotId, dotOwnerId, userId, trigger, causeId, createdAt) VALUES (?, 'i', 'create', ?, ?, ?, ?, ?, 0)",
            )
            .run(String(Math.random()), dotId, dotOwnerId, userId, trigger, causeId);
    expect(() => insert(dot.id, '')).toThrow(/CHECK/);
    expect(() => insert('', 'bob')).toThrow(/CHECK/);
    expect(() => insert(dot.id, 'bob', 'whenever')).toThrow(/CHECK/);
    // A goal's or a schedule's action names its cause.
    expect(() => insert(dot.id, 'bob', 'goal')).toThrow(/CHECK/);
    expect(() => insert(dot.id, 'bob', 'scheduled', '')).toThrow(/CHECK/);
    expect(() => insert(dot.id, 'bob', 'goal', 'G-1')).not.toThrow();
    // A person's own Dot acts only for its owner.
    expect(() => insert(dot.id, 'bob', 'chat', null, 'alice')).toThrow(/CHECK/);
    expect(() => insert(dot.id, 'bob', 'chat', null, 'bob')).not.toThrow();
    expect(() =>
        workspace.db
            .prepare(
                "INSERT INTO issue_dot_actions (id, issueId, action, dotId, trigger, createdAt) VALUES ('x', 'i', 'create', 'd', 'chat', 0)",
            )
            .run(),
    ).toThrow(/NOT NULL/);
});

it('shows close open items instead of filing, and files once the person confirms', async () => {
    const { workspace, dot } = workspaceFixture();
    await boardOf(workspace).issues.create({ title: 'Socios should file board items' }, 'alice');
    const first = await boardOf(workspace).filings.file(chat(dot.id), item('Let socios file items on the board'));
    expect(first).toMatchObject({
        outcome: 'possible_duplicates',
        matches: [{ issue: 'CB-1', title: 'Socios should file board items' }],
    });
    expect(await boardOf(workspace).issues.titles()).toHaveLength(1);
    expect(
        await boardOf(workspace).filings.file(
            chat(dot.id),
            item('Let socios file items on the board', { fileAnyway: true }),
        ),
    ).toMatchObject({ outcome: 'filed', issue: 'CB-2' });
    // A closed item is not a duplicate of new work.
    await boardOf(workspace).issues.update(1, { status: 'done' }, 'alice');
    await boardOf(workspace).issues.update(2, { status: 'wont_fix' }, 'alice');
    expect(await boardOf(workspace).filings.file(chat(dot.id), item('Socios file board items'))).toMatchObject({
        outcome: 'filed',
        issue: 'CB-3',
    });
});

it('limits filings per socio and per person, over the window', async () => {
    const { workspace, dot } = workspaceFixture();
    const other = workspace.createDot(workspace.spaces()[0]!.id, 'Ledger', 'Count.', false, false);
    const now = 1_000_000;
    const file = (dotId: string, userId: string, title: string, at = now) =>
        boardOf(workspace).filings.file(chat(dotId, userId), item(title), {
            limits,
            now: at,
        });
    expect(await file(dot.id, 'bob', 'Export pages as PDF')).toMatchObject({
        outcome: 'filed',
    });
    expect(await file(dot.id, 'alice', 'Dark mode for the editor')).toMatchObject({
        outcome: 'filed',
    });
    expect(await file(dot.id, 'bob', 'Calendar sync')).toMatchObject({
        outcome: 'rate_limited',
        message: expect.stringMatching(/This socio has filed 2/),
    });
    expect(await file(other.id, 'bob', 'Calendar sync')).toMatchObject({
        outcome: 'filed',
    });
    expect(await file(other.id, 'bob', 'Slack notifications')).toMatchObject({
        outcome: 'rate_limited',
        message: expect.stringMatching(/^2 items were filed for this person/),
    });
    expect(await file(dot.id, 'bob', 'Calendar import', now + limits.windowMs + 1)).toMatchObject({ outcome: 'filed' });
});

it('keeps emails out of what a socio files, and searches titles by their words', async () => {
    const { workspace, dot } = workspaceFixture();
    await boardOf(workspace).filings.file(
        chat(dot.id),
        item('Email digests for bob@example.com', {
            problem: 'Write to bob@example.com every Monday.',
        }),
    );
    const issue = (await boardOf(workspace).issues.get(1))!;
    expect(issue.title).not.toContain('@');
    expect(issue.body).not.toContain('@');
    await boardOf(workspace).issues.create({ title: 'Sending weekly digests' }, 'alice');
    await boardOf(workspace).issues.create({ title: 'Unrelated printer bug' }, 'alice');
    expect(
        (
            await boardOf(workspace).filings.search('weekly email digest', {
                origin: 'https://brain.example',
            })
        ).map((match) => [match.issue, match.url]),
    ).toEqual([
        ['CB-2', 'https://brain.example/issues/CB-2'],
        ['CB-1', 'https://brain.example/issues/CB-1'],
    ]);
});

// --- The tools ------------------------------------------------------------------

const turn = (dot: Dot, extra: Partial<DotTurn> = {}): DotTurn => ({
    dot,
    userId: 'bob',
    threadId: 'thread-1',
    channel: false,
    purpose: 'chat',
    check: () => {},
    signal: new AbortController().signal,
    toolNames: () => [],
    ...extra,
});

it('offers the board tools only to socios an admin allowed', () => {
    const { workspace, dot } = workspaceFixture();
    expect(dot.issuesAllowed).toBe(false);
    expect(filingTools(boardOf(workspace).filings, turn(dot))).toEqual([]);
    const allowed = workspace.updateDot(dot.id, {
        ...dot,
        issuesAllowed: true,
    });
    expect(allowed.issuesAllowed).toBe(true);
    expect(workspace.dot(dot.id)?.issuesAllowed).toBe(true);
    expect(filingTools(boardOf(workspace).filings, turn(allowed)).map((tool) => tool.name)).toEqual([
        'list_improvements',
        'search_improvements',
        'read_improvement',
        'file_improvement',
        'vote_improvement',
        'comment_on_improvement',
        'edit_improvement',
        'set_improvement_status',
    ]);
    // An update that leaves the flag out keeps it.
    const rest: Partial<Dot> = { ...allowed };
    delete rest.issuesAllowed;
    expect(workspace.updateDot(dot.id, rest as typeof allowed).issuesAllowed).toBe(true);
});

it('takes the cause from the turn: chat, Telegram, a scheduled task or a goal', async () => {
    const { dot } = workspaceFixture();
    const goalOf = (task: string) => (task === 'goal-task' ? { id: 'G-1' } : undefined);
    expect(await filingCause(turn(dot), goalOf)).toEqual({
        trigger: 'chat',
        causeId: null,
    });
    expect(await filingCause(turn(dot, { channel: true }), goalOf)).toEqual({
        trigger: 'telegram',
        causeId: null,
    });
    const scheduled = (id: string) => turn(dot, { purpose: 'scheduled', cause: { kind: 'schedule', id } });
    expect(await filingCause(scheduled('task-1'), goalOf)).toEqual({
        trigger: 'scheduled',
        causeId: 'task-1',
    });
    expect(await filingCause(scheduled('goal-task'), goalOf)).toEqual({
        trigger: 'goal',
        causeId: 'G-1',
    });
});

it('files with a person’s own socio only for its owner, and records the owner', async () => {
    const { workspace } = workspaceFixture();
    const own = workspace.createDot(
        workspace.spaces()[0]!.id,
        'Bob’s helper',
        'Help Bob.',
        false,
        false,
        undefined,
        null,
        false,
        null,
        true,
        'bob',
    );
    await expect(boardOf(workspace).filings.file(chat(own.id, 'alice'), item('For someone else'))).rejects.toThrow(
        /only for them/,
    );
    await boardOf(workspace).filings.file(chat(own.id, 'bob'), item('Bob’s own request'));
    expect(await boardOf(workspace).filings.filing((await boardOf(workspace).issues.get(1))!.id)).toMatchObject({
        dotId: own.id,
        dotOwnerId: 'bob',
        userId: 'bob',
    });
    // A scheduled filing needs its goal or task.
    await expect(
        boardOf(workspace).filings.file({ ...chat(own.id, 'bob'), trigger: 'scheduled' }, item('No cause given')),
    ).rejects.toThrow(/goal or task/);
});

// --- A real turn: the platform binds the Dot and the person ------------------------

async function platformFixture() {
    const config = {
        apiKey: 'fixture',
        model: 'custom-model',
        baseUrl: 'https://unused.invalid/v1',
        runtimeUrl: '',
        voiceName: 'marin',
        appOrigin: 'https://brain.example',
    };
    const { store, workspace, platform, dispose } = await makeTestRuntime({ config });
    cleanup.push(dispose);
    for (const user of DEFAULT_MOCK_USERS) {
        workspace.recordUser(user);
    }
    const dot = workspace.updateDot(workspace.dots()[0]!.id, {
        ...workspace.dots()[0]!,
        issuesAllowed: true,
    });
    workspace.bindThread('thread', dot.id, 'Board', 'alice');
    const agent = (actingUserId?: string, purpose?: 'chat' | 'scheduled') =>
        new DotAgent(store, workspace, config, dot.id, !!actingUserId, actingUserId, {
            extensions: platform.dotExtensions,
            purpose,
            ...(purpose === 'scheduled' ? { cause: { kind: 'schedule' as const, id: 'task-1' } } : {}),
        });
    const input = (text: string): RunAgentInput => ({
        threadId: 'thread',
        runId: `run-${Math.random()}`,
        state: {},
        context: [],
        messages: [{ id: 'user', role: 'user', content: text }],
        tools: [],
        forwardedProps: {},
    });
    return { platform, workspace, dot, agent, input };
}
const call = (name: string, args: unknown, id = name) =>
    completion(
        {
            role: 'assistant',
            tool_calls: [
                {
                    index: 0,
                    id,
                    type: 'function',
                    function: { name, arguments: JSON.stringify(args) },
                },
            ],
        },
        'tool_calls',
    );
const results = (events: Array<{ type: string }>) =>
    Object.fromEntries(
        events
            .filter((event) => event.type === EventType.TOOL_CALL_RESULT)
            .map((event) => {
                const e = event as unknown as { toolCallId: string; content: string };
                let content: unknown = e.content;
                try {
                    content = JSON.parse(e.content);
                } catch {
                    // An error's text.
                }
                return [e.toolCallId, content];
            }),
    );

it('files for the conversation’s owner in a chat turn, and ignores an identity the model sends', async () => {
    const f = await platformFixture();
    const network = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(call('search_improvements', { query: 'board' }))
        .mockResolvedValueOnce(
            call('file_improvement', { ...item('Forged filing'), userId: 'bob', dotId: 'other' }, 'forged'),
        )
        .mockResolvedValueOnce(call('file_improvement', item('Let socios file board items'), 'filed'))
        .mockResolvedValueOnce(call('capabilities', {}))
        .mockResolvedValueOnce(completion({ role: 'assistant', content: 'Done.' }));
    const events = await lastValueFrom(
        f.agent().run(f.input('Please file this as a feature request.')).pipe(toArray()),
    );
    const first = JSON.parse(String(network.mock.calls[0][1]?.body)) as {
        tools: Array<{ function: { name: string } }>;
    };
    expect(first.tools.map((tool) => tool.function.name)).toEqual(
        expect.arrayContaining(['search_improvements', 'file_improvement']),
    );
    const out = results(events);
    expect(out.search_improvements).toEqual({ matches: [] });
    // The schema is strict: an identity in the input is refused, nothing filed.
    expect(JSON.stringify(out.forged)).not.toContain('"outcome":"filed"');
    expect(out.filed).toMatchObject({
        outcome: 'filed',
        issue: 'CB-1',
        url: 'https://brain.example/issues/CB-1',
    });
    expect((await f.platform.board.issues.titles()).map((t) => t.title)).toEqual(['Let socios file board items']);
    const issue = (await f.platform.board.issues.get(1))!;
    expect(await f.platform.board.filings.filing(issue.id)).toMatchObject({
        dotId: f.dot.id,
        userId: 'alice',
        trigger: 'chat',
    });
    const capabilities = out.capabilities as {
        capabilities: Array<{ id: string; enabled: boolean; usage?: unknown }>;
    };
    expect(capabilities.capabilities.find((c) => c.id === 'improvements')).toMatchObject({
        enabled: true,
        usage: { filedByYouToday: 1, filedForPersonToday: 1 },
    });
});

it('files for the linked sender on Telegram and for the task owner when scheduled', async () => {
    const f = await platformFixture();
    vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(call('file_improvement', item('Telegram filing')))
        .mockResolvedValueOnce(completion({ role: 'assistant', content: 'Ok.' }))
        .mockResolvedValueOnce(call('file_improvement', item('Nightly report gap')))
        .mockResolvedValueOnce(completion({ role: 'assistant', content: 'Ok.' }));
    await lastValueFrom(f.agent('bob').run(f.input('File it.')).pipe(toArray()));
    await lastValueFrom(f.agent(undefined, 'scheduled').run(f.input('File it.')).pipe(toArray()));
    const filing = async (n: number) => f.platform.board.filings.filing((await f.platform.board.issues.get(n))!.id);
    expect(await filing(1)).toMatchObject({ userId: 'bob', trigger: 'telegram' });
    expect(await filing(2)).toMatchObject({
        userId: 'alice',
        trigger: 'scheduled',
        causeId: 'task-1',
    });
});

it('offers no board tools, and reports the capability off, until an admin allows the socio', async () => {
    const f = await platformFixture();
    f.workspace.updateDot(f.dot.id, { ...f.dot, issuesAllowed: false });
    const network = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(call('capabilities', {}))
        .mockResolvedValueOnce(completion({ role: 'assistant', content: 'No.' }));
    const events = await lastValueFrom(f.agent().run(f.input('File it.')).pipe(toArray()));
    const first = JSON.parse(String(network.mock.calls[0][1]?.body)) as {
        tools: Array<{ function: { name: string } }>;
    };
    const names = first.tools.map((tool) => tool.function.name);
    expect(names).not.toContain('file_improvement');
    expect(names).not.toContain('search_improvements');
    const capabilities = results(events).capabilities as {
        capabilities: Array<{ id: string; enabled: boolean; note?: string }>;
    };
    expect(capabilities.capabilities.find((c) => c.id === 'improvements')).toMatchObject({
        enabled: false,
        note: expect.stringMatching(/admin/),
    });
});

// --- Routes -------------------------------------------------------------------------

async function appFixture() {
    const { app, workspace, platform, dispose } = await makeTestRuntime({
        config: {
            baseUrl: '',
            apiKey: '',
            model: '',
            runtimeUrl: '',
        },
        app: {
            config: { mode: 'live', baseUrl: '' },
            auth: {
                provider: new MockAuthProvider(DEFAULT_MOCK_USERS, 'secret-0123456789abcdef-xyz'),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    for (const user of DEFAULT_MOCK_USERS) {
        workspace.recordUser(user);
    }
    const as = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
        return async <T>(path: string, method = 'GET', body?: unknown) => {
            const response = await app.request(`/api${path}`, {
                method,
                headers: {
                    cookie,
                    ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            return { status: response.status, body: (await response.json()) as T };
        };
    };
    return {
        workspace,
        platform,
        dot: workspace.dots()[0]!,
        alice: await as('alice'),
        bob: await as('bob'),
    };
}

it('shows everyone which socio filed an item and for whom; only admins allow a socio', async () => {
    const f = await appFixture();
    await f.platform.board.filings.file(chat(f.dot.id), item('Let socios file board items'));
    for (const as of [f.alice, f.bob]) {
        const detail = await as<IssueDetail>('/issues/1');
        expect(detail.status).toBe(200);
        expect(detail.body.filedBy).toMatchObject({
            dotId: f.dot.id,
            userId: 'bob',
            trigger: 'chat',
        });
        expect(detail.body.users[`dot:${f.dot.id}`]).toBe(f.dot.name);
        expect(detail.body.users.bob).toBeTruthy();
    }
    const plain = await f.platform.board.issues.create({ title: 'A plain bug' }, 'bob');
    expect((await f.bob<IssueDetail>(`/issues/${plain.number}`)).body.filedBy).toBeUndefined();
    const settings = {
        name: f.dot.name,
        instructions: f.dot.instructions,
        researchAllowed: f.dot.researchAllowed,
        memoryAllowed: f.dot.memoryAllowed,
        issuesAllowed: true,
    };
    expect((await f.bob(`/dots/${f.dot.id}`, 'PUT', settings)).status).toBe(403);
    expect(f.workspace.dot(f.dot.id)?.issuesAllowed).toBe(false);
    const saved = await f.alice<Dot>(`/dots/${f.dot.id}`, 'PUT', settings);
    expect(saved.status).toBe(200);
    expect(saved.body.issuesAllowed).toBe(true);
});

it('finds close items in other scripts too', async () => {
    const { workspace, dot } = workspaceFixture();
    await boardOf(workspace).issues.create({ title: 'Экспорт отчётов в CSV' }, 'alice');
    expect(await boardOf(workspace).filings.file(chat(dot.id), item('Экспорт отчётов в Excel'))).toMatchObject({
        outcome: 'possible_duplicates',
        matches: [{ issue: 'CB-1' }],
    });
    expect((await boardOf(workspace).filings.search('отчётов')).map((m) => m.issue)).toEqual(['CB-1']);
});
