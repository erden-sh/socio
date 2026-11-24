import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import {
    CODE_GROUP_NAME,
    permissionStatements,
    statementPermissions,
    type Group,
    type GroupMember,
    type GroupPermission,
    type PersonGroup,
} from '@socio/shared/groups';
import { isAdmin } from '@socio/shared/roles';
import type { Role } from '@socio/shared/types';

/**
 * Groups (CB-376) over Better Auth's organization plugin, with dynamic
 * access control: one hidden workspace organization, a `member` row for
 * every account, and each group a runtime role (`auth_organization_role`)
 * whose `permission` is what it gives. A person's member role is their
 * base role (`admin` for Socio's admins and operators, else `member`) and
 * their groups, comma-separated (`member,g-3fa2…`), as the plugin's
 * `hasPermission` reads it. The rows are written here, on the auth
 * connection; `/organization/*` is never served (better-auth.ts).
 */

/** The one organization: hidden, never listed or switched to. */
export const WORKSPACE_ORGANIZATION_ID = 'workspace';
/** The plugin's static roles: never a group's id. */
const STATIC_ROLES = new Set(['owner', 'admin', 'member']);
/** A group's role id: `g-` and hex. */
const GROUP_ID = /^g-[0-9a-f]{12}$/;

/** The workspace organization's base role for a Socio role: admins and operators are `admin`. */
export const baseRoleOf = (role: unknown): 'admin' | 'member' => (isAdmin({ role: role as Role }) ? 'admin' : 'member');

/** A member role (`member,g-…`) split into its base role and its groups. */
export function splitMemberRole(role: string | null | undefined): { base: string; groups: string[] } {
    const parts = (role ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
    const base = parts.find((part) => STATIC_ROLES.has(part)) ?? 'member';
    return { base, groups: [...new Set(parts.filter((part) => !STATIC_ROLES.has(part)))] };
}

const joinRole = (base: string, groups: readonly string[]) => [base, ...groups].join(',');

export class GroupError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 404 | 409,
    ) {
        super(message);
    }
}

interface RoleRow {
    id: string;
    role: string;
    permission: string;
    label: string | null;
    createdAt: unknown;
}

/** Runs `work` atomically, inside Better Auth's transaction when one is open. */
function atomically<T>(db: DatabaseSync, work: () => T): T {
    db.exec('SAVEPOINT socio_groups');
    try {
        const result = work();
        db.exec('RELEASE socio_groups');
        return result;
    } catch (error) {
        db.exec('ROLLBACK TO socio_groups');
        db.exec('RELEASE socio_groups');
        throw error;
    }
}

const now = () => new Date().toISOString();
/** A date column's value (ISO text, or epoch milliseconds) as ISO text. */
function iso(value: unknown) {
    const text = String(value);
    const ms = typeof value === 'number' || /^\d+$/.test(text) ? Number(value) : Date.parse(text);
    return new Date(Number.isFinite(ms) ? ms : 0).toISOString();
}
const newId = () => randomBytes(16).toString('hex');

/** The permissions a stored `permission` column gives; none when it doesn't parse. */
function permissionsOf(stored: string): GroupPermission[] {
    try {
        const value = JSON.parse(stored) as unknown;
        return value && typeof value === 'object' ? statementPermissions(value as Record<string, string[]>) : [];
    } catch {
        return [];
    }
}

export class WorkspaceGroups {
    constructor(private db: DatabaseSync) {}

    /**
     * The workspace organization and a member row for every account that
     * has none, with its base role (idempotent). Returns how many rows it
     * added.
     */
    ensureWorkspace(): number {
        return atomically(this.db, () => {
            this.db
                .prepare('INSERT OR IGNORE INTO auth_organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)')
                .run(WORKSPACE_ORGANIZATION_ID, 'Workspace', WORKSPACE_ORGANIZATION_ID, now());
            const missing = this.db
                .prepare(
                    'SELECT u.id, u.role FROM auth_user u WHERE NOT EXISTS (SELECT 1 FROM auth_member m WHERE m.userId=u.id AND m.organizationId=?)',
                )
                .all(WORKSPACE_ORGANIZATION_ID) as { id: string; role: string | null }[];
            for (const user of missing) {
                this.addMember(user.id, user.role);
            }
            return missing.length;
        });
    }

    /** An account's member row, when it has none, with the base role for `role`. */
    addMember(accountId: string, role: unknown) {
        this.db
            .prepare(
                'INSERT INTO auth_member (id, organizationId, userId, role, createdAt) SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM auth_member WHERE organizationId=? AND userId=?)',
            )
            .run(
                newId(),
                WORKSPACE_ORGANIZATION_ID,
                accountId,
                baseRoleOf(role),
                now(),
                WORKSPACE_ORGANIZATION_ID,
                accountId,
            );
    }

