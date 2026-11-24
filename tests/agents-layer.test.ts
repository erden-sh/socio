import { Context, Effect, Layer } from 'effect';
// Connected agents' layer and the composition's step build one `AgentGrants`
// on the workspace connection, offered under every tag, with `AgentTokens`
// resolving through it.
import { Hono } from 'hono';
import { afterEach, expect, it } from 'vitest';

import type { AppEnv } from '@socio/foundation/http/app-env';

import { AgentTokens, GrantAdmin, Grants } from '../src/server/agents/contract.js';
import { AgentGrants } from '../src/server/agents/grants.js';
import { AgentGrantsLive, AgentGrantsService } from '../src/server/agents/layer.js';
import { agentGrantRoutes } from '../src/server/agents/routes.js';
import { agentsLayers, buildAgentGrants, LegacyAgentGrants } from '../src/server/composition/agents.js';
import { LegacyWorkspace } from '../src/server/composition/base.js';
import type { WorkspaceAuditEntry } from '../src/server/workspace/contract.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
    for (const fn of cleanup.splice(0).reverse()) {
        fn();
    }
});

/** A workspace on a test database: the grants' tables are its modules'. */
function workspace() {
    const store = new WorkspaceStore(testDatabase());
    cleanup.push(() => store.close());
    store.recordUser({ id: 'alice', name: 'Alice', role: 'admin' });
    return store;
}

const GRANT = {
    userId: 'alice',
    authUserId: 'auth-alice',
    clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
    clientName: 'Claude Code',
    clientDomain: 'claude.ai',
    label: 'Claude Code on a laptop',
    scopes: ['issues:read'],
    resource: 'http://localhost/mcp',
    redirectUri: 'http://localhost:3000/callback',
};

it('offers one AgentGrants as AgentGrantsService, Grants and GrantAdmin, and AgentTokens through it', async () => {
    const { db } = workspace();
    const context = await Effect.runPromise(Layer.build(AgentGrantsLive(db)).pipe(Effect.scoped));
    const grants = Context.get(context, AgentGrantsService);
    expect(grants).toBeInstanceOf(AgentGrants);
    expect(Context.get(context, Grants)).toBe(grants);
    expect(Context.get(context, GrantAdmin)).toBe(grants);
    // The resolver is the grants', read at each call: no token, no actor.
    const tokens = Context.get(context, AgentTokens);
    expect(tokens).toBeTypeOf('function');
    expect(await tokens!('cbat_nope', 'http://localhost/mcp')).toBeNull();
    // A grant made through Grants is what GrantAdmin lists.
    const made = Context.get(context, Grants).create(GRANT);
    expect(
        Context.get(context, GrantAdmin)
            .list('alice')
            .map((one) => one.grantId),
    ).toEqual([made.grantId]);
});

it("builds the graph's step on the workspace connection, under the legacy tag too", async () => {
    const store = workspace();
    const layer = agentsLayers.grants.pipe(Layer.provide(Layer.succeed(LegacyWorkspace, store)));
    const context = await Effect.runPromise(Layer.build(layer).pipe(Effect.scoped));
    const grants = Context.get(context, LegacyAgentGrants);
    expect(LegacyAgentGrants).toBe(AgentGrantsService);
    expect(Context.get(context, Grants)).toBe(grants);
    expect(Context.get(context, GrantAdmin)).toBe(grants);
    // The same tables `Platform`'s own constructor reads.
    const made = grants.create(GRANT);
    expect(
        buildAgentGrants(store)
            .list('alice')
            .map((one) => one.grantId),
    ).toEqual([made.grantId]);
});

it('revokes through GrantAdmin and audits through the given audit, as before', async () => {
    const { db } = workspace();
    const grants = new AgentGrants(db);
    const made = grants.create(GRANT);
    const audited: WorkspaceAuditEntry[] = [];
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
        c.set('user', { id: 'alice', name: 'Alice', role: 'admin' });
        await next();
    });
    app.route(
        '/api',
        agentGrantRoutes(grants, (entry) => audited.push(entry)),
    );
    const gone = await app.request(`/api/agent-grants/${made.grantId}`, { method: 'DELETE' });
    expect(gone.status).toBe(200);
    expect(audited).toEqual([
        {
            actor: 'alice',
            action: 'revoke',
            targetKind: 'agent_grant',
            targetId: made.grantId,
            detail: 'Claude Code on a laptop for alice',
        },
    ]);
    const missing = await app.request('/api/agent-grants/nope', { method: 'DELETE' });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Connected agent not found.' });
    expect(audited).toHaveLength(1);
});

it("counts a person's live grants as revokeAllOf would revoke them (CB-360's preview)", () => {
    const { db } = workspace();
    const grants = new AgentGrants(db);
    grants.create(GRANT);
    expect(grants.countOf(GRANT.userId)).toBe(1);
    expect(grants.countOf('nobody')).toBe(0);
    expect(grants.revokeAllOf(GRANT.userId, 'alice')).toBe(1);
    expect(grants.countOf(GRANT.userId)).toBe(0);
});
