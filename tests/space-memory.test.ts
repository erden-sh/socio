import { randomUUID } from 'node:crypto';

import type { Message, RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { schemaDrift } from '@socio/data/drift';
import { teamOwner } from '@socio/foundation/telegram/team-owner';
import type { DotTurn } from '@socio/foundation/turns/turn';
import { TURN_MEMORY_CHARS } from '@socio/shared/context-settings';
import { ROOM_DISCLOSURE_VERSION } from '@socio/shared/rooms/rooms';
import {
    spaceAccessLevel,
    type SpaceMemoryState,
    type SpaceMemoryView,
    type SpacePeopleView,
} from '@socio/shared/space-memory';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { spaceMemoryRetentionDaysFromEnv, type PlatformConfig } from '../src/server/composition/config.js';
import { resetCalibration } from '../src/server/context/budget.js';
import { InferenceService } from '../src/server/inference/service.js';
import { DEFAULT_SPACE_MEMORY_RETENTION_DAYS } from '../src/server/memory/contract.js';
import { memoriesModule, spaceMemoryRetentionDays } from '../src/server/memory/module.js';
import { expireSpaceMemory, spaceMemoryForTurn } from '../src/server/memory/space-memory.js';
import { personalContext, TURN_SPACE_MEMORY_SHARE } from '../src/server/memory/turn.js';
import type { ModuleContext } from '../src/server/modules/contract.js';
import { settleHook } from '../src/server/modules/lifecycle.js';
import { spaceTables } from '../src/server/spaces/infra/sqlite/schema.js';
import { spacesSchema } from '../src/server/spaces/migrations.js';

import { completion } from './fixtures/model-stream.js';
import { roomsFixture, type Caller } from './fixtures/rooms.js';
import { DotAgent } from './helpers/dot-agent.js';
import { LocalAgentRunner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

// CB-181: a Space's shared memory, governed. Members and socios propose,
// the Space's editors approve, edit and retire; access is asked afresh at
// every read, so a person removed from a Space, or a room with someone who
// can't read it, gets nothing; every change is audited by id; retention
// runs on the leader.

const cleanup: Array<() => unknown> = [];
beforeEach(() => resetCalibration());
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
});

const CANARY = 'SPACE-CANARY invoices go out on the first business day';
const DAY = 24 * 60 * 60_000;

const json = async <T>(response: Response | Promise<Response>) => (await (await response).json()) as T;

async function api() {
    const f = await roomsFixture(cleanup);
    const spaceId = f.company.spaceId;
    const space = (as: Caller, path = '', method = 'GET', body?: unknown) =>
        as(`/spaces/${spaceId}${path}`, method, body);
    const view = async (who: string) => json<SpaceMemoryState>(space(f.as(who), '/memory'));
    return { ...f, spaceId, space, view };
}

it('has one rule: admins and editors approve, members and an open Space’s readers read, nobody else', () => {
    const person = (role: 'admin' | 'member', deactivated = false) => ({ role, deactivated }) as const;
    const open = { membersOnly: false };
    const closed = { membersOnly: true };
    expect(spaceAccessLevel({ person: person('admin'), space: closed })).toBe('editor');
    expect(spaceAccessLevel({ person: person('admin'), space: closed })).toBe('editor');
    expect(
        spaceAccessLevel({
            person: person('member'),
            space: closed,
            member: { role: 'editor' },
        }),
    ).toBe('editor');
    expect(
        spaceAccessLevel({
            person: person('member'),
            space: closed,
            member: { role: 'member' },
        }),
    ).toBe('reader');
    expect(spaceAccessLevel({ person: person('member'), space: open })).toBe('reader');
    expect(spaceAccessLevel({ person: person('member'), space: closed })).toBe(null);
    // A deactivated person, an unknown one, a Space that is gone: nothing.
    expect(
        spaceAccessLevel({
            person: person('admin', true),
            space: open,
            member: { role: 'editor' },
        }),
    ).toBe(null);
    expect(spaceAccessLevel({ person: undefined, space: open })).toBe(null);
    expect(
        spaceAccessLevel({
            person: person('admin'),
            space: undefined,
            member: { role: 'editor' },
        }),
    ).toBe(null);
});

