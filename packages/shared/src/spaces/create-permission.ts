/**
 * Who may create Spaces: the workspace's "create Spaces" permission. An
 * admin's choice in Settings → General → Permissions (`spaceCreators`):
 * everyone (the default, CB-181: a member's Space is private), or admins
 * only. Workspace admins and operators always may. The server checks it on
 * every create (`POST /api/spaces`, a socio's `create_space`) and tells the
 * client in `GET /api/workspace` (`permissions.createSpaces`), so the
 * Create Space control follows the server, never a role check of its own.
 */
import { isAdmin } from '../roles.js';
import type { Settings, User } from '../types.js';

/** Who may create Spaces besides admins: `everyone` lets members too. */
export const SPACE_CREATORS = ['everyone', 'admins'] as const;
export type SpaceCreators = (typeof SPACE_CREATORS)[number];

/** Unset: everyone, as since CB-181. */
export const SPACE_CREATORS_DEFAULT: SpaceCreators = 'everyone';

/** The 403 for someone the permission leaves out. */
export const SPACE_CREATE_REFUSED = 'Only workspace admins can create Spaces in this workspace.';

/** The setting in force: an admin's, else the default. */
export const spaceCreatorsInForce = (settings: Pick<Settings, 'spaceCreators'>): SpaceCreators =>
    settings.spaceCreators ?? SPACE_CREATORS_DEFAULT;

/** Whether `user` may create Spaces under these settings. */
export const canCreateSpaces = (user: Pick<User, 'role'> | undefined, settings: Pick<Settings, 'spaceCreators'>) =>
    !!user && (isAdmin(user) || spaceCreatorsInForce(settings) === 'everyone');
