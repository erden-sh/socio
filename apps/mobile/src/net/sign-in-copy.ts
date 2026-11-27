import { DEACTIVATED_MESSAGE, type SignInMethods } from '@socio/shared/auth';

import type { SignInProblem } from './sign-in';

// The words a person sees when signing in doesn't work: keyed by the
// problem, which comes from the answer's status and code (sign-in.ts), never
// from the server's text. Socio's people are mostly not technical, so each
// line says what happened and what to do, with no code or jargon in it;
// Advanced mode may add the raw code beside the line, never in its
// place. The web's `signInError` (packages/client/src/shell/auth-client.ts)
// is the model; its lines are reused where they fit.

/** What the screen offers with the line. */
export type SignInAction =
    /** The form stays, to try again (after the wait, for `rate-limited`). */
    | 'retry'
    /** The workspace takes no password here: a button opens its sign-in page in the browser. */
    | 'open-web';

export interface SignInCopy {
    readonly message: string;
    readonly action: SignInAction;
}

/**
 * The SignIn screen's headline, the web's (packages/client's SignIn): "Welcome back." under
 * a large Local, and the workspace's name under it. The ways in under them stay the app's
 * own.
 */
export const WELCOME_HEADLINE = 'Welcome back.';

/** The line under the headline, as the web words it: "Sign in to Workspace A." */
export function welcomeLine(name: string): string {
    return `Sign in to ${name}.`;
}

/**
 * INVALID_EMAIL_OR_PASSWORD. The server gives the same
 * answer for a wrong password, an unknown email, an email that isn't invited
 * (`not_invited` never comes from password sign-in) and an invited account
 * that has no password yet. The line says only what is true of all of them:
 * what a newcomer does is the screen's own line (`NEWCOMER_LINE`), shown
 * beside this one, so naming it here would say it twice.
 */
export const WRONG_CREDENTIALS = "That email and password don't match. Check both and try again.";

/**
 * The SignIn screen's line for someone with no account yet. Accounts come only
 * from an admin's invite (for Google Play's account-deletion rule), so the app
 * never offers to create one, not even by a link to the web, whatever the
 * workspace's `methods.signUp` says.
 */
export const NEWCOMER_LINE = 'Accounts are by invitation. New here? Open the invite link your admin sent you.';

/** What the SignIn screen shows under its form. */
export interface SignInFooter {
    /** "Forgot password?" (an existing account's reset on the web): the password form with `methods.emailReset`. */
    readonly forgot: boolean;
    /** The newcomer's line: always the invite one, never a sign-up offer. */
    readonly newcomer: string;
}

/** The SignIn screen's footer. `methods.signUp` is read by nothing here: sign-up is never offered. */
export function signInFooter(methods: SignInMethods | null | undefined, password: boolean): SignInFooter {
    return { forgot: password && methods?.emailReset === true, newcomer: NEWCOMER_LINE };
}

/** Password sign-in is off, by the access policy or the server's settings: the app can't sign in with a password, so the web it is. */
export const PASSWORD_OFF =
    "Signing in with a password is turned off for this workspace, so the app can't sign you in yet. Use it on the web for now: the button opens it in your browser.";

export const INVALID_EMAIL = "That doesn't look like an email address. Check it and try again.";

export const EMAIL_NOT_VERIFIED =
    'Confirm your email address first: open the link in the email you got when you made your account, then sign in again.';

/** No answer: offline, or a connection that couldn't be made safe (TLS). */
export const UNREACHABLE = "Couldn't reach this workspace. Check your internet connection and try again.";

export const SERVER_ERROR = "This workspace isn't answering right now. Try again in a moment.";

export const NOT_SIGNED_IN = "Signing in didn't finish. Try again.";

/**
 * The address now answers as another workspace than the one on the phone
 * (its manifest names another id), so nothing was sent to it.
 */
export const WORKSPACE_CHANGED =
    "This address now leads to a different workspace than the one on this phone, so Socio didn't sign in. Ask your admin.";

/**
 * The sheet's code wasn't taken: unknown or used (`code_invalid`), or its 5 minutes
 * passed (`code_expired`). Either way the person starts the sheet again.
 */
export const SHEET_CODE_DEAD = "That sign-in didn't go through in time. Choose Continue to try again.";

/** `wrong_variant`: another of Socio's builds on this device started the sign-in (a test build beside the store's). */
export const SHEET_WRONG_APP =
    'That sign-in was meant for another Socio app on this device. Choose Continue in this one to try again.';

/** `not_authorized`: the browser that approved the sign-in signed out before the app finished. */
export const SHEET_APPROVER_GONE =
    'The browser signed out before Socio finished signing you in. Choose Continue to try again.';

/** `denied`: the sign-in was refused on the web before the app finished it. */
export const SHEET_DENIED = 'That sign-in was refused in the browser. Choose Continue to try again.';

/** `method_off`: the way the person signed in on the web is turned off for this workspace now. */
export const SHEET_METHOD_OFF =
    'The way you signed in on the web is turned off for this workspace. Choose Continue and sign in another way, or ask your admin.';

/** A sign-in code's 5 tries are used up (`too_many`): the request is dead. */
export const CODE_TRIES_USED = 'Too many wrong codes. Ask for a new code and try again.';

