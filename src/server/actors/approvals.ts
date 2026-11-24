import { randomUUID } from 'node:crypto';

import { nextTurn } from '@socio/data/events';
import { intentDigest } from '@socio/foundation/actors/principal';
import { appInRuntime } from '@socio/foundation/apps/runtime-status';
import { parseAudience, type ActorDenyReason, type Audience } from '@socio/shared/actor-scopes';
import {
    DATA_ACTION_PREFIX,
    dataActionOperation,
    dataApprovalParams,
    operationTier,
} from '@socio/shared/dataspace/operations';
import { canonicalJson } from '@socio/shared/jcs';
import {
    ACCESS_CAPABILITY,
    ACTION_PARAMS,
    SOCIO_ACCESS_APPROVAL_TTL_MS,
    SOCIO_ACCESS_CAPABILITIES,
    SOCIO_ACCESS_PENDING,
    minutesText,
    type CardAppFacts,
} from '@socio/shared/socio-access';

import { ApprovalError, type ApprovalDecisionEvent, type ApprovalRecord } from '../approvals/contract.js';

import {
    accessCard,
    actionCard,
    cardLabel,
    displayLines,
    fullParams,
    paramCounts,
    paramsMustOpen,
    type AccessPayload,
    type ActionPayload,
} from './consent.js';
import type {
    ActionTarget,
    ActorActionServices,
    ActorAppServices,
    ActorApprovalServices,
    ActorPlugins,
    ActorsWorkspace,
    ConsumeAppAction,
} from './contract.js';

/**
 * What socio access's approvals, cards and action calls read: moved to the
 * contract, where the module's `ActorServices` holds them.
 */
export type { ActorActionServices, ActorAppServices, ActorApprovalServices, ActorPlugins, ActorsWorkspace };

/**
 * Delegated access's approvals (CB-232): the three
 * access capabilities, whose approval creates the grant, and `app_action`,
 * a consumable approval the app uses once. Policies are the person's own,
 * per socio: only `app_access_read` may be `bypass` or `auto`, by their
 * opt-in; write, `act` and every action are their click, and an app's
 * `alwaysAsk` overrides even the read opt-in. Requests wait 15 minutes.
 */

/** Approval decisions as `actor_audit` rows, in the deciding unit. */
function auditDecision(
    platform: Pick<ActorApprovalServices, 'actors'>,
    audience: string,
    correlationId: string,
    extra: { grantId?: string; digest?: string; action?: string } = {},
) {
    return (request: ApprovalRecord, event: ApprovalDecisionEvent) =>
        platform.actors.audit.recordIn({
            at: event.at,
            correlationId,
            phase: 'approval',
            ...(event.status === 'approved'
                ? { decision: 'allow' as const }
                : event.status === 'denied'
                  ? { decision: 'deny' as const }
                  : {}),
            status: event.status,
            personId: request.userId,
            socioId: request.dotId,
            ...(extra.grantId ? { grantId: extra.grantId } : {}),
            actorBy: event.by,
            audience,
            action: extra.action ?? request.capability,
            resourceKind: 'approval',
            resourceId: request.id,
            ...(extra.digest ? { digest: extra.digest } : {}),
        });
}

/**
 * Registers the capabilities on `platform.approvals` (once per platform,
 * from the actors module), and expires the action approvals of a grant
 * that ends.
 */
