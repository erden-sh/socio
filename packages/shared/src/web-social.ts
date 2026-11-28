import { z } from 'zod';

import { socialProviderSchema, type SocialProvider } from './device-sign-in.js';

/**
 * Google and Apple sign-in on the website, through Socio's sign-in page
 * (auth.socio.sh). The page's own browser code POSTs `start`, goes to the
 * `url` it answers, and comes back to `callback`, which redirects to the
 * page that asked with a closed code (below). The workspace never holds a
 * Google or Apple client id; the cloud redeems the result for the same
 * signed statement the app's sign-in gets.
 */

export const WEB_SOCIAL_START_PATH = '/api/auth/web/social/start';
export const WEB_SOCIAL_CALLBACK_PATH = '/api/auth/web/social/callback';

/** A start's purpose: a sign-in binds no session; a link binds the signed-in session that asked. */
export const WEB_SOCIAL_PURPOSES = ['signin', 'link'] as const;
export type WebSocialPurpose = (typeof WEB_SOCIAL_PURPOSES)[number];

/** `POST /api/auth/web/social/start`. `next` is where to go after: a same-origin path, else `/`. */
export const webSocialStartBodySchema = z
    .object({
        provider: socialProviderSchema,
        purpose: z.enum(WEB_SOCIAL_PURPOSES),
        next: z.string().max(2048).optional(),
    })
    .strict();
export type WebSocialStartBody = z.input<typeof webSocialStartBodySchema>;

/** The start's answer: the sign-in page to navigate to. */
export interface WebSocialStartAnswer {
    url: string;
}

/**
 * Why a website sign-in came back without signing in: the sign-in page
 * gets `?error=social_<code>` and shows it in words. A closed list: any
 * other code is shown as a generic failure.
 */
export const WEB_SOCIAL_SIGN_IN_ERRORS = [
    'canceled',
    'expired',
    'provider_unavailable',
    'nonce_invalid',
    'not_linked',
    'method_off',
    'deactivated',
    'too_many',
    'failed',
] as const;
export type WebSocialSignInError = (typeof WEB_SOCIAL_SIGN_IN_ERRORS)[number];
export const WEB_SOCIAL_ERROR_PREFIX = 'social_';

/**
 * How a website link came back: Settings gets `?social_link=<code>`,
 * `linked` or why not. A closed list, as for sign-in.
 */
export const WEB_SOCIAL_LINK_RESULTS = [
    'linked',
    'canceled',
    'expired',
    'provider_unavailable',
    'nonce_invalid',
    'not_authorized',
    'already_linked_other',
    'method_off',
    'deactivated',
    'too_many',
    'failed',
] as const;
export type WebSocialLinkResult = (typeof WEB_SOCIAL_LINK_RESULTS)[number];
export const WEB_SOCIAL_LINK_PARAM = 'social_link';
/** Where a link from Settings comes back by default: Account, its Google and Apple card. */
export const WEB_SOCIAL_LINK_HOME = '/settings/account#sign-in-methods';

/** The code as one of the list, or undefined (shown as a generic failure). */
export const webSocialSignInError = (code: string | null | undefined): WebSocialSignInError | undefined =>
    code?.startsWith(WEB_SOCIAL_ERROR_PREFIX)
        ? (WEB_SOCIAL_SIGN_IN_ERRORS as readonly string[]).includes(code.slice(WEB_SOCIAL_ERROR_PREFIX.length))
            ? (code.slice(WEB_SOCIAL_ERROR_PREFIX.length) as WebSocialSignInError)
            : 'failed'
        : undefined;
export const webSocialLinkResult = (code: string | null | undefined): WebSocialLinkResult | undefined =>
    code == null
        ? undefined
        : (WEB_SOCIAL_LINK_RESULTS as readonly string[]).includes(code)
          ? (code as WebSocialLinkResult)
          : 'failed';

/** The provider's name as people know it: brand names, not copy. */
export const SOCIAL_PROVIDER_NAMES: Readonly<Record<SocialProvider, string>> = { google: 'Google', apple: 'Apple' };
