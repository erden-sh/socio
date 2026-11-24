/**
 * Connected agents (CB-90): what the account and admin pages and the
 * consent screen show of a grant, one person's approval of one external
 * agent (Claude Code, Cursor, ...), and the scopes in plain words.
 */

/** The scopes an agent can ask for, in plain words (src/server/agents/actor.ts). */
export const AGENT_SCOPE_LABELS: Record<string, string> = {
    'issues:read': 'Search and read issues and their comments',
    'issues:write': 'File issues, comment, vote and change what you may change (status changes stay with admins)',
    'pages:read': 'Read Spaces, their page trees and search them',
    'pages:write': 'Create, edit, append to and delete pages in Spaces you can read',
    'docs:read': 'Read product help articles available to your role',
    'plugins:read':
        'Read data in the Social strategy plugin, if you may use it (other plugins ask for their own permission)',
    'plugins:write':
        'Add and change data in the Social strategy plugin, if you may use it (other plugins ask for their own permission)',
    offline_access: 'Stay connected until you disconnect it, without asking again',
};

export interface AgentGrantView {
    grantId: string;
    /** The person it acts for (app user id). */
    userId: string;
    clientId: string;
    clientName: string;
    /** The host the client's metadata comes from; null for unverified local apps. */
    clientDomain: string | null;
    /** Its redirect is on this computer: anyone can claim to be it. */
    localApp: boolean;
    label: string;
    scopes: string[];
    createdAt: number;
    lastUsedAt: number | null;
    expiresAt: number | null;
    revokedAt: number | null;
    revokedBy: string | null;
}

/** Admins see whose grant it is. */
export interface AgentGrantAdminView extends AgentGrantView {
    personName: string;
}

/** What the consent screen shows about one authorization request. */
export interface AgentConsentView {
    clientId: string;
    clientName: string;
    logoUri: string | null;
    clientUri: string | null;
    /** The host the client id (its metadata document) is served from. */
    metadataHost: string;
    /** Shown as the domain; null for unverified local apps. */
    clientDomain: string | null;
    localApp: boolean;
    /** The redirect the person goes back to, for unverified local apps. */
    redirectUri: string;
    scopes: string[];
    /**
     * Plain words for scopes `AGENT_SCOPE_LABELS` does not list: one
     * plugin's own scopes (`plugins:calendar:write`), named after it.
     */
    scopeLabels?: Record<string, string>;
    /** The person approving it. */
    personName: string;
    /** Set when an admin's allowlist doesn't include this client's domain. */
    refusal: string | null;
}

/** The admin's allowlist of client domains; null is off (any domain). */
export interface AgentSettingsView {
    allowedDomains: string[] | null;
}
