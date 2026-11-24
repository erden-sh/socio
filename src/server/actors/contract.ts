/**
 * What other features may know of socio-actor access (CB-232): its tags,
 * the slices of its services they call, its error, and plain types and
 * constants. It imports only `effect`, `@socio/*` and `import type` from
 * the allowlist, and
 * holds no logic.
 *
 * The types and constants here moved from the files that defined them. The pure
 * helpers other features call moved to packages
 * (`@socio/foundation/actors/principal`, `@socio/foundation/actors/tokens`,
 * `@socio/shared/actors/card-text`); the feature logic they call
 * (`appActorAccess`, the action calls, `consumeAppAction`) is behind the
 * `AppActors` and `ActorActions` tags.
 *
 * Socio access reads the mini apps and plugins, which sit above it in the
 * folder order, for its cards, grants and tools: it states what it reads of
 * them here (`ActorAppsShape`, `ActorPluginsShape`), and the apps
 * and plugins services satisfy those slices.
 */
import { Context } from 'effect';
import type { Context as HonoContext } from 'hono';

import type { AppsSettings } from '@socio/foundation/apps/settings';
import type { AppEnv } from '@socio/foundation/http/app-env';
import type {
    ActionTier,
    ActorAuditPhase,
    ActorDenyReason,
    ActorRevokeReason,
    ActorScope,
    Audience,
    GrantConversationKind,
} from '@socio/shared/actor-scopes';
import type { AppStatus } from '@socio/shared/apps/app-types';
import type { FlagKey } from '@socio/shared/flags';
import type { PluginMode } from '@socio/shared/plugins/plugins';
import type { User } from '@socio/shared/types';

import type { ApprovalsShape } from '../approvals/contract.js';
import type { ConversationsShape, PeopleShape, SociosShape, SpacesShape } from '../workspace/contract.js';

// ── Principals ───────────────────────────────────────────────────────────

/**
 * Who a request is for (CB-232). Built by the platform only, never
 * parsed from a payload. A socio actor always acts for a person, and
 * its `actorType` is fixed when the grant is made: nothing turns a socio
 * actor into a person actor.
 */
export type Actor =
    | { actorType: 'person'; personId: string }
    | {
          actorType: 'socio';
          /** The socio id (`dotId` in code). */
          socioId: string;
          /** The person it acts for: always present. */
          personId: string;
          grantId: string;
          /** One credential lineage (a broker context or a coding session). */
          sessionId: string;
          /** The execution context the credential is bound to. */
          contextId: string;
          scopes: readonly ActorScope[];
          /**
           * The audience's policy version the grant was approved under: an
           * app version's `actionSetHash`, '' for gateways. A string, not the
           * number earlier drafts showed.
           */
          policyVersion: string;
      };
export type SocioActor = Extract<Actor, { actorType: 'socio' }>;

// ── Rows ─────────────────────────────────────────────────────────────────

export interface GrantRecord {
    id: string;
    personId: string;
    socioId: string;
    audiences: Audience[];
    scopes: ActorScope[];
    resources: Record<string, unknown> | null;
    conversationId: string;
    conversationKind: GrantConversationKind;
    task: string;
    policyVersion: string;
    approvalId: string | null;
    createdAt: number;
    expiresAt: number;
    idleMs: number;
    lastUsedAt: number;
    revokedAt: number | null;
    revokedBy: string | null;
    revokeReason: string | null;
    replacedBy: string | null;
}

/** Which grants a revocation or a re-evaluation reaches. */
export interface GrantFilter {
    grantId?: string;
    personId?: string;
    socioId?: string;
    audience?: string;
    conversationId?: string;
    /** Every live grant (the feature switched off, the sweep). */
    all?: true;
}

export type CredentialKind = 'cbsa' | 'cbgw' | 'continuation';
export type HolderKind = 'context' | 'prompt-run' | 'grant';

export interface CredentialRecord {
    hash: string;
    kind: CredentialKind;
    grantId: string;
    audiences: Audience[];
    scopes: ActorScope[];
    contextId: string;
    holderKind: HolderKind;
    holderId: string;
    issuedAt: number;
    expiresAt: number;
    issuedBy: string;
}