it('mirrors the Space tables as migrated, expand-only', () => {
    const db = testDatabase();
    cleanup.push(() => db.close());
    expect(schemaDrift(db, spaceTables)).toEqual([]);
    expect(spacesSchema.migrations!.every((m) => m.phase === 'expand')).toBe(true);
    expect(() =>
        db.exec(
            "INSERT INTO space_members (spaceId, userId, role, addedAt, updatedAt) VALUES ('s', 'u', 'owner', 1, 1)",
        ),
    ).toThrow(/CHECK/);
});

it('lets readers propose and only editors approve, reject, edit and retire; a proposer withdraws only their own', async () => {
    const f = await api();
    const mo = f.as('mo');
    const ada = f.as('ada');
    // Mo reads the open Space and proposes: it waits.
    expect((await f.view('mo')).access).toBe('reader');
    const made = await f.space(mo, '/memory', 'POST', { text: CANARY });
    expect(made.status).toBe(201);
    const { version: proposal, waiting } = await json<{
        version: SpaceMemoryView;
        waiting: boolean;
    }>(made);
    expect(waiting).toBe(true);
    expect(proposal).toMatchObject({
        status: 'proposed',
        proposedBy: 'mo',
        version: null,
    });
    // Not in use: no entry, and no one else sees it but the editors.
    expect((await f.view('mo')).entries).toEqual([]);
    expect((await f.view('mo')).proposals.map((p) => p.id)).toEqual([proposal.id]);
    expect((await f.view('nina')).proposals).toEqual([]);
    expect((await f.view('alice')).proposals.map((p) => p.id)).toEqual([proposal.id]);
    // The same words again add nothing.
    expect((await f.space(f.as('nina'), '/memory', 'POST', { text: CANARY })).status).toBe(409);
    // A reader approves nothing, rejects nothing, manages no one.
    const approve = (as: Caller, id: string, body?: unknown) =>
        f.space(as, `/memory/proposals/${id}/approve`, 'POST', body);
    expect((await approve(mo, proposal.id)).status).toBe(403);
    expect((await f.space(mo, `/memory/proposals/${proposal.id}/reject`, 'POST')).status).toBe(403);
    expect((await f.space(mo, '/people/mo', 'PUT', { role: 'editor' })).status).toBe(403);
    expect((await f.space(mo, '/access', 'PUT', { membersOnly: true })).status).toBe(403);
    // Nina can't withdraw Mo's; Ada becomes an editor (an admin made her).
    expect((await f.space(f.as('nina'), `/memory/proposals/${proposal.id}/withdraw`, 'POST')).status).toBe(404);
    expect((await f.space(f.as('alice'), '/people/ada', 'PUT', { role: 'editor' })).status).toBe(200);
    const approved = await json<SpaceMemoryView>(approve(ada, proposal.id));
    expect(approved).toMatchObject({
        status: 'active',
        version: 1,
        decidedBy: 'ada',
        proposedBy: 'mo',
    });
    // Approved once: not again.
    expect((await approve(ada, proposal.id)).status).toBe(409);
    const inUse = (await f.view('nina')).entries;
    expect(inUse.map((entry) => [entry.text, entry.proposedByName])).toEqual([[CANARY, 'Mo']]);

    // A reader's change waits; two at once: the second is stale once the
    // first is approved, so it never quietly undoes it.
    const change = (as: Caller, text: string) =>
        json<{ version: SpaceMemoryView; waiting: boolean }>(
            f.space(as, `/memory/entries/${approved.entryId}`, 'PUT', { text }),
        );
    const first = await change(mo, `${CANARY}, in EUR`);
    const second = await change(f.as('nina'), `${CANARY}, in USD`);
    expect([first.waiting, second.waiting]).toEqual([true, true]);
    expect(first.version.supersedes).toBe(approved.id);
    expect((await approve(ada, first.version.id)).status).toBe(200);
    expect((await approve(ada, second.version.id)).status).toBe(409);
    // An editor edits with their own words when approving.
    const history = await json<SpaceMemoryView[]>(f.space(mo, `/memory/entries/${approved.entryId}/history`));
    expect(history.map((v) => [v.version, v.status])).toEqual([
        // Nina's proposal is hers: Mo sees only the approved ones and his own.
        [2, 'active'],
        [1, 'superseded'],
    ]);
    // An editor's own change is in use at once.
    const edited = await change(ada, `${CANARY}, in EUR, net 30`);
    expect(edited.waiting).toBe(false);
    expect(edited.version).toMatchObject({ status: 'active', version: 3 });
    // Withdraw: only one's own, while it waits.
    const mine = await json<{ version: SpaceMemoryView }>(
        f.space(mo, '/memory', 'POST', { text: 'Standups are at 9:30.' }),
    );
    expect((await f.space(mo, `/memory/proposals/${mine.version.id}/withdraw`, 'POST')).status).toBe(200);
    // Retire: editors only; then it can be deleted, and not before.
    const retire = (as: Caller) => f.space(as, `/memory/entries/${approved.entryId}/retire`, 'POST');
    expect((await f.space(ada, `/memory/entries/${approved.entryId}`, 'DELETE')).status).toBe(409);
    expect((await retire(mo)).status).toBe(403);
    expect((await retire(ada)).status).toBe(200);
    expect((await f.view('mo')).entries).toEqual([]);
    expect((await f.view('ada')).retired.map((v) => v.entryId)).toEqual([approved.entryId]);
    expect((await f.view('mo')).retired).toEqual([]);
    expect((await f.space(mo, `/memory/entries/${approved.entryId}`, 'DELETE')).status).toBe(403);
    const deleted = await json<{ deleted: number }>(f.space(ada, `/memory/entries/${approved.entryId}`, 'DELETE'));
    expect(deleted.deleted).toBe(4);
    expect((await f.space(ada, `/memory/entries/${approved.entryId}/history`)).status).toBe(404);

    // The audit: every step by id, never the words.
    const audit = f.workspace.db
        .prepare(
            "SELECT actor, action, targetId, detail FROM workspace_audit WHERE targetKind IN ('space_memory', 'space_member') ORDER BY id",
        )
        .all() as Array<Record<string, string>>;
    expect(audit.map((row) => `${row.actor}:${row.action}`)).toEqual([
        'mo:propose',
        'alice:create',
        'ada:approve',
        'mo:propose',
        'nina:propose',
        'ada:approve',
        'ada:update',
        'mo:propose',
        'mo:withdraw',
        'ada:retire',
        'ada:delete',
    ]);
    expect(JSON.stringify(audit)).not.toMatch(/invoices|Standups/i);
    expect(audit[1]).toMatchObject({
        targetId: `${f.spaceId}:ada`,
        detail: 'role editor',
    });
});

