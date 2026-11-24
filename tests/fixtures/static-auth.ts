import type { User } from '@socio/shared/types';

import type { AuthSetup } from '../../src/server/auth/contract.js';

/** Test-only provider: every request is signed in as `user`. */
export function staticAuth(user: User = { id: 'owner', name: 'Owner', role: 'admin' }): AuthSetup {
    return {
        secureCookies: false,
        provider: {
            kind: 'static',
            users: () => [user],
            resolve: async () => user,
            routes: () => {},
        },
    };
}
