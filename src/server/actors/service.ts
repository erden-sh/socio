import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { contextKey } from '@socio/foundation/actors/keys';
import type { ActorDenyReason, ActorRevokeReason, Audience } from '@socio/shared/actor-scopes';
import type { FlagKey } from '@socio/shared/flags';

import type { RuntimeOwnershipShape } from '../runtime/contract.js';

import { ActorAudit } from './audit.js';
import { ActorAuthorizer, AudienceRegistry, type AuthorizerDeps } from './authorize.js';
import { ActorContexts } from './contexts.js';
import type {
    AccessRequest,
    ActorsShape,
    CheckResult,
    ContextRecord,
    CredentialDeliverer,
    CredentialKind,
    CredentialRecord,
    GrantFilter,
    GrantRecord,
    ResolvedCredential,
} from './contract.js';
import { ActorCredentials } from './credentials.js';
import { SocioGrants } from './grants.js';
import { ACTOR_ACCESS_CONTRACT, ACTOR_ACCESS_CONTRACT_NAME } from './principal.js';
import { ActorRevocations } from './revocations.js';

/** When a context's credential is renewed: 5 minutes before it ends. */
const RENEW_BEFORE_MS = 5 * 60_000;
/** How often contexts are adopted and renewed on each runtime. */
const CONTEXT_LOOP_MS = 30_000;

/**
 * Why a grant that fails its grant-level check is revoked (the sweep, an
 * event). A stale policy version is not revoked: the grant is suspended
 * until the person approves the new version.
 */
const REVOKE_FOR: Partial<Record<ActorDenyReason, ActorRevokeReason>> = {
    grant_expired: 'expired',
    grant_idle: 'idle',
    feature_off: 'feature_off',
    person_inactive: 'person_deactivated',
    person_no_access: 'access_changed',
    socio_unavailable: 'socio_unavailable',
    audience_unavailable: 'audience_unavailable',
    conversation_gone: 'conversation_gone',
    conversation_shared: 'conversation_shared',
    conversation_changed: 'conversation_changed',
};

export interface ActorAccessOptions {
    /** This runtime on the shared connection (CB-108). */
    ownership: RuntimeOwnershipShape;
    /** The instance secret every runtime holds (SESSION_SECRET). */
    secret: string;
    deps: Omit<AuthorizerDeps, 'audiences' | 'now'>;
    now?: () => number;
    log?: (line: string) => void;
}

/**
 * Socio-actor access (CB-232), the shared core: grants, credentials,
 * contexts, the authorization intersection, revocation and the audit
 * (`platform.actors`). Nothing here lives only in this process: rows by
 * hash, MACs any runtime verifies, and caches.
 */
export class ActorAccess implements ActorsShape {
    readonly audiences = new AudienceRegistry();
    readonly audit: ActorAudit;
    readonly authorizer: ActorAuthorizer;
    readonly grants: SocioGrants;
    readonly credentials: ActorCredentials;
    readonly contexts: ActorContexts;
    readonly revocations: ActorRevocations;
    private deliverers = new Map<ContextRecord['kind'], CredentialDeliverer>();
    private contextTimer?: ReturnType<typeof setInterval>;
    private now: () => number;
    constructor(
        private db: DatabaseSync,
        private options: ActorAccessOptions,
    ) {
        this.now = options.now ?? Date.now;
        const { ownership } = options;
        // Every runtime says which actor-access contract it enforces.
        ownership.recordContract(ACTOR_ACCESS_CONTRACT_NAME, ACTOR_ACCESS_CONTRACT);
        const issuable = () => this.issuable();
        this.audit = new ActorAudit(db, this.now);
        this.authorizer = new ActorAuthorizer(db, {
            ...options.deps,
            audiences: this.audiences,
            now: this.now,
        });
        this.revocations = new ActorRevocations(db, {
            audit: this.audit,
            invalidate: (ids) => this.authorizer.invalidate(ids),
            recheck: async (grantId) => (await this.authorizer.authorizeGrant(grantId, { fresh: true })).allowed,
            now: this.now,
            log: options.log,
        });
        this.grants = new SocioGrants(db, {
            audit: this.audit,
            issuable,
            afterRevoke: (ids, reason) => this.revocations.afterRevoke(ids, reason, 'local'),
            now: this.now,
        });
        this.credentials = new ActorCredentials(db, {
            secret: options.secret,
            audit: this.audit,
            runtimeId: ownership.session.id,
            issuable,
            now: this.now,
        });
        this.contexts = new ActorContexts(db, {
            ownership,
            audit: this.audit,
            now: this.now,
        });
    }