it('hides a Space kept to its people from everyone else, without saying it is there', async () => {
    const f = await api();
    const alice = f.as('alice');
    await f.space(alice, '/memory', 'POST', { text: CANARY });
    await f.space(alice, '/people/mo', 'PUT', { role: 'member' });
    const people = await json<SpacePeopleView>(f.space(alice, '/access', 'PUT', { membersOnly: true }));
    expect(people.membersOnly).toBe(true);
    expect(people.people.map((p) => [p.userId, p.role])).toEqual([['mo', 'member']]);
    for (const path of ['/memory', '/people']) {
        expect((await f.space(f.as('nina'), path)).status).toBe(404);
    }
    expect((await f.space(f.as('nina'), '/memory', 'POST', { text: 'x y z' })).status).toBe(404);
    // A Space that isn't there answers the same.
    expect((await f.as('nina')('/spaces/nope/memory')).status).toBe(404);
    expect((await f.view('mo')).entries.map((e) => e.text)).toEqual([CANARY]);
    // Removed, Mo reads it no more, at once.
    expect((await f.space(alice, '/people/mo', 'DELETE')).status).toBe(200);
    expect((await f.space(f.as('mo'), '/memory')).status).toBe(404);
    expect(
        f.workspace.db
            .prepare("SELECT action, detail FROM workspace_audit WHERE targetKind = 'space_member' ORDER BY id")
            .all()
            .map((row) => ({ ...row })),
    ).toEqual([
        { action: 'create', detail: 'role member' },
        { action: 'update', detail: 'members only' },
        { action: 'remove', detail: 'removed' },
    ]);
});

