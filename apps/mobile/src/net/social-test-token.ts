import type { SocialProvider } from '@socio/shared/device-sign-in';

import { base64url } from './sheet-sign-in';

// A stand-in for the phone's Google or Apple sign-in, in development builds only (CB-570): real
// accounts can't sign in on emulators, simulators or in tests, so a development build's SignIn and
// Settings take a made-up test account, and this makes an unsigned token for it that only a fake
// verifier accepts (e2e/fake-cloud.mjs; Socio's cloud services refuse it, as Google and Apple
// would). Preview and production builds never make one: `testIdToken` throws there, and the screens
// show no field for it (`TEST_ACCOUNTS`, tests/social-sign-in.test.ts).

/** Whether a build of `variant` may stand a test account in for Google or Apple. */
export const testAccountsIn = (variant: string) => variant === 'development';

/** A test account's name as typed: letters, digits, dots and dashes. */
export const TEST_ACCOUNT = /^[a-z0-9][a-z0-9.-]{0,39}$/;

const encoder = new TextEncoder();
const segment = (value: unknown) => base64url(encoder.encode(JSON.stringify(value)));

/**
 * An unsigned, made-up ID token for `account`, carrying the nonce the phone's sign-in was given (for
 * Apple already its SHA-256), as a real one would. Throws outside development.
 */
export function testIdToken(options: {
    readonly variant: string;
    readonly provider: SocialProvider;
    readonly account: string;
    readonly nonce: string;
}): string {
    if (!testAccountsIn(options.variant)) {
        throw new Error('Test accounts are for development builds only.');
    }
    const account = options.account.trim().toLowerCase();
    if (!TEST_ACCOUNT.test(account)) {
        throw new Error('Not a test account name.');
    }
    return [
        segment({ alg: 'none', typ: 'JWT' }),
        segment({
            iss: 'socio-e2e',
            aud: options.provider,
            sub: account,
            nonce: options.nonce,
            email: `${account}@example.test`,
        }),
        'e2e',
    ].join('.');
}
