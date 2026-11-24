// WorkspaceStore split into People, Spaces, Socios and Audit, and
// Conversations: the root provides the slices the store forwards to, so the
// tags and the legacy facade share one state.
import { Context, Effect, Layer, ManagedRuntime } from 'effect';
import { afterEach, expect, it } from 'vitest';

import { issuesModule } from '../src/server/issues/module.js';
import { startAppRuntime } from '../src/server/main.js';
import {
    Audit,
    Conversations,
    Socios,
    People,
    PeopleSync,
    Spaces,
    DELETE_BLOCKED,
    type AccessChange,
    type SociosShape,
    type PeopleShape,
} from '../src/server/workspace/contract.js';
import { PeopleSyncLive, WorkspaceLive } from '../src/server/workspace/layer.js';

import { LocalAgentRunner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testAuth } from './helpers/test-auth.js';
import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

function workspace() {
    const store = new WorkspaceStore(testDatabase());
    cleanup.push(() => store.close());
    return store;
}

it('the root provides the five slices the store forwards to', async () => {
    const ws = workspace();
    const store = new Store(testDatabase());
    cleanup.push(() => store.close());
    const config = {
        baseUrl: '',
        apiKey: '',
        model: '',
        voiceName: 'marin',
        runtimeUrl: '',
        appOrigin: 'https://app.example.invalid',
    };
    const { runtime } = await startAppRuntime({
        db: ws.db,
        store,
        workspace: ws,
        config,
        runner: new LocalAgentRunner(testDatabase()),
        auth: testAuth(),
        modules: [issuesModule],
    });
    cleanup.push(() => runtime.dispose());
    const context = await runtime.context();
    expect(Context.get(context, People)).toBe(ws.slices.people);
    expect(Context.get(context, Spaces)).toBe(ws.slices.spaces);
    expect(Context.get(context, Socios)).toBe(ws.slices.socios);
    expect(Context.get(context, Audit)).toBe(ws.slices.audit);
    expect(Context.get(context, Conversations)).toBe(ws.slices.conversations);
});

it('writes through the facade read back through the slices, and the other way', async () => {
    const ws = workspace();
    const runtime = ManagedRuntime.make(WorkspaceLive(ws));
    cleanup.push(() => runtime.dispose());

    ws.recordUser({ id: 'alice', name: 'Alice', role: 'admin' });
    const people = Context.get(await runtime.context(), People);
    expect(people.users().map((user) => user.id)).toEqual(['alice']);

    const [space] = ws.spaces();
    const made = await runtime.runPromise(
        Socios.use((dots) => Effect.sync(() => dots.createDot(space!.id, 'Heron', 'Be brief.', false, false))),
    );
    expect(ws.dot(made.id)?.name).toBe('Heron');
    expect(ws.dotAudit(made.id).map((line) => line.action)).toEqual(['create']);

    await runtime.runPromise(
        Audit.use((audit) =>
            Effect.sync(() => audit.audit({ actor: 'alice', action: 'delete', targetKind: 'page', targetId: 'p1' })),
        ),
    );
    expect(ws.auditOf('page', 'p1')).toMatchObject([{ actor: 'alice', action: 'delete' }]);

    const spaces = Context.get(await runtime.context(), Spaces);
    const other = ws.createSpace('Garden', 'Plants.');
    expect(spaces.spaces().map((entry) => entry.id)).toContain(other.id);
});

it('conversations written through the facade read back through the slice, and the other way', async () => {
    const ws = workspace();
    const runtime = ManagedRuntime.make(WorkspaceLive(ws));
    cleanup.push(() => runtime.dispose());
    ws.recordUser({ id: 'alice', name: 'Alice', role: 'member' });
    const [sebas] = ws.dots();

    const chat = ws.bindThread('t1', sebas!.id, 'Plans', 'alice');
    const conversations = Context.get(await runtime.context(), Conversations);
    expect(conversations.thread('t1')).toEqual(chat);
    expect((await conversations.conversations('alice')).map((row) => row.id)).toEqual(['t1']);

    const call = await runtime.runPromise(Conversations.use((slice) => Effect.sync(() => slice.createCall('t1'))));
    expect(ws.requireOwnedCall('alice', call.id).threadId).toBe('t1');
    ws.saveCapture('t1', { step: 2 });
    expect(conversations.capture('t1')).toEqual({ step: 2 });
    expect(ws.usedDot('alice', sebas!.id)).toBe(true);
    expect(conversations.usedDot('bob', sebas!.id)).toBe(false);

    // A call in progress blocks a delete, through either door.
    await expect(conversations.deleteThread('t1', 'alice')).rejects.toThrow(DELETE_BLOCKED.call);
    ws.setCall(call.id, 'ended', 'Bye.');
    await ws.deleteThread('t1', 'alice');
    expect(conversations.thread('t1')).toBeUndefined();
    expect(conversations.deletedThreadIds()).toEqual(['t1']);
});

it('access changes from any slice reach the store’s listeners', () => {
    const ws = workspace();
    const heard: AccessChange[] = [];
    ws.onAccessChange((change) => heard.push(change));
    ws.recordUser({ id: 'bob', name: 'Bob', role: 'member' });
    ws.slices.people.recordUser({ id: 'bob', name: 'Bob', role: 'admin' });
    const [sebas] = ws.dots();
    ws.slices.socios.archiveDot(sebas!.id, 'bob');
    expect(heard).toEqual([{ personId: 'bob' }, { socioId: sebas!.id }]);
    heard.length = 0;
    ws.unarchiveDot(sebas!.id, 'bob');
    heard.length = 0;
    ws.bindThread('t2', sebas!.id, 'Notes', 'bob');
    ws.slices.conversations.setArchived('t2', true, 'bob');
    expect(heard).toEqual([{ conversationId: 't2' }]);

    const spaces: string[] = [];
    ws.onSpaceAccessChange((spaceId) => spaces.push(spaceId));
    ws.slices.spaces.spaceChanged('s1');
    expect(spaces).toEqual(['s1']);
});

it('PeopleSync reads the People and Socios tags, so a fake swaps in', async () => {
    const people = {
        users: () => [{ id: 'carol', name: 'Carol', role: 'admin' }],
        isDeactivated: (id: string) => id === 'dave',
    } as unknown as PeopleShape;
    const dots = { dot: (id: string) => (id === 'd1' ? { name: 'Heron', ownerId: null } : undefined) };
    const runtime = ManagedRuntime.make(
        PeopleSyncLive.pipe(
            Layer.provide(
                Layer.mergeAll(Layer.succeed(People, people), Layer.succeed(Socios, dots as unknown as SociosShape)),
            ),
        ),
    );
    cleanup.push(() => runtime.dispose());
    const sync = Context.get(await runtime.context(), PeopleSync);
    expect(sync.userExists('carol')).toBe(true);
    expect(sync.userExists('erin')).toBe(false);
    expect(sync.canManageDependencies('carol')).toBe(true);
    expect(sync.deactivated('dave')).toBe(true);
    expect(sync.user('carol')?.name).toBe('Carol');
    expect(sync.dot('d1')).toEqual({ name: 'Heron', ownerId: null });
});