it('never approves what a socio proposes, whoever it acts for, and never reaches a Space the person can’t read', async () => {
    const f = await api();
    const ctx: ModuleContext = f.platform.context;
    // Each in a chat of their own: the tool names only Spaces its readers
    // may read (CB-181).
    f.workspace.bindThread('chat-1', f.company.id, 'Alice’s', 'alice');
    const propose = (userId: string, threadId = 'chat-1') => {
        const tool = memoriesModule.dotTools!(ctx, {
            dot: f.company,
            userId,
            threadId,
            channel: false,
            purpose: 'chat',
            check: () => {},
            signal: new AbortController().signal,
            toolNames: () => [],
        } as unknown as DotTurn).find((t) => t.name === 'propose_space_memory')!;
        return (args: unknown) => tool.execute!(args as never) as Promise<Record<string, unknown>>;
    };
    const space = f.workspace.spaces().find((s) => s.id === f.spaceId)!;
    // Alice is an operator, an editor of every Space: still it waits.
    const result = await propose('alice')({ space: space.name, text: CANARY });
    expect(result).toMatchObject({ proposed: true, space: space.name });
    expect(String(result.note)).toContain('editors');
    const state = await f.view('alice');
    expect(state.entries).toEqual([]);
    expect(state.proposals).toMatchObject([
        {
            text: CANARY,
            status: 'proposed',
            proposedBy: 'alice',
            dotId: f.company.id,
            threadId: 'chat-1',
            dotName: f.company.name,
        },
    ]);
    // Unused until approved.
    const hits = (userId: string, threadId = 'nina-chat') =>
        spaceMemoryForTurn(f.store, f.workspace, {
            dotId: f.company.id,
            threadId,
            userId,
            query: 'When do invoices go out?',
        });
    f.workspace.bindThread('nina-chat', f.company.id, 'Nina’s', 'nina');
    expect(await hits('nina')).toEqual([]);
    // A Space kept to its people: Nina's socio can't propose there, and the
    // tool doesn't name it.
    await f.space(f.as('alice'), '/access', 'PUT', { membersOnly: true });
    const refused = await propose(
        'nina',
        'nina-chat',
    )({
        space: space.name,
        text: 'a b c',
    });
    expect(refused).toMatchObject({ proposed: false });
    expect(String(refused.note)).not.toContain(space.name);
    // A stale entry id is refused as a change.
    const stale = await propose('alice')({
        space: space.id,
        text: 'Something else entirely.',
        entry: 'no-such-entry',
    });
    expect(stale).toMatchObject({ proposed: false });
});