    /**
     * The member role's base follows Socio's role (`auth_user.role`, read
     * here, not from the caller), its groups kept: called whenever an
     * account is written, so the two can't drift.
     */
    syncBaseRole(accountId: string) {
        atomically(this.db, () => {
            const account = this.db.prepare('SELECT role FROM auth_user WHERE id=?').get(accountId) as
                | { role: string | null }
                | undefined;
            if (!account) {
                return;
            }
            const { role } = account;
            const stored = this.memberRole(accountId);
            if (stored === undefined) {
                this.addMember(accountId, role);
                return;
            }
            const { groups } = splitMemberRole(stored);
            const next = joinRole(baseRoleOf(role), groups);
            if (next !== stored) {
                this.writeRole(accountId, next);
            }
        });
    }

    /** The account's member role in the workspace organization, if it has a row. */
    memberRole(accountId: string): string | undefined {
        const row = this.db
            .prepare('SELECT role FROM auth_member WHERE organizationId=? AND userId=?')
            .get(WORKSPACE_ORGANIZATION_ID, accountId) as { role: string } | undefined;
        return row?.role;
    }

    private writeRole(accountId: string, role: string) {
        this.db
            .prepare('UPDATE auth_member SET role=? WHERE organizationId=? AND userId=?')
            .run(role, WORKSPACE_ORGANIZATION_ID, accountId);
    }

    private roles(): RoleRow[] {
        return this.db
            .prepare(
                'SELECT id, role, permission, label, createdAt FROM auth_organization_role WHERE organizationId=? ORDER BY createdAt, id',
            )
            .all(WORKSPACE_ORGANIZATION_ID) as unknown as RoleRow[];
    }

    private roleRow(id: string) {
        if (!GROUP_ID.test(id)) {
            return undefined;
        }
        return this.roles().find((row) => row.role === id);
    }

    private requireGroup(id: string) {
        const row = this.roleRow(id);
        if (!row) {
            throw new GroupError('Group not found.', 404);
        }
        return row;
    }

    private uniqueName(name: string, except?: string) {
        const taken = this.roles().some(
            (row) => row.role !== except && (row.label ?? row.role).toLowerCase() === name.toLowerCase(),
        );
        if (taken) {
            throw new GroupError(`There is already a group called “${name}”.`, 409);
        }
    }

    /** Every group, with its members, oldest first. */
    list(): Group[] {
        const members = this.db
            .prepare(
                `SELECT m.role, u.id AS accountId, coalesce(u.appUserId, '') AS userId, u.name, u.email, coalesce(u.banned, 0) AS banned
                 FROM auth_member m JOIN auth_user u ON u.id=m.userId WHERE m.organizationId=? ORDER BY u.name, u.id`,
            )
            .all(WORKSPACE_ORGANIZATION_ID) as {
            role: string;
            accountId: string;
            userId: string;
            name: string;
            email: string;
            banned: number;
        }[];
        return this.roles().map((row) => ({
            id: row.role,
            name: row.label ?? row.role,
            permissions: permissionsOf(row.permission),
            members: members
                .filter((member) => splitMemberRole(member.role).groups.includes(row.role))
                .map((member): GroupMember => ({
                    accountId: member.accountId,
                    userId: member.userId,
                    name: member.name,
                    email: member.email,
                    deactivated: !!member.banned,
                })),
            createdAt: iso(row.createdAt),
        }));
    }

    get(id: string): Group {
        const group = this.list().find((entry) => entry.id === id);
        if (!group) {
            throw new GroupError('Group not found.', 404);
        }
        return group;
    }

    /** The groups an account is in. */
    groupsOf(accountId: string): PersonGroup[] {
        const { groups } = splitMemberRole(this.memberRole(accountId));
        return this.roles()
            .filter((row) => groups.includes(row.role))
            .map((row) => ({ id: row.role, name: row.label ?? row.role, permissions: permissionsOf(row.permission) }));
    }

    create(name: string, permissions: readonly GroupPermission[]): Group {
        const id = atomically(this.db, () => {
            this.uniqueName(name);
            let role: string;
            do {
                role = `g-${randomBytes(6).toString('hex')}`;
            } while (this.roleRow(role));
            const at = now();
            this.db
                .prepare(
                    'INSERT INTO auth_organization_role (id, organizationId, role, permission, createdAt, updatedAt, label) VALUES (?, ?, ?, ?, ?, ?, ?)',
                )
                .run(
                    newId(),
                    WORKSPACE_ORGANIZATION_ID,
                    role,
                    JSON.stringify(permissionStatements(permissions)),
                    at,
                    at,
                    name,
                );
            return role;
        });
        return this.get(id);
    }

    update(id: string, patch: { name?: string; permissions?: readonly GroupPermission[] }): Group {
        atomically(this.db, () => {
            const row = this.requireGroup(id);
            if (patch.name !== undefined) {
                this.uniqueName(patch.name, row.role);
            }
            this.db
                .prepare('UPDATE auth_organization_role SET label=?, permission=?, updatedAt=? WHERE id=?')
                .run(
                    patch.name ?? row.label ?? row.role,
                    patch.permissions === undefined
                        ? row.permission
                        : JSON.stringify(permissionStatements(patch.permissions)),
                    now(),
                    row.id,
                );
        });
        return this.get(id);
    }

