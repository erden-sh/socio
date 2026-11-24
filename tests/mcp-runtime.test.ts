import { afterEach, expect, it, vi } from 'vitest';

import type { DotTurn } from '@socio/foundation/turns/turn';

import { sqliteApprovals } from '../src/server/approvals/services.js';
import { McpConnections } from '../src/server/mcp/connections.js';
import { McpConnectionRepository } from '../src/server/mcp/infra/sqlite/repository.js';
import { McpOAuth } from '../src/server/mcp/oauth.js';
import { McpRuntime } from '../src/server/mcp/runtime.js';

import { mcpProvider } from './helpers/mcp-provider.js';
import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) {
        await close();
    }
});
async function fixture(configure?: (provider: ReturnType<typeof mcpProvider>) => void) {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    const active = new Set(['alice', 'bob']);
    const repository = new McpConnectionRepository(workspace.db),
        connections = new McpConnections(
            repository,
            { legacy: 'fixture-key' },
            { active: (id) => active.has(id), socio: () => true },
        );
    const provider = mcpProvider(),
        oauth = new McpOAuth(connections, 'https://socio.example.test', provider.network);
    configure?.(provider);
    const decider = vi.fn(async () => {
        throw new Error('Must never call decision model');
    });
    const approvals = sqliteApprovals(workspace.db, {
        auto: { decider: { decide: decider } },
    });
    const runtime = new McpRuntime(connections, oauth, approvals, {
        thread: (id, userId) => id === 'thread' && userId === 'alice',
        network: provider.network,
    });
    const row = await connections.create('alice', {
        name: 'Fixture server',
        url: 'https://mcp.example.test/mcp',
    });
    const discovery = await oauth.discover('alice', row.id),
        authorization = await oauth.authorize('alice', row.id, {
            generation: discovery.connection.generation,
            scopes: ['crm.read'],
        });
    const nonce = new URL(authorization.authorizationUrl).searchParams.get('state')!;
    await oauth.callback('alice', nonce, authorization.cookie, 'fixture-code');
    await oauth.catalog('alice', row.id);
    const ready = connections.get('alice', row.id),
        dot = workspace.dots()[0];
    const grant = {
        generation: ready.generation,
        catalogRevision: ready.catalogRevision!,
        dotId: dot.id,
        tools: ['read_records'],
    };
    await connections.grant('alice', row.id, grant);
    const turn: DotTurn = {
        dot,
        userId: 'alice',
        threadId: 'thread',
        channel: false,
        purpose: 'chat',
        check: () => {},
        signal: new AbortController().signal,
        toolNames: () => [],
    };
    const calls = () => provider.requests.filter((r) => r.body.includes('"method":"tools/call"'));
    return {
        workspace,
        repository,
        connections,
        provider,
        oauth,
        approvals,
        runtime,
        row: ready,
        dot,
        grant,
        turn,
        active,
        calls,
        decider,
    };
}
it('requires human approval even with persisted bypass/auto and preserves complete exact arguments', async () => {
    const f = await fixture();
    for (const policy of ['auto', 'bypass'] as const) {
        await expect(f.approvals.setPolicy('alice', f.dot.id, 'external.mcp', policy)).rejects.toThrow(
            'requires your approval',
        );
    }
    // A stale/forged legacy policy must not bypass the server-side invariant.
    f.workspace.db
        .prepare('INSERT INTO approval_policies(userId,dotId,capability,policy,updatedAt) VALUES(?,?,?,?,?)')
        .run('alice', f.dot.id, 'external.mcp', 'bypass', 1);
    expect(await f.approvals.policy('alice', f.dot.id, 'external.mcp')).toBe('manual');
    expect(await f.approvals.policies('alice')).toMatchObject([{ policy: 'manual' }]);
    const args = { limit: 2 },
        pending = await f.runtime.request(f.turn, {
            connection_id: f.row.id,
            tool: 'read_records',
            arguments: args,
        });
    args.limit = 5;
    expect(pending.status).toBe('pending_approval');
    expect(f.calls()).toHaveLength(0);
    const view = await f.approvals.get(pending.id, 'alice');
    expect(view.details).toContain('Complete arguments: {"limit":2}');
    await expect(f.approvals.decide(pending.id, 'bob', true)).rejects.toThrow('not found');
    const result = await f.approvals.decide(pending.id, 'alice', true);
    expect(result.outcome).toContain('completed');
    expect(f.calls()).toHaveLength(1);
    expect(JSON.parse(f.calls()[0].body).params.arguments).toEqual({ limit: 2 });
    const saved = f.runtime.result('alice', f.dot.id, pending.call_id);
    expect(saved.state).toBe('succeeded');
    expect(JSON.parse(saved.text)).toMatchObject({
        untrusted_external_result: true,
        content: [{ type: 'text', text: 'Fixture result' }],
    });
    await expect(f.approvals.decide(pending.id, 'alice', true)).rejects.toThrow('already decided');
    expect(f.calls()).toHaveLength(1);
    expect(f.decider).not.toHaveBeenCalled();
    expect(() => f.runtime.result('bob', f.dot.id, pending.call_id)).toThrow('not found');
    await f.connections.remove('alice', f.row.id);
    expect(f.runtime.tools(f.turn).some((tool) => tool.name === 'read_mcp_call_result')).toBe(true);
    expect(f.runtime.result('alice', f.dot.id, pending.call_id).text).toBe(saved.text);
});
it('rejects invalid arguments before planning, and stale grant/catalog approvals before dispatch', async () => {
    const f = await fixture();
    await expect(
        f.runtime.request(f.turn, {
            connection_id: f.row.id,
            tool: 'read_records',
            arguments: { limit: 6 },
        }),
    ).rejects.toThrow('schema');
    expect(f.calls()).toHaveLength(0);
    const stale = await f.runtime.request(f.turn, {
        connection_id: f.row.id,
        tool: 'read_records',
        arguments: { limit: 1 },
    });
    await f.connections.grant('alice', f.row.id, { ...f.grant, tools: [] });
    await f.connections.grant('alice', f.row.id, f.grant);
    await f.approvals.decide(stale.id, 'alice', true);
    expect(f.calls()).toHaveLength(0);
    const changed = await f.runtime.request(f.turn, {
        connection_id: f.row.id,
        tool: 'read_records',
        arguments: { limit: 1 },
    });
    f.provider.tools[0].description = 'Changed after consent';
    const outcome = await f.approvals.decide(changed.id, 'alice', true);
    expect(outcome.outcome).toContain('not sent');
    expect(f.calls()).toHaveLength(0);
    expect(f.connections.get('alice', f.row.id).state).toBe('review');
    expect(f.connections.grants('alice', f.row.id)).toEqual([]);
});
it('records unknown delivery without resending on authorization failures or restart', async () => {
    for (const status of [401, 403, 500]) {
        const f = await fixture(),
            original = f.provider.network.request!;
        f.provider.network.request = async (url, address, init, signal) => {
            if (typeof init.body === 'string' && JSON.parse(init.body).method === 'tools/call') {
                return new Response('{"error":"provider-private-token"}', {
                    status,
                    headers: { 'content-type': 'application/json' },
                });
            }
            return original(url, address, init, signal);
        };
        let attempts = 0;
        const intercept = f.provider.network.request;
        f.provider.network.request = async (...args) => {
            if (typeof args[2].body === 'string' && JSON.parse(args[2].body).method === 'tools/call') {
                attempts++;
            }
            return intercept(...args);
        };
        const pending = await f.runtime.request(f.turn, {
            connection_id: f.row.id,
            tool: 'read_records',
            arguments: { limit: 1 },
        });
        const outcome = await f.approvals.decide(pending.id, 'alice', true);
        expect(outcome.outcome).toContain('unknown outcome');
        expect(outcome.outcome).not.toContain('provider-private-token');
        expect(attempts).toBe(1);
        expect(f.runtime.result('alice', f.dot.id, pending.call_id)).toMatchObject({
            state: 'unknown',
            text: '',
            replay_allowed: false,
        });
        await f.repository.recoverCalls(Date.now());
        await expect(f.approvals.decide(pending.id, 'alice', true)).rejects.toThrow('already decided');
        expect(attempts).toBe(1);
    }
});
it('revokes active operations and suppresses late results after disconnect or stop', async () => {
    for (const action of ['disconnect', 'stop', 'catalog', 'deactivate']) {
        const f = await fixture(),
            original = f.provider.network.request!;
        let release!: () => void, entered!: () => void;
        const enteredPromise = new Promise<void>((resolve) => (entered = resolve)),
            held = new Promise<void>((resolve) => (release = resolve));
        f.provider.network.request = async (...args) => {
            if (typeof args[2].body === 'string' && JSON.parse(args[2].body).method === 'tools/call') {
                entered();
                await held;
            }
            return original(...args);
        };
        const pending = await f.runtime.request(f.turn, {
                connection_id: f.row.id,
                tool: 'read_records',
                arguments: { limit: 1 },
            }),
            decision = f.approvals.decide(pending.id, 'alice', true);
        await enteredPromise;
        if (action === 'stop') {
            f.connections.stop();
        } else if (action === 'catalog') {
            await f.oauth.catalog('alice', f.row.id);
        } else if (action === 'deactivate') {
            f.active.delete('alice');
            await f.connections.forgetUser('alice');
        } else {
            await f.connections.disconnect('alice', f.row.id);
        }
        release();
        await decision;
        expect(f.repository.call('alice', pending.call_id)).toMatchObject({
            state: action === 'stop' ? 'sending' : 'unknown',
            result: null,
        });
        f.connections.resume();
        await f.repository.recoverCalls(Date.now());
        expect(f.repository.call('alice', pending.call_id)?.state).toBe('unknown');
    }
});
it('does not expose personal external tools to autonomous, channel or unowned conversations', async () => {
    const f = await fixture();
    expect(f.runtime.tools(f.turn).map((t) => t.name)).toEqual([
        'list_mcp_connections',
        'describe_mcp_tool',
        'call_mcp_tool',
        'read_mcp_call_result',
    ]);
    for (const override of [
        { purpose: 'scheduled' as const },
        { purpose: 'approval' as const },
        { channel: true },
        { cause: { kind: 'schedule' as const, id: 'task' } },
        { threadId: 'foreign' },
        { userId: 'bob' },
    ]) {
        expect(f.runtime.tools({ ...f.turn, ...override })).toEqual([]);
    }
});
it('shows the complete largest accepted argument value and rejects oversized consent before planning', async () => {
    const f = await fixture((provider) =>
        Object.assign(provider.tools[0], {
            inputSchema: {
                type: 'object',
                properties: { note: { type: 'string' } },
                required: ['note'],
                additionalProperties: false,
            },
        }),
    );
    const args = { note: 'é'.repeat(2042) }; // 4095 UTF-8 bytes as canonical JSON.
    expect(Buffer.byteLength(JSON.stringify(args))).toBeLessThanOrEqual(4096);
    const pending = await f.runtime.request(f.turn, {
        connection_id: f.row.id,
        tool: 'read_records',
        arguments: args,
    });
    const details = (await f.approvals.get(pending.id, 'alice')).details;
    expect(details).toContain('Complete arguments: ' + JSON.stringify(args));
    expect(details.every((line) => line.length <= 8192)).toBe(true);
    await expect(
        f.runtime.request(f.turn, {
            connection_id: f.row.id,
            tool: 'read_records',
            arguments: { note: args.note + 'é' },
        }),
    ).rejects.toThrow('size limit');
    await f.approvals.decide(pending.id, 'alice', true);
    expect(JSON.parse(f.calls()[0].body).params.arguments).toEqual(args);
});
it('validates structured output in the worker and returns text/JSON as durable paged untrusted data', async () => {
    for (const total of [1, 0]) {
        const text = 'Saved untrusted result '.repeat(1000);
        const f = await fixture((provider) => {
            Object.assign(provider.tools[0], {
                outputSchema: {
                    type: 'object',
                    properties: { total: { type: 'integer', minimum: 1 } },
                    required: ['total'],
                },
            });
            const original = provider.network.request!;
            provider.network.request = async (...args) => {
                if (typeof args[2].body === 'string') {
                    const request = JSON.parse(args[2].body);
                    if (request.method === 'tools/call') {
                        return new Response(
                            JSON.stringify({
                                jsonrpc: '2.0',
                                id: request.id,
                                result: {
                                    structuredContent: { total },
                                    content: [
                                        { type: 'text', text },
                                        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
                                        {
                                            type: 'resource_link',
                                            uri: 'https://private.example/resource',
                                            name: 'Never fetched',
                                        },
                                    ],
                                },
                            }),
                            { headers: { 'content-type': 'application/json' } },
                        );
                    }
                }
                return original(...args);
            };
        });
        const pending = await f.runtime.request(f.turn, {
            connection_id: f.row.id,
            tool: 'read_records',
            arguments: { limit: 1 },
        });
        await f.approvals.decide(pending.id, 'alice', true);
        if (total === 0) {
            expect(f.runtime.result('alice', f.dot.id, pending.call_id)).toMatchObject({ state: 'unknown', text: '' });
        } else {
            let offset = 0,
                complete = '';
            while (true) {
                const page = f.runtime.result('alice', f.dot.id, pending.call_id, offset);
                complete += page.text;
                if (page.next_offset === null) {
                    break;
                }
                offset = page.next_offset;
            }
            expect(JSON.parse(complete)).toEqual({
                untrusted_external_result: true,
                isError: false,
                structuredContent: { total },
                content: [
                    { type: 'text', text },
                    { type: 'omitted', original_type: 'image' },
                    { type: 'omitted', original_type: 'resource_link' },
                ],
            });
        }
        expect(f.provider.requests.some((r) => r.url.includes('private.example'))).toBe(false);
    }
});