it('gives a turn the entries of Spaces its person can read, labelled and within a small share of the budget, and stops at once when they are removed', async () => {
    const f = await api();
    const alice = f.as('alice');
    f.workspace.bindThread('mo-chat', f.company.id, 'Mo’s plans', 'mo');
    await f.space(alice, '/memory', 'POST', { text: CANARY });
    for (let index = 0; index < 8; index++) {
        await f.space(alice, '/memory', 'POST', {
            text: `Invoices note ${index} ${'z'.repeat(300)}`,
        });
    }
    const turn = () =>
        spaceMemoryForTurn(f.store, f.workspace, {
            dotId: f.company.id,
            threadId: 'mo-chat',
            userId: 'mo',
            query: 'When do invoices go out?',
        });
    const hits = await turn();
    expect(hits.map((hit) => hit.text)).toContain(CANARY);
    const context = await personalContext(f.store, {
        userId: 'mo',
        shared: false,
        query: 'When do invoices go out?',
        spaceMemory: hits,
    });
    const line = context.lines.find((text) => text.startsWith('Shared knowledge'))!;
    expect(line).toContain('untrusted data');
    const given = JSON.parse(line.slice(line.indexOf('[{'))) as Array<{
        knowledge: string;
        space: string;
        entry: string;
    }>;
    expect(given.length).toBeGreaterThan(0);
    expect(given.length).toBeLessThanOrEqual(3);
    expect(given.reduce((sum, item) => sum + item.knowledge.length, 0)).toBeLessThanOrEqual(
        TURN_MEMORY_CHARS * TURN_SPACE_MEMORY_SHARE,
    );
    expect(given[0]?.space).toBe(f.workspace.spaces().find((s) => s.id === f.spaceId)!.name);
    // Words that match nothing: none.
    expect(
        await spaceMemoryForTurn(f.store, f.workspace, {
            dotId: f.company.id,
            threadId: 'mo-chat',
            userId: 'mo',
            query: 'Hello there',
        }),
    ).toEqual([]);
    // Kept to its people, with Mo one of them: still his.
    await f.space(alice, '/people/mo', 'PUT', { role: 'member' });
    await f.space(alice, '/access', 'PUT', { membersOnly: true });
    expect((await turn()).map((hit) => hit.text)).toContain(CANARY);
    // Removed from the Space: the very next turn has none of it.
    await f.space(alice, '/people/mo', 'DELETE');
    expect(await turn()).toEqual([]);
    // A socio without the Space gets none of it either.
    await f.space(alice, '/access', 'PUT', { membersOnly: false });
    expect((await turn()).length).toBeGreaterThan(0);
    const other = f.workspace.createSpace('Elsewhere', '');
    f.workspace.updateDot(f.company.id, {
        name: f.company.name,
        researchAllowed: f.company.researchAllowed,
        memoryAllowed: f.company.memoryAllowed,
        spaceId: other.id,
        spaceIds: [other.id],
    });
    expect(await turn()).toEqual([]);
});

it('uses in a room only Spaces every member, and everyone invited, can read', async () => {
    const f = await api();
    const alice = f.as('alice');
    const ada = f.as('ada');
    await f.space(alice, '/memory', 'POST', { text: CANARY });
    await f.space(alice, '/people/ada', 'PUT', { role: 'member' });
    await f.space(alice, '/people/mo', 'PUT', { role: 'member' });
    await f.space(alice, '/access', 'PUT', { membersOnly: true });
    const { id: roomId } = await json<{ id: string }>(ada('/rooms', 'POST', { dotId: f.company.id, title: 'Billing' }));
    await ada(`/rooms/${roomId}/invites`, 'POST', { userId: 'mo' });
    await f.as('mo')(`/rooms/${roomId}/accept`, 'POST', {
        disclosureVersion: ROOM_DISCLOSURE_VERSION,
    });
    const turn = (userId: string) =>
        spaceMemoryForTurn(f.store, f.workspace, {
            dotId: f.company.id,
            threadId: roomId,
            userId,
            query: 'When do invoices go out?',
        });
    // Ada and Mo both read it: the room gets it, for either of them.
    expect((await turn('ada')).map((hit) => hit.text)).toEqual([CANARY]);
    expect((await turn('mo')).map((hit) => hit.text)).toEqual([CANARY]);
    // Nina, who can't, is invited: nothing, for anyone, before she joins.
    await ada(`/rooms/${roomId}/invites`, 'POST', { userId: 'nina' });
    expect(await turn('ada')).toEqual([]);
    await f.as('nina')(`/rooms/${roomId}/accept`, 'POST', {
        disclosureVersion: ROOM_DISCLOSURE_VERSION,
    });
    expect(await turn('ada')).toEqual([]);
    const shared = await personalContext(f.store, {
        userId: 'ada',
        shared: true,
        query: 'When do invoices go out?',
        spaceMemory: await turn('ada'),
    });
    expect(shared.lines.join('\n')).not.toContain('SPACE-CANARY');
    // Nina leaves: it is back.
    await f.as('nina')(`/rooms/${roomId}/leave`, 'POST');
    expect((await turn('ada')).map((hit) => hit.text)).toEqual([CANARY]);
    // Mo is removed from the Space: the room loses it at once.
    await f.space(alice, '/people/mo', 'DELETE');
    expect(await turn('ada')).toEqual([]);
    // A room the person isn't in, a Telegram team topic, someone else's
    // chat: never.
    await f.space(alice, '/access', 'PUT', { membersOnly: false });
    expect((await turn('ada')).length).toBe(1);
    expect(await turn('olive')).toEqual([]);
    f.workspace.bindThread('team', f.company.id, 'Team', teamOwner('-100'));
    f.workspace.bindThread('mo-chat', f.company.id, 'Mo’s', 'mo');
    for (const [threadId, userId] of [
        ['team', 'ada'],
        ['mo-chat', 'ada'],
        ['nope', 'ada'],
    ]) {
        expect(
            await spaceMemoryForTurn(f.store, f.workspace, {
                dotId: f.company.id,
                threadId,
                userId,
                query: 'When do invoices go out?',
            }),
        ).toEqual([]);
    }
});