export interface ContextRecord {
    id: string;
    grantId: string;
    personId: string;
    socioId: string;
    kind: 'browser' | 'sandbox';
    audience: string;
    worker: string | null;
    openedAt: number;
    closedAt: number | null;
    closeReason: string | null;
}

/** One `actor_audit` row: ids, codes and digests, never secrets. */
export interface AuditEntry {
    at: number;
    correlationId: string;
    phase: ActorAuditPhase;
    decision?: 'allow' | 'deny';
    reason?: string;
    personId?: string;
    socioId?: string;
    grantId?: string;
    /** Who caused it: a person or admin id, or `system`. */
    actorBy?: string;
    audience?: string;
    action?: string;
    tier?: string;
    resourceKind?: string;
    resourceId?: string;
    status?: string;
    digest?: string;
    /** `setting` rows only: the setting and its old and new values. */
    detail?: string;
}

// ── Constants ────────────────────────────────────────────────────────────

/** App browser caps: per person, per socio, per instance. */
export const BROWSER_CONTEXT_LIMITS = {
    perPerson: 2,
    perSocio: 4,
    perInstance: 8,
};

export interface ContextLimits {
    perPerson: number;
    perSocio: number;
    perInstance: number;
}

/**
 * A standing extraction grant (CB-267, CB-239): audience `gateway:git`
 * and scope `git:extract` alone may last up to 7 days; every other grant
 * keeps GRANT_MINUTES.max (8 hours).
 */
export const STANDING_EXTRACTION_MAX_MINUTES = 7 * 24 * 60;

// ── The error ────────────────────────────────────────────────────────────

/**
 * A refusal with its reason code: thrown by grants, credentials and
 * contexts, caught by the apps broker and browse tools. A plain `Error`
 * subclass, as before: callers test it with `instanceof` and read
 * `reason`, and its name, `String()` and JSON stay what they were. A
 * `Data.TaggedError` would change those; it comes with the actors layer,
 * not here.
 */
export class ActorAccessError extends Error {
    constructor(
        readonly reason: ActorDenyReason,
        message: string,
    ) {
        super(message);
    }
}

// ── Authorization ────────────────────────────────────────────────────────

/**
 * What a conversation is now, for where delegated output may go.
 */
export type ConversationState =
    | 'private'
    | 'room'
    | 'schedule'
    /** A Telegram group or topic: refused until it is a room. */
    | 'telegram-group'
    /** Deleted, archived, or never existed. */
    | 'gone';

/**
 * What an audience says about itself. Registered per audience kind
 * (`app`, `plugin`) or exact gateway (`gateway:model`, `gateway:git`) by
 * the feature that owns it: the apps (from `AppsService`), the plugins and
 * the gateways. With none registered, the audience is
 * unavailable and every check fails closed.
 */
export interface AudiencePolicy {
    /**
     * The audience's current policy version when it may be delegated now
     * (an app version's `actionSetHash`, '' for a gateway); undefined when
     * it can't (no delegation contract, unpublished, unregistered, a
     * development app on a company socio, the gateway off).
     */
    policyVersion(audience: Audience): string | undefined | Promise<string | undefined>;
    /**
     * Whether the person may still open or use the audience
     * (`AppsService.access`, Space membership, the code-access list).
     */
    personMay(personId: string, audience: Audience, grant: GrantRecord): boolean | Promise<boolean>;
    /**
     * The app's `delegation.alwaysAsk`: every access request for it shows
     * the person's card, whatever their policy for `app_access_read`. Part
     * of `policyVersion` (the `actionSetHash`). Unset: false. The apps
     * answer it from the manifest.
     */
    alwaysAsk?(audience: Audience): boolean | Promise<boolean>;
    /** An app action's declared tier; undefined when it isn't declared. */
    actionTier?(audience: Audience, action: string): ActionTier | undefined | Promise<ActionTier | undefined>;
    /**
     * A rule on the resource the request touches: Space reach for a
     * dataset (CB-227), a repository still on the list. Allowed when unset.
     */
    resourceAllowed?(input: {
        grant: GrantRecord;
        audience: Audience;
        action?: string;
        tier?: ActionTier;
        scope?: ActorScope;
        resource: { kind: string; id: string };
    }): boolean | Promise<boolean>;
}