    /**
     * Whether grants and credentials may be issued now: not while a live
     * runtime enforces an older actor-access contract, or none.
     */
    issuable() {
        return !this.options.ownership.contractBehind(ACTOR_ACCESS_CONTRACT_NAME, ACTOR_ACCESS_CONTRACT, this.now());
    }

    /**
     * The one check a listener makes for a presented `cbsa_` or `cbgw_`:
     * the credential (shape, hash, expiry, audience, holder), then an
     * optional binding proof (the context proof at the apps proxy, the
     * stamp's sandbox at the gateway), then `authorizeActor` for the
     * request. 401 for the credential, 403 for authorization (and while a
     * live runtime enforces an older contract). Records the decision (a
     * grant's every deny, sampled allows and credential-less denies) and
     * the grant's use.
     */
    async check(
        token: string | undefined,
        request: AccessRequest & {
            kind: Extract<CredentialKind, 'cbsa' | 'cbgw'>;
            correlationId: string;
        },
        bind?: (credential: CredentialRecord) => boolean,
    ): Promise<CheckResult> {
        const resolved: ResolvedCredential = this.credentials.resolve(token, {
            kind: request.kind,
            audience: request.audience,
        });
        // A deny with no credential behind it (any bearer from the internet)
        // is sampled per reason and minute on this runtime, like allows: the
        // table is append-only. Denies for a real grant are each recorded.
        const record = (
            decision: 'allow' | 'deny',
            reason?: ActorDenyReason,
            credential?: CredentialRecord,
            grant?: GrantRecord,
        ) =>
            this.audit.decision(
                {
                    correlationId: request.correlationId,
                    phase: 'decision',
                    decision,
                    ...(reason ? { reason } : {}),
                    ...(grant
                        ? {
                              personId: grant.personId,
                              socioId: grant.socioId,
                              grantId: grant.id,
                          }
                        : {}),
                    audience: request.audience,
                    action: request.action ?? request.scope,
                    tier: request.tier,
                    ...(request.resource
                        ? {
                              resourceKind: request.resource.kind,
                              resourceId: request.resource.id,
                          }
                        : {}),
                },
                grant
                    ? `${credential?.hash ?? 'none'}|${request.action ?? request.scope ?? ''}`
                    : `deny|${reason ?? ''}`,
                { sampleDeny: !grant },
            );
        if (!resolved.ok) {
            record('deny', resolved.reason);
            return { ok: false, status: 401, reason: resolved.reason };
        }
        const { credential, grant } = resolved;
        // Not while a live runtime enforces an older contract, at every
        // listener, not only the apps proxy: that runtime would serve the
        // request unnarrowed.
        if (!this.issuable()) {
            record('deny', 'contract_outdated', credential, grant);
            return { ok: false, status: 403, reason: 'contract_outdated' };
        }
        if (bind && !bind(credential)) {
            record('deny', 'credential_invalid', credential, grant);
            return { ok: false, status: 401, reason: 'credential_invalid' };
        }
        // A request narrower than the credential's own scopes is checked
        // against the credential too: `cbgw_` scopes say which gateway it may use.
        if (request.scope && !credential.scopes.includes(request.scope)) {
            record('deny', 'scope_insufficient', credential, grant);
            return { ok: false, status: 403, reason: 'scope_insufficient' };
        }
        const decision = await this.authorizer.authorize(grant.id, request);
        if (!decision.allowed) {
            record('deny', decision.reason, credential, grant);
            return { ok: false, status: 403, reason: decision.reason };
        }
        record('allow', undefined, credential, grant);
        this.grants.touch(grant.id);
        return {
            ok: true,
            grant,
            credential,
            decision,
            actor: {
                actorType: 'socio',
                socioId: grant.socioId,
                personId: grant.personId,
                grantId: grant.id,
                sessionId: credential.holderId,
                contextId: credential.contextId,
                scopes: credential.scopes,
                policyVersion: grant.policyVersion,
            },
        };
    }

