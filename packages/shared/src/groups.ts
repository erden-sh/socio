import { z } from 'zod';

/**
 * Groups (CB-376): permissions admins give people beyond their role, under
 * Settings → People → Groups. A group is a role of Better Auth's
 * organization plugin (dynamic access control) in the one hidden workspace
 * organization; a person's groups are listed in their member row's role.
 * Admins and operators have every permission without a group.
 */

/** What a group can give. "Run code" (coding sessions) is the only one for now. */
export const GROUP_PERMISSIONS = ['code:run'] as const;
export type GroupPermission = (typeof GROUP_PERMISSIONS)[number];

/** How the People settings name each permission. */
export const GROUP_PERMISSION_LABELS: Record<GroupPermission, { label: string; detail: string }> = {
    'code:run': {
        label: 'Run code',
        detail: 'Start coding sessions, and use the coding gateways for models and Git.',
    },
};

/** The group seeded from `CODE_USERS` (and its Settings → Access list) on the first boot with groups. */
export const CODE_GROUP_NAME = 'Code';

/** One person in a group, as admins see them. */
export interface GroupMember {
    /** The sign-in account (`/api/accounts/:id`). */
    accountId: string;
    /** The app user id their content belongs to. */
    userId: string;
    name: string;
    email: string;
    deactivated: boolean;
}

/** `GET /api/groups`: one group. */
export interface Group {
    /** Stable: its role in the workspace organization. */
    id: string;
    name: string;
    permissions: GroupPermission[];
    members: GroupMember[];
    /** ISO text. */
    createdAt: string;
}

/** A group a person is in, on their page. */
export interface PersonGroup {
    id: string;
    name: string;
    permissions: GroupPermission[];
}

export const groupNameSchema = z.string().trim().min(1).max(60);

/** `POST /api/groups`. */
export const groupCreateSchema = z
    .object({
        name: groupNameSchema,
        permissions: z.array(z.enum(GROUP_PERMISSIONS)).max(GROUP_PERMISSIONS.length).default([]),
    })
    .strict();

/** `PATCH /api/groups/:id`: a new name, new permissions, or both. */
export const groupUpdateSchema = z
    .object({
        name: groupNameSchema.optional(),
        permissions: z.array(z.enum(GROUP_PERMISSIONS)).max(GROUP_PERMISSIONS.length).optional(),
    })
    .strict()
    .refine((value) => value.name !== undefined || value.permissions !== undefined);

/** A permission as Better Auth's access control states it (`code:run` → `{ code: ['run'] }`). */
export function permissionStatements(permissions: readonly GroupPermission[]): Record<string, string[]> {
    const statements: Record<string, string[]> = {};
    for (const permission of permissions) {
        const [resource, action] = permission.split(':') as [string, string];
        statements[resource] = [...new Set([...(statements[resource] ?? []), action])];
    }
    return statements;
}

/** The permissions a stored statement gives, among those groups know. */
export function statementPermissions(statements: Record<string, readonly string[]>): GroupPermission[] {
    return GROUP_PERMISSIONS.filter((permission) => {
        const [resource, action] = permission.split(':') as [string, string];
        return statements[resource]?.includes(action) ?? false;
    });
}
