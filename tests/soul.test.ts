import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { RunAgentInput } from '@ag-ui/core';
import { EMPTY, defer, lastValueFrom, toArray } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import { migrate } from '@socio/data/migrate';
import { dotSoul, soulPrompt, textDiff, type SoulVersion, type SoulView } from '@socio/shared/soul';
import type { Dot, User } from '@socio/shared/types';

import { MockAuthProvider } from '../src/server/auth/mock.js';
import { schemas } from '../src/server/modules/index.js';
import { workspaceSchema } from '../src/server/workspace/workspace.js';

import { DotAgent } from './helpers/dot-agent.js';
import { WorkspaceStore } from './helpers/stores.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

/*
 * CB-179: a socio's Soul. Its instructions, upgraded word for word into
 * version 1; every edit and restore a new version; who may change it (the
 * owner of a personal socio, admins for a company socio, never a socio);
 * and the system prompt, which reads the version in use.
 */

type Captured = { name: string };
const hoisted = vi.hoisted(() => ({
    tools: [] as Captured[],
    prompts: [] as string[],
}));
vi.mock('@copilotkit/runtime/v2', async (importOriginal) => {
    const original = await importOriginal<typeof import('@copilotkit/runtime/v2')>();
    return {
        ...original,
        BuiltInAgent: class {
            constructor(private options: { factory: (ctx: unknown) => Promise<unknown> }) {}
            run = (input: unknown) =>
                defer(async () => {
                    await this.options.factory({
                        input,
                        learnedSkills: { tools: {} },
                        abortController: new AbortController(),
                        abortSignal: new AbortController().signal,
                    });
                    return EMPTY;
                });
            abortRun = () => {};
        },
    };
});
vi.mock('@tanstack/ai', async (importOriginal) => {
    const original = await importOriginal<typeof import('@tanstack/ai')>();
    return {
        ...original,
        chat: (options: { tools: Captured[]; systemPrompts: string[] }) => {
            hoisted.tools = options.tools;
            hoisted.prompts = options.systemPrompts;
            return (async function* () {})();
        },
    };
});

const USERS: User[] = [
    { id: 'alice', name: 'Alice', role: 'admin' },
    { id: 'bob', name: 'Bob', role: 'member' },
    { id: 'carol', name: 'Carol', role: 'member' },
];
const SECRET = 'secret-0123456789abcdef-xyz';
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function fixture() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // No outside calls: every fetch fails here.
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 503 }));
    const dir = mkdtempSync(join(tmpdir(), 'cb-soul-'));
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

/** The system prompt of one turn with the socio, and the tools it got. */
async function turn(f: Awaited<ReturnType<typeof fixture>>, dotId: string) {
    const threadId = `chat-${dotId}`;
    if (!f.workspace.thread(threadId)) {
        f.workspace.bindThread(threadId, dotId, 'Chat', 'bob');
    }
    hoisted.prompts = [];
    hoisted.tools = [];
    const agent = new DotAgent(f.store, f.workspace, f.config, dotId, false, undefined, {
        extensions: f.platform.dotExtensions,
    });
    const input: RunAgentInput = {
        threadId,
        runId: `run-${Math.random()}`,
        state: {},
        messages: [{ id: 'm1', role: 'user', content: 'Hello' }],
        tools: [],
        context: [],
        forwardedProps: {},
    };
    await lastValueFrom(agent.run(input).pipe(toArray()));
    return { prompt: hoisted.prompts[0] ?? '', tools: hoisted.tools };
}

const soulOf = async (call: Awaited<ReturnType<typeof fixture>>['alice'], id: string) =>
    (await call<SoulView>(`/dots/${id}/soul`)).body;

