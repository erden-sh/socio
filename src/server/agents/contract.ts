/**
 * What other features may know of connected agents (CB-90): their tags, the
 * slices of `AgentGrants` and `CimdFetcher` they call, and plain types.
 * `layer.ts` implements `Grants`, `GrantAdmin` and `AgentTokens`. It imports
 * only `effect`, `@socio/*` and `import type` from `node:*`, and holds no
 * logic.
 *
 * Moved here (the old paths are gone):
 * - `AgentTokenResolver` (`actor.ts`), `AgentDocsCatalog` (`docs.ts`).
 * - `AgentGrantError` (still a plain `Error`; `auth/better-auth.ts` and
 *   `routes.ts` check it with `instanceof`) and `NewGrant` (`grants.ts`).
 * - `CimdOptions`, `ResolvedAddress` and `ClientMetadata` (`cimd.ts`).
 *
 * Moved into packages (the old paths are gone):
 * - `AgentActor`: `@socio/foundation/agents/actor` (so the Board, below
 *   agents in the folder order, can name it).
 * - `AGENT_SCOPES`, `AgentScope`, `isGrantableScope`:
 *   `@socio/shared/agents/scopes` (`actor.ts`).
 * - `clientHost`, `isLocalRedirect`: `@socio/foundation/agents/clients`
 *   (`grants.ts`, `cimd.ts`).
 * - The authorization server's paths (`MCP_PATH`, `AUTH_PATH`,
 *   `CONSENT_PATH`, ...), `OAUTH_SCOPES`, `AGENT_CLIENTS_TABLE`,
 *   `mcpResource`, `protectedResourceMetadata` and its URL helpers,
 *   `agentChallenge` and `withConsentGrant`:
 *   `@socio/foundation/agents/oauth` (`oauth.ts`).
 *
 * Not here, on purpose:
 * - `AgentGrants` and `CimdFetcher` themselves: the composition builds them.
 *   Other folders get the `Grants` tag below; the composition hands the
 *   `CimdFetcher` to `agentOAuthOptions` itself, so it has no tag.
 * - `agentOAuthOptions` (`oauth.ts`): it returns Better Auth's
 *   `OAuthOptions`, a type a contract can't name (`@better-auth/*` isn't on
 *   the allowlist), so it stays in `oauth.ts`: the composition hands it to
 *   auth (`composition/auth.ts`, `agentAuthorization`).
 * - `agentGrantsSchema` (`grants.ts`): the modules registry's.
 * - The docs catalog tag: the catalog is `docs/`'s. Its shape must
 *   satisfy `AgentDocsCatalog`, what agents read of it.
 * - An `AgentsConfig` tag: agents reads no `PlatformConfig` field. The MCP
 *   endpoint's allowed origins come from the HTTP composition
 *   (`composition/http/agents.ts`); auth reads `CimdOptions` from its own
 *   config.
 */
import type { IncomingMessage } from 'node:http';

import { Context } from 'effect';

import type { AgentActor } from '@socio/foundation/agents/actor';
import type { AgentGrantAdminView, AgentGrantView } from '@socio/shared/agent-grants';
import type { User } from '@socio/shared/types';

// ── Plain types ──────────────────────────────────────────────────────────

/**
 * Resolves `Authorization: Bearer <token>` for `resource` (the MCP endpoint's
 * canonical URL, RFC 8707) to the agent and person, or null when the token is
 * missing, expired, revoked, for another resource, or its person can't sign in.
 */
export type AgentTokenResolver = (token: string, resource: string) => Promise<AgentActor | null>;

/** The same audience-filtered catalog used by the web documentation. */
export interface AgentDocsCatalog {
    list(role?: User['role']): Array<{
        title: string;
        description: string;
        url: string;
    }>;
    markdown(url: string, role?: User['role']): string | null;
    search(
        query: string,
        role?: User['role'],
    ): Promise<
        Array<{
            id: string;
            url: string;
            type: 'page' | 'heading' | 'text';
            content: string;
            breadcrumbs?: string[];
            table?: string;
        }>
    >;
}

/** An approval the consent screen records (`GrantsShape.create`). */
export interface NewGrant {
    userId: string;
    /** The Better Auth account (`auth_user.id`) the tokens name. */
    authUserId: string;
    clientId: string;
    clientName: string;
    clientDomain: string | null;
    label: string;
    /** What the agent asked for; only agent scopes are kept. */
    scopes: readonly string[];
    resource: string;
    redirectUri: string;
}

export interface ResolvedAddress {
    address: string;
    family: number;
}

