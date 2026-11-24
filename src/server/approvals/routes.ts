import { Hono, type Context } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { APPROVAL_POLICIES, AUTO_GUIDANCE_MAX, type ApprovalsState } from '@socio/shared/approvals';

import { ApprovalError } from './contract.js';
import type { ApprovalRoutesPlatform } from './sources.js';
import { approvalsView } from './views.js';

const decision = z.object({ decision: z.enum(['approve', 'deny']) }).strict();
const policy = z
    .object({
        dotId: z.string().min(1).max(64),
        capability: z.string().min(1).max(64),
        policy: z.enum(APPROVAL_POLICIES),
    })
    .strict();
const guidance = z.object({ guidance: z.string().max(AUTO_GUIDANCE_MAX * 2) }).strict();

/**
 * Approvals, for the signed-in user only: their requests, decisions and
 * policies. Nobody, admins included, sees or decides another user's.
 */
export function approvalRoutes(platform: ApprovalRoutesPlatform) {
    const app = new Hono<AppEnv>();
    const { approvals } = platform;
    const fail = (c: Context<AppEnv>, error: unknown) => {
        if (error instanceof ApprovalError) {
            return c.json({ error: error.message }, error.status);
        }
        throw error;
    };
    // `?review=auto`: recent decisions only from requests an auto review saw.
    app.get('/approvals', async (c) =>
        c.json<ApprovalsState>(
            await approvalsView(platform, c.get('user').id, {
                auto: c.req.query('review') === 'auto',
            }),
        ),
    );
    app.put('/approvals/guidance', async (c) => {
        const parsed = guidance.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json({ error: `Keep the guidance under ${AUTO_GUIDANCE_MAX} characters.` }, 400);
        }
        try {
            return c.json({
                guidance: await approvals.setGuidance(c.get('user').id, parsed.data.guidance),
            });
        } catch (error) {
            return fail(c, error);
        }
    });
    app.put('/approvals/policies', async (c) => {
        const parsed = policy.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json({ error: 'Choose a socio, a capability and manual, auto or bypass.' }, 400);
        }
        if (!platform.workspace.canUseDot(c.get('user').id, parsed.data.dotId)) {
            return c.json({ error: 'Socio not found.' }, 404);
        }
        try {
            return c.json(
                await approvals.setPolicy(
                    c.get('user').id,
                    parsed.data.dotId,
                    parsed.data.capability,
                    parsed.data.policy,
                ),
            );
        } catch (error) {
            return fail(c, error);
        }
    });
    app.get('/approvals/:id', async (c) => {
        try {
            return c.json(await approvals.get(c.req.param('id'), c.get('user').id));
        } catch (error) {
            return fail(c, error);
        }
    });
    app.post('/approvals/:id/decision', async (c) => {
        const parsed = decision.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json({ error: 'Approve or deny.' }, 400);
        }
        try {
            return c.json(
                await approvals.decide(c.req.param('id'), c.get('user').id, parsed.data.decision === 'approve'),
            );
        } catch (error) {
            return fail(c, error);
        }
    });
    // Details too long to show inline (CB-232): their person opens them
    // here, which is what lets Approve work.
    app.post('/approvals/:id/open', async (c) => {
        try {
            return c.json(await approvals.open(c.req.param('id'), c.get('user').id));
        } catch (error) {
            return fail(c, error);
        }
    });
    app.post('/approvals/:id/undo', async (c) => {
        try {
            return c.json(await approvals.undo(c.req.param('id'), c.get('user').id));
        } catch (error) {
            return fail(c, error);
        }
    });
    return app;
}