it('upgrades each socio’s instructions, word for word, into version 1 of its Soul', () => {
    const db = new DatabaseSync(':memory:');
    // A workspace as it was before the Soul (workspace 15).
    migrate(db, [
        {
            ...workspaceSchema,
            migrations: workspaceSchema.migrations!.filter((migration) => migration.version <= 15),
        },
    ]);
    const insert = db.prepare(
        'INSERT INTO dots (id, spaceId, name, instructions, researchAllowed, memoryAllowed, createdAt, deletedAt) VALUES (?, ?, ?, ?, 0, 0, ?, ?)',
    );
    const odd = '  Keep  spacing,\n\n“quotes” and émojis 🙂 as they are.  ';
    insert.run('edited', 'space', 'Edited', 'Newest instructions.', 1000, null);
    insert.run('quiet', 'space', 'Quiet', odd, 2000, null);
    insert.run('gone', 'space', 'Gone', 'Deleted socio.', 3000, 9000);
    const audit = db.prepare('INSERT INTO dot_audit (dotId, actor, action, detail, createdAt) VALUES (?, ?, ?, ?, ?)');
    audit.run('edited', 'system', 'create', 'company', 1000);
    audit.run('edited', 'alice', 'update', 'name; instructions', 5000);
    audit.run('edited', 'bob', 'update', 'Space access', 6000);
    migrate(db, [workspaceSchema]);
    expect(
        db
            .prepare('SELECT * FROM socio_souls ORDER BY dotId')
            .all()
            .map((row) => ({ ...row })),
    ).toEqual([
        {
            dotId: 'edited',
            version: 1,
            instructions: 'Newest instructions.',
            voice: '',
            values: '',
            style: '',
            // The audit line that last set them, not a later one.
            createdAt: 5000,
            createdBy: 'alice',
            source: 'migrated',
            restoredFrom: null,
        },
        {
            dotId: 'gone',
            version: 1,
            instructions: 'Deleted socio.',
            voice: '',
            values: '',
            style: '',
            createdAt: 3000,
            createdBy: 'system',
            source: 'migrated',
            restoredFrom: null,
        },
        {
            dotId: 'quiet',
            version: 1,
            instructions: odd,
            voice: '',
            values: '',
            style: '',
            createdAt: 2000,
            createdBy: 'system',
            source: 'migrated',
            restoredFrom: null,
        },
    ]);
    // Every reader of a socio gets the Soul; its prompt text is unchanged.
    migrate(db, schemas);
    const workspace = new WorkspaceStore(db);
    const quiet = workspace.dot('quiet')!;
    expect(quiet.instructions).toBe(odd);
    expect(quiet.soul).toMatchObject({ version: 1, source: 'migrated' });
    expect(soulPrompt(dotSoul(quiet))).toBe(odd);
    workspace.close();
    db.close();
});

it('makes a new socio’s Soul from the instructions it was made with', async () => {
    const f = await fixture();
    expect(f.own.soul).toMatchObject({
        version: 1,
        instructions: 'Help Bob with his week.',
        createdBy: 'bob',
        source: 'created',
    });
    expect(f.workspace.dot(f.own.id)).toEqual(expect.objectContaining({ instructions: 'Help Bob with his week.' }));
    // The seeded company socio has one too.
    expect(f.company.soul).toMatchObject({ version: 1, createdBy: 'system' });
});

