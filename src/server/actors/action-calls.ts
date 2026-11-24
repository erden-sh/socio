/**
 * The socio-access calls an app or a service plugin makes for the request
 * it serves (CB-232): continuations, action approvals and their
 * consume-once use. One set of handlers behind `/api/apps/actor/*` (an
 * app's data token) and `/api/plugins/:id/actor/*` (the plugin's service
 * token and proof). The caller has authenticated who is
 * calling and opened the request's `cbob_` for that audience; the grant
 * always comes from the `cbob_`, the audience from the credential, never
 * from the body.
 */
import type { Context } from 'hono';
import { z } from 'zod';

import { intentDigest } from '@socio/foundation/actors/principal';
import type { AppEnv } from '@socio/foundation/http/app-env';

import { actionSubject, consumeAppAction, requestAppAction, type ActorActionServices } from './approvals.js';
import { appActorAccess } from './apps.js';
import { ActorAccessError, type ActorActionsShape, type ActorCall, type AppActorAccess } from './contract.js';

const continuationBody = z.object({ minutes: z.number().int().min(1).max(480) }).strict();
const DIGEST = /^[0-9a-f]{64}$/;
const approvalBody = z
    .object({
        action: z.string().min(1).max(64),
        params: z.unknown(),
        display: z.unknown().optional(),
        digest: z.string().regex(DIGEST).optional(),
    })
    .strict();
const consumeBody = z.object({ digest: z.string().regex(DIGEST) }).strict();
/** What an app is told when an action approval is refused. */
const APPROVAL_REFUSALS = {
    400: 'Only a declared consequential action needs an approval.',
    403: 'This access doesn’t allow that action.',
    409: 'Three actions already wait for the person.',
    413: 'The parameters are over 64 KB: nobody reviews more.',
} as const;
/**
 * Refusal reasons an app (or plugin) is told: about its own request (its
 * shape, size or tier, the cap of waiting cards), never which security
 * check failed.
 */
const APP_REASONS = new Set<string>([
    'not_consequential',
    'params_too_large',
    'params_invalid',
    'request_malformed',
    'limit_reached',
]);
/** A `data:<op>` approval's params aren't the operation's own. */
const DATA_PARAMS_REFUSED =
    'A data operation’s approval takes exactly its parameters, e.g. { path } for data:files.delete.';
/** Plugins don't call Socio's data API, so they have no `data:` approvals. */
const PLUGIN_DATA_REFUSED = 'data:<op> approvals are for mini apps: a plugin’s data routes take none.';
const PERSON_CONTINUATION_MS = 8 * 60 * 60_000;
const PERSONS_OWN = 'A person acts for themselves: approvals are for socios.' as const;

/**
 * `POST …/actor/continuations`: a socio's is a reference token held
 * by its grant, so it ends with it and never outlives it; a person's is a
 * sealed `cbob_` naming their session, at most 8 hours, which dies with
 * the session.
 */
export async function continuationCall(
    c: Context<AppEnv>,
    actors: Pick<AppActorAccess, 'grant' | 'authorize' | 'continuation'>,
    call: ActorCall,
) {
    const parsed = continuationBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
        return c.json({ error: 'Send { minutes } from 1 to 480.' }, 400);
    }
    const { audience, obo } = call;
    const ttlMs = parsed.data.minutes * 60_000;
    if (obo.grantId) {
        const grant = actors.grant(obo.grantId);
        const decision = await actors.authorize(obo.grantId, {
            audience,
            tier: 'read',
        });
        if (!grant || !decision.allowed) {
            return c.json({ error: 'This access was revoked.' }, 403);
        }
        try {
            const issued = await actors.continuation({
                grant,
                audience,
                requestId: obo.requestId,
                ttlMs,
            });
            return c.json({
                continuation: issued.token,
                expiresAt: issued.expiresAt,
            });
        } catch (error) {
            if (error instanceof ActorAccessError) {
                return c.json({ error: error.message }, error.reason === 'contract_outdated' ? 503 : 403);
            }
            throw error;
        }
    }
    if (!(await call.personSession(obo.sessionHash!))) {
        return c.json({ error: 'This session ended.' }, 403);
    }
    const minted = Math.min(ttlMs, PERSON_CONTINUATION_MS);
    return c.json({
        continuation: call.mintPersonObo(obo.sessionHash!, obo.requestId, minted),
        expiresAt: Date.now() + minted,
    });
}

