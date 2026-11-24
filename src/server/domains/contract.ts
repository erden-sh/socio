/**
 * What other features may know of domains (hostnames through Nginx Proxy
 * Manager and Cloudflare DNS): its tags, the slice of `DomainsService`
 * the composition and the module call, the error a caller catches, and the plain
 * types it names. It imports only `effect` and `@socio/*`, and holds no
 * logic.
 *
 * The types and the error here moved from `settings.ts`, `http.ts` and
 * `service.ts`, which re-export them, so every importer keeps compiling until
 * that importer switches to the contract. `DomainsService` implements
 * `DomainsShape`.
 *
 * The settings bundle `domainsSettingsFromEnv` returns is `DomainsSetup`
 * here, so the config tag can take the `DomainsConfig` name the other
 * contracts use; `settings.ts` still exports it as `DomainsConfig`, its
 * old name (`composition/config.ts` names `DomainsSetup`).
 *
 * Not here, on purpose:
 * - `domainsSettingsFromEnv`, `normalHostname`, `wildcardOf` and
 *   `CLOUDFLARE_API_URL`: only the entry (`index.ts`) and this folder use
 *   them.
 * - The NPM and Cloudflare clients, `Redactor` and `requestJson`: this
 *   folder's own plumbing.
 * - `DomainsStore` and `domainsSchema`: construction and migrations
 *   (the store's repositories have tags in `integrations/contract.ts`).
 * - `ensureBase`, `remove`, `checkHostname`, `baseNames`, `idle` and
 *   `current`: only this folder and its tests call them.
 */
import { Context } from 'effect';

import type { DomainOp, DomainsStatus, ManagedHostname } from '@socio/shared/domains';

// ── Settings ─────────────────────────────────────────────────────────────

/**
 * The domains module's settings. It is off unless every one of NPM's and
 * Cloudflare's settings is there; a secret whose value is `none` (the
 * placeholder swarm secret) counts as missing. `DOMAINS_ACME_EMAIL` is
 * optional: without it the module refuses to request certificates.
 */
export interface DomainsSettings {
    /** `DOMAINS_ZONE`: the Cloudflare zone, e.g. example.test. */
    zone: string;
    /** `DOMAINS_BASE`: the app's host, under the zone, e.g. brain.example.test. */
    base: string;
    /** `DOMAINS_TARGET_IP`: where A records point (IPv4; DNS only). */
    targetIp: string;
    /** `DOMAINS_UPSTREAM`: what proxy hosts forward to. */
    upstream: { scheme: 'http' | 'https'; host: string; port: number };
    /** `DOMAINS_ACME_EMAIL`: the Let's Encrypt account address; unset refuses certificates. */
    acmeEmail?: string;
    npm: {
        /** `NPM_API_URL`, e.g. http://ingress_proxy:81/api. */
        url: string;
        /** `NPM_CREDENTIALS` (`NPM_CREDENTIALS_FILE`): the scoped NPM user's login. */
        email: string;
        password: string;
        timeoutMs: number;
        /** Certificate requests wait for certbot's DNS-01 challenge. */
        certificateTimeoutMs: number;
    };
    cloudflare: {
        /** `CLOUDFLARE_API_URL`; api.cloudflare.com by default (tests use a fake). */
        url: string;
        /** `CLOUDFLARE_DNS_TOKEN` (`CLOUDFLARE_DNS_TOKEN_FILE`). */
        token: string;
        /** `CLOUDFLARE_ZONE_ID`: skips the zone lookup when set. */
        zoneId?: string;
        timeoutMs: number;
    };
}

/**
 * What `domainsSettingsFromEnv` read: the settings, or the names of the
 * missing ones (the module is off). `settings.ts` exports it as
 * `DomainsConfig`, and `PlatformConfig.domains` has this type.
 */
export interface DomainsSetup {
    settings?: DomainsSettings;
    /** The missing settings, by name, when off. */
    missing: string[];
}

// ── Errors ───────────────────────────────────────────────────────────────

export type DomainsErrorCode =
    | 'not_configured'
    | 'invalid_hostname'
    | 'outside_zone'
    | 'covered'
    | 'busy'
    | 'acme_email_missing'
    | 'acme_email_mismatch'
    | 'conflict'
    | 'not_managed'
    | 'unavailable'
    | 'refused'
    | 'unauthorized';

/** The service a failure came from. */
export type Upstream = 'npm' | 'cloudflare';

/**
 * Every failure the module reports; its message is already redacted. A
 * plain `Error`: `DomainsShape` returns promises, which reject with it, and
 * the routes map `code` to a status with `instanceof`. It stays so for
 * now; it becomes tagged errors when the shape's methods return Effects.
 */
export class DomainsError extends Error {
    constructor(
        readonly code: DomainsErrorCode,
        message: string,
        readonly service?: Upstream,
        readonly status?: number,
    ) {
        super(message);
        this.name = 'DomainsError';
    }
}

// ── Plain types ──────────────────────────────────────────────────────────

/** What `provision` resolves to: the audited op and the host's state after it. */
export interface ProvisionResult {
    op: DomainOp;
    host?: ManagedHostname;
}

/** An operation once it is saved, and the promise of its end (the routes answer 202 with `op`). */
export interface DomainOpStart {
    op: DomainOp;
    done: Promise<DomainOp>;
}

// ── Tags ─────────────────────────────────────────────────────────────────

/**
 * Domains as the composition (`LegacyDomains`), the operator routes and the
 * module's start hook call them; `provision` is the hook for promoted apps'
 * custom domains. `DomainsService` implements it.
 */
export interface DomainsShape {
    /** Whether every setting is there. */
    readonly enabled: boolean;
    /** The managed hostnames with NPM's live state, and the recent operations. */
    status(): Promise<DomainsStatus>;
    /** Sets up or repairs the base and its wildcard, without waiting for the end. */
    startEnsureBase(actor: string): Promise<DomainOpStart>;
    /** Provisions one hostname, without waiting for the end; throws `DomainsError` for refusals. */
    startProvision(raw: string, actor: string): Promise<DomainOpStart & { hostname: string }>;
    /** Removes a hostname this module provisioned, without waiting for the end. */
    startRemove(raw: string, actor: string): Promise<DomainOpStart>;
    /** Provisions one hostname and waits for the audited op and the host's state. */
    provision(raw: string, options?: { actor: string }): Promise<ProvisionResult>;
    /** At start: operations the last process didn't finish are marked failed; how many. */
    recover(): Promise<number>;
}

export class Domains extends Context.Service<Domains, DomainsShape>()('socio/domains/Domains') {}

// ── Config ───────────────────────────────────────────────────────────────

/** The `PlatformConfig` field domains reads. */
export interface DomainsConfigShape {
    readonly domains?: DomainsSetup;
}

export class DomainsConfig extends Context.Service<DomainsConfig, DomainsConfigShape>()(
    'socio/domains/DomainsConfig',
) {}