    /**
     * Re-checks the grants `filter` matches now (an event: a socio archived,
     * a role changed, a conversation archived) and revokes those that fail,
     * with the reason the check gave. A stale policy version suspends, not
     * revokes. Returns the grants revoked.
     */
    async reevaluate(filter: GrantFilter, by = 'system') {
        const revoked: string[] = [];
        const correlationId = `reevaluate-${randomUUID()}`;
        for (const grant of this.grants.unrevoked(filter)) {
            const decision = await this.authorizer.grantDecision(grant);
            if (decision.allowed) {
                continue;
            }
            const reason = REVOKE_FOR[decision.reason];
            if (!reason) {
                continue;
            }
            revoked.push(...(await this.revocations.revoke({ grantId: grant.id }, by, reason, correlationId)));
        }
        return revoked;
    }

    /**
     * The leader's minute: every unrevoked grant re-checked (expiry, idle,
     * the feature switched off, a conversation now a room) and expired
     * credential rows dropped.
     */
    async sweep() {
        const revoked = await this.reevaluate({ all: true });
        await this.credentials.pruneExpired();
        return revoked;
    }

    /**
     * A CB-169 flag for a person. The apps proxy sends a person's envelope
     * and `cbob_` only while `socio-actor-access` is on for them.
     */
    featureOn(personId: string, flag: FlagKey = 'socio-actor-access') {
        return this.options.deps.featureOn(personId, flag);
    }

    /** A context's proof key, from the secret every runtime holds. */
    contextKey(contextId: string) {
        return contextKey(this.options.secret, contextId);
    }

    /** How many grants `revokePerson` would end now (a deactivation preview). */
    personGrantCount(personId: string) {
        return this.grants.unrevoked({ personId }).length;
    }

    /** A person's audit rows, newest first (CB-360's trail). */
    personTrail(personId: string, before: { at: number; id: number } | undefined, limit: number) {
        return this.audit.personPage(personId, before, limit);
    }

    /** Every grant of a person (accounts.ts, a deactivation). */
    revokePerson(personId: string, by: string) {
        return this.revocations.revokePerson(personId, by);
    }

    /** A grant ends at the person's or an admin's word (the routes and tools). */
    revoke(filter: GrantFilter, by: string, reason: ActorRevokeReason, correlationId?: string) {
        return this.revocations.revoke(filter, by, reason, correlationId);
    }

    /**
     * Who delivers renewed `cbsa_` credentials to app browser contexts (the
     * broker client). Without one, nothing is renewed.
     */
    deliverWith(kind: ContextRecord['kind'], deliver: CredentialDeliverer) {
        this.deliverers.set(kind, deliver);
        return () => void this.deliverers.delete(kind);
    }

    /**
     * Adopts orphaned contexts and renews the credentials of those this
     * runtime holds that end within 5 minutes. Returns the contexts
     * renewed.
     */
    async renewContexts() {
        this.contexts.adoptOrphans();
        const renewed: string[] = [];
        for (const context of this.contexts.owned()) {
            // Coding sandboxes get a `cbgw_` per prompt run instead (CB-239).
            if (context.kind !== 'browser') {
                continue;
            }
            const deliver = this.deliverers.get(context.kind);
            if (!deliver) {
                continue;
            }
            const newest = this.credentials.newestExpiry('context', context.id) ?? 0;
            if (newest - this.now() > RENEW_BEFORE_MS) {
                continue;
            }
            const grant = this.grants.get(context.grantId);
            if (!grant || !(await this.authorizer.authorizeGrant(grant.id)).allowed) {
                continue;
            }
            const { token, expiresAt } = await this.credentials.issue({
                grant,
                kind: 'cbsa',
                audiences: [context.audience as Audience],
                contextId: context.id,
                holder: { kind: 'context', id: context.id },
                correlationId: `renew-${context.id}`,
            });
            await deliver(context, token, expiresAt);
            renewed.push(context.id);
        }
        return renewed;
    }

    /** Starts this runtime's revocation watch and context loop (every runtime). */
    watch() {
        this.revocations.watch();
        if (this.contextTimer) {
            return;
        }
        this.contextTimer = setInterval(() => {
            if (!this.db.isOpen) {
                return;
            }
            void this.renewContexts().catch(() => this.options.log?.('Socio access: renewing contexts failed.'));
        }, CONTEXT_LOOP_MS);
        this.contextTimer.unref();
    }

    /** A drain (CB-108): context leases go to the next runtime. */
    drain() {
        return this.contexts.releaseOwned();
    }

    stop() {
        this.revocations.stop();
        clearInterval(this.contextTimer);
        this.contextTimer = undefined;
    }
}