/** How client metadata documents are fetched (`CimdFetcher`); auth's config holds them. */
export interface CimdOptions {
    /** Every address a host name resolves to (DNS by default). */
    lookup?: (hostname: string) => Promise<ResolvedAddress[]>;
    /**
     * Sends the GET, connected to `address` alone (https by default). Tests
     * send it to a local fake server instead.
     */
    request?: (url: URL, address: ResolvedAddress, signal: AbortSignal) => Promise<IncomingMessage>;
    now?: () => number;
    /** How long a fetch may take (5 s). */
    timeoutMs?: number;
}

/** A client's metadata document, checked. */
export interface ClientMetadata {
    clientId: string;
    /** The host the document is served from ("claude.ai"). */
    host: string;
    name: string;
    redirectUris: string[];
    logoUri?: string;
    clientUri?: string;
    /** native when a redirect is on this computer or an app's own scheme. */
    applicationType: 'web' | 'native';
}

// ── Errors ───────────────────────────────────────────────────────────────

/**
 * A grant can't be made, found or changed; `status` is the HTTP answer.
 * A plain `Error` during the migration: callers check it with `instanceof`,
 * and a `Data.TaggedError` would change its name and how it prints. Its
 * `(message, status)` constructor stays too: `auth/better-auth.ts` builds
 * it, so converting it waits for auth's call sites.
 */
export class AgentGrantError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 403 | 404 = 400,
    ) {
        super(message);
    }
}

// ── Grants ───────────────────────────────────────────────────────────────

/**
 * What other features and the composition call of connected agents' grants, with
 * the signatures `AgentGrants` has today (synchronous, but `resolve`).
 * Listing, revoking one grant and the domain allowlist's edits are agents'
 * own routes' (`GrantAdmin`).
 */
export interface GrantsShape {
    /** Records an approval (the consent screen, `auth/better-auth.ts`). */
    create(input: NewGrant, now?: number): AgentGrantView;
    /** Drops a grant whose consent did not go through (no tokens exist). */
    discard(grantId: string): void;
    /** Revokes all of a person's grants (a deactivation, `auth/accounts.ts`). Returns how many. */
    revokeAllOf(userId: string, by: string, now?: number): number;
    /** How many grants `revokeAllOf` would revoke now (CB-360's deactivation preview). */
    countOf(userId: string, now?: number): number;
    /** The allowlist of client domains; null when off (any domain). */
    allowedDomains(): string[] | null;
    /** Whether a client may connect, by the allowlist. */
    clientAllowed(clientId: string): boolean;
    /** The MCP endpoint's resolver (`AgentTokens`). */
    readonly resolve: AgentTokenResolver;
}

export class Grants extends Context.Service<Grants, GrantsShape>()('socio/agents/Grants') {}

/**
 * What agents' own routes call of the grants (Account → Connected agents,
 * Admin → Connected agents): listing, revoking one grant, and the domain
 * allowlist's edits. `AgentGrants` implements it.
 */
export interface GrantAdminShape {
    /** A person's live grants, newest first. */
    list(userId: string, now?: number): AgentGrantView[];
    /** Everyone's live grants, for admins, newest first. */
    listAll(now?: number): AgentGrantAdminView[];
    /** Revokes a grant (`owner`: only if it is theirs); throws `AgentGrantError` (404) when not found. */
    revoke(grantId: string, by: string, owner?: string, now?: number): AgentGrantView;
    /** The allowlist of client domains; null when off (any domain). */
    allowedDomains(): string[] | null;
    /** Sets the allowlist (null turns it off); throws `AgentGrantError` (400) for a bad domain. */
    setAllowedDomains(domains: readonly string[] | null): string[] | null;
}

export class GrantAdmin extends Context.Service<GrantAdmin, GrantAdminShape>()('socio/agents/GrantAdmin') {}

/**
 * `AgentTokens`: how the MCP endpoint resolves a bearer token.
 * Optional today (the endpoint answers 503 without it), so the default is
 * undefined and callers keep checking for it.
 */
export const AgentTokens = Context.Reference<AgentTokenResolver | undefined>('socio/agents/AgentTokens', {
    defaultValue: () => undefined,
});

// ── Client metadata documents ────────────────────────────────────────────

/**
 * What the authorization server reads of client metadata documents
 * (`CimdFetcher`): the composition builds one from auth's `CimdOptions`
 * and hands it to `agentOAuthOptions` (`composition/auth.ts`).
 */
export interface CimdShape {
    /** The cached document, while it is fresh. */
    cached(clientId: string): ClientMetadata | undefined;
    /** The client's document: from the cache while fresh, else fetched. Rejects with why it can't be used. */
    get(clientId: string): Promise<ClientMetadata>;
}