/** The keys an audience policy is registered under. */
export type AudienceKey = 'app' | 'plugin' | 'gateway:model' | 'gateway:git';

/** One use of a grant: the audience, and what the request does there. */
export interface AccessRequest {
    audience: Audience;
    /** An app action's manifest name, or a data API operation's. */
    action?: string;
    /** The tier, when the platform knows it (data API operations). */
    tier?: ActionTier;
    /** A gateway's scope for this request (`model:invoke`, `git:push`). */
    scope?: ActorScope;
    resource?: { kind: string; id: string };
}

export type Decision = { allowed: true; tier?: ActionTier } | { allowed: false; reason: ActorDenyReason };

// ── Grants, credentials, contexts, revocation ───────────────────────────

export interface NewSocioGrant {
    personId: string;
    socioId: string;
    /** One app or plugin; or the coding gateways' pair (CB-239). */
    audiences: readonly Audience[];
    scopes: readonly ActorScope[];
    /** Gateways: repositories, the card's model, an extraction's payload. */
    resources?: Record<string, unknown> | null;
    conversationId: string;
    conversationKind: GrantConversationKind;
    /** The socio's words, kept for the person's history; at most 500 chars. */
    task: string;
    /** The audience's policy version it is approved under. */
    policyVersion?: string;
    approvalId?: string | null;
    minutes?: number;
    idleMinutes?: number;
    /** Who approved it: the person, or `system` for a reuse policy. */
    approvedBy: string;
    correlationId: string;
    /** A grant this one widens: revoked in the same transaction. */
    replaces?: string;
}

export interface IssueCredential {
    grant: GrantRecord;
    kind: CredentialKind;
    /** One app or plugin; for `cbgw_` a subset of the gateways. */
    audiences: readonly Audience[];
    /** Narrows the grant's scopes; the grant's when unset. */
    scopes?: readonly ActorScope[];
    /** The broker context, the sandbox, or (continuations) the request. */
    contextId: string;
    /** The work whose life the credential follows. */
    holder: { kind: HolderKind; id: string };
    ttlMs?: number;
    correlationId: string;
}

export type ResolvedCredential =
    | { ok: true; credential: CredentialRecord; grant: GrantRecord }
    | { ok: false; reason: ActorDenyReason };

/** What a `cbob_` names: the app, whose request, until when. */
export interface OboClaims {
    appId: string;
    /** A socio session's grant; or, for a person's, their app session's hash. */
    grantId?: string;
    sessionHash?: string;
    requestId: string;
    issuedAt: number;
    expiresAt: number;
}

/**
 * Whether the work a credential is bound to is still live, by its id.
 * Synchronous: `resolve` is, and a holder's row is a local SQLite read.
 * A check that throws counts as not live.
 */
export type HolderCheck = (id: string) => boolean;

/** A new execution context (`ActorContexts.open`). */
export interface OpenContext {
    grant: GrantRecord;
    kind: ContextRecord['kind'];
    audience: Audience;
    worker?: string;
    limits?: ContextLimits;
    correlationId: string;
}

/** Something open that a revocation must close: a socket, a stream, a run. */
export interface TrackedHandle {
    close(reason: string): void;
}

export type RevocationListener = (event: {
    grantIds: readonly string[];
    reason: string;
    /** `local`: revoked here; `remote`: learned from another runtime or a re-check. */
    origin: 'local' | 'remote';
}) => void;

/** An `actor_audit` line as callers give it; `at` defaults to now. */
export type AuditInput = Omit<AuditEntry, 'at'> & { at?: number };

/** A credential presented at a listener, checked (`ActorAccess.check`). */
export type CheckResult =
    | {
          ok: true;
          actor: SocioActor;
          grant: GrantRecord;
          credential: CredentialRecord;
          decision: Extract<Decision, { allowed: true }>;
      }
    | { ok: false; status: 401 | 403; reason: ActorDenyReason };

/** Hands a renewed credential to whoever holds the context. */
export type CredentialDeliverer = (context: ContextRecord, token: string, expiresAt: number) => Promise<void> | void;

