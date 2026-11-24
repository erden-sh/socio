// Page moves built by the composition root, behind a tag.
import { Context, Effect, Layer } from 'effect';
import { afterEach, expect, it } from 'vitest';

import { type AppBoot } from '../src/server/main.js';
import { PageMoves, type PageMovesShape } from '../src/server/pages/contract.js';
import { PageMovesLive } from '../src/server/pages/layer.js';
import { SqlitePageMoves } from '../src/server/pages/page-moves.js';

import { LocalAgentRunner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testAuth } from './helpers/test-auth.js';
import { testDatabase } from './helpers/test-database.js';
import { startWithTestPlatform } from './helpers/test-platform.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const config = { baseUrl: '', apiKey: '', model: '', voiceName: 'marin', runtimeUrl: '' };

function boot(): AppBoot {
    const workspace = new WorkspaceStore(testDatabase());
    const store = new Store(testDatabase());
    cleanup.push(() => {
        store.close();
        workspace.close();
    });
    return {
        db: workspace.db,
        store,
        workspace,
        config,
        runner: new LocalAgentRunner(testDatabase()),
        auth: testAuth(),
        modules: [],
    };
}

it('builds page moves once at startup and hands them to Platform', async () => {
    const app = boot();
    const { runtime, platform } = await startWithTestPlatform(app);
    cleanup.push(() => runtime.dispose());
    const moves = Context.get(await runtime.context(), PageMoves);
    expect(moves).toBeInstanceOf(SqlitePageMoves);
    expect(platform.pageMoves).toBe(moves);
    // The workspace no longer builds its own.
    expect('pageMoves' in app.workspace).toBe(false);

    // A move through the tag is a move on the workspace's pages.
    const [from] = app.workspace.spaces();
    const to = app.workspace.createSpace('Elsewhere', '');
    const page = await app.workspace.pages.create(from.id, { title: 'Notes' });
    const moved = await runtime.runPromise(
        PageMoves.use((service) => Effect.promise(() => service.move({ spaceId: from.id, id: page.id, to: to.id }))),
    );
    expect(moved).toMatchObject({ from: from.id, moved: [page.id], page: { spaceId: to.id } });
    expect(await platform.pageMoves.locate(page.id)).toBe(to.id);
});

it('lets a test swap the layer: a fake satisfies the same contract', async () => {
    const located: string[] = [];
    const fake: PageMovesShape = {
        move: () => Promise.reject(new Error('not in this test')),
        locate: async (id) => (located.push(id), 'space-1'),
    };
    const program = PageMoves.use((service) => Effect.promise(() => service.locate('p1')));
    expect(await Effect.runPromise(program.pipe(Effect.provide(Layer.succeed(PageMoves, fake))))).toBe('space-1');
    expect(located).toEqual(['p1']);

    // And the real layer, on its own, over a workspace's connection and pages.
    const { workspace } = boot();
    const [space] = workspace.spaces();
    const page = await workspace.pages.create(space.id, { title: 'Here' });
    const real = PageMoves.use((service) => Effect.promise(() => service.locate(page.id)));
    expect(await Effect.runPromise(real.pipe(Effect.provide(PageMovesLive(workspace.db, workspace.pages))))).toBe(
        space.id,
    );
});
