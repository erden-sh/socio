/**
 * The cloud connection as the server reports it to admins (`GET /api/cloud`)
 * and uses itself: how the deployment stands with the cloud services'
 * issuer. Never a key, a token or the enrollment token.
 */

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