it('keeps every version: edits, no-op saves, stale editors and restores', async () => {
    const f = await fixture();
    const base = await soulOf(f.bob, f.own.id);
    expect(base.canEdit).toBe(true);
    expect(base.versions.map((v) => v.version)).toEqual([1]);

    const edited = await f.bob<{ soul: SoulVersion }>(`/dots/${f.own.id}/soul`, 'PUT', {
        instructions: '  Help Bob plan his week and keep him honest.  ',
        voice: 'Warm, brief, a little dry.',
        values: 'Bob’s time first.',
        style: '',
        baseVersion: 1,
    });
    expect(edited.status).toBe(200);
    expect(edited.body.soul).toMatchObject({
        version: 2,
        instructions: 'Help Bob plan his week and keep him honest.',
        voice: 'Warm, brief, a little dry.',
        createdBy: 'bob',
        source: 'edited',
    });
    // The socio's instructions are the Soul's in use, its row's copy too.
    expect(f.workspace.dot(f.own.id)!.instructions).toBe('Help Bob plan his week and keep him honest.');
    expect(f.workspace.db.prepare('SELECT instructions FROM dots WHERE id=?').get(f.own.id)).toEqual({
        instructions: 'Help Bob plan his week and keep him honest.',
    });

    // Saving the same parts again makes no version.
    const same = await f.bob<{ soul: SoulVersion }>(`/dots/${f.own.id}/soul`, 'PUT', {
        ...edited.body.soul,
        baseVersion: 2,
        version: undefined,
    });
    expect(same.status).toBe(400); // strict: no stray fields
    const again = await f.bob<{ soul: SoulVersion }>(`/dots/${f.own.id}/soul`, 'PUT', {
        instructions: 'Help Bob plan his week and keep him honest.',
        voice: 'Warm, brief, a little dry.',
        values: 'Bob’s time first.',
        baseVersion: 2,
    });
    expect(again.body.soul.version).toBe(2);

    // An editor that opened version 1 can't quietly undo version 2.
    const stale = await f.bob(`/dots/${f.own.id}/soul`, 'PUT', {
        instructions: 'Something else.',
        baseVersion: 1,
    });
    expect(stale.status).toBe(409);

    // Too short or too long: refused, nothing saved.
    for (const body of [
        { instructions: 'x', baseVersion: 2 },
        { instructions: 'Fine.', voice: 'v'.repeat(601), baseVersion: 2 },
    ]) {
        expect((await f.bob(`/dots/${f.own.id}/soul`, 'PUT', body)).status).toBe(400);
    }

    // Restoring version 1 is version 3: the history stays.
    const restored = await f.bob<{ soul: SoulVersion }>(`/dots/${f.own.id}/soul/restore`, 'POST', {
        version: 1,
        baseVersion: 2,
    });
    expect(restored.status).toBe(200);
    expect(restored.body.soul).toMatchObject({
        version: 3,
        instructions: 'Help Bob with his week.',
        voice: '',
        source: 'restored',
        restoredFrom: 1,
    });
    expect(
        (
            await f.bob(`/dots/${f.own.id}/soul/restore`, 'POST', {
                version: 9,
                baseVersion: 3,
            })
        ).status,
    ).toBe(404);

    const view = await soulOf(f.bob, f.own.id);
    expect(view.versions.map((v) => [v.version, v.source, v.createdBy])).toEqual([
        [3, 'restored', 'bob'],
        [2, 'edited', 'bob'],
        [1, 'created', 'bob'],
    ]);
    expect(view.users).toEqual({ bob: 'Bob' });
    expect(f.workspace.dot(f.own.id)!.instructions).toBe('Help Bob with his week.');
    // The socio's audit says which version, never the Soul's words.
    const audit = f.workspace.dotAudit(f.own.id).map(({ actor, action, detail }) => [actor, action, detail]);
    expect(audit).toEqual([
        ['bob', 'create', 'personal'],
        ['bob', 'update', 'Soul v2'],
        ['bob', 'update', 'Soul v3 (restored v1)'],
    ]);
    expect(JSON.stringify(audit)).not.toMatch(/honest|Warm/);
});