// ── Slices of `ActorAccess` ──────────────────────────────────────────────

/** `actor_audit`, as other features write it (`ActorAudit`). */
export interface ActorAuditShape {
    /** Inside the caller's open transaction: a state change's own row. */
    recordIn(input: AuditInput): void;
    /** Nothing reads it back at once: a deny, an outcome, a context event. */
    recordSoon(input: AuditInput): void;
    /**
     * An access decision: every deny, and one allow per `sampleKey` per
     * minute; `sampleDeny` samples a deny tied to no grant the same way.
     * False when sampled out.
     */
    decision(
        input: AuditInput & { decision: 'allow' | 'deny' },
        sampleKey: string,
        options?: { sampleDeny?: boolean },
    ): boolean;
}

/** Audience policies by kind or exact gateway (`AudienceRegistry`). */
export interface AudiencesShape {
    /** Registers a policy; the returned function removes it (tests). */
    register(key: AudienceKey, policy: AudiencePolicy): () => void;
    for(audience: string): AudiencePolicy | undefined;
}

/** `authorizeActor`, as other features call it (`ActorAuthorizer`). */
export interface ActorAuthorizerShape {
    /** What a conversation is now. */
    conversation(id: string): ConversationState | Promise<ConversationState>;
    /** The grant-level terms only, cached at most 5 s unless `fresh`. */
    authorizeGrant(grantId: string, options?: { fresh?: boolean }): Promise<Decision>;
    /** The grant-level terms, then the request's own. */
    authorize(grantId: string, request: AccessRequest, options?: { fresh?: boolean }): Promise<Decision>;
    /** The grant-level terms, in order, uncached; the first that fails is the reason. */
    grantDecision(grant: GrantRecord): Promise<Decision>;
}

/** Delegation grants, as other features use them (`SocioGrants`). */
export interface SocioGrantsShape {
    /** Records an approved grant and its `grant` audit row in one transaction. */
    create(input: NewSocioGrant): Promise<GrantRecord>;
    get(id: string): GrantRecord | undefined;
    unrevoked(filter: GrantFilter): GrantRecord[];
    /** Records a grant's use (at most once a minute per grant). */
    touch(grantId: string): void;
    /**
     * A live grant to reuse: same person, socio and conversation, for
     * this audience, whose scopes cover the request, with time left and not idle.
     */
    reusable(request: {
        personId: string;
        socioId: string;
        audience: Audience;
        conversationId: string;
        scopes: readonly ActorScope[];
    }): GrantRecord | undefined;
    /** A person's grants, newest first, with their ends (Account → Socio access). */
    ofPerson(personId: string): GrantRecord[];
    /** Everyone's live grants (Operations → Access). */
    live(): GrantRecord[];
}

/** Liveness checks of holder kinds a feature owns (`HolderChecks`). */
export interface HolderChecksShape {
    /** Registers `kind`'s check (one per kind); returns its removal. */
    register(kind: Exclude<HolderKind, 'context' | 'grant'>, check: HolderCheck): () => void;
}

/** Socio-actor credentials, as other features use them (`ActorCredentials`). */
export interface ActorCredentialsShape {
    readonly holders: HolderChecksShape;
    /** A new credential for live work under a live grant. */
    issue(input: IssueCredential): Promise<{ token: string; hash: string; expiresAt: number }>;
    /** A presented reference token, checked: shape, hash, expiry, audience, holder. */
    resolve(token: string | undefined, expect: { kind: CredentialKind; audience?: Audience }): ResolvedCredential;
    /** Ends every credential a piece of work holds; resolves to how many. */
    revokeHolder(kind: HolderKind, id: string): Promise<number>;
    /** When the newest credential a holder has expires (for renewal). */
    newestExpiry(kind: HolderKind, id: string): number | undefined;
    /** A `cbob_` for one proxied request. */
    mintObo(input: Omit<OboClaims, 'issuedAt' | 'expiresAt'> & { ttlMs: number }): string;
    /** A request-bound `cbob_`'s claims, for `appId` only. */
    openObo(token: string | undefined, appId: string): OboClaims | undefined;
}