export function registerSocioAccessApprovals(platform: ActorApprovalServices) {
    const { approvals, actors } = platform;
    const LABEL = {
        read: 'Let a socio read an app for you',
        write: 'Let a socio change an app’s data for you',
        act: 'Let a socio ask to act in an app for you',
    } as const;
    const DESCRIPTION = {
        read: 'A socio asks to see one mini app and its data for you, for a limited time, from one conversation. It can’t change anything. You may let it read apps without asking, per socio; an app can still insist on asking.',
        write: 'A socio asks to see and change one mini app’s own data for you, for one task. Always your decision.',
        act: 'A socio asks to change one mini app’s data and to request its consequential actions (sending, paying, deleting), each of which you approve on its own. Always your decision.',
    } as const;
    for (const access of ['read', 'write', 'act'] as const) {
        approvals.register<AccessPayload>({
            capability: ACCESS_CAPABILITY[access],
            label: LABEL[access],
            description: DESCRIPTION[access],
            // Only read may skip the card, and only by the person.
            ...(access === 'read' ? {} : { manualOnly: true }),
            ttlMs: SOCIO_ACCESS_APPROVAL_TTL_MS,
            auto:
                access === 'read'
                    ? {
                          maxRiskForAuto: 'low',
                          riskNotes:
                              'Read-only access to one app the person can open themselves, for a limited time; the socio may then see that app’s data. Deny or escalate if the task looks unrelated to what the person is doing.',
                          describe: (payload) => ({
                              app: payload.facts.label,
                              origin: payload.facts.origin,
                              owner: payload.facts.owner,
                              minutes: payload.minutes,
                              task: payload.task,
                              sharedRoom: payload.visibleTo,
                          }),
                      }
                    : { allowed: false },
            card: (request) => accessCard(request.payload),
            onDecision: (request, event) =>
                auditDecision(platform, request.payload.audience, request.payload.correlationId)(request, event),
            execute: (request) => grantFromApproval(platform, request),
        });
    }
    approvals.register<ActionPayload>({
        capability: SOCIO_ACCESS_CAPABILITIES.action,
        label: 'Let a socio take an action in an app',
        description:
            'One consequential action in a mini app (sending, paying, deleting in bulk, reaching outside Socio), with the exact parameters it will run with. Always your decision, every time; it can be used once.',
        manualOnly: true,
        consumable: true,
        ttlMs: SOCIO_ACCESS_APPROVAL_TTL_MS,
        card: (request) => actionCard(request.payload),
        review: { mustOpen: paramsMustOpen, full: fullParams },
        onDecision: (request, event) => {
            // The consume call records its own row, with its request's id.
            if (event.status === 'consumed') {
                return;
            }
            auditDecision(platform, request.payload.audience, request.payload.correlationId, {
                grantId: request.payload.grantId,
                digest: request.payload.digest,
                action: request.payload.action,
            })(request, event);
        },
    });
    // Approvals made for a grant die with it: pending ones expire
    // now rather than in 15 minutes. Consuming re-checks the grant anyway.
    actors.revocations.onRevoked(({ grantIds }) => {
        void nextTurn()
            .then(() => approvals.expireBound(grantIds, 'The access it was for ended.'))
            .catch(() => console.error('Socio access: expiring a grant’s approvals failed.'));
    });
}

/**
 * An approved access request becomes a grant: checked again now,
 * since up to 15 minutes passed; never under a policy version other than
 * the one the card was shown for.
 */
async function grantFromApproval(
    platform: Pick<ActorApprovalServices, 'actors'>,
    request: ApprovalRecord<AccessPayload>,
) {
    const { actors } = platform;
    const payload = request.payload;
    const policy = actors.audiences.for(payload.audience);
    const version = policy ? await policy.policyVersion(payload.audience) : undefined;
    if (version === undefined) {
        throw new Error('The app is no longer available to socios.');
    }
    if (version !== payload.policyVersion) {
        throw new Error('The app changed since you were asked; the socio has to ask again.');
    }
    const replaces =
        payload.replaces && actors.grants.get(payload.replaces)?.revokedAt === null ? payload.replaces : undefined;
    const grant = await actors.grants.create({
        personId: request.userId,
        socioId: request.dotId,
        audiences: [payload.audience],
        scopes: payload.scopes,
        conversationId: payload.conversationId,
        conversationKind: payload.conversationKind,
        task: payload.task,
        policyVersion: payload.policyVersion,
        approvalId: request.id,
        minutes: payload.minutes,
        approvedBy: request.userId,
        correlationId: payload.correlationId,
        ...(replaces ? { replaces } : {}),
    });
    // Every term of the intersection, now, before it is reported granted.
    const decision = await actors.authorizer.grantDecision(grant);
    if (!decision.allowed) {
        await actors.revoke({ grantId: grant.id }, 'system', 'access_changed', payload.correlationId);
        throw new Error(`The access can’t be granted now (${decision.reason}).`);
    }
    return `Granted: ${payload.access} access to ${payload.facts.label} for ${minutesText(payload.minutes)}, grant ${grant.id}. Pass this grant id to the app tools.`;
}

/**
 * An action target's audience, kind and the id its intent digest names
 * (`SHA-256(JCS({appId, action, params}))`): an app's own id, as it
 * always was, and `plugin:<id>` for a plugin, so an app and a plugin of
 * the same id never share a digest. What `@socio/app-sdk` puts in the
 * digest is `CB_APP_ID`, which is exactly this.
 */
