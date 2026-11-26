/**
 * What other features may know of the cloud connection: the deployment's
 * identity at the cloud services' issuer (docs/specs/CLOUD-SERVICES-PROTOCOL.md).
 * Its tags, the slice of the service they call, and plain types and
 * constants. It imports only `effect`, and holds no logic.
 *
 * Not here, on purpose: `CloudService`, `cloudFromEnv`, the key and the
 * issuer's client. The layer (`cloud/layer.ts`) and the composition build
 * them (`composition/cloud.ts`, `index.ts`).
 */
import { Context } from 'effect';

// ── Plain types and constants ─────────────────────────────────────────────

/** The issuer a deployment talks to unless `SOCIO_CLOUD_ISSUER` names another. */
export const CLOUD_ISSUER_DEFAULT = 'https://cloud.socio.sh';

/** Where the identity is kept, sealed (`SecretSettings`): the private key never leaves it. */
export const CLOUD_IDENTITY_SETTING = 'cloud.identity';

/** `SOCIO_CLOUD*`, as `cloudFromEnv` reads them. */
export interface CloudEnvironment {
    /** `SOCIO_CLOUD=off`: the module never calls out, whatever else is set. */
    off: boolean;
    /** `SOCIO_CLOUD_ISSUER`: the issuer's identifier, an origin without a path. */
    issuer: string;
    /** `SOCIO_CLOUD_ENROLLMENT_TOKEN` (`_FILE`): provisioning's initial access token, single use. */
    enrollmentToken?: string;
}

/**
 * How the deployment stands with the issuer:
 *
 * - `off`: turned off by the environment.
 * - `not-connected`: no identity for this issuer. Nothing is sent.
 * - `connected`: it holds a key the issuer knows.
 * - `paused`: the issuer holds back tokens until its staff confirm a changed origin.
 * - `revoked`: the issuer refused the key. Nothing more is sent until it enrolls again.
 * - `lost`: an identity is stored, but its seal can't be opened (the data key changed).
 */
export type CloudConnection = 'off' | 'not-connected' | 'connected' | 'paused' | 'revoked' | 'lost';

/** `hosted` or `self-hosted`, as the issuer assigned it; the app never chooses. */
export type DeploymentMode = 'hosted' | 'self-hosted';

/** The connection, for the server's own use and its admins; never a key or a token. */
export interface CloudStatus {
    connection: CloudConnection;
    issuer: string;
    /** The deployment id the issuer gave at registration (`dep_…`). */
    deploymentId?: string;
    deploymentMode?: DeploymentMode;
    /** What the issuer lets the deployment do, as it last said. */
    scopes: readonly string[];
    /** When it enrolled, and when the issuer last answered a sync (ms). */
    enrolledAt?: number;
    lastSyncAt?: number;
}

// ── The service ──────────────────────────────────────────────────────────

/** What another feature may ask of the cloud connection. */
export interface CloudShape {
    status(): CloudStatus;
    /**
     * An access token for one service, named by its origin (RFC 8707): a
     * cached one while it is fresh, or a new one. Undefined when the
     * deployment isn't connected or the issuer can't be reached or refuses:
     * the caller then does without, and never falls back to anything else.
     */
    token(audience: string): Promise<string | undefined>;
    /**
     * What is due now, on the leader only (the module's tick): enrollment
     * with a token not yet tried, and the daily sync. It never throws.
     */
    work(): Promise<void>;
}

export class Cloud extends Context.Service<Cloud, CloudShape>()('socio/cloud/Cloud') {}

/** What the cloud connection reads of the startup configuration. */
export interface CloudConfigShape {
    /** `SOCIO_CLOUD*`; unset in a platform built without them (tests): off. */
    readonly cloud?: CloudEnvironment;
}

export class CloudConfig extends Context.Service<CloudConfig, CloudConfigShape>()('socio/cloud/CloudConfig') {}
