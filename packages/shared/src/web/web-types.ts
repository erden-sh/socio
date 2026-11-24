/**
 * How a Dot appears on the web. `agent`: the declared
 * `http_get`/`http_json` tools with an honest User-Agent. `browser`: the
 * Dot browses through its computer's Chromium instead, and the declared
 * tools say so. Neither identifies the user.
 */
export const WEB_IDENTITIES = ['agent', 'browser'] as const;
export type WebIdentity = (typeof WEB_IDENTITIES)[number];

/** One line of a Dot's web-read audit. */
export interface WebAudit {
    id: string;
    /** The user the Dot acted for; an admin for policy changes. */
    userId?: string | null;
    /** `GET`/`HEAD` for reads; `SET` for an identity change. */
    method: string;
    host: string;
    /** The path, with query parameter names but never their values. */
    path: string;
    status?: number | null;
    bytes: number;
    outcome: string;
    createdAt: number;
}

/** `GET /api/dots/:id/web`: the Dot's web identity, limits and stops. */
export interface WebStatus {
    identity: WebIdentity;
    /** Whether the identity is the Dot's own or the workspace default. */
    source: 'dot' | 'default';
    defaultIdentity: WebIdentity;
    userAgent: string;
    limits: {
        perHostPerMinute: number;
        globalPerMinute: number;
        maxBytes: number;
        timeoutMs: number;
        cacheTtlSeconds: number;
        cooldownSeconds: number;
    };
    /** Hosts that refused recently, and until when reads to them pause. */
    stoppedHosts: { host: string; status: number; until: number }[];
    /** Admins only. */
    audit?: WebAudit[];
}
