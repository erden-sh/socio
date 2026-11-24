// An auth setup for tests that build the app runtime (`startAppRuntime`,
// main.ts): the boot step's provider, stood in by one that knows nobody.
import type { AuthSetup } from '../../src/server/auth/contract.js';

/**
 * A provider that resolves every request to no user. `codeRunners` stands
 * in for the people the `code:run` permission covers (admins and the
 * groups that give it, CB-376): `mayRunCode` reads the array on every
 * call, so a test that changes it revokes or grants at once.
 */
export function testAuth({ codeRunners = [] }: { codeRunners?: string[] } = {}): AuthSetup {
    return {
        provider: {
            kind: 'test',
            resolve: async () => null,
            users: () => [],
            routes: () => undefined,
            signInMethods: () => ({ passkey: false, password: false, oauth: [] }) as never,
            mayRunCode: async (userId) => codeRunners.includes(userId),
        },
        secureCookies: false,
    };
}
