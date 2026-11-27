import { DEACTIVATED_MESSAGE } from '@socio/shared/auth';
import type { SocialProvider } from '@socio/shared/device-sign-in';

import type { SignInProblem } from './sign-in';
import { signInCopy, UNREACHABLE, SERVER_ERROR, waitText } from './sign-in-copy';
import { PROVIDER_NAMES, type SocialProblem } from './social-sign-in';

// The words for Google and Apple sign-in and linking (CB-570), by the problem's kind and the
// provider, never the server's text. The SignIn screen and Settings → Account show them; test
// builds add the status and code under them.

/** The buttons' words. Apple's own button says its words itself on iOS ("Continue with Apple"). */
export const continueWith = (provider: SocialProvider) => `Continue with ${PROVIDER_NAMES[provider]}`;

/** Between the Google and Apple buttons and the other ways in. */
export const SOCIAL_OR = 'or';

export const notLinkedLine = (provider: SocialProvider) =>
    `No Socio account uses this ${PROVIDER_NAMES[provider]} account. Sign in another way, then link it in Settings → Account.`;

export const unavailableLine = (provider: SocialProvider) =>
    `${PROVIDER_NAMES[provider]} sign-in isn't available right now. Sign in another way.`;

export const invalidTokenLine = (provider: SocialProvider) =>
    `${PROVIDER_NAMES[provider]} couldn't confirm it's you. Try again.`;

export const NONCE_LINE = 'That sign-in took too long or was used already. Try again.';

export const START_AGAIN_LINE = "That sign-in didn't finish. Try again.";

export const methodOffLine = (provider: SocialProvider) =>
    `Signing in with ${PROVIDER_NAMES[provider]} is turned off for this workspace. Sign in another way, or ask your admin.`;

export const tooManyLine = (seconds: number | null = null) =>
    `Too many tries. Wait ${waitText(seconds)}, then try again.`;

/** Android: Credential Manager found no Google account to choose. */
export const NO_GOOGLE_ACCOUNT =
    "There's no Google account on this phone. Add one in the phone's Settings, or sign in another way.";

export const nativeUnavailableLine = (provider: SocialProvider) =>
    `This phone can't sign in with ${PROVIDER_NAMES[provider]}. Sign in another way.`;

export const nativeFailedLine = (provider: SocialProvider) =>
    `${PROVIDER_NAMES[provider]} sign-in didn't open or didn't finish. Try again.`;

/** The SignIn screen's line for a redeem that didn't sign in. */
export function socialSignInLine(provider: SocialProvider, problem: SignInProblem): string {
    switch (problem.kind) {
        case 'not-linked':
            return notLinkedLine(provider);
        case 'invalid-token':
            return invalidTokenLine(provider);
        case 'nonce-invalid':
            return NONCE_LINE;
        case 'not-authorized':
            return START_AGAIN_LINE;
        case 'social-off':
            return methodOffLine(provider);
        case 'provider-unavailable':
            return unavailableLine(provider);
        case 'deactivated':
            return DEACTIVATED_MESSAGE;
        default:
            return signInCopy(problem).message;
    }
}

/** What a start, a link or the links' read said, for the SignIn screen and Settings. */
export function socialProblemLine(
    provider: SocialProvider,
    problem: SocialProblem,
    during: 'signin' | 'link' | 'unlink' | 'links',
): string {
    switch (problem.kind) {
        case 'not-authorized':
            return during === 'signin' ? START_AGAIN_LINE : LINK_SIGNED_OUT;
        case 'method-off':
            return during === 'signin' ? methodOffLine(provider) : linkOffLine(provider);
        case 'deactivated':
            return DEACTIVATED_MESSAGE;
        case 'invalid-token':
            return invalidTokenLine(provider);
        case 'nonce-invalid':
            return NONCE_LINE;
        case 'not-linked':
            return during === 'signin' ? notLinkedLine(provider) : LINKS_CHANGED;
        case 'already-linked-other':
            return alreadyLinkedOtherLine(provider);
        case 'last-method':
            return LAST_METHOD;
        case 'rate-limited':
            return tooManyLine();
        case 'provider-unavailable':
            return during === 'signin' ? unavailableLine(provider) : linkUnavailableLine(provider);
        case 'unreachable':
            return UNREACHABLE;
        case 'server-error':
            return SERVER_ERROR;
        case 'unknown':
            return during === 'signin' ? START_AGAIN_LINE : LINK_GENERIC;
    }
}

/** Settings → Account's section: its title and the line under it. */
export const SIGN_IN_METHODS_TITLE = 'Sign-in methods';
export const SIGN_IN_METHODS_NOTE =
    'Link your Google or Apple account to sign in to this workspace with it on your phone. Nothing is linked by your email alone.';
export const LINK = 'Link';
export const UNLINK = 'Unlink';
export const NOT_LINKED = 'Not linked';
/** A link the server listed without an email (Apple may give none). */
export const LINKED = 'Linked';

export const LINK_SIGNED_OUT = "Socio couldn't confirm you're still signed in here. Try again.";
export const linkOffLine = (provider: SocialProvider) =>
    `Linking ${PROVIDER_NAMES[provider]} is turned off for this workspace.`;
export const alreadyLinkedOtherLine = (provider: SocialProvider) =>
    `This ${PROVIDER_NAMES[provider]} account is already linked to someone else in this workspace. Choose another ${PROVIDER_NAMES[provider]} account.`;
export const LAST_METHOD = "It's your only way to sign in. Add another way before you unlink it.";
export const linkUnavailableLine = (provider: SocialProvider) =>
    `${PROVIDER_NAMES[provider]} isn't available right now. Try again later.`;
export const LINKS_CHANGED = 'That changed meanwhile. Check the list and try again.';
export const LINK_GENERIC = "Couldn't change this. Try again.";
export const LINKS_UNREAD = "Couldn't load your sign-in methods. Check your connection.";

export const linkedLine = (provider: SocialProvider) => `${PROVIDER_NAMES[provider]} is linked.`;

/** Asked before an unlink; Cancel is the default. */
export function unlinkQuestion(provider: SocialProvider) {
    const name = PROVIDER_NAMES[provider];
    return {
        title: `Unlink ${name}?`,
        message: `You won't be able to sign in to this workspace with this ${name} account anymore. Phones that signed in with it are signed out, this one too if it did.`,
        confirm: UNLINK,
        cancel: 'Cancel',
    };
}