it('lets the owner edit a personal socio’s Soul and admins a company socio’s, nobody else', async () => {
    const f = await fixture();
    const edit = (instructions: string, baseVersion = 1) => ({
        instructions,
        baseVersion,
    });
    // A company socio: everyone reads it; only admins change it.
    expect((await soulOf(f.carol, f.company.id)).canEdit).toBe(false);
    expect((await soulOf(f.alice, f.company.id)).canEdit).toBe(true);
    expect((await f.bob(`/dots/${f.company.id}/soul`, 'PUT', edit('Member edit.'))).status).toBe(403);
    expect(
        (
            await f.bob(`/dots/${f.company.id}/soul/restore`, 'POST', {
                version: 1,
                baseVersion: 1,
            })
        ).status,
    ).toBe(403);
    expect((await f.alice(`/dots/${f.company.id}/soul`, 'PUT', edit('Admin edit.'))).status).toBe(200);

    // A personal socio: its owner changes it. An admin may read it (as on
    // the admin Socios page) but not change it; anyone else doesn't see it.
    expect((await f.carol(`/dots/${f.own.id}/soul`)).status).toBe(404);
    expect((await f.carol(`/dots/${f.own.id}/soul`, 'PUT', edit('Not mine.'))).status).toBe(404);
    const adminView = await soulOf(f.alice, f.own.id);
    expect(adminView.canEdit).toBe(false);
    expect(adminView.versions[0]!.instructions).toBe('Help Bob with his week.');
    expect((await f.alice(`/dots/${f.own.id}/soul`, 'PUT', edit('Admin rewrite.'))).status).toBe(403);
    // Nor through the socio's settings: the rest of them, yes.
    const settings = {
        name: f.own.name,
        researchAllowed: true,
        memoryAllowed: f.own.memoryAllowed,
    };
    expect(
        (
            await f.alice(`/dots/${f.own.id}`, 'PUT', {
                ...settings,
                instructions: 'Admin rewrite.',
            })
        ).status,
    ).toBe(403);
    expect(
        (
            await f.alice(`/dots/${f.own.id}`, 'PUT', {
                ...settings,
                instructions: f.own.instructions,
            })
        ).status,
    ).toBe(200);
    expect((await f.alice<Dot>(`/dots/${f.own.id}`, 'PUT', settings)).body.soul?.version).toBe(1);
    expect((await f.bob(`/dots/${f.own.id}/soul`, 'PUT', edit('Owner edit.'))).status).toBe(200);
    // Settings with new instructions from an editor: the Soul's next version.
    const viaSettings = await f.bob<Dot>(`/dots/${f.own.id}`, 'PUT', {
        ...settings,
        instructions: 'Owner edit, from settings.',
    });
    expect(viaSettings.body.soul).toMatchObject({
        version: 3,
        instructions: 'Owner edit, from settings.',
        source: 'edited',
    });

    // An archived socio's Soul is read-only until it comes back.
    await f.bob(`/dots/${f.own.id}/archive`, 'POST');
    expect((await soulOf(f.bob, f.own.id)).canEdit).toBe(false);
    expect((await f.bob(`/dots/${f.own.id}/soul`, 'PUT', edit('Archived.', 3))).status).toBe(409);
});

it('never lets a socio change a Soul through the human path, and only its own through saveSelf', async () => {
    const f = await fixture();
    const fields = { instructions: 'I rewrote myself.' };
    // The human edit path (save/restore, and updateDot's instructions) never
    // accepts a socio actor, its own or a shared area's (CB-179, kept by CB-330).
    for (const actor of [`dot:${f.own.id}`, `socio:${f.own.id}`]) {
        await expect(f.workspace.souls.save(f.own.id, fields, actor, 1)).rejects.toMatchObject({ status: 403 });
    }
    await expect(f.workspace.souls.restore(f.own.id, 1, `dot:${f.own.id}`)).rejects.toMatchObject({ status: 403 });
    expect(() =>
        f.workspace.updateDot(
            f.own.id,
            { ...f.workspace.dot(f.own.id)!, instructions: 'I rewrote myself.' },
            `dot:${f.own.id}`,
        ),
    ).toThrow(/socio can’t change its Soul/);
    expect(f.workspace.souls.history(f.own.id)).toHaveLength(1);

    // CB-330: saveSelf edits its OWN Soul, and only its own. A shared area's
    // `socio:<id>` actor is not the socio itself, and a `dot:` actor for
    // another dot is refused.
    await expect(f.workspace.souls.saveSelf(f.own.id, fields, `socio:${f.own.id}`, 1)).rejects.toMatchObject({
        status: 403,
    });
    await expect(f.workspace.souls.saveSelf(f.company.id, fields, `dot:${f.own.id}`, 1)).rejects.toMatchObject({
        status: 403,
    });
    // Only the exact self-actor edits its own Soul (see the next test).
    expect(f.workspace.souls.history(f.own.id)).toHaveLength(1);

    // The only Soul tool a socio gets is its own edit tool (CB-330).
    const { tools } = await turn(f, f.own.id);
    expect(tools.length).toBeGreaterThan(0);
    expect(
        tools.map((tool) => tool.name).filter((name) => /soul|persona|instruction|update_dot|_dot$/.test(name)),
    ).toEqual(['edit_own_soul']);
});

