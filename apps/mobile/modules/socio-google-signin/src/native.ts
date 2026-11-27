import { requireNativeModule } from 'expo';

/**
 * What the Swift and Kotlin modules answer. `reason` is a fixed word (an error's code or class),
 * never a message, a token or an account.
 */
export type GoogleSignInResult =
    | { type: 'success'; idToken: string }
    | { type: 'cancel' }
    /** Android: Credential Manager has no Google account to offer. */
    | { type: 'no-account' }
    /** The phone can't: no activity or view controller, no Google Play services' provider. */
    | { type: 'unavailable'; reason: string }
    | { type: 'failed'; reason: string };

/** What the native side exports as `SocioGoogleSignIn` (SocioGoogleSignInModule.swift and .kt). */
export interface SocioGoogleSignInNative {
    /**
     * One sign-in for one ID token whose audience is `serverClientId` and which carries `nonce`.
     * iOS configures GIDSignIn with `clientId` (the build's iOS client id) first and signs out of
     * Google's SDK after, so nothing of the account stays there; Android ignores `clientId`.
     */
    signIn(clientId: string | null, serverClientId: string, nonce: string): Promise<GoogleSignInResult>;
}

let loaded: SocioGoogleSignInNative | undefined;

/** The native module, loaded on first use, so a client built without it fails at the call, not at launch. */
export function native(): SocioGoogleSignInNative {
    loaded ??= requireNativeModule<SocioGoogleSignInNative>('SocioGoogleSignIn');
    return loaded;
}
