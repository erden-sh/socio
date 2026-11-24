import type { DatabaseSync } from 'node:sqlite';

import {
    closeScopes,
    parseAudience,
    scopeFitsAudience,
    scopesCoverTier,
    type ActorDenyReason,
} from '@socio/shared/actor-scopes';
import type { FlagKey } from '@socio/shared/flags';

import type {
    AccessRequest,
    ActorAuthorizerShape,
    AudienceKey,
    AudiencePolicy,
    AudiencesShape,
    ConversationState,
    Decision,
    GrantRecord,
} from './contract.js';
import { GrantRows } from './infra/sqlite/rows.js';

/** How long a decision is cached per grant and request. */
export const AUTHORIZE_CACHE_MS = 5_000;

/** Audience policies by kind or exact gateway (`AudiencePolicy`). */
export class AudienceRegistry implements AudiencesShape {
    private policies = new Map<string, AudiencePolicy>();
    /** Registers a policy; the returned function removes it (tests). */
    register(key: AudienceKey, policy: AudiencePolicy) {
        if (this.policies.has(key)) {
            throw new Error(`An audience policy for ${key} is already registered.`);
        }
        this.policies.set(key, policy);
        return () => void this.policies.delete(key);
    }
    for(audience: string): AudiencePolicy | undefined {
        const parsed = parseAudience(audience);
        if (!parsed) {
            return undefined;
        }
        return parsed.kind === 'gateway' ? this.policies.get(audience) : this.policies.get(parsed.kind);
    }
}

/** The CB-169 flags a grant needs on for its person. */
export function grantFeatures(grant: Pick<GrantRecord, 'audiences' | 'scopes'>) {
    const flags = new Set<FlagKey>(['socio-actor-access']);
    const scopes = closeScopes(grant.scopes);
    if (
        grant.audiences.includes('gateway:model') ||
        scopes.some((scope) => ['git:read', 'git:push', 'git:pr'].includes(scope))
    ) {
        flags.add('coding-sessions');
    }
    if (scopes.includes('git:extract')) {
        flags.add('repo-extraction');
    }
    return [...flags];
}

export interface AuthorizerDeps {
    /** An account that may act now: known and not deactivated. */
    personActive(personId: string): boolean;
    /** The person may still use the socio: live, unarchived, theirs or the company's. */
    socioUsable(personId: string, socioId: string): boolean;
    /** A CB-169 flag's value for the person. */
    featureOn(personId: string, flag: FlagKey): boolean;
    conversation(id: string): ConversationState | Promise<ConversationState>;
    audiences: AudienceRegistry;
    now?: () => number;
}

const deny = (reason: ActorDenyReason): Decision => ({
    allowed: false,
    reason,
});

/**
 * `authorizeActor`: the one function every use goes through.
 *
 *   allowed = grant live (not revoked, expired or idle)
 *          && its feature flags on for the person
 *          && person active && socio usable by the person
 *          && the conversation it was made in may still carry its output
 *          && each audience delegable, at the grant's policy version,
 *             and the person may still open it
 *          && (per request) the audience is the grant's, the action is
 *             declared, not `admin`, and the grant's scopes cover it,
 *             and the resource's own rule allows it
 *
 * Every input is read from the database or a live service. The result is
 * cached at most 5 s per grant and request, in this process only, so a
 * revocation converges within 5 s on every runtime even if its event is missed.
 */
export class ActorAuthorizer implements ActorAuthorizerShape {
    private grants: GrantRows;
    private cache = new Map<string, { at: number; decision: Decision }>();
    private now: () => number;
    constructor(
        db: DatabaseSync,
        private deps: AuthorizerDeps,
    ) {
        this.grants = new GrantRows(db);
        this.now = deps.now ?? Date.now;
    }

    /**
     * What a conversation is now: where `request_app_access` may ask from,
     * and the kind a new grant records.
     */
    conversation(id: string) {
        return this.deps.conversation(id);
    }

    /** Forgets cached decisions for these grants (a local revocation). */
    invalidate(grantIds?: readonly string[]) {
        if (!grantIds) {
            return this.cache.clear();
        }
        for (const key of [...this.cache.keys()]) {
            if (grantIds.some((id) => key.startsWith(`${id}|`))) {
                this.cache.delete(key);
            }
        }
    }

