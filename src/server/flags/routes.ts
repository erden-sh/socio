import type { DatabaseSync } from 'node:sqlite';

import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { requireAdmin, requireOperator } from '@socio/foundation/http/guards';
import {
    FLAG_TIER_ID,
    MAX_FLAG_PEOPLE,
    MAX_TIER_DESCRIPTION,
    MAX_TIER_NAME,
    type FlagAdminView,
    type FlagAuditLine,
    type FlagsAdminState,
} from '@socio/shared/flags';
import { ROLES } from '@socio/shared/roles';

import type { FlagAdminShape, FlagAuditEntry, FlagScope, FlagsWorkspaceShape } from './contract.js';
import { workspaceBlocked } from './evaluate.js';

const ruleSchema = z
    .object({
        enabled: z.boolean(),
        roles: z.array(z.enum(ROLES)).max(ROLES.length).default([]),
        people: z.array(z.string().min(1).max(100)).max(MAX_FLAG_PEOPLE).default([]),
        locked: z.boolean().optional(),
    })
    // Strict: a rule with `optIn` (people opting in, retired by CB-503) is refused.
    .strict();
const tierSchema = z
    .object({
        name: z.string().trim().min(1).max(MAX_TIER_NAME),
        description: z.string().trim().max(MAX_TIER_DESCRIPTION).default(''),
        flags: z.record(z.string(), z.boolean()).default({}),
    })
    .strict();

const AUDIT_LINES = 50;

/**
 * `/api/flags` (CB-169, CB-182, CB-503):
 * - admins read every flag this deployment has with its layers and the
 *   audit, and set the workspace's rule, unless this server's
 *   configuration decides it (a locked server rule, or a plan that leaves
 *   it out). Flags in development exist only in an internal deployment
 *   (`SOCIO_DEPLOYMENT_KIND=internal`); in a customer one their keys are
 *   unknown here (404) and never listed.
 * - the server-rule and plan routes below take the operator role; the app
 *   offers no editor for them (CB-503), and Settings shows what they decide
 *   read-only.
 * No route takes a person's own choice: people don't turn flags on or off
 * for themselves (CB-503), so `/flags/early-access` and
 * `/flags/:key/choice` are gone and answer 404.
 * Each change is a `workspace_audit` line. Signed-in people only: service
 * keys and data tokens never reach these. `db` is the workspace connection
 * (`ModuleContext.db`), for the audit's flag lines.
 */