it('deletes what has been out of use past retention, keeps entries in use, on the leader’s tick, the admin’s setting over the environment', async () => {
    const f = await api();
    const alice = f.as('alice');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 0, 1));
    const kept = await json<{ version: SpaceMemoryView }>(
        f.space(alice, '/memory', 'POST', { text: 'Kept in use forever.' }),
    );
    await f.space(alice, `/memory/entries/${kept.version.entryId}`, 'PUT', {
        text: 'Kept in use forever, really.',
    });
    const old = await json<{ version: SpaceMemoryView }>(
        f.space(alice, '/memory', 'POST', { text: 'Old and retired.' }),
    );
    await f.space(alice, `/memory/entries/${old.version.entryId}/retire`, 'POST');
    const waiting = await json<{ version: SpaceMemoryView }>(
        f.space(f.as('mo'), '/memory', 'POST', { text: 'Waited too long.' }),
    );
    expect(waiting.version.status).toBe('proposed');
    vi.setSystemTime(Date.UTC(2026, 0, 1) + 400 * DAY);
    // Signed in now (a session from 400 days ago is long over).
    const fresh = await json<{ version: SpaceMemoryView }>(
        f.space(f.as('nina'), '/memory', 'POST', { text: 'Fresh proposal.' }),
    );
    const ctx: ModuleContext = { ...f.platform.context, log: () => {} };
    const retention = { store: f.store, config: f.platform.config };
    expect(spaceMemoryRetentionDays(retention)).toBe(DEFAULT_SPACE_MEMORY_RETENTION_DAYS);
    // The memories module's tick runs it, on the leader only (CB-108).
    await settleHook(memoriesModule.tick!.run(ctx), ctx.services.run);
    const rows = f.store.connection
        .prepare('SELECT text, status FROM space_memories ORDER BY createdAt')
        .all()
        .map((row) => ({ ...row }));
    expect(rows).toEqual([
        { text: 'Kept in use forever, really.', status: 'active' },
        { text: 'Fresh proposal.', status: 'proposed' },
    ]);
    expect(fresh.version.status).toBe('proposed');
    // The admin's setting over the environment's.
    await f.store.updateSettings({ limits: { spaceMemoryRetentionDays: 30 } });
    expect(spaceMemoryRetentionDays(retention)).toBe(30);
    expect(spaceMemoryRetentionDaysFromEnv({})).toBeUndefined();
    expect(spaceMemoryRetentionDaysFromEnv({ SPACE_MEMORY_RETENTION_DAYS: ' 90 ' })).toBe(90);
    expect(() => spaceMemoryRetentionDaysFromEnv({ SPACE_MEMORY_RETENTION_DAYS: '0' })).toThrow(/1 to 3650/);
    // A proposal waiting past it goes too; the entry in use never does.
    expect(await expireSpaceMemory(f.store, 1, Date.now() + 2 * DAY)).toBe(1);
    expect(await f.store.spaceMemories.count(f.spaceId, 'active')).toBe(1);
});