/** Execution contexts, as other features use them (`ActorContexts`). */
export interface ActorContextsShape {
    open(input: OpenContext): Promise<ContextRecord>;
    get(id: string): ContextRecord | undefined;
    /** Every open context (diagnostics, the broker's reconciliation). */
    openContexts(): ContextRecord[];
    /** Closes contexts; resolves to the ids it closed. */
    close(ids: readonly string[], reason: string, correlationId: string): Promise<string[]>;
}

/** Revocation, as other features follow it (`ActorRevocations`). */
export interface ActorRevocationsShape {
    /** Holds something open for a grant; returns its release. */
    track(grantId: string, handle: TrackedHandle): () => void;
    /** Called with every revocation this runtime makes or learns of. */
    onRevoked(listener: RevocationListener): () => void;
}

/**
 * Socio-actor access (CB-232): what the composition (`LegacyActors`), the
 * server entry and other features call of `ActorAccess` (actors/service.ts).
 */
export interface ActorsShape {
    readonly audiences: AudiencesShape;
    readonly audit: ActorAuditShape;
    readonly authorizer: ActorAuthorizerShape;
    readonly grants: SocioGrantsShape;
    readonly credentials: ActorCredentialsShape;
    readonly contexts: ActorContextsShape;
    readonly revocations: ActorRevocationsShape;
    /**
     * Whether grants and credentials may be issued now: not while a live
     * runtime enforces an older actor-access contract, or none.
     */
    issuable(): boolean;
    /** The one check a listener makes for a presented `cbsa_` or `cbgw_`. */
    check(
        token: string | undefined,
        request: AccessRequest & {
            kind: Extract<CredentialKind, 'cbsa' | 'cbgw'>;
            correlationId: string;
        },
        bind?: (credential: CredentialRecord) => boolean,
    ): Promise<CheckResult>;
    /** Re-checks the grants `filter` matches now; resolves to those revoked. */
    reevaluate(filter: GrantFilter, by?: string): Promise<string[]>;
    /** The leader's minute: every unrevoked grant re-checked, expired credentials dropped. */
    sweep(): Promise<string[]>;
    /** A CB-169 flag for a person; `socio-actor-access` by default. */
    featureOn(personId: string, flag?: FlagKey): boolean;
    /** A context's proof key. */
    contextKey(contextId: string): Buffer;
    /** Every grant of a person (a deactivation); resolves to how many ended. */
    revokePerson(personId: string, by: string): Promise<number>;
    /** How many grants `revokePerson` would end now (CB-360's deactivation preview). */
    personGrantCount(personId: string): number;
    /**
     * A person's `actor_audit` rows, newest first, older than `before` (by
     * time, then id): CB-360's trail. Ids, codes and digests, never secrets.
     */
    personTrail(
        personId: string,
        before: { at: number; id: number } | undefined,
        limit: number,
    ): (AuditEntry & { id: number })[];
    /** A grant ends at the person's or an admin's word; resolves to the grants revoked. */
    revoke(filter: GrantFilter, by: string, reason: ActorRevokeReason, correlationId?: string): Promise<string[]>;
    /** Who delivers renewed `cbsa_` credentials to a context kind; returns its removal. */
    deliverWith(kind: ContextRecord['kind'], deliver: CredentialDeliverer): () => void;
    /** Starts this runtime's revocation watch and context loop (every runtime). */
    watch(): void;
    /** A drain (CB-108): context leases go to the next runtime; returns how many. */
    drain(): number;
    stop(): void;
}

export class Actors extends Context.Service<Actors, ActorsShape>()('socio/actors/Actors') {}

// ── What apps and plugins see ────────────────────────────────────────────

/**
 * What the apps service and the apps proxy see of socio-actor access
 * (CB-232): the audience registry, for the apps' `app` policy;
 * revocation of an app's grants (unpublish, unregister, unshare); and, for
 * the proxy and `/api/apps/actor/*`, the listener check, the `cbob_` codec,
 * continuations and per-grant tracking of open responses and sockets.
 */
