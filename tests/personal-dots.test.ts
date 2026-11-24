import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import type { Dot, User, WorkspaceState } from '@socio/shared/types';

import { MockAuthProvider } from '../src/server/auth/mock.js';
import { PERSONAL_DOTS_PER_USER } from '../src/server/workspace/workspace-routes.js';

import { DotAgent } from './helpers/dot-agent.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const USERS: User[] = [
    { id: 'alice', name: 'Alice', role: 'admin' },
    { id: 'bob', name: 'Bob', role: 'member' },
    { id: 'carol', name: 'Carol', role: 'member' },
    { id: 'dana', name: 'Dana', role: 'admin' },
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
    const dir = mkdtempSync(join(tmpdir(), 'cb-personal-dots-'));
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
    const settings = (extra: Record<string, unknown> = {}) => ({
        spaceId: company.spaceId,
        name: 'Bob’s helper',
        instructions: 'Help Bob with his week.',
        researchAllowed: false,
        memoryAllowed: true,
        ...extra,
    });
    return {
        store,
        workspace,
        platform,
        config,
        company,
        settings,
        alice: await as('alice'),
        bob: await as('bob'),
        carol: await as('carol'),
        dana: await as('dana'),
    };
}

it('lets a member make a socio of their own, without settings that reach beyond them', async () => {
    const f = await fixture();
    const made = await f.bob<Dot>(
        '/dots',
        'POST',
        f.settings({
            issuesAllowed: true,
            learningContainerId: 'research-workflow',
            skillDeliveryEnabled: true,
        }),
    );
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
        ownerId: 'bob',
        issuesAllowed: false,
        learningContainerId: null,
        skillDeliveryEnabled: false,
    });
    // Workspace sharing requires an explicit choice, even for Operators.
    const shared = await f.alice<Dot>('/dots', 'POST', f.settings({ name: 'Ledger', personal: false }));
    expect(shared.body.ownerId).toBeNull();
    const names = async (as: typeof f.bob) => (await as<WorkspaceState>('/workspace')).body.dots.map((dot) => dot.name);
    // Company Dots first, then the person's own; nobody else sees it.
    expect(await names(f.bob)).toEqual(['Sebas', 'Ledger', 'Bob’s helper']);
    expect(await names(f.carol)).toEqual(['Sebas', 'Ledger']);
    expect(await names(f.alice)).toEqual(['Sebas', 'Ledger']);
});

it('defaults Operator and Admin socios to private and ignores a member’s sharing request', async () => {
    const f = await fixture();
    const own = await f.alice<Dot>('/dots', 'POST', f.settings({ name: 'Private' }));
    expect(own.status).toBe(201);
    expect(own.body.ownerId).toBe('alice');
    const adminOwn = await f.dana<Dot>('/dots', 'POST', f.settings());
    expect(adminOwn.status).toBe(201);
    expect(adminOwn.body.ownerId).toBe('dana');
    const adminShared = await f.dana<Dot>('/dots', 'POST', f.settings({ personal: false }));
    expect(adminShared.status).toBe(201);
    expect(adminShared.body.ownerId).toBeNull();
    const member = await f.bob<Dot>('/dots', 'POST', f.settings({ personal: false }));
    expect(member.body.ownerId).toBe('bob');
    const bobView = (await f.bob<WorkspaceState>('/workspace')).body;
    expect(bobView.dots.some((dot) => dot.id === own.body.id)).toBe(false);
    expect((await f.bob('/conversations', 'POST', { dotId: own.body.id, title: 'No' })).status).toBe(404);
    expect((await f.bob(`/dots/${own.body.id}`, 'PUT', f.settings())).status).toBe(404);
    expect((await f.bob(`/dots/${own.body.id}/computer`)).status).toBe(404);
    // Settings updates cannot silently change either existing ownership kind.
    const edited = await f.alice<Dot>(`/dots/${own.body.id}`, 'PUT', f.settings({ personal: false }));
    expect(edited.body.ownerId).toBe('alice');
    const company = await f.alice<Dot>(`/dots/${f.company.id}`, 'PUT', f.settings({ personal: true }));
    expect(company.body.ownerId).toBeNull();
});

it('keeps a person’s own socio private: others get “not found” on every route', async () => {
    const f = await fixture();
    const own = (await f.bob<Dot>('/dots', 'POST', f.settings())).body;
    const conversation = { dotId: own.id, title: 'Hi' };
    expect((await f.carol('/conversations', 'POST', conversation)).status).toBe(404);
    expect((await f.carol(`/dots/${own.id}`, 'PUT', f.settings({ name: 'Mine' }))).status).toBe(404);
    expect((await f.carol(`/dots/${own.id}/computer`)).status).toBe(404);
    expect((await f.carol(`/dots/${own.id}/computer/start`, 'POST')).status).toBe(404);
    expect((await f.carol(`/dots/${own.id}/web`)).status).toBe(404);
    expect(
        (
            await f.carol('/approvals/policies', 'PUT', {
                dotId: own.id,
                capability: 'schedule.create',
                policy: 'bypass',
            })
        ).status,
    ).toBe(404);
    expect(
        (
            await f.carol('/data/grants', 'PUT', {
                dotId: own.id,
                folder: 'notes',
                access: 'read',
            })
        ).status,
    ).toBe(404);
    // Nobody else can own a chat with it, by any path.
    expect(() => f.workspace.bindThread('x', own.id, 'Chat', 'carol')).toThrow('Socio not found.');
    expect(f.workspace.canUseDot('carol', own.id)).toBe(false);
    expect(f.workspace.canUseDot('bob', own.id)).toBe(true);
    // Its owner chats with it.
    expect((await f.bob('/conversations', 'POST', conversation)).status).toBe(201);
});

