/**
 * What other features may know of the cloud connection: the deployment's
 * identity at the cloud services' issuer (docs/specs/CLOUD-SERVICES-PROTOCOL.md).
 * Its tags, the slice of the service they call, and plain types and
 * constants; and the AI reply reports that use it (CB-382). It imports only
 * `effect`, `@socio/*` types and context's contract (the reactions' side of
 * the reports), and holds no logic.
 *
 * Not here, on purpose: `CloudService`, `cloudFromEnv`, the key and the
 * issuer's client. The layer (`cloud/layer.ts`) and the composition build
 * them (`composition/cloud.ts`, `index.ts`).
 */
import type { KeyObject } from 'node:crypto';

import { Context, Data } from 'effect';

import type { SealState } from '@socio/foundation/keys/secret-box';
import type { ReplyReportsAdminView } from '@socio/shared/chat/reply-reports';
import type { CloudStatus } from '@socio/shared/cloud';

import type { PreparedReactionReport, ReactionReportInput, ReactionReportsShape } from '../context/contract.js';

// ── Plain types and constants ─────────────────────────────────────────────

/** The issuer a deployment talks to unless `SOCIO_CLOUD_ISSUER` names another. */
export const CLOUD_ISSUER_DEFAULT = 'https://cloud.socio.sh';

/** Where the identity is kept, sealed (`SecretSettings`): the private key never leaves it. */
export const CLOUD_IDENTITY_SETTING = 'cloud.identity';

/**
 * Where the per-deployment key for reply reports' hashes is kept, sealed:
 * `threadHash` and `socio` are HMACs under keys derived from it, so they
 * group a deployment's reports without naming anything (CB-382).
 */
export const CLOUD_REPORTS_KEY_SETTING = 'cloud.reports-key';

/** `SOCIO_CLOUD*`, as `cloudFromEnv` reads them. */
export interface CloudEnvironment {
    /** `SOCIO_CLOUD=off`: the module never calls out, whatever else is set. */
    off: boolean;
    /** `SOCIO_CLOUD_ISSUER`: the issuer's identifier, an origin without a path. */
    issuer: string;
    /** `SOCIO_CLOUD_ENROLLMENT_TOKEN` (`_FILE`): provisioning's initial access token, single use. */
    enrollmentToken?: string;
    /**
     * `SOCIO_CLOUD_REPLACE_LOST=true`: a stored identity the data key can't
     * open may be replaced by enrolling with the token. Without it, nothing
     * enrolls over one: the token still mounted is most likely the one
     * already spent, and the record of that is what was lost.
     */
    replaceLost?: boolean;
    /**
     * `SOCIO_CLOUD_REPORTS_ORIGIN`: the reports collector's origin, when it
     * isn't the issuer's own sibling (`reportsOrigin` derives that one).
     */
    reportsOrigin?: string;
}

export type { CloudConnection, CloudStatus, DeploymentMode } from '@socio/shared/cloud';

// ── The service ──────────────────────────────────────────────────────────

/** What another feature may ask of the cloud connection. */
export interface CloudShape {
    status(): CloudStatus;
    /**
     * An access token for one service, named by its origin (RFC 8707): a
     * cached one while it is fresh, or a new one. Undefined when the
     * deployment isn't connected or the issuer can't be reached or refuses:
     * the caller then does without, and never falls back to anything else.
     * `renew`: the service refused the cached one (a 401), so a new one is
     * asked for, as protocol §3.3 says, once.
     */
    token(audience: string, options?: { renew?: boolean }): Promise<string | undefined>;
    /**
     * One of the issuer's signing keys, by `kid` (§2.5), for what the issuer
     * signs (`issuer-jws.ts`). Undefined for one it doesn't publish; throws
     * when its keys can't be read.
     */
    issuerKey(kid: string): Promise<KeyObject | undefined>;
    /**
     * What is due now, on the leader only (the module's tick): enrollment
     * with a token not yet tried, and the daily sync. It never throws.
     */
    work(): Promise<void>;
    /**
     * Waits for the work running now and starts no more until `resume`: the
     * module's `release` and `stop`, so a shutdown never closes the database
     * between the issuer spending a token and the identity being stored.
     */
    drain(): Promise<void>;
    /** Lets `work` run again (the module's `start`, when this runtime leads again). */
    resume(): void;
}

export class Cloud extends Context.Service<Cloud, CloudShape>()('socio/cloud/Cloud') {}

/** What the cloud connection reads of the startup configuration. */
export interface CloudConfigShape {
    /** `SOCIO_CLOUD*`; unset in a platform built without them (tests): off. */
    readonly cloud?: CloudEnvironment;
}

