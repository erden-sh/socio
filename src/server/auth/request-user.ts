import type { DatabaseSync } from 'node:sqlite';

import { transaction } from '@socio/data/open';

import type { PeopleShape } from '../workspace/contract.js';

import type { AuthSetup, RequestUserResolver } from './contract.js';

/**
 * Where a request's user is recorded: the `People` slice, on the
 * connection whose unit of work it waits behind.
 */
export interface RequestUserRecorder {
    readonly workspace: Pick<PeopleShape, 'recordUser'> & { readonly db: DatabaseSync };
}

/**
 * Resolves a request to its user, then records the user in the workspace
 * (once per name and role, per resolver), so other views can name them.
 * The API's auth check and the page services (web/services.ts) both use
 * one; `setHeader` gets what the provider sets on the response (a
 * sliding session's renewed cookie).
 */
export function requestUserResolver(auth: AuthSetup, platform?: RequestUserRecorder): RequestUserResolver {
    const recorded = new Set<string>();
    return async (request, setHeader) => {
        const user = await auth.provider.resolve(request, setHeader);
        if (!user) {
            return null;
        }
        const key = `${user.id}:${user.role}:${user.name}`;
        if (platform && !recorded.has(key)) {
            // Behind any open unit of work on the connection (CB-110).
            await transaction(platform.workspace.db, 'record user', () => platform.workspace.recordUser(user));
            recorded.add(key);
        }
        return user;
    };
}