export interface AppActorAccess {
    audiences: Pick<AudiencesShape, 'register'>;
    /** Ends every grant for `app:<appId>`; resolves to how many ended. */
    appEnded(appId: string, by: string, reason: ActorRevokeReason): Promise<number>;
    /** The one listener check for a `cbsa_` at the apps proxy. */
    check: ActorsShape['check'];
    /** A context's proof key. */
    contextKey(contextId: string): Buffer;
    /** Whether `socio-actor-access` is on for the person. */
    featureOn(personId: string): boolean;
    /** A `cbob_` for one proxied request. */
    mintObo(input: Omit<OboClaims, 'issuedAt' | 'expiresAt'> & { ttlMs: number }): string;
    /** A request-bound `cbob_`'s claims, for `appId` only. */
    openObo(token: string | undefined, appId: string): OboClaims | undefined;
    /** `authorizeActor` for one use of a grant. */
    authorize(grantId: string, request: AccessRequest): Promise<Decision>;
    grant(id: string): GrantRecord | undefined;
    /** A continuation for a socio's request, held by its grant. */
    continuation(input: {
        grant: GrantRecord;
        audience: Audience;
        requestId: string;
        ttlMs: number;
    }): Promise<{ token: string; expiresAt: number }>;
    /**
     * Whether every live runtime enforces this actor-access contract. While
     * it is false, listeners refuse socio credentials too, not only their
     * issuance: after a rollback, an older runtime's data API would ignore
     * `x-cb-obo`.
     */
    issuable(): boolean;
    /** Holds an open response or socket of a grant. */
    track(grantId: string, handle: TrackedHandle): () => void;
}

/** `AppActorAccess` over `ActorAccess`, built once (`appActorAccess`, actors/apps.ts). */
export class AppActors extends Context.Service<AppActors, AppActorAccess>()('socio/actors/AppActors') {}

// ── The apps and plugins socio access reads ──────────────────────────────

/** A mini app as socio access reads it: the fields of apps' `AppRecord` it uses. */
export interface ActorAppRecord {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly dotId: string;
    readonly ownerUserId: string;
    readonly status: AppStatus;
}

/** The mini apps as socio access reads them: the slice of apps' `AppsShape` it calls. */
export interface ActorAppsShape {
    readonly enabled: boolean;
    get(id: string): ActorAppRecord | undefined;
    all(): ActorAppRecord[];
    url(app: Pick<ActorAppRecord, 'id'>): string;
    access(userId: string, app: ActorAppRecord): 'owner' | 'space' | undefined;
    socioMayReach(app: ActorAppRecord, userId: string, conversationId: string, dotId: string): boolean;
}

/** An installed plugin as socio access reads it: the fields of plugins' `InstalledPlugin` it uses. */
export interface ActorPluginRecord {
    readonly id: string;
    readonly enabled: boolean;
    readonly mode: PluginMode;
    readonly manifest: { readonly name: string };
}

/**
 * The installed plugins as socio access reads them: the slice of plugins'
 * `PluginsShape` it calls, and the apps' settings (`appsSettings` isn't
 * in `PluginsShape` yet: plugins/contract.ts says why).
 */
export interface ActorPluginsShape {
    readonly parentOrigin: string;
    readonly appsSettings?: AppsSettings;
    list(): ActorPluginRecord[];
    get(id: string): ActorPluginRecord | undefined;
    origin(id: string): string | undefined;
    mayUse(row: ActorPluginRecord | undefined, person: User | undefined): boolean;
    activeUser(userId: string): User | undefined;
}

// ── What socio access's approvals, cards and calls read ──────────────────

/**
 * What socio access's approvals use: its own service (`Actors`) and the
 * approvals (`Approvals`), as their contracts type them. The composition's
 * views over the graph's tags satisfy it wherever it is passed in.
 */
export interface ActorApprovalServices {
    readonly actors: ActorsShape;
    readonly approvals: ApprovalsShape;
}

/**
 * The workspace as socio access and the platforms it is handed read it:
 * its conversations, people, socios and Spaces (dataspace's routes name
 * their platform by `consumeAppAction`'s parameter and read `readsSpace`).
 */
export type ActorsWorkspace = ConversationsShape & PeopleShape & SociosShape & SpacesShape;

/** The plugins as socio access reads them (`ActorPluginsShape`). */
export type ActorPlugins = ActorPluginsShape;