export function flagRoutes({
    flags,
    db,
    workspace,
}: {
    flags: FlagAdminShape;
    db: DatabaseSync;
    workspace: FlagsWorkspaceShape;
}) {
    const app = new Hono<AppEnv>();
    const signedIn: MiddlewareHandler<AppEnv> = async (c, next) => {
        if (c.get('serviceKey') || c.get('dataToken')) {
            return c.json({ error: 'Sign in to the app to manage features.' }, 403);
        }
        await next();
    };
    app.use('/flags', signedIn);
    app.use('/flags/*', signedIn);
    const audit = (entry: FlagAuditEntry) => workspace.audit(entry);
    const unknown = { error: 'There is no such feature.' };

    // Only the flags this deployment has: no `dev` flag in a customer one (CB-503).
    const adminView = (userId: string): FlagAdminView[] =>
        flags.registry
            .filter((flag) => !!flags.definition(flag.key))
            .map((flag) => {
                const layers = flags.layers(flag.key);
                return {
                    key: flag.key,
                    title: flag.title,
                    description: flag.description,
                    stage: flag.stage,
                    default: flag.default,
                    owner: flag.owner,
                    removeBy: flag.removeBy,
                    ...(flag.issue ? { issue: flag.issue } : {}),
                    tools: [...(flag.tools ?? [])],
                    ...(layers.env !== undefined ? { env: layers.env } : {}),
                    ...(layers.instance ? { instance: flags.rule('instance', flag.key) } : {}),
                    ...(layers.tier !== undefined ? { tier: layers.tier } : {}),
                    ...(layers.workspace ? { workspace: flags.rule('tenant', flag.key) } : {}),
                    you: flags.evaluate(flag.key, userId),
                    everyone: flags.everyone(flag.key),
                    workspaceBlocked: workspaceBlocked(flag, layers, flags.internal),
                };
            });

    const auditLines = (): FlagAuditLine[] => {
        const names = new Map(workspace.users().map((user) => [user.id, user.name]));
        // The workspace audit's flag lines (written below), newest first.
        return (
            (
                db
                    .prepare(
                        `SELECT actor, action, targetKind, targetId, detail, createdAt FROM workspace_audit WHERE targetKind IN ('feature_flag', 'flag_tier') ORDER BY id DESC LIMIT ${AUDIT_LINES}`,
                    )
                    .all() as unknown as Array<Omit<FlagAuditLine, 'actorName'>>
            )
                // Nor the changes to flags this deployment doesn't have (`dev` ones in a customer deployment).
                .filter((line) => line.targetKind !== 'feature_flag' || !!flags.definition(line.targetId))
                .map((line) => ({
                    ...line,
                    actorName: names.get(line.actor) ?? line.actor,
                }))
        );
    };

    app.get('/flags', requireAdmin, (c) => {
        const user = c.get('user');
        const deactivated = workspace.deactivatedUsers();
        const state: FlagsAdminState = {
            tenantId: flags.tenantId,
            flags: adminView(user.id),
            tiers: flags.tiers(),
            tierId: flags.tenantTier()?.id ?? null,
            people: workspace
                .users()
                .filter((person) => !deactivated.has(person.id))
                .map(({ id, name, role }) => ({ id, name, role })),
            audit: auditLines(),
        };
        return c.json(state);
    });

    // Plans (CB-182): operators define them and choose the workspace's.
    // Before the flag routes, so a plan id never reads as a flag's path.
    app.put('/flags/tiers/:id', requireOperator, async (c) => {
        const user = c.get('user');
        const id = c.req.param('id');
        if (!FLAG_TIER_ID.test(id)) {
            return c.json({ error: 'A plan id is lowercase letters, digits and dashes.' }, 400);
        }
        const parsed = tierSchema.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json(
                {
                    error: `Give the plan a name (up to ${MAX_TIER_NAME} characters) and say which features it includes.`,
                },
                400,
            );
        }
        const unknownKeys = Object.keys(parsed.data.flags).filter((key) => !flags.definition(key));
        if (unknownKeys.length) {
            return c.json({ error: `No such feature: ${unknownKeys.join(', ')}.` }, 400);
        }
        const before = flags.tier(id) ?? null;
        const tier = await flags.saveTier({ id, ...parsed.data }, user.id);
        audit({
            actor: user.id,
            action: 'update',
            targetKind: 'flag_tier',
            targetId: id,
            detail: JSON.stringify({
                before: before && {
                    name: before.name,
                    flags: before.flags,
                },
                after: { name: tier.name, flags: tier.flags },
            }),
        });
        return c.json({ tier });
    });
    app.delete('/flags/tiers/:id', requireOperator, async (c) => {
        const id = c.req.param('id');
        const before = flags.tier(id);
        const outcome = await flags.deleteTier(id);
        if (outcome === 'missing') {
            return c.json({ error: 'There is no such plan.' }, 404);
        }
        if (outcome === 'in-use') {
            return c.json({ error: 'A workspace is on this plan: move it to another first.' }, 409);
        }
        audit({
            actor: c.get('user').id,
            action: 'remove',
            targetKind: 'flag_tier',
            targetId: id,
            detail: JSON.stringify({
                before: before && { name: before.name, flags: before.flags },
            }),
        });
        return c.json({ ok: true });
    });
    app.put('/flags/tier', requireOperator, async (c) => {
        const parsed = z
            .object({ tierId: z.string().nullable() })
            .strict()
            .safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json({ error: 'Choose a plan, or none.' }, 400);
        }
        const { tierId } = parsed.data;
        if (tierId !== null && !flags.tier(tierId)) {
            return c.json({ error: 'There is no such plan.' }, 404);
        }
        const before = flags.tenantTier()?.id ?? null;
        await flags.setTenantTier(tierId, c.get('user').id);
        audit({
            actor: c.get('user').id,
            action: tierId === null ? 'remove' : 'update',
            targetKind: 'flag_tier',
            targetId: flags.tenantId,
            detail: JSON.stringify({ scope: 'workspace', before, after: tierId }),
        });
        return c.json({ tierId });
    });

    const saveRule = (scope: FlagScope) => async (c: Context<AppEnv>) => {
        const user = c.get('user');
        const key = c.req.param('key')!;
        const flag = flags.definition(key);
        if (!flag) {
            return c.json(unknown, 404);
        }
        const parsed = ruleSchema.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json(
                {
                    error: `Choose who it is on for: everyone, or up to ${MAX_FLAG_PEOPLE} people and some roles.`,
                },
                400,
            );
        }
        const input = parsed.data;
        if (scope === 'tenant') {
            const blocked = workspaceBlocked(flag, flags.layers(key), flags.internal);
            if (blocked) {
                return c.json({ error: blocked }, 403);
            }
            if (input.locked) {
                return c.json({ error: 'Only an operator can lock a feature.' }, 403);
            }
        }
        const known = new Set(workspace.users().map((person) => person.id));
        if (input.people.some((id) => !known.has(id))) {
            return c.json({ error: 'Choose people from this workspace.' }, 400);
        }
        const before = flags.rule(scope, key) ?? null;
        const after = await flags.setRule(scope, key, input, user.id);
        audit({
            actor: user.id,
            action: 'update',
            targetKind: 'feature_flag',
            targetId: key,
            detail: JSON.stringify({
                scope: scope === 'tenant' ? 'workspace' : 'instance',
                before: before && withoutStamp(before),
                after: withoutStamp(after),
            }),
        });
        return c.json({ rule: after });
    };
    const clearRule = (scope: FlagScope) => async (c: Context<AppEnv>) => {
        const user = c.get('user');
        const key = c.req.param('key')!;
        const flag = flags.definition(key);
        if (!flag) {
            return c.json(unknown, 404);
        }
        if (scope === 'tenant') {
            const blocked = workspaceBlocked(flag, flags.layers(key), flags.internal);
            if (blocked) {
                return c.json({ error: blocked }, 403);
            }
        }
        const before = flags.rule(scope, key);
        if (await flags.clearRule(scope, key)) {
            audit({
                actor: user.id,
                action: 'remove',
                targetKind: 'feature_flag',
                targetId: key,
                detail: JSON.stringify({
                    scope: scope === 'tenant' ? 'workspace' : 'instance',
                    before: before && withoutStamp(before),
                }),
            });
        }
        return c.json({ ok: true });
    };
    app.put('/flags/:key/instance', requireOperator, saveRule('instance'));
    app.delete('/flags/:key/instance', requireOperator, clearRule('instance'));
    app.put('/flags/:key/workspace', requireAdmin, saveRule('tenant'));
    app.delete('/flags/:key/workspace', requireAdmin, clearRule('tenant'));

    return app;
}

const withoutStamp = ({ updatedAt: _at, updatedBy: _by, ...rule }: { updatedAt: number; updatedBy: string }) => rule;