export class CloudConfig extends Context.Service<CloudConfig, CloudConfigShape>()('socio/cloud/CloudConfig') {}

// ── AI reply reports (CB-382, docs/specs/REPLY-REPORTS.md) ─────────────────

/** The reaction route's report (context's contract): the cloud's names for it. */
export type ReplyReportInput = ReactionReportInput;
export type PreparedReplyReport = PreparedReactionReport;

/** Turning sharing on while the server can't share. */
export class ReplyReportsUnavailable extends Data.TaggedError('ReplyReportsUnavailable') {}

/**
 * The reply reports: the sharing setting, the outbox and its sender.
 * `file` and `withdraw` are synchronous and write on the workspace
 * connection, so the reaction's own unit of work holds them with the
 * reaction row.
 */
export interface ReplyReportsShape extends ReactionReportsShape {
    /** `GET /api/cloud/reply-reports`. */
    admin(): ReplyReportsAdminView;
    /** `PUT /api/cloud/reply-reports`; throws `ReplyReportsUnavailable` turning it on when the server can't share. */
    setSharing(sharing: boolean, actor: string): Promise<ReplyReportsAdminView>;
    /** The leader's tick: sends what is due, expires and forgets old rows. It never throws. */
    send(): Promise<void>;
    /** Waits for a send in flight and starts no more until `resume`. */
    drain(): Promise<void>;
    resume(): void;
    /** The sealed key and unsent bodies, for the data key's counts and re-seal. */
    sealStates(): Record<SealState, number>;
    reseal(): Promise<{ resealed: number; unreadable: number }>;
}

// ── Native Google and Apple sign-in (CB-570) ────────────────────────────

/** The scope the issuer grants a deployment that may have Google and Apple sign-ins verified. */
export const SOCIAL_VERIFY_SCOPE = 'social:verify';

export type SocialProviderId = 'google' | 'apple';

/**
 * `GET /v1/social/config`: the providers the cloud verifies, and Google's
 * server client id. `web: true`: the provider also works on the website,
 * through the cloud's sign-in page.
 */
export interface SocialProviderConfig {
    google?: { serverClientId: string; web?: true };
    apple?: { web?: true };
}

/** Why a verification gave no person: the server's refusal codes. */
export type SocialRefusal = 'invalid_token' | 'nonce_invalid' | 'too_many' | 'provider_unavailable';

/** Who the cloud vouches for, once its statement checked out. */
export interface SocialPerson {
    provider: SocialProviderId;
    /** The provider's stable subject id. */
    sub: string;
    /** For display only: never used to find an account. */
    email?: string;
    emailVerified?: boolean;
    /** The raw nonce the token was made with, as this server issued it. */
    nonce: string;
}

export type SocialVerdict = ({ ok: true } & SocialPerson) | { ok: false; code: SocialRefusal };

/**
 * Sign-in with Google and Apple through Socio's cloud services: the one
 * adapter between the auth feature and the cloud's verification service.
 */
export interface SocialVerificationShape {
    /** The providers offered now; null while the connection can't verify (not connected, paused, no scope). */
    config(): Promise<SocialProviderConfig | null>;
    /** Has the cloud verify an ID token made with `nonce`; never throws. */
    verify(input: { provider: SocialProviderId; idToken: string; nonce: string }): Promise<SocialVerdict>;
    /**
     * The website's flow: a one-time sign-in page for this nonce, made by
     * the cloud (which picks the return address itself). Never throws.
     */
    webStart(input: SocialWebStartInput): Promise<SocialWebStart>;
    /**
     * Redeems the sealed result the browser brought back for the cloud's
     * statement, checked as `verify`'s is. Its nonce is the statement's, for
     * the caller to match. Never throws.
     */
    redeemWeb(input: { provider: SocialProviderId; result: string }): Promise<SocialVerdict>;
}

export interface SocialWebStartInput {
    provider: SocialProviderId;
    purpose: 'signin' | 'link';
    nonce: string;
}

/** A started website flow: the page's address, or why not (with the cloud's wait, in seconds). */
export type SocialWebStart =
    | { ok: true; url: string }
    | { ok: false; code: 'provider_unavailable' | 'too_many'; retryAfterS?: number };

export class SocialVerification extends Context.Service<SocialVerification, SocialVerificationShape>()(
    'socio/cloud/SocialVerification',
) {}

export class ReplyReports extends Context.Service<ReplyReports, ReplyReportsShape>()('socio/cloud/ReplyReports') {}
