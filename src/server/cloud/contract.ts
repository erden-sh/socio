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

export class ReplyReports extends Context.Service<ReplyReports, ReplyReportsShape>()('socio/cloud/ReplyReports') {}
