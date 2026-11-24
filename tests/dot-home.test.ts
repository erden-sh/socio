import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it, vi } from 'vitest';

import type { DotFiledItem } from '@socio/shared/issues/issue-types';
import type { Dot, DotRun, User } from '@socio/shared/types';

import { MockAuthProvider } from '../src/server/auth/mock.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-89: what a Dot's home page reads besides the shell's chats, its
// approvals and its schedules: the person's own turns with the Dot, and
// what it filed for them. Never anyone else's; another person's own Dot
// is missing; an archived Dot's are still listed.
const USERS: User[] = [
    { id: 'alice', name: 'Alice', role: 'admin' },
    { id: 'bob', name: 'Bob', role: 'member' },
    { id: 'carol', name: 'Carol', role: 'member' },
];
const SECRET = 'secret-0123456789abcdef-xyz';
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function fixture() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), 'cb-dot-home-'));
    cleanup.push(() => {
        rmSync(dir, { recursive: true, force: true });
    });
    const { app, workspace, platform, dispose } = await makeTestRuntime({
        config: {
            baseUrl: 'https://unused.invalid/v1',
            apiKey: 'fixture',
            model: 'fixture',
            voiceName: 'marin',
            runtimeUrl: '',
            data: { userDataDir: dir },
        },
        app: {
            config: { mode: 'live', baseUrl: '' },
            auth: {
                provider: new MockAuthProvider(USERS, SECRET),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    for (const user of USERS) {
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
    const company = workspace.updateDot(
        workspace.dots()[0]!.id,
        { ...workspace.dots()[0]!, issuesAllowed: true },
        'alice',
    );
    const dotInput = (name: string) => ({
        spaceId: company.spaceId,
        name,
        instructions: `${name} helps.`,
        researchAllowed: false,
        memoryAllowed: true,
    });
    const bob = await as('bob');
    const own = (await bob<Dot>('/dots', 'POST', dotInput('Bob’s helper'))).body;
    const run = (threadId: string, runId: string, status: string, at: number) =>
        (platform.runner as unknown as { db: DatabaseSync }).db
            .prepare(
                "INSERT INTO agent_runs(threadId, runId, status, events, startedAt, finishedAt, source) VALUES (?, ?, ?, '[]', ?, ?, NULL)",
            )
            .run(threadId, runId, status, at, status === 'running' ? null : at + 1);
    return {
        workspace,
        platform,
        company,
        own,
        run,
        dotInput,
        alice: await as('alice'),
        bob,
        carol: await as('carol'),
    };
}

it('lists the person’s own latest turns with a Dot, archived chats too, and nobody else’s', async () => {
    const f = await fixture();
    f.workspace.bindThread('b1', f.company.id, 'Garden plan', 'bob');
    f.workspace.bindThread('b2', f.company.id, 'Old trip', 'bob');
    f.workspace.setArchived('b2', true, 'bob');
    f.workspace.bindThread('b3', f.own.id, 'His week', 'bob');
    f.workspace.bindThread('a1', f.company.id, 'Alice’s plan', 'alice');
    f.run('b1', 'r1', 'finished', 1);
    f.run('b2', 'r2', 'failed', 2);
    f.run('b3', 'r3', 'finished', 3);
    f.run('a1', 'r4', 'finished', 4);
    f.run('b1', 'r5', 'running', 5);

    const bob = await f.bob<DotRun[]>(`/dots/${f.company.id}/runs`);
    expect(bob.status).toBe(200);
    expect(bob.body).toEqual([
        expect.objectContaining({
            runId: 'r5',
            threadId: 'b1',
            title: 'Garden plan',
            status: 'running',
            source: 'web',
            finishedAt: null,
        }),
        expect.objectContaining({ runId: 'r2', title: 'Old trip' }),
        expect.objectContaining({ runId: 'r1', status: 'finished' }),
    ]);
    // Alice, an operator, sees her own only.
    expect((await f.alice<DotRun[]>(`/dots/${f.company.id}/runs`)).body.map((item) => item.runId)).toEqual(['r4']);
    expect((await f.bob<DotRun[]>(`/dots/${f.own.id}/runs`)).body.map((item) => item.runId)).toEqual(['r3']);
    // Bob's own Dot is missing to everyone else, admins too; so is a Dot
    // that doesn't exist.
    expect((await f.carol(`/dots/${f.own.id}/runs`)).status).toBe(404);
    expect((await f.alice(`/dots/${f.own.id}/runs`)).status).toBe(404);
    expect((await f.bob('/dots/nope/runs')).status).toBe(404);
    // Archived, its page still lists them.
    expect((await f.bob(`/dots/${f.own.id}/archive`, 'POST')).status).toBe(200);
    expect((await f.bob<DotRun[]>(`/dots/${f.own.id}/runs`)).body.map((item) => item.runId)).toEqual(['r3']);
});

it('lists what a Dot filed for the person asking only, live items only', async () => {
    const f = await fixture();
    const file = (userId: string, title: string, dotId = f.company.id) =>
        f.platform.board.filings.file(
            { dotId, userId, trigger: 'chat', causeId: null, threadId: null },
            { title, kind: 'feature', problem: `${title}, by hand today.` },
        );
    await file('bob', 'Export my week as a calendar');
    await file('alice', 'Bulk rename pages');
    const gone = await file('bob', 'Print the board on paper');
    expect(gone).toMatchObject({ outcome: 'filed' });
    const bob = await f.bob<DotFiledItem[]>(`/issues/filed?dot=${f.company.id}`);
    expect(bob.status).toBe(200);
    expect(bob.body).toEqual([
        {
            number: expect.any(Number),
            title: 'Print the board on paper',
            status: 'triage',
            filedAt: expect.any(Number),
        },
        expect.objectContaining({ title: 'Export my week as a calendar' }),
    ]);
    expect((await f.alice<DotFiledItem[]>(`/issues/filed?dot=${f.company.id}`)).body).toEqual([
        expect.objectContaining({ title: 'Bulk rename pages' }),
    ]);
    // A deleted item leaves the list.
    await f.platform.board.issues.remove(bob.body[0]!.number, 'alice');
    expect((await f.bob<DotFiledItem[]>(`/issues/filed?dot=${f.company.id}`)).body.map((item) => item.title)).toEqual([
        'Export my week as a calendar',
    ]);
    // Another person's own Dot, or none, is missing.
    expect((await f.carol(`/issues/filed?dot=${f.own.id}`)).status).toBe(404);
    expect((await f.carol('/issues/filed')).status).toBe(404);
    expect((await f.bob<DotFiledItem[]>(`/issues/filed?dot=${f.own.id}`)).body).toEqual([]);
});

it('keeps an archived company Dot’s page readable', async () => {
    const f = await fixture();
    const other = (
        await f.alice<Dot>('/dots', 'POST', {
            ...f.dotInput('Second'),
            personal: false,
        })
    ).body;
    expect(other.ownerId ?? null).toBeNull();
    f.workspace.bindThread('b1', other.id, 'Plans', 'bob');
    f.run('b1', 'r1', 'finished', 1);
    expect((await f.alice(`/dots/${other.id}/archive`, 'POST')).status).toBe(200);
    const runs = await f.bob<DotRun[]>(`/dots/${other.id}/runs`);
    expect(runs.status).toBe(200);
    expect(runs.body.map((item) => item.runId)).toEqual(['r1']);
    expect((await f.bob(`/issues/filed?dot=${other.id}`)).status).toBe(200);
});