export function actionSubject(target: ActionTarget):
    | {
          audience: Audience;
          kind: 'app' | 'plugin';
          id: string;
          intentId: string;
      }
    | undefined {
    if (target.audience === undefined) {
        return target.appId
            ? {
                  audience: `app:${target.appId}`,
                  kind: 'app',
                  id: target.appId,
                  intentId: target.appId,
              }
            : undefined;
    }
    const parsed = parseAudience(target.audience);
    if (parsed?.kind === 'app') {
        return {
            audience: target.audience,
            kind: 'app',
            id: parsed.id,
            intentId: parsed.id,
        };
    }
    if (parsed?.kind === 'plugin') {
        return {
            audience: target.audience,
            kind: 'plugin',
            id: parsed.id,
            intentId: target.audience,
        };
    }
    return undefined;
}

export type ActionRequestResult =
    | {
          ok: true;
          approval: {
              id: string;
              status: 'pending' | 'approved';
              expiresAt: number;
          };
      }
    | { ok: false; status: 400 | 403 | 409 | 413; reason: ActorDenyReason };

/**
 * `POST /api/apps/actor/approvals`, for the apps route, and
 * `POST /api/plugins/:id/actor/approvals` for a service plugin: the app's
 * data token (or the plugin's service token and proof) and the request's
 * `cbob_` have named the audience and the grant already; never take
 * either from the body. Checks the action is declared `consequential` and
 * the grant has `app:act`, then finds or creates the pending approval for
 * that digest and grant. At most 3 wait per grant; parameters over 64 KB
 * are refused before a card is made.
 *
 * A data operation's approval is asked for the same way, with the
 * reserved action `data:<op>`: its tier is the data API's, never the
 * manifest's, only consequential operations qualify, and its parameters
 * must be exactly the platform's shape for that operation
 * (`packages/shared/src/dataspace/operations.ts`), which the data API recomputes from the
 * call that consumes it. Apps only: a plugin has its own data routes, so
 * a plugin's `data:` action is refused (`request_malformed`).
 */
