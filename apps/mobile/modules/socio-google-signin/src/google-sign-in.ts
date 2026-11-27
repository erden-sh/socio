import { type GoogleSignInResult, native } from './native';

const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/**
 * Google's sign-in for an ID token made for `serverClientId` with `nonce`. Never rejects: a native
 * error is `failed`, and an answer that isn't a token is too. Nothing here logs.
 */
export async function googleSignIn(options: {
    readonly clientId: string | null;
    readonly serverClientId: string;
    readonly nonce: string;
}): Promise<GoogleSignInResult> {
    let result: GoogleSignInResult;
    try {
        result = await native().signIn(options.clientId, options.serverClientId, options.nonce);
    } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        return { type: 'failed', reason: typeof code === 'string' && /^[\w.-]{1,64}$/.test(code) ? code : 'native' };
    }
    if (result.type === 'success' && !TOKEN.test(result.idToken)) {
        return { type: 'failed', reason: 'not-a-token' };
    }
    return result;
}
