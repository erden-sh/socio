import { signInLinkMessage, signInLinkSubject } from '@socio/foundation/auth/sign-in-links';

import type { SignInLinkSender } from './contract.js';
import type { Mailer } from './mailer.js';

/**
 * Sign-in links and codes by email (CB-352): over the account mailer,
 * to the account's own address. The message holds the link or the code and
 * nothing else about the person. Whether email links are on is the access
 * policy's `emailLinks`, which the provider checks before choosing this.
 */
export function emailSignInLinks(
    mailer: Mailer,
    /** The account behind an app user: its address, and whether it can sign in. */
    accountOf: (userId: string) => { email: string; deactivated: boolean } | undefined,
): SignInLinkSender {
    const address = (userId: string) => {
        const account = accountOf(userId);
        return account && !account.deactivated && account.email ? account.email.toLowerCase() : null;
    };
    return {
        via: 'email',
        canDeliver: (userId) => !!address(userId),
        recipient: (userId) => address(userId),
        async deliver(userId, link) {
            const to = address(userId);
            if (!to) {
                throw new Error('This account has no address to send to.');
            }
            await mailer.send({ to, subject: signInLinkSubject(link), text: signInLinkMessage(link) });
        },
    };
}
