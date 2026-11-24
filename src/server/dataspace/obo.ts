import { randomUUID } from 'node:crypto';

import { intentDigest } from '@socio/foundation/actors/principal';
import { isContinuationToken } from '@socio/foundation/actors/tokens';
import type { DataTokenScope } from '@socio/foundation/http/app-env';
import { scopesCoverTier, type ActionTier, type ActorDenyReason, type Audience } from '@socio/shared/actor-scopes';
import {
    dataAction,
    dataApprovalParams,
    operationTier,
    type DataApiOperation,
} from '@socio/shared/dataspace/operations';

import type { ActorsShape } from '../actors/contract.js';

import type { DataContractTerms, AgentActor } from './contract.js';
import type { DataSpace } from './space.js';
import { dataTokenAppId } from './tokens.js';

/**
 * Data authority for apps (CB-232): the confused deputy.
 *
 * An app's `cbdt_` data token keeps the app's own rights. A request that
 * also carries `x-cb-obo` (the apps proxy's per-request `cbob_`, or a
 * continuation) is narrowed to what the actor it names may do:
 *
 *   effective = appRights            the app's token, checked as before
 *             ∩ actorRights
 *   person:  owner → every operation the app has
 *            space → read; write only where the app declares `spaceAccess`
 *   socio:   authorizeActor for the grant at the operation's fixed tier,
 *            the credential's own scopes, and its person's rights;
 *            consequential operations need a consumed approval
 *
 * A consequential operation through a socio's `cbob_` carries
 * `x-cb-approval`: an `app_action` approval for the reserved action
 * `data:<op>`, whose parameters (`operations.ts`) the gate recomputes
 * from this very request. It is consumed atomically, once, for (approval,
 * digest, the `cbob_`'s grant, the token's app) before the operation runs;
 * if the operation then fails it stays used. A continuation never
 * consumes one: a job runs after the socio's request that the person
 * approved, so a job can't spend approvals either (conservatively).
 *
 * And for an app that declares `delegation.contract`, a call without
 * `x-cb-obo` is refused, except reads (unless `background.read` is false)
 * and `write`-tier operations on the datasets it lists under
 * `delegation.background`. So a read-only socio can't write by asking the
 * app to (the app passes `obo`, the data API refuses), and the app can't
 * drop `obo` to get its own rights back.
 *
 * Nothing here is kept between requests: the `cbob_` opens under a key
 * every runtime derives, a continuation is a row by hash, and the grant or
 * app session it names is read on every use. An older runtime ignores
 * `x-cb-obo`, so the actor-access contract is 2 and nothing is issued
 * while one runs (`principal.ts`).
 */

export const OBO_HEADER = 'x-cb-obo';

/**
 * The header a socio's repeated request names its consumed approval in,
 * passed on by the app. Only an app's data token with `x-cb-obo` may send
 * it; its shape is checked before any lookup.
 */
export const APPROVAL_HEADER = 'x-cb-approval';
const APPROVAL_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface DataRequest {
    /** The request's data token; a session's request has none. */
    token: DataTokenScope | undefined;
    /** The token as the data space's actor, to name datasets. */
    actor: AgentActor | undefined;
    /** The `x-cb-obo` header. */
    obo: string | undefined;
    /** The route's operation; undefined for a route a token doesn't reach. */
    op: DataApiOperation | undefined;
    /** The dataset reference the route names, if any. */
    dataset?: string;
    /** The `x-cb-approval` header: a consumed approval for this call. */
    approval?: string;
    /**
     * This call's input for its operation's approval parameters
     * (`dataApprovalParams`); read only for a consequential operation.
     */
    params?: () => unknown;
}

/**
 * Consumes an approval of a data operation (actors' `consumeAppAction`):
 * once, only for its grant, app and digest; true when this call used it.
 */
export type ConsumeDataApproval = (input: {
    approvalId: string;
    grantId: string;
    appId: string;
    digest: string;
    correlationId: string;
}) => Promise<boolean>;

export type Gate =
    | {
          ok: true;
          /** Records the outcome of a socio's write: call with the status. */
          after?: (status: number) => void;
      }
    | { ok: false; status: 400 | 403; error: string; reason?: ActorDenyReason };

const REFUSED = {
    obo: 'This app adopted socio access: send the request’s x-cb-obo with this call.',
    invalid: 'The request’s x-cb-obo is invalid or expired.',
    denied: 'The person or socio this request is for can’t do this.',
    approval: 'This change needs the person’s approval first; the app asks for it.',
    unusable: 'That approval can’t be used for this call: it isn’t approved, was used, or was for something else.',
    stray: 'x-cb-obo goes with an app’s data token only.',
    strayApproval: 'x-cb-approval goes with an app’s data token and x-cb-obo.',
    approvalShape: 'x-cb-approval is not an approval id.',
} as const;

