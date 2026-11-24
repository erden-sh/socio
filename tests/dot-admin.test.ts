import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import type { DotAdminDetail, DotAdminRow } from '@socio/shared/dot-admin-types';
import type { Dot, User, WorkspaceState } from '@socio/shared/types';

import { MockAuthProvider } from '../src/server/auth/mock.js';
import { DOT_ARCHIVED_SCHEDULE } from '../src/server/composition/app/conversations.js';

import { DotAgent } from './helpers/dot-agent.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

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
    const dir = mkdtempSync(join(tmpdir(), 'cb-dot-admin-'));
    const config = {
        baseUrl: 'https://unused.invalid/v1',
        apiKey: 'fixture',
        model: 'fixture',
        voiceName: 'marin',
        runtimeUrl: '',
        data: { userDataDir: dir },
    };
    cleanup.push(() => {
        rmSync(dir, { recursive: true, force: true });
    });
    const { app, store, workspace, platform, dispose } = await makeTestRuntime({
        config,
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
        return async <T = Record<string, unknown>>(path: string, method = 'GET', body?: unknown) => {
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
    const company = workspace.dots()[0]!;
    const bob = await as('bob');
    const own = (
        await bob<Dot>('/dots', 'POST', {
            spaceId: company.spaceId,
            name: 'Bob’s helper',
            instructions: 'Help Bob with his week.',
            researchAllowed: false,
            memoryAllowed: true,
        })
    ).body;
    return {
        store,
        workspace,
        platform,
        config,
        company,
        own,
        alice: await as('alice'),
        bob,
        carol: await as('carol'),
    };
}

it('archives a socio, never deleting it: out of every list and turn, its schedules paused, then back', async () => {
    const f = await fixture();
    const chat = f.workspace.bindThread('bob-chat', f.own.id, 'Chat', 'bob');
    await f.platform.approvals.setPolicy('bob', f.own.id, 'schedule.create', 'bypass');
    await f.platform.schedules.propose('bob', f.own.id, {
        title: 'Weekly plan',
        cadence: 'every day at 08:00',
        action: { kind: 'turn', prompt: 'Plan the week.' },
    });
    const [schedule] = await f.platform.schedules.list('bob');
    expect(schedule!.status).toBe('scheduled');
    // Others can't archive it; nobody but admins archives a company Dot.
    expect((await f.carol(`/dots/${f.own.id}/archive`, 'POST')).status).toBe(404);
    expect((await f.bob(`/dots/${f.company.id}/archive`, 'POST')).status).toBe(403);
    const archived = await f.bob<Dot>(`/dots/${f.own.id}/archive`, 'POST');
    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({
        archivedAt: expect.any(Number),
        archivedBy: 'bob',
    });
    // Kept: the row, its chat, and the Dot by id.
    expect(f.workspace.dot(f.own.id)?.name).toBe('Bob’s helper');
    expect(f.workspace.thread(chat.id)).toBeTruthy();
    // Out of use: lists, new chats, turns.
    // Still a Dot (grants, apps and names stay); out of every list to choose from.
    expect(f.workspace.dots().map((dot) => dot.id)).toContain(f.own.id);
    expect(f.workspace.dotsFor('bob').map((dot) => dot.id)).not.toContain(f.own.id);
    const view = (await f.bob<WorkspaceState>('/workspace')).body;
    expect(view.dots.at(-1)).toMatchObject({
        id: f.own.id,
        archivedAt: expect.any(Number),
    });
    expect((await f.bob('/conversations', 'POST', { dotId: f.own.id, title: 'x' })).status).toBe(404);
    expect(() => f.workspace.bindThread('new', f.own.id, 'x', 'bob')).toThrow('This socio is archived.');
    const network = vi.spyOn(globalThis, 'fetch');
    const events = await lastValueFrom(
        new DotAgent(f.store, f.workspace, f.config, f.own.id)
            .run({
                threadId: chat.id,
                runId: 'run',
                state: {},
                context: [],
                messages: [{ id: 'm', role: 'user', content: 'Hi' }],
                tools: [],
                forwardedProps: {},
            } satisfies RunAgentInput)
            .pipe(toArray()),
    );
    expect(events.map((event) => event.type)).toContain('RUN_ERROR');
    expect(network).not.toHaveBeenCalled();
    expect(await f.platform.schedules.get('bob', schedule!.id)).toMatchObject({
        status: 'paused',
        error: DOT_ARCHIVED_SCHEDULE,
    });
    // Back: in the lists again, its schedule still paused for Bob to resume.
    expect((await f.bob<Dot>(`/dots/${f.own.id}/unarchive`, 'POST')).body.archivedAt).toBeNull();
    expect(f.workspace.dotsFor('bob').map((dot) => dot.id)).toContain(f.own.id);
    expect((await f.platform.schedules.get('bob', schedule!.id)).status).toBe('paused');
    expect(f.workspace.dotAudit(f.own.id).map(({ actor, action }) => [actor, action])).toEqual([
        ['bob', 'create'],
        ['bob', 'archive'],
        ['bob', 'unarchive'],
    ]);
});

it('audits who changed a socio’s settings, with setting names and on/off only', async () => {
    const f = await fixture();
    const settings = {
        name: f.company.name,
        instructions: 'A secret new prompt.',
        researchAllowed: f.company.researchAllowed,
        memoryAllowed: f.company.memoryAllowed,
        issuesAllowed: true,
    };
    expect((await f.alice(`/dots/${f.company.id}`, 'PUT', settings)).status).toBe(200);
    // Saving the same settings again changes nothing, so no line.
    await f.alice(`/dots/${f.company.id}`, 'PUT', settings);
    const audit = f.workspace.dotAudit(f.company.id);
    expect(audit.map(({ actor, action, detail }) => [actor, action, detail])).toEqual([
        // The seeded Sebas stores its character (CB-256).
        ['system', 'create', 'company; character: sebas'],
        // New instructions are the Soul's next version (CB-179).
        ['alice', 'update', 'Soul v2; Improvements board filing: off → on'],
    ]);
    expect(JSON.stringify(audit)).not.toContain('secret');
});

it('lists every socio to admins, with each one’s use and audit, and to nobody else', async () => {
    const f = await fixture();
    f.workspace.bindThread('bob-chat', f.own.id, 'Plans', 'bob');
    f.workspace.updateDot(f.own.id, { ...f.workspace.dot(f.own.id)!, issuesAllowed: true }, 'alice');
    await f.platform.board.filings.file(
        {
            dotId: f.own.id,
            userId: 'bob',
            trigger: 'chat',
            causeId: null,
            threadId: 'bob-chat',
        },
        {
            title: 'Export my week as a calendar',
            kind: 'feature',
            problem: 'Bob copies plans by hand.',
        },
    );
    await f.bob(`/dots/${f.own.id}/archive`, 'POST');
    expect((await f.bob('/admin/dots')).status).toBe(403);
    expect((await f.bob(`/admin/dots/${f.own.id}`)).status).toBe(403);
    const list = await f.alice<{ dots: DotAdminRow[] }>('/admin/dots');
    expect(list.status).toBe(200);
    expect(list.body.dots.map((row) => [row.dot.name, row.ownerName, !!row.dot.archivedAt])).toEqual([
        ['Sebas', null, false],
        ['Bob’s helper', 'Bob', true],
    ]);
    const detail = await f.alice<DotAdminDetail>(`/admin/dots/${f.own.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.row).toMatchObject({ conversations: 1, people: 1 });
    expect(detail.body.filings).toBe(1);
    // Owners and dates only: chat titles are a model's summary of the chat.
    expect(detail.body.conversations).toEqual([{ id: 'bob-chat', ownerId: 'bob', createdAt: expect.any(Number) }]);
    expect(JSON.stringify(detail.body)).not.toContain('Plans');
    const kinds = detail.body.activity.map((line) => [line.kind, line.actor, line.onBehalfOf]);
    expect(kinds).toEqual(
        expect.arrayContaining([
            ['settings', 'bob', null],
            ['settings', 'alice', null],
            ['filing', `dot:${f.own.id}`, 'bob'],
        ]),
    );
    expect(detail.body.activity.find((line) => line.kind === 'filing')?.summary).toMatch(
        /^filed CB-1 “Export my week as a calendar” \(chat\)$/,
    );
    expect(detail.body.users).toMatchObject({
        bob: 'Bob',
        alice: 'Alice',
        [`dot:${f.own.id}`]: 'Bob’s helper',
    });
    expect(detail.body.next).toBeNull();
});

it('keeps an archived socio’s data grants and approval policies through the deleted-socio cleanup', async () => {
    const f = await fixture();
    f.platform.data.setGrant('bob', {
        dotId: f.own.id,
        folder: 'notes',
        access: 'read',
    });
    await f.platform.approvals.setPolicy('bob', f.own.id, 'schedule.create', 'bypass');
    await f.bob(`/dots/${f.own.id}/archive`, 'POST');
    // What a deleted Dot's cleanup runs (hourly, and on Data page loads).
    f.platform.data.reconcileDots();
    f.platform.apps.forgetDeletedDots();
    expect(f.platform.data.grants('bob')).toEqual([expect.objectContaining({ dotId: f.own.id, folder: 'notes/' })]);
    expect(await f.platform.approvals.policy('bob', f.own.id, 'schedule.create')).toBe('bypass');
});

it('keeps the last company socio, leaves an admin’s archive to admins, and keeps an archived socio’s computer and schedules still', async () => {
    const f = await fixture();
    const last = await f.alice(`/dots/${f.company.id}/archive`, 'POST');
    expect(last.status).toBe(409);
    expect(last.body.error).toMatch(/last company socio/);
    // An admin archives Bob's Dot: Bob can't bring it back himself.
    await f.alice(`/dots/${f.own.id}/archive`, 'POST');
    const undo = await f.bob(`/dots/${f.own.id}/unarchive`, 'POST');
    expect(undo.status).toBe(403);
    expect(f.workspace.dot(f.own.id)?.archivedAt).toEqual(expect.any(Number));
    await expect(f.platform.computers.start(f.own.id, 'bob')).rejects.toThrow('This socio is archived.');
    // A schedule of an archived Dot waits, paused.
    f.workspace.unarchiveDot(f.own.id, 'alice');
    await f.platform.approvals.setPolicy('bob', f.own.id, 'schedule.create', 'bypass');
    await f.platform.schedules.propose('bob', f.own.id, {
        title: 'Weekly plan',
        cadence: 'every day at 08:00',
        action: { kind: 'turn', prompt: 'Plan the week.' },
    });
    const [schedule] = await f.platform.schedules.list('bob');
    await f.platform.archiveDot(f.own.id, 'bob');
    await expect(f.platform.schedules.act('bob', schedule!.id, 'resume')).rejects.toThrow(
        'This schedule’s socio is archived.',
    );
    await expect(f.platform.schedules.act('bob', schedule!.id, 'run')).rejects.toThrow('archived');
    expect((await f.platform.schedules.act('bob', schedule!.id, 'cancel')).status).toBe('cancelled');
});

it('pages a socio’s audit without gaps or repeats, even within one millisecond', async () => {
    const f = await fixture();
    const at = Date.now() - 1000;
    const insert = f.workspace.db.prepare(
        "INSERT INTO dot_audit (dotId, actor, action, detail, createdAt) VALUES (?, 'alice', 'update', ?, ?)",
    );
    for (let n = 0; n < 230; n++) {
        insert.run(f.own.id, `change ${String(n).padStart(3, '0')}`, n < 150 ? at : at - n);
    }
    const seen: string[] = [];
    let query = '';
    for (let pages = 0; pages < 10; pages++) {
        const page = (await f.alice<DotAdminDetail>(`/admin/dots/${f.own.id}${query}`)).body;
        seen.push(...page.activity.map((line) => line.summary));
        if (!page.next) {
            break;
        }
        query = `?before=${page.next.before}&skip=${page.next.skip}`;
    }
    const changes = seen.filter((line) => line.startsWith('updated: change'));
    expect(changes).toHaveLength(230);
    expect(new Set(changes).size).toBe(230);
});

it('names only the asker’s socios in the runtime’s agent list', async () => {
    const f = await fixture();
    const info = async (as: typeof f.bob) => JSON.stringify((await as('/copilotkit/info')).body);
    expect(await info(f.bob)).toContain(f.own.id);
    expect(await info(f.carol)).not.toContain(f.own.id);
    expect(await info(f.carol)).toContain(f.company.id);
});