    private cached(key: string, fresh: boolean) {
        const hit = this.cache.get(key);
        if (!fresh && hit && this.now() - hit.at < AUTHORIZE_CACHE_MS) {
            return hit.decision;
        }
        return undefined;
    }
    private remember(key: string, decision: Decision) {
        if (this.cache.size > 20_000) {
            this.cache.clear();
        }
        this.cache.set(key, { at: this.now(), decision });
        return decision;
    }

    /** The grant as a whole (issuance, the 5-s re-check of open streams). */
    async authorizeGrant(grantId: string, { fresh = false }: { fresh?: boolean } = {}): Promise<Decision> {
        const key = `${grantId}|`;
        const hit = this.cached(key, fresh);
        if (hit) {
            return hit;
        }
        const grant = this.grants.get(grantId);
        return this.remember(key, grant ? await this.grantDecision(grant) : deny('grant_missing'));
    }

    /** One use of a grant for `request`. */
    async authorize(
        grantId: string,
        request: AccessRequest,
        { fresh = false }: { fresh?: boolean } = {},
    ): Promise<Decision> {
        const key = [
            grantId,
            request.audience,
            request.action ?? '',
            request.tier ?? '',
            request.scope ?? '',
            request.resource ? `${request.resource.kind}:${request.resource.id}` : '',
        ].join('|');
        const hit = this.cached(key, fresh);
        if (hit) {
            return hit;
        }
        const grant = this.grants.get(grantId);
        if (!grant) {
            return this.remember(key, deny('grant_missing'));
        }
        const whole = await this.grantDecision(grant);
        if (!whole.allowed) {
            return this.remember(key, whole);
        }
        return this.remember(key, await this.requestDecision(grant, request));
    }

    /** The grant-level terms, in order; the first that fails is the reason. */
    async grantDecision(grant: GrantRecord): Promise<Decision> {
        const { deps } = this;
        const now = this.now();
        if (grant.revokedAt !== null) {
            return deny('grant_revoked');
        }
        if (grant.expiresAt <= now) {
            return deny('grant_expired');
        }
        if (now - grant.lastUsedAt >= grant.idleMs) {
            return deny('grant_idle');
        }
        if (!grantFeatures(grant).every((flag) => deps.featureOn(grant.personId, flag))) {
            return deny('feature_off');
        }
        if (!deps.personActive(grant.personId)) {
            return deny('person_inactive');
        }
        if (!deps.socioUsable(grant.personId, grant.socioId)) {
            return deny('socio_unavailable');
        }
        const conversation = await deps.conversation(grant.conversationId);
        if (conversation === 'gone') {
            return deny('conversation_gone');
        }
        if (conversation === 'telegram-group') {
            return deny('conversation_shared');
        }
        if (conversation !== grant.conversationKind) {
            return deny('conversation_changed');
        }
        for (const audience of grant.audiences) {
            const policy = deps.audiences.for(audience);
            const version = policy ? await policy.policyVersion(audience) : undefined;
            if (!policy || version === undefined) {
                return deny('audience_unavailable');
            }
            if (version !== grant.policyVersion) {
                return deny('policy_stale');
            }
            if (!(await policy.personMay(grant.personId, audience, grant))) {
                return deny('person_no_access');
            }
        }
        return { allowed: true };
    }

    private async requestDecision(grant: GrantRecord, request: AccessRequest): Promise<Decision> {
        if (!grant.audiences.includes(request.audience)) {
            return deny('audience_mismatch');
        }
        const policy = this.deps.audiences.for(request.audience)!;
        const scopes = closeScopes(grant.scopes);
        let tier = request.tier;
        if (request.scope) {
            if (!scopeFitsAudience(request.scope, request.audience) || !scopes.includes(request.scope)) {
                return deny('scope_insufficient');
            }
        } else {
            if (!tier && request.action) {
                tier = await policy.actionTier?.(request.audience, request.action);
            }
            if (!tier) {
                return deny('action_undeclared');
            }
            if (tier === 'admin') {
                return deny('admin_tier');
            }
            if (!scopesCoverTier(scopes, tier)) {
                return deny('scope_insufficient');
            }
        }
        if (
            request.resource &&
            policy.resourceAllowed &&
            !(await policy.resourceAllowed({
                grant,
                audience: request.audience,
                action: request.action,
                tier,
                scope: request.scope,
                resource: request.resource,
            }))
        ) {
            return deny('resource_denied');
        }
        return tier ? { allowed: true, tier } : { allowed: true };
    }
}
