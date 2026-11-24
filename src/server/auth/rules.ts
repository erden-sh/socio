import { normalizeRole } from '@socio/shared/roles';
import type { Role } from '@socio/shared/types';

/** Who may join and who is an admin, from `AUTH_*` (see settings.ts). */
export interface AccessRules {
    /** Verified emails that are always admins (and may join by OAuth). */
    adminEmails: ReadonlySet<string>;
    /** Verified emails and email domains that may join by OAuth. */
    allowedEmails: ReadonlySet<string>;
    allowedDomains: ReadonlySet<string>;
    /** Anyone may create an account (`AUTH_OPEN_SIGNUP=true`). */
    openSignUp: boolean;
    /** Email → existing app user id (`AUTH_LINK_USERS`). */
    links: ReadonlyMap<string, string>;
}

/** Per OAuth provider: the groups claim and the groups that count. */
export interface GroupRules {
    groupsClaim: string;
    adminGroups: readonly string[];
    allowedGroups: readonly string[];
}

/** An identity as an OAuth provider asserts it. */
export interface Identity {
    email?: string;
    emailVerified: boolean;
    groups: readonly string[];
}

const normalized = (email: string | undefined) => email?.trim().toLowerCase();

/** The groups or roles in a claim: an array of strings, or one string. */
export function claimGroups(profile: Record<string, unknown> | undefined, claim: string): string[] {
    const value = profile?.[claim];
    if (typeof value === 'string') {
        return value.split(/[\s,]+/).filter(Boolean);
    }
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Admin by rule: a verified email in the admin list. */
export function adminByEmail(rules: AccessRules, email: string | undefined, verified: boolean) {
    const address = normalized(email);
    return verified && !!address && rules.adminEmails.has(address);
}

/**
 * An OAuth identity: whether it may create an account here (invite-only
 * otherwise: an admin creates the account first) and whether it is an admin.
 * Emails count only when the provider marks them verified.
 */
export function oauthAccess(
    rules: AccessRules,
    groups: GroupRules,
    identity: Identity,
): { join: boolean; admin: boolean } {
    const email = identity.emailVerified ? normalized(identity.email) : undefined;
    const admin =
        adminByEmail(rules, email, true) || identity.groups.some((group) => groups.adminGroups.includes(group));
    const join =
        admin ||
        rules.openSignUp ||
        (!!email &&
            (rules.allowedEmails.has(email) ||
                rules.links.has(email) ||
                rules.allowedDomains.has(email.split('@')[1] ?? ''))) ||
        identity.groups.some((group) => groups.allowedGroups.includes(group));
    return { join, admin };
}

/**
 * The role an account has: its own, or admin by an email rule. A stored
 * `operator` (retired, CB-390) is an admin until boot rewrites it.
 */
export function effectiveRole(
    rules: AccessRules,
    user: { role?: unknown; email: string; emailVerified: boolean },
): Role {
    return normalizeRole(user.role) === 'admin' || adminByEmail(rules, user.email, user.emailVerified)
        ? 'admin'
        : 'member';
}