    /** Deletes the group and takes it off everyone's member role, at once. */
    delete(id: string): Group {
        const group = this.get(id);
        atomically(this.db, () => {
            const row = this.requireGroup(id);
            for (const member of group.members) {
                this.setMembership(member.accountId, id, false);
            }
            this.db.prepare('DELETE FROM auth_organization_role WHERE id=?').run(row.id);
        });
        return group;
    }

    /** Adds or removes an account; true when that changed anything. */
    setMembership(accountId: string, id: string, inGroup: boolean): boolean {
        return atomically(this.db, () => {
            this.requireGroup(id);
            const account = this.db.prepare('SELECT role FROM auth_user WHERE id=?').get(accountId) as
                | { role: string | null }
                | undefined;
            if (!account) {
                throw new GroupError('Account not found.', 404);
            }
            if (this.memberRole(accountId) === undefined) {
                this.addMember(accountId, account.role);
            }
            const stored = this.memberRole(accountId)!;
            const { base, groups } = splitMemberRole(stored);
            const next = inGroup ? [...new Set([...groups, id])] : groups.filter((group) => group !== id);
            const role = joinRole(base, next);
            if (role === stored) {
                return false;
            }
            this.writeRole(accountId, role);
            return true;
        });
    }

    /**
     * The `CODE_USERS` migration (CB-376): once per database, a "Code"
     * group that may run code, with the non-admins of `codeUsers` (app user
     * ids) in it, when there are any. Admins have the permission anyway.
     * The organization's metadata records that it ran, so a group deleted
     * later is not made again. Returns lines for the log.
     */
    seedCodeGroup(codeUsers: readonly string[]): string[] {
        return atomically(this.db, () => {
            const org = this.db
                .prepare('SELECT metadata FROM auth_organization WHERE id=?')
                .get(WORKSPACE_ORGANIZATION_ID) as { metadata: string | null } | undefined;
            if (!org) {
                return [];
            }
            let metadata: Record<string, unknown> = {};
            try {
                metadata = (org.metadata && (JSON.parse(org.metadata) as Record<string, unknown>)) || {};
            } catch {
                metadata = {};
            }
            if (metadata.codeUsersSeeded) {
                return [];
            }
            const lines: string[] = [];
            if (codeUsers.length) {
                const accounts = this.db
                    .prepare(
                        `SELECT id, appUserId, role FROM auth_user WHERE appUserId IN (${codeUsers.map(() => '?').join(',')})`,
                    )
                    .all(...codeUsers) as { id: string; appUserId: string; role: string | null }[];
                const members = accounts.filter((account) => !isAdmin({ role: account.role as Role }));
                if (members.length) {
                    const group = this.create(this.freeName(CODE_GROUP_NAME), ['code:run']);
                    for (const account of members) {
                        this.setMembership(account.id, group.id, true);
                    }
                    lines.push(
                        `Groups: made the “${group.name}” group from CODE_USERS, with ${members.length} person(s); admins may run code without it.`,
                    );
                }
                const unknown = codeUsers.length - accounts.length;
                if (unknown) {
                    lines.push(`Groups: ${unknown} CODE_USERS id(s) have no account and were not added to a group.`);
                }
            }
            this.db
                .prepare('UPDATE auth_organization SET metadata=? WHERE id=?')
                .run(JSON.stringify({ ...metadata, codeUsersSeeded: Date.now() }), WORKSPACE_ORGANIZATION_ID);
            return lines;
        });
    }

    /** `name`, or `name 2`, … when a group already has it. */
    private freeName(name: string) {
        const taken = new Set(this.roles().map((row) => (row.label ?? row.role).toLowerCase()));
        let candidate = name;
        for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) {
            candidate = `${name} ${n}`;
        }
        return candidate;
    }
}

/**
 * The organization plugin's options (CB-376): Socio's access control, with
 * `code: ['run']` beside Better Auth's own statements; the static `owner`
 * and `admin` roles carry it, `member` doesn't. Runtime roles (groups)
 * come from `auth_organization_role`, read on every check. Teams stay off;
 * nobody creates organizations through the plugin.
 */
export function workspaceOrganization(
    { createAccessControl }: typeof import('better-auth/plugins/access'),
    { defaultStatements, adminAc, ownerAc, memberAc }: typeof import('better-auth/plugins/organization/access'),
) {
    const ac = createAccessControl({ code: ['run'], ...defaultStatements } as const);
    return {
        ac,
        roles: {
            owner: ac.newRole({ ...ownerAc.statements, code: ['run'] }),
            admin: ac.newRole({ ...adminAc.statements, code: ['run'] }),
            member: ac.newRole({ ...memberAc.statements }),
        },
        dynamicAccessControl: { enabled: true },
        teams: { enabled: false },
        allowUserToCreateOrganization: false,
        schema: {
            organization: { modelName: 'auth_organization' },
            member: { modelName: 'auth_member' },
            invitation: { modelName: 'auth_invitation' },
            organizationRole: {
                modelName: 'auth_organization_role',
                // The group's name; `role` is its stable id (`g-…`).
                additionalFields: { label: { type: 'string', required: false, input: false } },
            },
        },
    } as const;
}
export type WorkspaceOrganizationOptions = ReturnType<typeof workspaceOrganization>;