/**
 * The data API's check of a request against its actor. One per
 * platform; holds no state of its own.
 */
export class DataAuthority {
    /**
     * `consume`: the consume-once approvals; without it no consequential
     * operation passes through a socio.
     */
    constructor(
        private space: DataSpace,
        private actors: ActorsShape,
        private consume?: ConsumeDataApproval,
    ) {}

    async gate(request: DataRequest): Promise<Gate> {
        const { token, obo, approval } = request;
        const appId = token && dataTokenAppId(token);
        // `x-cb-approval` only from an app's token on behalf of someone, and
        // only shaped like an approval id, before anything is looked up.
        if (approval !== undefined) {
            if (!appId || obo === undefined) {
                return { ok: false, status: 400, error: REFUSED.strayApproval };
            }
            if (!APPROVAL_ID.test(approval)) {
                return { ok: false, status: 400, error: REFUSED.approvalShape };
            }
        }
        if (!appId)
        // A computer's, a job's or a session's request: as before.
        {
            return obo !== undefined ? { ok: false, status: 400, error: REFUSED.stray } : { ok: true };
        }
        const terms = this.space.delegation?.terms(appId);
        // An app that hasn't adopted the contract, on its own: as before.
        if (obo === undefined && !terms) {
            return { ok: true };
        }
        const audience = `app:${appId}` as Audience;
        const dataset =
            request.dataset !== undefined && request.actor
                ? this.space.datasetFor(request.actor, request.dataset)
                : undefined;
        const correlationId = `data-${randomUUID()}`;
        const deny = (
            reason: ActorDenyReason,
            error: string,
            who: { personId?: string; socioId?: string; grantId?: string } = {},
            correlation = correlationId,
            resource?: { kind: string; id: string },
        ): Gate => {
            this.actors.audit.decision(
                {
                    correlationId: correlation,
                    phase: 'decision',
                    decision: 'deny',
                    reason,
                    ...who,
                    audience,
                    action: request.op,
                    tier: request.op && operationTier(request.op),
                    ...(resource
                        ? { resourceKind: resource.kind, resourceId: resource.id }
                        : dataset
                          ? { resourceKind: 'dataset', resourceId: dataset.id }
                          : {}),
                },
                '',
            );
            return { ok: false, status: 403, error, reason };
        };

        if (obo === undefined) {
            // A contract app's own work, without a person or socio behind it.
            // It reaches only operations the data API names.
            if (!terms || !request.op) {
                return deny('obo_required', REFUSED.obo);
            }
            const tier = operationTier(request.op);
            if (tier === 'read' && terms.backgroundRead) {
                return { ok: true };
            }
            if (tier === 'write' && dataset && named(terms.background, dataset) !== undefined) {
                return { ok: true };
            }
            return deny('obo_required', REFUSED.obo);
        }

        if (!request.op) {
            return deny('credential_invalid', REFUSED.denied);
        }
        const op = request.op;
        const tier = operationTier(op);

        // A continuation: a reference token, by hash, for this app.
        if (isContinuationToken(obo)) {
            const resolved = this.actors.credentials.resolve(obo, {
                kind: 'continuation',
                audience,
            });
            if (!resolved.ok) {
                return deny(resolved.reason, REFUSED.invalid);
            }
            const { credential, grant } = resolved;
            // It carries no more than it was issued with.
            if (!scopesCoverTier(credential.scopes, tier)) {
                return deny('scope_insufficient', REFUSED.denied, who(grant), credential.contextId);
            }
            return this.socio(grant.id, {
                audience,
                op,
                tier,
                dataset,
                terms,
                appId,
                correlationId: credential.contextId,
                deny,
                continuation: true,
                request,
            });
        }

        // The proxy's per-request `cbob_`: opens only for this very app.
        const claims = this.actors.credentials.openObo(obo, appId);
        if (!claims) {
            return deny('credential_invalid', REFUSED.invalid);
        }
        if (claims.grantId) {
            return this.socio(claims.grantId, {
                audience,
                op,
                tier,
                dataset,
                terms,
                appId,
                correlationId: claims.requestId,
                deny,
                continuation: false,
                request,
            });
        }

        // A person's own session on the app.
        const session = await this.space.delegation?.session(appId, claims.sessionHash!);
        const access = session && this.space.delegation?.personAccess(appId, session.userId);
        if (!session || !access || !personMay(access, tier, dataset, terms)) {
            return { ok: false, status: 403, error: REFUSED.denied };
        }
        return { ok: true };
    }