/**
 * Google or Apple (CB-570) without the provider's name: social-copy.ts words each with it, and the
 * SignIn screen shows those. These stand in where no provider is known.
 */
export const SOCIAL_NOT_LINKED_ANY =
    'No Socio account uses that account. Sign in another way, then link it in Settings → Account.';
export const SOCIAL_INVALID_TOKEN_ANY = "That sign-in couldn't be confirmed. Try again.";
export const SOCIAL_NONCE_INVALID = 'That sign-in took too long or was used already. Try again.';
export const SOCIAL_OFF_ANY = 'That way of signing in is turned off for this workspace. Sign in another way.';
export const SOCIAL_UNAVAILABLE_ANY = "That way of signing in isn't available right now. Sign in another way.";

/** Any answer the table doesn't know: never the server's text. */
export const GENERIC = "Couldn't sign you in. Try again, or ask your admin.";

/** How long to wait, in words: "42 seconds", "2 minutes", or "a minute" when the server didn't say. */
export function waitText(seconds: number | null): string {
    if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
        return 'a minute';
    }
    const whole = Math.max(1, Math.ceil(seconds));
    if (whole < 60) {
        return whole === 1 ? '1 second' : `${whole} seconds`;
    }
    const minutes = Math.ceil(whole / 60);
    return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/** The line and the action for a sign-in problem. */
export function signInCopy(problem: SignInProblem): SignInCopy {
    switch (problem.kind) {
        case 'wrong-credentials':
            return { message: WRONG_CREDENTIALS, action: 'retry' };
        case 'deactivated':
            return { message: DEACTIVATED_MESSAGE, action: 'retry' };
        case 'method-off':
        case 'password-disabled':
            return { message: PASSWORD_OFF, action: 'open-web' };
        case 'rate-limited':
            return {
                message: `Too many tries. Wait ${waitText(problem.retryAfterSeconds)}, then try again.`,
                action: 'retry',
            };
        case 'invalid-email':
            return { message: INVALID_EMAIL, action: 'retry' };
        case 'email-not-verified':
            return { message: EMAIL_NOT_VERIFIED, action: 'retry' };
        case 'unreachable':
            return { message: UNREACHABLE, action: 'retry' };
        case 'server-error':
            return { message: SERVER_ERROR, action: 'retry' };
        case 'not-signed-in':
            return { message: NOT_SIGNED_IN, action: 'retry' };
        case 'workspace-changed':
            return { message: WORKSPACE_CHANGED, action: 'retry' };
        case 'code-invalid':
        case 'code-expired':
            return { message: SHEET_CODE_DEAD, action: 'retry' };
        case 'wrong-variant':
            return { message: SHEET_WRONG_APP, action: 'retry' };
        case 'not-authorized':
            return { message: SHEET_APPROVER_GONE, action: 'retry' };
        case 'sheet-off':
            return { message: SHEET_METHOD_OFF, action: 'retry' };
        case 'sheet-denied':
            return { message: SHEET_DENIED, action: 'retry' };
        case 'not-allowed-yet':
            // Add a device polls past it; a screen never shows it as a refusal.
            return { message: NOT_SIGNED_IN, action: 'retry' };
        case 'too-many-tries':
            return { message: CODE_TRIES_USED, action: 'retry' };
        case 'not-linked':
            return { message: SOCIAL_NOT_LINKED_ANY, action: 'retry' };
        case 'invalid-token':
            return { message: SOCIAL_INVALID_TOKEN_ANY, action: 'retry' };
        case 'nonce-invalid':
            return { message: SOCIAL_NONCE_INVALID, action: 'retry' };
        case 'social-off':
            return { message: SOCIAL_OFF_ANY, action: 'retry' };
        case 'provider-unavailable':
            return { message: SOCIAL_UNAVAILABLE_ANY, action: 'retry' };
        case 'unknown':
            return { message: GENERIC, action: 'retry' };
    }
}

/** The another-person confirmation, before the previous person's copy is wiped. Cancel is the default. */
export interface OtherPersonCopy {
    readonly title: string;
    readonly message: string;
    readonly confirm: string;
    readonly cancel: string;
}

/**
 * The confirmation when someone else's copy of the workspace is on the phone
 * ("N unsent items from the previous person will be deleted"). `unsent`
 * is their outbox and unsent rows together, or
 * null when they couldn't be counted, which is never taken as none.
 */
export function otherPersonCopy(unsent: number | null): OtherPersonCopy {
    const removed = "Signing in removes the previous person's copy of this workspace from this phone.";
    let message: string;
    if (unsent === null) {
        message = `${removed} Anything they haven't sent yet will be deleted.`;
    } else if (unsent === 0) {
        message = `${removed} Nothing of theirs is waiting to be sent.`;
    } else {
        message = `${removed} ${unsent === 1 ? '1 unsent item' : `${unsent} unsent items`} from the previous person will be deleted.`;
    }
    return { title: 'Someone else is signed in here', message, confirm: 'Sign in anyway', cancel: 'Cancel' };
}

/** A copy of this workspace for this person is still being removed (a wipe that hasn't finished). */
export const UNFINISHED =
    'Socio is still removing an earlier copy of this workspace. Close Socio, open it again, then sign in.';
