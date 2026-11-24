import type { Role } from './types.js';

/**
 * Service accounts (CB-57): workspace principals for external agents and
 * scripts. They sign in with API keys only, never as people, can't be
 * operators, and can't chat with Dots. Each key carries scopes, a fixed set.
 */
export const SERVICE_SCOPES = ['issues:read', 'issues:write', 'pages:read'] as const;
export type ServiceScope = (typeof SERVICE_SCOPES)[number];

export const SERVICE_SCOPE_LABELS: Record<ServiceScope, string> = {
    'issues:read': 'Read issues, comments and attachments',
    'issues:write': 'File issues, comment, attach files and change issues (as its role allows)',
    'pages:read': 'Read Spaces and their pages',
};

/** Service accounts are members or admins; never operators. */
export const SERVICE_ROLES = ['member', 'admin'] as const satisfies readonly Role[];
export type ServiceRole = (typeof SERVICE_ROLES)[number];

/** Key lifetimes on offer, in days. */
export const SERVICE_KEY_DAYS = [30, 90, 365] as const;

export interface ServiceKeyView {
    id: string;
    name: string;
    /** The key's first characters after `cbk_`, to tell keys apart. */
    hint: string;
    scopes: ServiceScope[];
    createdAt: number;
    /** The app user id of the admin who made it. */
    createdBy: string | null;
    /** Their name as the workspace knows it now; null when unknown (CB-360). */
    createdByName: string | null;
    expiresAt: number;
    lastUsedAt: number | null;
    /** The address the last request came from, as the proxy reported it. */
    lastUsedIp: string | null;
    revokedAt: number | null;
}

export interface ServiceAccountView {
    id: string;
    name: string;
    role: ServiceRole;
    description: string;
    createdAt: number;
    createdBy: string | null;
    /** Their name as the workspace knows it now; null when unknown (CB-360). */
    createdByName: string | null;
    disabledAt: number | null;
    keys: ServiceKeyView[];
}

/** `POST /api/service-accounts/:id/keys`: the key, shown this once. */
export interface CreatedServiceKey {
    key: ServiceKeyView;
    token: string;
}

/**
 * A live key a person made, as a deactivation of theirs would revoke it
 * (CB-360's impact preview). `lastLiveKey` says the account keeps no other
 * live key afterwards: whatever uses it stops working.
 */
export interface KeyMadeBy {
    keyId: string;
    name: string;
    hint: string;
    accountId: string;
    account: string;
    lastUsedAt: number | null;
    expiresAt: number;
    lastLiveKey: boolean;
}
