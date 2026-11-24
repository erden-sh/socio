// The socio's own Soul tool is a layer over `Souls` and the workspace's
// slices, and answers as the module's hook does; `SoulError` is a tagged error
// that reads as the plain one did; in the server's graph the tags hold the
// workspace's Souls.
import type { ToolDefinition } from '@copilotkit/runtime/v2';
import { Context, Effect, Layer } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import type { DotTurn } from '@socio/foundation/turns/turn';

import { SoulError, Souls, SoulTools } from '../src/server/souls/contract.js';
import { SoulToolsLive } from '../src/server/souls/layer.js';
import { soulsModule } from '../src/server/souls/module.js';
import { WorkspaceLive } from '../src/server/workspace/layer.js';

import { testModuleServices } from './helpers/module-services.js';
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
    vi.restoreAllMocks();
});

const config = {
    baseUrl: '',
    apiKey: '',
    model: '',
    voiceName: 'marin',
    runtimeUrl: '',
    appOrigin: 'https://app.example.invalid',
};

function workspaceWithSocio() {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    workspace.recordUser({ id: 'alice', name: 'Alice', role: 'admin' });
    workspace.recordUser({ id: 'bob', name: 'Bob', role: 'member' });
    const space = workspace.spaces()[0]!.id;
    const dot = workspace.createDot(space, 'Helper', 'Help the team.', false, false);
    return { workspace, dot };
}

const turnOf = (dot: DotTurn['dot'], userId: string) =>
    ({
        dot,
        userId,
        threadId: 'thread',
        channel: false,
        purpose: 'chat',
        check: () => {},
        signal: new AbortController().signal,
        toolNames: () => [],
    }) as unknown as DotTurn;

type Execute = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
const execute = (tool: ToolDefinition) => (tool as unknown as { execute: Execute }).execute;

it('the tags carry their keys', () => {
    expect([Souls.key, SoulTools.key]).toEqual(['socio/souls/Souls', 'socio/souls/SoulTools']);
});

it('SoulError is tagged and reads as the plain error did', () => {
    const error = new SoulError({ message: 'Socio not found.', status: 404 });
    expect(error).toBeInstanceOf(Error);
    expect(error._tag).toBe('SoulError');
    expect(error.name).toBe('SoulError');
    expect(error.message).toBe('Socio not found.');
    expect(error.status).toBe(404);
    expect(String(error)).toBe('SoulError: Socio not found.');
});

it('builds the socio’s Soul tool from the tags, as the module’s hook does', async () => {
    const { workspace, dot } = workspaceWithSocio();
    const tools = await Effect.runPromise(
        Effect.gen(function* () {
            return yield* SoulTools;
        }).pipe(
            Effect.provide(
                SoulToolsLive.pipe(
                    Layer.provide(Layer.mergeAll(WorkspaceLive(workspace), Layer.succeed(Souls, workspace.souls))),
                ),
            ),
        ),
    );
    const context = { platform: { workspace }, services: testModuleServices({ workspace }) } as unknown as Parameters<
        NonNullable<typeof soulsModule.dotTools>
    >[0];
    // An admin may edit a company socio's Soul; a member may not.
    const forAlice = tools.tools(turnOf(dot, 'alice'));
    expect(forAlice.map((tool) => tool.name)).toEqual(['edit_own_soul']);
    expect(forAlice.map((tool) => tool.description)).toEqual(
        soulsModule.dotTools!(context, turnOf(dot, 'alice')).map((tool) => tool.description),
    );
    expect(tools.tools(turnOf(dot, 'bob'))).toEqual([]);
    expect(soulsModule.dotTools!(context, turnOf(dot, 'bob'))).toEqual([]);

    const saved = await execute(forAlice[0]!)({ instructions: 'Help the whole team, briefly.', baseVersion: 1 });
    expect(saved).toMatchObject({ status: 'saved', version: 2 });
    expect(workspace.souls.current(dot.id)).toMatchObject({ version: 2, createdBy: `dot:${dot.id}` });

    // A stale version: the SoulError's message and status, as a tool error.
    const stale = await execute(forAlice[0]!)({ instructions: 'Something else entirely.', baseVersion: 1 });
    expect(JSON.stringify(stale)).toContain('Someone changed this Soul since you opened it.');
    expect(workspace.souls.current(dot.id)?.version).toBe(2);
});

it('in the server’s graph, the tags hold the workspace’s Souls', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const db = testDatabase();
    const workspace = new WorkspaceStore(db);
    const store = new Store(db);
    const { runtime, platform } = await startWithTestPlatform({
        db,
        store,
        workspace,
        config,
        runner: new LocalAgentRunner(testDatabase()),
        auth: testAuth(),
    });
    cleanup.push(async () => {
        await platform.stop();
        await runtime.dispose();
        store.close();
        workspace.close();
    });
    const context = await runtime.context();
    expect(Context.get(context, Souls)).toBe(workspace.souls);
    workspace.recordUser({ id: 'alice', name: 'Alice', role: 'admin' });
    const dot = workspace.createDot(workspace.spaces()[0]!.id, 'Helper', 'Help the team.', false, false);
    expect(
        Context.get(context, SoulTools)
            .tools(turnOf(dot, 'alice'))
            .map((tool) => tool.name),
    ).toEqual(['edit_own_soul']);
});
