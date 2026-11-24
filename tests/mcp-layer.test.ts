import type { DatabaseSync } from 'node:sqlite';

import { Context, Effect, Layer } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import { Approvals, type ApprovalsShape } from '../src/server/approvals/contract.js';
import { mcpLayers } from '../src/server/composition/mcp.js';
import { type AppBoot } from '../src/server/main.js';
import { Connections, McpConfig, McpConnectionError, Tools } from '../src/server/mcp/contract.js';
import { mcpError } from '../src/server/mcp/errors.js';
import {
    ConnectionsLive,
    McpConnectionsLive,
    McpConnectionsService,
    McpOAuthLive,
    McpOAuthService,
    McpRuntimeLive,
    McpRuntimeService,
    ToolsLive,
} from '../src/server/mcp/layer.js';
import {
    Conversations,
    People,
    Socios,
    type ConversationsShape,
    type PeopleShape,
    type SociosShape,
} from '../src/server/workspace/contract.js';

import { LocalAgentRunner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testAuth } from './helpers/test-auth.js';
import { testDatabase } from './helpers/test-database.js';
import { startWithTestPlatform } from './helpers/test-platform.js';

const opened: DatabaseSync[] = [];
const closing: Array<() => unknown> = [];
afterEach(async () => {
    for (const close of closing.splice(0).reverse()) {
        await close();
    }
    for (const db of opened.splice(0)) {
        db.close();
    }
    vi.unstubAllEnvs();
});

/** The slices the layers yield, as fakes: alice is active, bob deactivated; alice may use `dot-1`. */
function slices(register = vi.fn()) {
    const people = { users: () => [{ id: 'alice' }, { id: 'bob' }], isDeactivated: (id: string) => id === 'bob' };
    const socios = { canUseDot: (userId: string, dotId: string) => userId === 'alice' && dotId === 'dot-1' };
    const conversations = {
        answers: (id: string, dotId: string) => id === 'thread' && dotId === 'dot-1',
        allows: (userId: string, id: string) => userId === 'alice' && id === 'thread',
    };
    return Layer.mergeAll(
        Layer.succeed(People, people as unknown as PeopleShape),
        Layer.succeed(Socios, socios as unknown as SociosShape),
        Layer.succeed(Conversations, conversations as unknown as ConversationsShape),
        Layer.succeed(Approvals, { register } as unknown as ApprovalsShape),
    );
}

function mcpLayer(register = vi.fn(), config: { appOrigin?: string } = { appOrigin: 'https://socio.example.test' }) {
    const db = testDatabase();
    opened.push(db);
    const connections = ConnectionsLive.pipe(
        Layer.provideMerge(McpConnectionsLive(db, { legacy: 'fixture-key' })),
        Layer.provideMerge(Layer.succeed(McpConfig, config)),
    );
    const oauth = McpOAuthLive.pipe(Layer.provideMerge(connections));
    return ToolsLive.pipe(
        Layer.provideMerge(McpRuntimeLive),
        Layer.provideMerge(oauth),
        Layer.provide(slices(register)),
    );
}

it('offers the contract tags over the very services the folder uses, built once', async () => {
    const register = vi.fn();
    const context = await Effect.runPromise(Effect.scoped(Layer.build(mcpLayer(register))));
    const connections = Context.get(context, McpConnectionsService);
    expect(Context.get(context, Connections)).toBe(connections);
    expect(Context.get(context, Tools)).toBe(Context.get(context, McpRuntimeService));
    expect(Context.get(context, McpOAuthService).origin).toBe('https://socio.example.test');
    // The runtime registers its approval capability once, as it is built.
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]?.[0]).toMatchObject({ capability: 'external.mcp', manualOnly: true });
    expect(connections.running).toBe(true);
});

it('reads who may use a connection from the People and Socios slices', async () => {
    const context = await Effect.runPromise(Effect.scoped(Layer.build(mcpLayer())));
    const connections = Context.get(context, McpConnectionsService);
    expect(connections.list('alice')).toEqual([]);
    expect(() => connections.list('bob')).toThrow('active account');
    expect(() => connections.list('carol')).toThrow('active account');
    expect(() => connections.socio('alice', 'dot-2')).toThrow('Socio not found.');
    expect(() => connections.socio('alice', 'dot-1')).not.toThrow();
});

it('turns OAuth off without an origin', async () => {
    const context = await Effect.runPromise(Effect.scoped(Layer.build(mcpLayer(vi.fn(), {}))));
    expect(Context.get(context, McpOAuthService).origin).toBe('');
});

/** A service of the app's runtime. */
const read = <I, S>(tag: Context.Key<I, S>) =>
    Effect.gen(function* () {
        return yield* tag;
    });

/** A boot with the given origin, as the graph test's (`tests/app-graph.test.ts`). */
function boot(appOrigin: string | undefined): AppBoot {
    const db = testDatabase();
    const workspace = new WorkspaceStore(db);
    const store = new Store(db);
    closing.push(() => {
        store.close();
        workspace.close();
    });
    const config = { baseUrl: '', apiKey: '', model: '', voiceName: 'marin', runtimeUrl: '', appOrigin };
    return { db, store, workspace, config, runner: new LocalAgentRunner(testDatabase()), auth: testAuth() };
}

it.each([
    ['a supplied origin', 'https://app.example.invalid/some/path', 'https://app.example.invalid'],
    ['no origin', undefined, ''],
])('gives OAuth the supplied config, not the environment, through the graph: %s', async (_, appOrigin, origin) => {
    vi.stubEnv('APP_ORIGIN', 'https://env.example.invalid');
    const { runtime, platform } = await startWithTestPlatform(boot(appOrigin));
    closing.push(async () => {
        await platform.stop();
        await runtime.dispose();
    });
    expect(platform.mcpOAuth.origin).toBe(origin);
    expect(await runtime.runPromise(read(McpConfig))).toEqual({ appOrigin });
    // The graph's contract tags are the very services `Platform` holds.
    expect(await runtime.runPromise(read(Connections))).toBe(platform.mcpConnections);
    expect(await runtime.runPromise(read(Tools))).toBe(platform.mcpRuntime);
    expect(Object.keys(mcpLayers)).toEqual(['connections', 'oauth', 'runtime']);
});

it('keeps McpConnectionError an Error with its name, message and status', () => {
    const error = mcpError('Connection not found.', 404);
    expect(error).toBeInstanceOf(McpConnectionError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('McpConnectionError');
    expect(error._tag).toBe('McpConnectionError');
    expect(error.message).toBe('Connection not found.');
    expect(error.status).toBe(404);
    expect(String(error)).toBe('McpConnectionError: Connection not found.');
    expect(mcpError('Enter a public HTTPS MCP server URL.').status).toBe(400);
});
