/**
 * Socio-actor scopes (CB-232): a closed list. Apps don't
 * invent scopes; they declare actions and give each a tier, and tiers map
 * to scopes. Gateways (CB-239) use their own scopes as the action names.
 * Shared by the server, the consent cards and (later) the app SDK.
 */

export const ACTOR_SCOPES = [
    'app:read',
    'app:write',
    'app:act',
    'model:invoke',
    'git:read',
    'git:push',
    'git:pr',
    // CB-267: one approved read of a repository for a workspace app.
    'git:extract',
] as const;
export type ActorScope = (typeof ACTOR_SCOPES)[number];

/**
 * What an app action does. `admin` is never a socio's: no scope maps
 * to it.
 */
export const ACTION_TIERS = ['read', 'write', 'consequential', 'admin'] as const;
export type ActionTier = (typeof ACTION_TIERS)[number];

/** Who a credential is for: one app or plugin, or a coding gateway. */
export type Audience = `app:${string}` | `plugin:${string}` | 'gateway:model' | 'gateway:git';
export type AudienceKind = 'app' | 'plugin' | 'gateway';

const AUDIENCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const GATEWAYS = ['model', 'git'] as const;

/** An audience's kind and id, or undefined for anything else. */
export function parseAudience(value: string): { kind: AudienceKind; id: string } | undefined {
    const colon = value.indexOf(':');
    if (colon < 1) {
        return undefined;
    }
    const kind = value.slice(0, colon);
    const id = value.slice(colon + 1);
    if (kind === 'gateway') {
        return (GATEWAYS as readonly string[]).includes(id) ? { kind, id } : undefined;
    }
    if ((kind === 'app' || kind === 'plugin') && AUDIENCE_ID.test(id)) {
        return { kind, id };
    }
    return undefined;
}
export const isAudience = (value: string): value is Audience => !!parseAudience(value);

/** The audience kinds each scope is valid for. */
export const SCOPE_AUDIENCES: Record<ActorScope, readonly string[]> = {
    'app:read': ['app', 'plugin'],
    'app:write': ['app', 'plugin'],
    'app:act': ['app', 'plugin'],
    'model:invoke': ['gateway:model'],
    'git:read': ['gateway:git'],
    'git:push': ['gateway:git'],
    'git:pr': ['gateway:git'],
    'git:extract': ['gateway:git'],
};

/** Whether `scope` may be granted for `audience`. */
export function scopeFitsAudience(scope: ActorScope, audience: string) {
    const parsed = parseAudience(audience);
    if (!parsed) {
        return false;
    }
    const allowed = SCOPE_AUDIENCES[scope];
    return allowed.includes(parsed.kind) || allowed.includes(`${parsed.kind}:${parsed.id}`);
}

/** Scopes each scope implies: `act` ⇒ `write` ⇒ `read`. */
const IMPLIES: Partial<Record<ActorScope, readonly ActorScope[]>> = {
    'app:act': ['app:write'],
    'app:write': ['app:read'],
};

/**
 * The closure of a scope list, in the closed list's order: every implied
 * scope added, unknown strings dropped.
 */
export function closeScopes(scopes: readonly string[]): ActorScope[] {
    const out = new Set<ActorScope>();
    const add = (scope: ActorScope) => {
        if (out.has(scope)) {
            return;
        }
        out.add(scope);
        for (const implied of IMPLIES[scope] ?? []) {
            add(implied);
        }
    };
    for (const scope of scopes) {
        if ((ACTOR_SCOPES as readonly string[]).includes(scope)) {
            add(scope as ActorScope);
        }
    }
    return ACTOR_SCOPES.filter((scope) => out.has(scope));
}

/** What `request_app_access`'s `access` asks for. */
export const APP_ACCESS_LEVELS = ['read', 'write', 'act'] as const;
export type AppAccessLevel = (typeof APP_ACCESS_LEVELS)[number];
export const APP_ACCESS_SCOPES: Record<AppAccessLevel, readonly ActorScope[]> = {
    read: ['app:read'],
    write: ['app:write', 'app:read'],
    act: ['app:act', 'app:write', 'app:read'],
};

/**
 * The scope an app action's tier needs; null for `admin`, which no socio
 * may ever hold.
 */
export function tierScope(tier: ActionTier): ActorScope | null {
    switch (tier) {
        case 'read':
            return 'app:read';
        case 'write':
            return 'app:write';
        case 'consequential':
            return 'app:act';
        case 'admin':
            return null;
    }
}

/** Whether a grant's scopes cover an app action of `tier`. */
export function scopesCoverTier(scopes: readonly string[], tier: ActionTier): boolean {
    const needed = tierScope(tier);
    return needed !== null && closeScopes(scopes).includes(needed);
}

/**
 * The data API's operations and their fixed tiers: the platform
 * applies them itself, whatever an app declares.
 */