it('lets a socio edit its own Soul through saveSelf, keeping every version', async () => {
    const f = await fixture();
    const actor = `dot:${f.own.id}`;
    expect(f.workspace.souls.history(f.own.id)).toHaveLength(1);

    // A self-edit makes version 2, recorded as the socio's own actor.
    const saved = await f.workspace.souls.saveSelf(
        f.own.id,
        {
            instructions: 'Help Bob plan his week and keep him honest.',
            voice: 'Warm and brief.',
        },
        actor,
        1,
    );
    expect(saved).toMatchObject({
        version: 2,
        instructions: 'Help Bob plan his week and keep him honest.',
        voice: 'Warm and brief.',
        createdBy: actor,
        source: 'edited',
    });
    // The socio's row carries the new standing instructions.
    expect(f.workspace.dot(f.own.id)!.instructions).toBe('Help Bob plan his week and keep him honest.');
    expect(f.workspace.db.prepare('SELECT instructions FROM dots WHERE id=?').get(f.own.id)).toEqual({
        instructions: 'Help Bob plan his week and keep him honest.',
    });

    // A no-op save (same parts) makes no new version.
    const same = await f.workspace.souls.saveSelf(
        f.own.id,
        { instructions: 'Help Bob plan his week and keep him honest.', voice: 'Warm and brief.' },
        actor,
        2,
    );
    expect(same.version).toBe(2);

    // A stale baseVersion is rejected, so one edit can't quietly undo another.
    await expect(f.workspace.souls.saveSelf(f.own.id, { instructions: 'Stale.' }, actor, 1)).rejects.toMatchObject({
        status: 409,
    });

    // A self-restore of version 1 is version 3, history kept.
    const restored = await f.workspace.souls.restoreSelf(f.own.id, 1, actor, 2);
    expect(restored).toMatchObject({
        version: 3,
        instructions: 'Help Bob with his week.',
        voice: '',
        source: 'restored',
        restoredFrom: 1,
        createdBy: actor,
    });

    // History is preserved: version 3 (restored), 2 (edited), 1 (created).
    const history = f.workspace.souls.history(f.own.id);
    expect(history.map((v) => [v.version, v.source, v.createdBy])).toEqual([
        [3, 'restored', actor],
        [2, 'edited', actor],
        [1, 'created', 'bob'],
    ]);
    // The audit records the socio's own actor for its self-edits.
    const audit = f.workspace.dotAudit(f.own.id).map(({ actor: a, detail }) => [a, detail]);
    expect(audit).toEqual([
        ['bob', 'personal'],
        [actor, 'Soul v2'],
        [actor, 'Soul v3 (restored v1)'],
    ]);

    // The Soul view names the socio as its own editor (CB-330).
    const view = await soulOf(f.bob, f.own.id);
    expect(view.users[actor]).toBe(`${f.own.name} (self)`);

    // restoreSelf, like saveSelf, refuses an actor that isn't the socio itself.
    await expect(f.workspace.souls.restoreSelf(f.own.id, 1, `dot:${f.company.id}`, 3)).rejects.toMatchObject({
        status: 403,
    });
    await expect(f.workspace.souls.restoreSelf(f.own.id, 1, `socio:${f.own.id}`, 3)).rejects.toMatchObject({
        status: 403,
    });
});