export async function requestAppAction(
    platform: ActorActionServices,
    input: ActionTarget & {
        grantId: string;
        action: string;
        params: unknown;
        display?: unknown;
        correlationId: string;
    },
): Promise<ActionRequestResult> {
    const { actors, approvals } = platform;
    const subject = actionSubject(input);
    const audience: Audience = subject?.audience ?? input.audience ?? `app:${input.appId ?? ''}`;
    const deny = (status: 400 | 403 | 409 | 413, reason: ActorDenyReason): ActionRequestResult => {
        actors.audit.recordSoon({
            correlationId: input.correlationId,
            phase: 'approval',
            decision: 'deny',
            reason,
            grantId: input.grantId,
            audience,
            action: input.action.slice(0, 100),
        });
        return { ok: false, status, reason };
    };
    if (!subject) {
        return deny(403, 'audience_mismatch');
    }
    const grant = actors.grants.get(input.grantId);
    if (!grant || !grant.audiences.includes(audience)) {
        return deny(403, 'audience_mismatch');
    }
    // `data:<op>` names Socio's data API, which plugins don't call.
    if (subject.kind === 'plugin' && input.action.startsWith(DATA_ACTION_PREFIX)) {
        return deny(400, 'request_malformed');
    }
    const dataOp = dataActionOperation(input.action);
    if (dataOp === null) {
        return deny(403, 'action_undeclared');
    }
    const decision = await actors.authorizer.authorize(
        grant.id,
        {
            audience,
            action: input.action,
            // A data operation's tier is the platform's.
            ...(dataOp ? { tier: operationTier(dataOp) } : {}),
        },
        { fresh: true },
    );
    if (!decision.allowed) {
        return deny(403, decision.reason);
    }
    if (decision.tier !== 'consequential') {
        return deny(400, 'not_consequential');
    }
    let params = input.params;
    if (dataOp) {
        const shaped = dataApprovalParams(dataOp, input.params);
        if (!shaped) {
            return deny(400, 'request_malformed');
        }
        params = shaped;
    }
    let canonical: string;
    try {
        canonical = canonicalJson(params);
    } catch {
        // A value RFC 8785 can't hold (NaN, Infinity, a cycle, a BigInt).
        return deny(400, 'params_invalid');
    }
    const bytes = Buffer.byteLength(canonical);
    if (bytes > ACTION_PARAMS.maxBytes) {
        return deny(413, 'params_too_large');
    }
    const digest = intentDigest(subject.intentId, input.action, params);
    const facts =
        subject.kind === 'plugin'
            ? pluginFactsOf(platform, subject.id, grant.personId)
            : appFactsOf(platform, subject.id, grant.personId);
    if (!facts) {
        return deny(403, 'audience_unavailable');
    }
    const socioName = platform.workspace.dot(grant.socioId)?.name ?? 'A socio';
    const payload: ActionPayload = {
        v: 1,
        audience,
        appId: subject.intentId,
        grantId: grant.id,
        action: input.action,
        canonical,
        bytes,
        digest,
        counts: paramCounts(params),
        display: displayLines(input.display),
        ...(dataOp ? { operation: dataOp } : {}),
        socioName,
        facts,
        correlationId: input.correlationId,
    };
    const threadId = grant.conversationId.startsWith('schedule:') ? undefined : grant.conversationId;
    try {
        // The same intent finds its own card, inside the inserting unit, so
        // two identical requests at once make one.
        const outcome = await approvals.requestBound<ActionPayload>({
            userId: grant.personId,
            dotId: grant.socioId,
            capability: SOCIO_ACCESS_CAPABILITIES.action,
            summary: `${facts.label}: ${payload.action.slice(0, 100)}`,
            details: [
                `${facts.label} (${facts.origin}), owned by ${facts.owner}.`,
                `Parameters: ${bytes} bytes${payload.counts.length ? `; ${payload.counts.map((item) => `${item.count} items in ${item.path}`).join(', ')}` : ''}. Open it in Socio to see them.`,
            ],
            payload,
            ...(threadId ? { threadId } : {}),
            binding: { digest, bindingId: grant.id },
            limit: {
                max: SOCIO_ACCESS_PENDING.perGrant,
                capabilities: [SOCIO_ACCESS_CAPABILITIES.action],
                by: 'binding',
                message: 'Three actions already wait for the person: wait for them to answer.',
            },
        });
        if (outcome.status === 'bound') {
            return {
                ok: true,
                approval: {
                    id: outcome.id,
                    status: outcome.approved ? 'approved' : 'pending',
                    expiresAt: outcome.expiresAt,
                },
            };
        }
        actors.audit.recordSoon({
            correlationId: input.correlationId,
            phase: 'approval',
            status: 'requested',
            personId: grant.personId,
            socioId: grant.socioId,
            grantId: grant.id,
            audience,
            action: input.action.slice(0, 100),
            tier: 'consequential',
            resourceKind: 'approval',
            resourceId: outcome.id,
            digest,
        });
        return {
            ok: true,
            approval: {
                id: outcome.id,
                status: outcome.status === 'approved' ? 'approved' : 'pending',
                expiresAt: 'expiresAt' in outcome ? outcome.expiresAt : Date.now() + SOCIO_ACCESS_APPROVAL_TTL_MS,
            },
        };
    } catch (error) {
        if (error instanceof ApprovalError && error.status === 409) {
            return deny(409, 'limit_reached');
        }
        throw error;
    }
}

/**
 * `POST /api/apps/actor/approvals/:id/consume`, for the apps route, and
 * `POST /api/plugins/:id/actor/approvals/:approval/consume`: the grant
 * comes from the new request's `cbob_`, never from the app or plugin.
 * Uses the approval once, only for that grant, audience and digest, only
 * while the grant lives; one row changes or none (concurrent calls:
 * exactly one wins). Its `actor_audit` row commits with it. An approval
 * made for an app is never used by a plugin, nor one plugin's by another
 * or by an app.
 *
 * `kind`: `app` for the app's (or plugin's) own consume call, which can't
 * use a data operation's approval (the app passes that one on to the data
 * API, which consumes it with `data`); `data` uses only those, apps only.
 */