/** What a card's or a grant's app and plugin facts read: the apps, the plugins and the workspace. */
export interface ActorAppServices {
    readonly apps: ActorAppsShape;
    readonly plugins: ActorPlugins;
    readonly workspace: ActorsWorkspace;
}

/** What asking for an app's action reads: both of the above. */
export type ActorActionServices = ActorApprovalServices & ActorAppServices;

/**
 * Socio access's own services and what its routes, tools, cards and action
 * calls read with them (`ActorActionServices`): the very objects
 * `ActorActions` is made over, for the module's hooks.
 */
export class ActorServices extends Context.Service<ActorServices, ActorActionServices>()(
    'socio/actors/ActorServices',
) {}

// ── Actions an app or plugin asks for ────────────────────────────────────

/**
 * The socio-access calls an app or a service plugin makes for the request
 * it serves (CB-232): continuations, action approvals and their
 * consume-once use. The caller has authenticated who is calling and opened
 * the request's `cbob_` for that audience; the grant always comes from the
 * `cbob_`, the audience from the credential, never from the body.
 */
export interface ActorCall {
    /** `app:<id>` or `plugin:<id>`, from the app token or plugin proof. */
    audience: Audience;
    /** The request's `cbob_`, opened for that audience. */
    obo: OboClaims;
    /** A person's live session by the hash their `cbob_` names. */
    personSession(hash: string): Promise<boolean>;
    /** A sealed `cbob_` for the person's session, for a continuation. */
    mintPersonObo(sessionHash: string, requestId: string, ttlMs: number): string;
}

/**
 * Which app or audience an action approval is for: an app's id, or any
 * audience that has actions (`plugin:<id>`). The caller always takes it
 * from the authenticated app token or plugin proof.
 */
export interface ActionTarget {
    /** An app's id (the apps' callers). */
    appId?: string;
    /** Or the audience, `app:<id>` or `plugin:<id>`; it wins when both are given. */
    audience?: Audience;
}

/** One consume-once use of an action approval (`consumeAppAction`). */
export type ConsumeAppAction = ActionTarget & {
    approvalId: string;
    grantId: string;
    digest: string;
    correlationId: string;
    kind?: 'app' | 'data';
};

/**
 * The handlers behind `/api/apps/actor/*` and `/api/plugins/:id/actor/*`
 * (actors/action-calls.ts), and the data API's consume of a `data:<op>`
 * approval (`consumeAppAction`, actors/approvals.ts). `actorActions`
 * (action-calls.ts) builds it over the platform.
 */
export interface ActorActionsShape {
    /** `POST …/actor/continuations`. */
    continuationCall(
        c: HonoContext<AppEnv>,
        actors: Pick<AppActorAccess, 'grant' | 'authorize' | 'continuation'>,
        call: ActorCall,
    ): Promise<Response>;
    /**
     * `POST …/actor/continuations` over socio access's own app view
     * (`appActorAccess`, actors/apps.ts), for a caller that holds no
     * `AppActorAccess` of its own (a plugin's service).
     */
    accessContinuationCall(c: HonoContext<AppEnv>, call: ActorCall): Promise<Response>;
    /** `POST …/actor/approvals`. */
    approvalCall(c: HonoContext<AppEnv>, call: ActorCall): Promise<Response>;
    /** `POST …/actor/approvals/:id/consume`. */
    consumeCall(c: HonoContext<AppEnv>, call: ActorCall, approvalId: string): Promise<Response>;
    /** Uses an approval once, for that grant, audience and digest only. */
    consumeAppAction(input: ConsumeAppAction): Promise<boolean>;
}

export class ActorActions extends Context.Service<ActorActions, ActorActionsShape>()('socio/actors/ActorActions') {}

// ── Config ───────────────────────────────────────────────────────────────

/**
 * What `actors` reads of the platform's config: the instance secret every
 * runtime holds (`SESSION_SECRET`), or without one (loopback only) the
 * secret this process made. The composition root resolves it once, so
 * every feature that keys on it sees the same value.
 */
export interface ActorsConfigShape {
    readonly secret: string;
}

export class ActorsConfig extends Context.Service<ActorsConfig, ActorsConfigShape>()('socio/actors/ActorsConfig') {}
