import { expect, it } from 'vitest';

import * as contract from '../src/server/auth/contract.js';

// The guards, `RateLimits`, `localRequest` and the sign-in link's message
// moved to packages, and their old paths are gone.
it('keeps the sign-in link constants in the contract', () => {
    expect([contract.SIGN_IN_LINK_SECONDS, contract.SIGN_IN_LINK_PATH, contract.SIGN_IN_LINK_SENT]).toEqual([
        900,
        '/sign-in-link',
        'If that account can receive links, one is on its way.',
    ]);
});

it('names its tags socio/auth/<Name>', () => {
    expect([contract.Auth.key, contract.RequestUsers.key, contract.AccessPolicyReader.key]).toEqual([
        'socio/auth/Auth',
        'socio/auth/RequestUsers',
        'socio/auth/AccessPolicyReader',
    ]);
});