/**
 * Socio on an OpenAI-compatible backend that never leaves this process,
 * each turn through the durable runner, as the app's are.
 */
async function turns() {
    const workspace = new WorkspaceStore(testDatabase());
    const store = new Store(testDatabase());
    const runner = new LocalAgentRunner(testDatabase());
    cleanup.push(
        () => workspace.close(),
        () => store.close(),
        () => runner.close(),
    );
    const inference = new InferenceService(workspace.db, {
        secret: 'space-memory-test-secret-0123456789abcdef',
        log: () => {},
    });
    await inference.createBackend({
        label: 'Homelab',
        baseUrl: 'http://orion.invalid/v1',
        model: 'qwen',
        contextWindow: 32_000,
    });
    const rounds: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        rounds.push(JSON.parse(String(init?.body)));
        return completion({ role: 'assistant', content: 'Noted.' });
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const person of DEFAULT_MOCK_USERS) {
        workspace.recordUser(person);
    }
    const dot = workspace.dots()[0]!;
    workspace.bindThread('bob-chat', dot.id, 'Bob’s billing', 'bob');
    const config: PlatformConfig = {
        baseUrl: '',
        apiKey: '',
        model: '',
        voiceName: 'marin',
        runtimeUrl: '',
        sessionSecret: 'space-memory-test-secret-0123456789abcdef',
    };
    const send = async (threadId: string, person: string, text: string) => {
        const agent = new DotAgent(store, workspace, config, dot.id, false, person, { inference });
        const message: Message = { id: randomUUID(), role: 'user', content: text };
        const input: RunAgentInput = {
            threadId,
            runId: randomUUID(),
            state: {},
            context: [],
            messages: [...(await runner.messages(threadId)), message],
            tools: [],
            forwardedProps: {},
        };
        agent.threadId = threadId;
        agent.setMessages(input.messages);
        const events = await lastValueFrom(runner.run({ threadId, agent, input }).pipe(toArray()));
        expect(events.map((event) => event.type)).not.toContain('RUN_ERROR');
        const body = rounds.at(-1)!;
        return {
            system: JSON.stringify(body.messages.filter((m) => m.role === 'system').map((m) => m.content)),
            newest: JSON.stringify(body.messages.filter((m) => m.role === 'user').at(-1)?.content),
        };
    };
    return { workspace, store, dot, send };
}

it('puts approved Space memory in the turn’s note, never the system prompt, and takes it out the turn after its person is removed', async () => {
    const f = await turns();
    const spaceId = f.dot.spaceId;
    await f.workspace.spaceAccess.setRole(spaceId, 'alice', 'bob', 'member');
    await f.workspace.spaceAccess.setMembersOnly(spaceId, 'alice', true);
    const before = await f.send('bob-chat', 'bob', 'Hello.');
    const made = await f.store.spaceMemories.add({ spaceId, text: CANARY, proposedBy: 'alice' }, 'alice');
    expect(made.ok).toBe(true);
    const own = await f.send('bob-chat', 'bob', 'When do invoices go out?');
    expect(own.newest).toContain('SPACE-CANARY');
    expect(own.newest).toContain('Shared knowledge of the Spaces');
    // Byte for byte the same system prompt (CB-139).
    expect(own.system).toBe(before.system);
    expect(own.system).not.toContain('SPACE-CANARY');
    // Removed from the Space: the next turn has none of it.
    await f.workspace.spaceAccess.remove(spaceId, 'alice', 'bob');
    const after = await f.send('bob-chat', 'bob', 'When do invoices go out?');
    expect(after.newest).not.toContain('SPACE-CANARY');
    // Memory off for the workspace: none, whoever can read it.
    await f.workspace.spaceAccess.setMembersOnly(spaceId, 'alice', false);
    expect((await f.send('bob-chat', 'bob', 'When do invoices go out?')).newest).toContain('SPACE-CANARY');
    await f.store.updateSettings({ memoryAllowed: false });
    expect((await f.send('bob-chat', 'bob', 'When do invoices go out?')).newest).not.toContain('SPACE-CANARY');
});
