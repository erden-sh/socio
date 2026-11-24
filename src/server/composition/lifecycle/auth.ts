/**
 * Sign-in's boot steps: the provider's start, and the accounts it knows
 * recorded in the workspace. `index.ts` runs them where the process entry did.
 */
import { isAdmin } from '@socio/shared/roles';

import { accessPolicyLine, readStoredPolicy } from '../../auth/access-policy-store.js';
import { activeUser } from '../../auth/accounts.js';
import type { AuthSetup } from '../../auth/contract.js';
import { assignUnowned, type CoreStore } from '../core-store.js';
import type { AppWorkspace } from '../workspace-parts.js';

/** Better Auth: the first admin (AUTH_FIRST_ADMIN_EMAIL) and the workspace owner, before users sync. */
export async function startAuthProvider(auth: AuthSetup) {
    for (const line of (await auth.provider.start?.()) ?? []) {
        console.log(line);
    }
}

/**
 * The `CODE_USERS` migration (CB-376): once per database, a "Code" group
 * from the list in force, with its non-admins (Better Auth only).
 */
export async function seedCodeGroup(auth: AuthSetup, codeUsers: readonly string[]) {
    for (const line of (await auth.provider.seedCodeGroup?.(codeUsers)) ?? []) {
        console.log(line);
    }
}

/**
 * The accounts the provider knows, recorded in the workspace, and what was
 * there before accounts given to the first admin.
 */
export async function syncAccounts(
    auth: AuthSetup,
    store: CoreStore,
    workspace: AppWorkspace,
    env: Record<string, string | undefined>,
) {
    // What the app narrows of the environment's sign-in, and
    // since when (CB-124): a restore that brings back an older policy shows.
    console.log(accessPolicyLine(readStoredPolicy(workspace.db)));
    for (const user of auth.provider.users()) {
        workspace.recordUser(user);
    }
    // Conversations from before user accounts belong to the first admin (with
    // Better Auth, the first admin account, if there is one yet).
    const firstAdmin = auth.provider.users().find(isAdmin);
    if (firstAdmin) {
        const migrated = workspace.migrateLegacyOwner(env.OWNER_ID ?? 'company-brain-owner', firstAdmin.id);
        if (migrated) {
            console.log(`Moved ${migrated} conversations to ${firstAdmin.id}.`);
        }
        const unowned = await assignUnowned(store, firstAdmin.id);
        if (unowned) {
            console.log(`Moved ${unowned} tasks and memories to ${firstAdmin.id}.`);
        }
    } else {
        console.warn(
            'Auth: no admin account yet. Create one with `pnpm run auth create-user --role admin …` (see docs/SETUP.md).',
        );
    }
}

/** A deactivated person is not a user here (accounts.ts); createApp ends what acts for them when they are deactivated. */
export function activeUsers(auth: AuthSetup) {
    return activeUser(auth.provider);
}

/** Sign-in's steps, as lifecycle/index.ts runs them: the provider's start, the accounts' sync and who is an active user. */
export const authLifecycle = { startProvider: startAuthProvider, seedCodeGroup, syncAccounts, activeUsers };