it('lets the owner edit it, keeps admin settings with admins, and caps how many each person has', async () => {
    const f = await fixture();
    const own = (await f.bob<Dot>('/dots', 'POST', f.settings())).body;
    const edited = await f.bob<Dot>(
        `/dots/${own.id}`,
        'PUT',
        f.settings({ name: 'Weekly helper', issuesAllowed: true }),
    );
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({
        name: 'Weekly helper',
        issuesAllowed: false,
    });
    // An admin may allow it to file on the board; the owner can't undo that.
    expect(
        (await f.alice<Dot>(`/dots/${own.id}`, 'PUT', f.settings({ name: 'Weekly helper', issuesAllowed: true }))).body
            .issuesAllowed,
    ).toBe(true);
    expect(
        (await f.bob<Dot>(`/dots/${own.id}`, 'PUT', f.settings({ name: 'Weekly helper', issuesAllowed: false }))).body
            .issuesAllowed,
    ).toBe(true);
    // A company Dot stays the admins'.
    expect((await f.bob(`/dots/${f.company.id}`, 'PUT', f.settings())).status).toBe(403);
    for (let n = 1; n < PERSONAL_DOTS_PER_USER; n++) {
        expect((await f.bob('/dots', 'POST', f.settings({ name: `Helper ${n}` }))).status).toBe(201);
    }
    const over = await f.bob('/dots', 'POST', f.settings({ name: 'One more' }));
    expect(over.status).toBe(400);
    expect(over.body.error).toMatch(/the limit/);
});

it('runs a person’s own socio only for them, and never as the channel socio', async () => {
    const f = await fixture();
    const own = f.workspace.createDot(
        f.company.spaceId,
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
    f.workspace.bindThread('bob-chat', own.id, 'Chat', 'bob');
    const network = vi.spyOn(globalThis, 'fetch');
    // A channel turn acting for someone else is refused before any model call.
    const events = await lastValueFrom(
        new DotAgent(f.store, f.workspace, f.config, own.id, true, 'carol', {
            extensions: f.platform.dotExtensions,
        })
            .run({
                threadId: 'bob-chat',
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
    expect(f.workspace.companyDots().map((dot) => dot.id)).toEqual([f.company.id]);
    expect(f.workspace.dotsFor('bob').map((dot) => dot.id)).toEqual([f.company.id, own.id]);
});

// CB-256: whoever may edit a socio's settings may choose its character.
it('lets the people who edit a socio choose its character, and nobody else', async () => {
    const f = await fixture();
    const made = await f.bob<Dot>('/dots', 'POST', f.settings({ character: 'rulo' }));
    expect(made.status).toBe(201);
    expect(made.body.character).toBe('rulo');
    // Duplicates are fine: the same character for another socio.
    const twin = await f.bob<Dot>('/dots', 'POST', f.settings({ name: 'Twin', character: 'rulo' }));
    expect(twin.body.character).toBe('rulo');
    // Outside the cast is refused, on create and on edit.
    expect((await f.bob('/dots', 'POST', f.settings({ character: 'godzilla' }))).status).toBe(400);
    expect((await f.bob(`/dots/${made.body.id}`, 'PUT', f.settings({ character: 'godzilla' }))).status).toBe(400);
    // The owner changes it; every view carries the choice.
    const owner = await f.bob<Dot>(`/dots/${made.body.id}`, 'PUT', f.settings({ character: 'manny' }));
    expect(owner.status).toBe(200);
    expect(owner.body.character).toBe('manny');
    const view = (await f.bob<WorkspaceState>('/workspace')).body;
    expect(view.dots.find((dot) => dot.id === made.body.id)?.character).toBe('manny');
    // An edit that leaves it out keeps it.
    expect((await f.bob<Dot>(`/dots/${made.body.id}`, 'PUT', f.settings({ name: 'Renamed' }))).body.character).toBe(
        'manny',
    );
    // Admins manage personal socios' settings, so its character too.
    expect((await f.dana<Dot>(`/dots/${made.body.id}`, 'PUT', f.settings({ character: 'mingo' }))).body.character).toBe(
        'mingo',
    );
    // Another member: not found; a company socio: admins only.
    expect((await f.carol(`/dots/${made.body.id}`, 'PUT', f.settings({ character: 'sebas' }))).status).toBe(404);
    expect((await f.bob(`/dots/${f.company.id}`, 'PUT', f.settings({ character: 'rulo' }))).status).toBe(403);
    expect(f.workspace.dot(made.body.id)!.character).toBe('mingo');
    expect(f.workspace.dot(f.company.id)!.character).toBe('sebas');
    const company = await f.alice<Dot>(
        `/dots/${f.company.id}`,
        'PUT',
        f.settings({ name: 'Sebas', character: 'rulo' }),
    );
    expect(company.body.character).toBe('rulo');
    // Each change is in the socio's audit, with who made it.
    expect(
        f.workspace
            .dotAudit(made.body.id)
            .filter((entry) => entry.detail.includes('character'))
            .map((entry) => [entry.actor, entry.detail]),
    ).toEqual([
        ['bob', 'personal; character: rulo'],
        ['bob', 'character: rulo → manny'],
        ['dana', 'name; character: manny → mingo'],
    ]);
});
