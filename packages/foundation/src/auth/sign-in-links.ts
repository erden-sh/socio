import { formatCode } from '@socio/shared/device-sign-in';

/** One-time sign-in links last 15 minutes and work once. */
export const SIGN_IN_LINK_SECONDS = 15 * 60;

/**
 * A one-time way in that signs its holder in to one account, as a channel
 * (Telegram, email) carries it: a link (the web's "Send me a sign-in
 * link"; `kind` may be left out), or a code the Socio app asked for, typed
 * into the app on the device that asked, with the link domain's link that
 * fills it in there (CB-352).
 */
export type SignInLink =
    | { kind?: 'link'; url: string; expiresAt: Date }
    | { kind: 'code'; code: string; openUrl: string; expiresAt: Date }
    /** "Send me a link for the app": opens the workspace in the app; it signs nobody in. */
    | { kind: 'app'; url: string };

const MINUTES = Math.round(SIGN_IN_LINK_SECONDS / 60);

/** The message it travels in: a one-line note and the link, or the code and how to use it. */
export const signInLinkMessage = (link: SignInLink) =>
    link.kind === 'code'
        ? `Your Socio sign-in code: ${formatCode(link.code)}. Only type this into the Socio app on your own device. It works once, for ${MINUTES} minutes. Open in the Socio app: ${link.openUrl}`
        : link.kind === 'app'
          ? `Open your workspace in the Socio app (install it first if you need to), then sign in there:\n${link.url}`
          : `Your Socio sign-in link (works once, for ${MINUTES} minutes; ignore it if you didn't ask for it):\n${link.url}`;

/** An email's subject for it. */
export const signInLinkSubject = (link: SignInLink) =>
    link.kind === 'code'
        ? 'Your Socio sign-in code'
        : link.kind === 'app'
          ? 'Your workspace in the Socio app'
          : 'Your Socio sign-in link';