export const DATA_OPERATION_TIERS = {
    query: 'read',
    read: 'read',
    insert: 'write',
    upsert: 'write',
    createTable: 'write',
    addColumn: 'write',
    createIndex: 'write',
    dropIndex: 'write',
    analyze: 'write',
    batch: 'write',
    // A table's row history on or off (CB-369): a plugin's own token only.
    tableHistory: 'write',
    // Analytical tables (CB-369): bulk appends and DuckDB queries.
    append: 'write',
    appendFrom: 'write',
    analyticsQuery: 'read',
    deleteRows: 'consequential',
    dropTable: 'consequential',
    deleteDataset: 'consequential',
} as const satisfies Record<string, ActionTier>;
export type DataOperation = keyof typeof DATA_OPERATION_TIERS;

/** Each scope in words, for consent cards: what it allows. */
export const SCOPE_WORDS: Record<ActorScope, string> = {
    'app:read': 'see the app and its data; it can’t change anything',
    'app:write': 'see and change the app’s own data',
    'app:act': 'ask to take the app’s consequential actions, each of which you approve',
    'model:invoke': 'use the coding model on the card',
    'git:read': 'read the repository',
    'git:push': 'push to its own session branch',
    'git:pr': 'open draft pull requests from its session branch',
    'git:extract': 'give one app a copy of the approved files, once',
};

/**
 * Why an access check failed: a closed list, stored in `actor_audit.reason`
 * (never free text). Wave-2 phases add codes here, never elsewhere.
 */
export const ACTOR_DENY_REASONS = [
    // The grant and the credential.
    'grant_missing',
    'grant_revoked',
    'grant_expired',
    'grant_idle',
    'credential_invalid',
    'credential_expired',
    'audience_mismatch',
    'context_closed',
    // The intersection.
    'feature_off',
    'person_inactive',
    'person_no_access',
    'socio_unavailable',
    'audience_unavailable',
    'policy_stale',
    'action_undeclared',
    'admin_tier',
    'scope_insufficient',
    'resource_denied',
    'conversation_gone',
    'conversation_shared',
    'conversation_changed',
    // Issuance.
    'contract_outdated',
    'limit_reached',
    // The data API: a contract app's call without `x-cb-obo`
    // outside its background datasets; a consequential data operation
    // without a consumed approval.
    'obo_required',
    'approval_required',
    // The app browser: a turn for another person, socio or conversation
    // addressed a grant; a development app on a company socio.
    'turn_mismatch',
    'not_promoted',
    // Action approvals.
    'params_too_large',
    'not_consequential',
    'approval_unusable',
    // CB-239, the Git proxy.
    'rate_limited',
    'token_ceiling',
    'github_unavailable',
    'github_unreachable',
    'github_refused',
    'github_answer',
    'installation_refused',
    'token_refused',
    'request_malformed',
    'request_too_large',
    'commands_malformed',
    'ref_outside_session',
    'ref_delete',
    'capability_refused',
    'coding_git_unavailable',
    'mirror_missing',
    'protected_path',
    'submodule',
    'token_shape',
    'foreign_identity',
    'commit_text',
    'not_a_commit',
    'too_many_commits',
    'pack_invalid',
    'pack_too_large',
    // CB-267, extraction for workspace apps (CB-239).
    'extraction_off',
    'app_ineligible',
    'ref_unknown',
    'paths_invalid',
    'standing_invalid',
    'standing_off',
    'commit_missing',
    'too_large',
    'storage_refused',
    'extraction_not_ready',
    'extraction_expired',
    'read_window_over',
    // CB-232: action parameters RFC 8785 can't canonicalize.
    'params_invalid',
    // CB-239: the first request the coding egress proxy refused for a
    // session and host.
    'egress_denied',
] as const;
export type ActorDenyReason = (typeof ACTOR_DENY_REASONS)[number];

/** Why a grant ended: a closed list, as `actor_audit.reason` for `revoke` rows. */
export const ACTOR_REVOKE_REASONS = [
    'person_revoked',
    'admin_revoked',
    'task_ended',
    'replaced',
    'expired',
    'idle',
    'person_deactivated',
    'access_changed',
    'socio_unavailable',
    'audience_unavailable',
    'policy_stale',
    'feature_off',
    'conversation_gone',
    'conversation_changed',
    'conversation_shared',
    // CB-239: a coding session ended for its own reasons (setup failed,
    // budget used, a start that never finished).
    'session_ended',
] as const;
export type ActorRevokeReason = (typeof ACTOR_REVOKE_REASONS)[number];

/** `actor_audit.phase`. */
export const ACTOR_AUDIT_PHASES = [
    'grant',
    'credential',
    'decision',
    'approval',
    'outcome',
    'revoke',
    'context',
    'setting',
] as const;
export type ActorAuditPhase = (typeof ACTOR_AUDIT_PHASES)[number];

/** Where a grant was made: a person's chat, a room, or a schedule. */
export const GRANT_CONVERSATION_KINDS = ['private', 'room', 'schedule'] as const;
export type GrantConversationKind = (typeof GRANT_CONVERSATION_KINDS)[number];

/** Grant lifetimes, in minutes. */
export const GRANT_MINUTES = { min: 5, max: 480, default: 60, idle: 30 };