    /** A socio acting for a person, under its grant. */
    private async socio(
        grantId: string,
        input: {
            audience: Audience;
            op: DataApiOperation;
            tier: ActionTier;
            dataset: { id: string; ref?: string } | undefined;
            terms: DataContractTerms | undefined;
            appId: string;
            correlationId: string;
            deny: (
                reason: ActorDenyReason,
                error: string,
                who?: { personId?: string; socioId?: string; grantId?: string },
                correlation?: string,
                resource?: { kind: string; id: string },
            ) => Gate;
            /** A continuation rather than the request's own `cbob_`. */
            continuation: boolean;
            request: DataRequest;
        },
    ): Promise<Gate> {
        const { audience, op, tier, dataset, correlationId, deny } = input;
        const decision = await this.actors.authorizer.authorize(grantId, {
            audience,
            action: op,
            tier,
            ...(dataset ? { resource: { kind: 'dataset', id: dataset.id } } : {}),
        });
        const grant = this.actors.grants.get(grantId);
        if (!decision.allowed || !grant) {
            return deny(
                decision.allowed ? 'grant_missing' : decision.reason,
                decision.allowed || !['grant_revoked', 'grant_expired', 'grant_idle'].includes(decision.reason)
                    ? REFUSED.denied
                    : 'This access was revoked or has ended.',
                grant ? who(grant) : { grantId },
                correlationId,
            );
        }
        // The person's own rights in the app bound the socio's.
        const access = this.space.delegation?.personAccess(input.appId, grant.personId);
        if (!access || !personMay(access, tier, dataset, input.terms)) {
            return deny('person_no_access', REFUSED.denied, who(grant), correlationId);
        }
        // A destructive data call needs a consumed approval bound to it (of the
        // consumable kind): consumed here, before the operation runs, for the
        // digest of this very call.
        let used: { approvalId: string; digest: string } | undefined;
        if (tier === 'consequential') {
            const approvalId = input.request.approval;
            if (approvalId === undefined || !this.consume) {
                return deny('approval_required', REFUSED.approval, who(grant), correlationId);
            }
            const refuse = () =>
                deny('approval_unusable', REFUSED.unusable, who(grant), correlationId, {
                    kind: 'approval',
                    id: approvalId,
                });
            // A job doesn't spend the person's approvals.
            if (input.continuation) {
                return refuse();
            }
            const params = dataApprovalParams(op, input.request.params?.());
            if (!params) {
                return refuse();
            }
            const digest = intentDigest(input.appId, dataAction(op), params);
            const consumed = await this.consume({
                approvalId,
                grantId: grant.id,
                appId: input.appId,
                digest,
                correlationId,
            }).catch(() => false);
            if (!consumed) {
                return refuse();
            }
            used = { approvalId, digest };
        }
        const record = {
            correlationId,
            ...who(grant),
            audience,
            action: op,
            tier,
            // A consequential call is recorded by the approval it used:
            // its id and digest, never its parameters.
            ...(used
                ? {
                      resourceKind: 'approval',
                      resourceId: used.approvalId,
                      digest: used.digest,
                  }
                : dataset
                  ? { resourceKind: 'dataset', resourceId: dataset.id }
                  : {}),
        };
        this.actors.audit.decision(
            { ...record, phase: 'decision', decision: 'allow' },
            `${grant.id}|${op}|${used?.approvalId ?? dataset?.id ?? ''}`,
        );
        this.actors.grants.touch(grant.id);
        return {
            ok: true,
            // Every write outcome is recorded, with the original actor and
            // the request's correlation id.
            after:
                tier === 'read'
                    ? undefined
                    : (status) =>
                          this.actors.audit.recordSoon({
                              ...record,
                              phase: 'outcome',
                              status: String(status),
                          }),
        };
    }
}

const who = (grant: { id: string; personId: string; socioId: string }) => ({
    personId: grant.personId,
    socioId: grant.socioId,
    grantId: grant.id,
});

/** The entry of `list` (ids or manifest refs) that names `dataset`. */
function named(list: readonly string[], dataset: { id: string; ref?: string }): string | undefined {
    return list.find(
        (entry) =>
            entry === dataset.id || (dataset.ref !== undefined && entry.toLowerCase() === dataset.ref.toLowerCase()),
    );
}

/** A person's rights through the app: `actorRights(person)`. */
function personMay(
    access: 'owner' | 'space',
    tier: ActionTier,
    dataset: { id: string; ref?: string } | undefined,
    terms: DataContractTerms | undefined,
) {
    if (tier === 'admin') {
        return false;
    }
    if (access === 'owner') {
        return true;
    }
    if (tier === 'read') {
        return true;
    }
    if (tier !== 'write' || !dataset || !terms?.spaceAccess) {
        return false;
    }
    const key = named(Object.keys(terms.spaceAccess), dataset);
    return key !== undefined && terms.spaceAccess[key] === 'write';
}
