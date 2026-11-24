import type { Role, User } from './types.js';

/** Every role, highest first (CB-390: one admin tier, no operator role). */
export const ROLES = ['admin', 'member'] as const satisfies readonly Role[];

/**
 * The role a stored value means. `operator` was retired (CB-390): rows an
 * older release or an older backup still carries read as `admin` until boot
 * rewrites them. Anything else unknown is a member.
 */
export const normalizeRole = (value: unknown): Role => (value === 'admin' || value === 'operator' ? 'admin' : 'member');

/** Admin checks. */
export const isAdmin = (user: Pick<User, 'role'> | undefined) => !!user && normalizeRole(user.role) === 'admin';
/**
 * The former operator check, now the admin check (CB-390): kept as
 * an alias until its last callers move.
 */
export const isOperator = isAdmin;

/** The role as the People panel and badges show it. */
export const roleLabel = (role: Role) => (normalizeRole(role) === 'admin' ? 'Admin' : 'Member');
