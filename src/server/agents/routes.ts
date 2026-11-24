import { Hono, type Context } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { requireAdmin } from '@socio/foundation/http/guards';

import type { AuditShape } from '../workspace/contract.js';

import { AgentGrantError, type GrantAdminShape } from './contract.js';

/**
 * Connected agents (CB-90): each person's grants under Account →
 * Connected agents, and everyone's for admins (Admin → Connected agents),
 * with the allowlist of client domains. Revoking ends the agent's access
 * at once; it is audited, through `audit` (the workspace's).
 */
export function agentGrantRoutes(grants: GrantAdminShape, audit: AuditShape['audit']) {
    const app = new Hono<AppEnv>();
    const fail = (c: Context<AppEnv>, error: unknown) => {
        if (error instanceof AgentGrantError) {
            return c.json({ error: error.message }, error.status);
        }
        throw error;
    };
    const revoke = (c: Context<AppEnv>, owner?: string) => {
        const by = c.get('user').id;
        try {
            const grant = grants.revoke(c.req.param('id') ?? '', by, owner);
            audit({
                actor: by,
                action: 'revoke',
                targetKind: 'agent_grant',
                targetId: grant.grantId,
                detail: `${grant.label} for ${grant.userId}`,
            });
            return c.json(grant);
        } catch (error) {
            return fail(c, error);
        }
    };
    app.get('/agent-grants', (c) => c.json({ grants: grants.list(c.get('user').id) }));
    app.delete('/agent-grants/:id', (c) => revoke(c, c.get('user').id));
    app.use('/admin/agent-grants', requireAdmin);
    app.use('/admin/agent-grants/*', requireAdmin);
    app.get('/admin/agent-grants', (c) =>
        c.json({
            grants: grants.listAll(),
            settings: { allowedDomains: grants.allowedDomains() },
        }),
    );
    app.delete('/admin/agent-grants/:id', (c) => revoke(c));
    app.put('/admin/agent-grants/settings', async (c) => {
        const parsed = z
            .object({
                allowedDomains: z.array(z.string().trim().min(1).max(253)).max(50).nullable(),
            })
            .strict()
            .safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json({ error: 'Give a list of domains, or none to allow any.' }, 400);
        }
        try {
            return c.json({
                allowedDomains: grants.setAllowedDomains(parsed.data.allowedDomains),
            });
        } catch (error) {
            return fail(c, error);
        }
    });
    return app;
}