/**
 * `POST …/actor/approvals`: `requestAppAction` checks the tier, the
 * grant's `app:act`, the size and the cap.
 */
export async function approvalCall(c: Context<AppEnv>, platform: ActorActionServices, call: ActorCall) {
    const parsed = approvalBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
        return c.json({ error: 'Send { action, params, display? }.' }, 400);
    }
    const { audience, obo } = call;
    if (!obo.grantId) {
        return c.json({ error: PERSONS_OWN }, 400);
    }
    const subject = actionSubject({ audience })!;
    if (subject.kind === 'plugin' && parsed.data.action.startsWith('data:')) {
        return c.json({ error: PLUGIN_DATA_REFUSED, reason: 'request_malformed' }, 400);
    }
    const params = parsed.data.params ?? null;
    let digest: string;
    try {
        digest = intentDigest(subject.intentId, parsed.data.action, params);
    } catch {
        return c.json({ error: 'The parameters are not JSON.' }, 400);
    }
    if (parsed.data.digest && parsed.data.digest !== digest) {
        return c.json(
            {
                error: 'The digest doesn’t match the parameters (canonical JSON, RFC 8785).',
            },
            400,
        );
    }
    const result = await requestAppAction(platform, {
        audience,
        grantId: obo.grantId,
        action: parsed.data.action,
        params,
        ...(parsed.data.display === undefined ? {} : { display: parsed.data.display }),
        correlationId: obo.requestId,
    });
    if (!result.ok) {
        return c.json(
            {
                error:
                    result.reason === 'request_malformed'
                        ? DATA_PARAMS_REFUSED
                        : result.reason === 'params_invalid'
                          ? 'The parameters are not JSON that canonicalises (RFC 8785).'
                          : APPROVAL_REFUSALS[result.status],
                // Only what is about the caller's own request; which check of the
                // grant, person or socio failed stays in actor_audit.
                ...(APP_REASONS.has(result.reason) ? { reason: result.reason } : {}),
            },
            result.status,
        );
    }
    return c.json(
        {
            approval: result.approval.id,
            status: result.approval.status,
            expiresAt: result.approval.expiresAt,
            digest,
        },
        202,
    );
}

/**
 * `POST …/actor/approvals/:id/consume`: once, for this request's grant,
 * the caller's audience and the digest.
 */
export async function consumeCall(
    c: Context<AppEnv>,
    platform: ActorActionServices,
    call: ActorCall,
    approvalId: string,
) {
    const parsed = consumeBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
        return c.json({ error: 'Send { digest }.' }, 400);
    }
    const { audience, obo } = call;
    if (!obo.grantId) {
        return c.json({ error: PERSONS_OWN }, 400);
    }
    const ok = await consumeAppAction(platform, {
        audience,
        approvalId,
        grantId: obo.grantId,
        digest: parsed.data.digest,
        correlationId: obo.requestId,
    });
    return ok ? c.json({ ok: true, approval: approvalId }) : c.json({ error: 'That approval can’t be used.' }, 409);
}

/**
 * The contract's `ActorActions` over the platform: the three calls above
 * (the continuation also over socio access's own `appActorAccess`, read
 * at each call) and `consumeAppAction` (approvals.ts), as they are.
 */
export function actorActions(platform: ActorActionServices): ActorActionsShape {
    return {
        continuationCall: (c, actors, call) => continuationCall(c, actors, call),
        accessContinuationCall: (c, call) => continuationCall(c, appActorAccess(platform.actors), call),
        approvalCall: (c, call) => approvalCall(c, platform, call),
        consumeCall: (c, call, approvalId) => consumeCall(c, platform, call, approvalId),
        consumeAppAction: (input) => consumeAppAction(platform, input),
    };
}