export async function consumeAppAction(
    // Wider than it reads: dataspace's routes name their platform by it.
    platform: ActorActionServices,
    input: ConsumeAppAction,
): Promise<boolean> {
    const { actors, approvals } = platform;
    const subject = actionSubject(input);
    const audience: Audience = subject?.audience ?? input.audience ?? `app:${input.appId ?? ''}`;
    const refuse = () => {
        actors.audit.recordSoon({
            correlationId: input.correlationId,
            phase: 'approval',
            decision: 'deny',
            reason: 'approval_unusable',
            grantId: input.grantId,
            audience,
            resourceKind: 'approval',
            resourceId: input.approvalId.slice(0, 64),
        });
        return false;
    };
    if (!subject || (subject.kind === 'plugin' && input.kind === 'data')) {
        return refuse();
    }
    const grant = actors.grants.get(input.grantId);
    if (!grant || !grant.audiences.includes(audience)) {
        return refuse();
    }
    if (!(await actors.authorizer.authorizeGrant(grant.id, { fresh: true })).allowed) {
        return refuse();
    }
    const used = await approvals
        .consume(
            input.approvalId,
            {
                capability: SOCIO_ACCESS_CAPABILITIES.action,
                digest: input.digest,
                bindingId: grant.id,
            },
            (request) => {
                const payload = request.payload as ActionPayload;
                // The digest covers the app id (`plugin:<id>` for a plugin); this
                // is belt and braces.
                if (payload.audience !== audience || payload.appId !== subject.intentId) {
                    throw new Error('An approval is used only by its own app.');
                }
                // A data operation's approval is spent only by the data API's
                // call it was asked for, never by the app's consume call.
                if (payload.action.startsWith(DATA_ACTION_PREFIX) !== (input.kind === 'data')) {
                    throw new Error('That approval is used elsewhere.');
                }
                actors.audit.recordIn({
                    correlationId: input.correlationId,
                    phase: 'approval',
                    decision: 'allow',
                    status: 'consumed',
                    personId: grant.personId,
                    socioId: grant.socioId,
                    grantId: grant.id,
                    actorBy: 'platform',
                    audience,
                    action: payload.action.slice(0, 100),
                    tier: 'consequential',
                    resourceKind: 'approval',
                    resourceId: request.id,
                    digest: payload.digest,
                });
            },
        )
        .catch(() => false);
    return used || refuse();
}

/**
 * An app's platform facts for a card: its label (inert), its
 * own origin and its owner's name; whether it is a development app. For
 * an app `personId` can open; undefined otherwise.
 */
export function appFactsOf(
    platform: Pick<ActorAppServices, 'apps' | 'workspace'>,
    appId: string,
    personId: string,
): CardAppFacts | undefined {
    const { apps, workspace } = platform;
    if (!apps.enabled) {
        return undefined;
    }
    const app = apps.get(appId);
    if (!app || !apps.access(personId, app)) {
        return undefined;
    }
    return {
        label: cardLabel(app.name),
        origin: apps.url(app),
        // A person's name is theirs to write: inert like the label.
        owner: cardLabel(workspace.users().find((user) => user.id === app.ownerUserId)?.name ?? 'a former member'),
        development: !appInRuntime(app),
    };
}

/**
 * A plugin's platform facts for a card (CB-232): its name (inert), where
 * it opens (its own origin for a service, the workspace page for a bundled
 * one) and that the workspace installed it. For a plugin `personId` may
 * use (its install's audience); undefined otherwise.
 */
export function pluginFactsOf(
    platform: Pick<ActorAppServices, 'plugins'>,
    pluginId: string,
    personId: string,
): CardAppFacts | undefined {
    const { plugins } = platform;
    const row = plugins.get(pluginId);
    if (!row || !plugins.mayUse(row, plugins.activeUser(personId))) {
        return undefined;
    }
    return {
        label: cardLabel(row.manifest.name),
        origin: pluginOpensAt(plugins, row),
        owner: 'your workspace (an installed plugin)',
        development: false,
    };
}

/**
 * Where a plugin opens, a platform fact: a service plugin's own origin on
 * the apps host, a bundled one's page in the workspace.
 */
export function pluginOpensAt(plugins: ActorPlugins, row: { id: string; mode: 'service' | 'bundled' }) {
    const workspace = plugins.parentOrigin || plugins.appsSettings?.mainOrigin || '';
    return row.mode === 'service' ? (plugins.origin(row.id) ?? workspace) : `${workspace}/plugins/${row.id}`;
}

/** A new correlation id for one request's records. */
export const newCorrelation = () => `a1-${randomUUID()}`;