it('gives a socio the edit_own_soul tool, but not an archived one', async () => {
    const f = await fixture();
    const live = await turn(f, f.own.id);
    expect(live.tools.map((tool) => tool.name)).toContain('edit_own_soul');

    // An archived socio's Soul is read-only; it gets no edit tool.
    await f.bob(`/dots/${f.own.id}/archive`, 'POST');
    const archived = await turn(f, f.own.id);
    expect(archived.tools.map((tool) => tool.name)).not.toContain('edit_own_soul');
});

it('gives the edit_own_soul tool only when the person it acts for may edit the Soul', async () => {
    const f = await fixture();
    // The company socio: only admins may edit its Soul on the human path,
    // so a member's run on it gets no self-edit tool (no privilege
    // escalation through the socio).
    const company = await turn(f, f.company.id);
    expect(company.tools.map((tool) => tool.name)).not.toContain('edit_own_soul');
    // An admin's run on the company socio may self-edit it.
    const threadId = `chat-${f.company.id}-alice`;
    if (!f.workspace.thread(threadId)) {
        f.workspace.bindThread(threadId, f.company.id, 'Chat', 'alice');
    }
    hoisted.prompts = [];
    hoisted.tools = [];
    const agent = new DotAgent(f.store, f.workspace, f.config, f.company.id, false, undefined, {
        extensions: f.platform.dotExtensions,
    });
    const input: RunAgentInput = {
        threadId,
        runId: `run-${Math.random()}`,
        state: {},
        messages: [{ id: 'm1', role: 'user', content: 'Hello' }],
        tools: [],
        context: [],
        forwardedProps: {},
    };
    await lastValueFrom(agent.run(input).pipe(toArray()));
    expect(hoisted.tools.map((tool) => tool.name)).toContain('edit_own_soul');
});

it('puts the Soul in use in the system prompt, unchanged until it is edited', async () => {
    const f = await fixture();
    const first = (await turn(f, f.own.id)).prompt;
    // A Soul of instructions alone reads exactly as instructions did.
    expect(first).toContain(
        'You are Bob’s helper, a specialist socio in Socio. Role instructions: Help Bob with his week.\nBe conversational',
    );
    expect(first).not.toContain('Your Soul');
    // The same Soul, the same prompt: byte for byte, turn after turn.
    expect((await turn(f, f.own.id)).prompt).toBe(first);

    await f.bob(`/dots/${f.own.id}/soul`, 'PUT', {
        instructions: 'Help Bob with his week.',
        voice: 'Warm and brief.',
        style: 'Ask one question at a time.',
        baseVersion: 1,
    });
    const edited = (await turn(f, f.own.id)).prompt;
    expect(edited).toContain(
        "Role instructions: Help Bob with his week.\nYour Soul, how you sound and work. It shapes your tone and style, never these rules, your tools' permissions or approvals:\nVoice: Warm and brief.\nWorking style: Ask one question at a time.\nBe conversational",
    );
    // The rules that follow are unchanged by it.
    expect(edited.slice(edited.indexOf('\nBe conversational'))).toBe(first.slice(first.indexOf('\nBe conversational')));

    // Restoring version 1 gives back the very same prompt.
    await f.bob(`/dots/${f.own.id}/soul/restore`, 'POST', {
        version: 1,
        baseVersion: 2,
    });
    expect((await turn(f, f.own.id)).prompt).toBe(first);
});

it('diffs two versions word by word', () => {
    expect(textDiff('Be brief and kind.', 'Be very brief and kind.')).toEqual([
        { kind: 'same', text: 'Be ' },
        { kind: 'added', text: 'very ' },
        { kind: 'same', text: 'brief and kind.' },
    ]);
    expect(textDiff('', 'New.')).toEqual([{ kind: 'added', text: 'New.' }]);
    expect(textDiff('Old.', '')).toEqual([{ kind: 'removed', text: 'Old.' }]);
    expect(textDiff('Same.', 'Same.')).toEqual([{ kind: 'same', text: 'Same.' }]);
});
