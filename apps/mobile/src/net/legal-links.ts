// Socio's public legal pages on socio.sh, the one place the app keeps their
// addresses (Google Play asks for a privacy-policy link inside the app):
// Settings' Legal rows, and the Privacy link on the first screen and the
// sign-in screen, before any workspace is open. They open in the in-app
// browser (src/platform/legal-links.ts), never through a workspace, so they
// work signed out. No React Native here: tests/net runs it under Node.

/** The site that publishes them. Nothing else opens through `openLegalLink`. */
export const LEGAL_ORIGIN = 'https://socio.sh';

export const LEGAL_LINKS = {
    privacy: `${LEGAL_ORIGIN}/privacy`,
    terms: `${LEGAL_ORIGIN}/terms`,
    cookies: `${LEGAL_ORIGIN}/cookies`,
    deleteAccount: `${LEGAL_ORIGIN}/delete-account`,
    support: `${LEGAL_ORIGIN}/support`,
} as const;

export type LegalLink = (typeof LEGAL_LINKS)[keyof typeof LEGAL_LINKS];

export interface LegalRow {
    readonly id: 'privacy' | 'terms' | 'delete-account' | 'support';
    readonly title: string;
    readonly href: LegalLink;
    readonly testID: string;
}

/** Settings' Legal section, in this order. */
export const LEGAL_SECTION = {
    title: 'Legal',
    /** Under the section: who publishes the app. */
    publisher: 'Socio by Ingenio Ventures Inc.',
    hint: 'Opens in your browser',
    testID: 'settings-legal',
} as const;

export const LEGAL_ROWS: readonly LegalRow[] = [
    { id: 'privacy', title: 'Privacy Policy', href: LEGAL_LINKS.privacy, testID: 'settings-legal-privacy' },
    { id: 'terms', title: 'Terms of Service', href: LEGAL_LINKS.terms, testID: 'settings-legal-terms' },
    {
        id: 'delete-account',
        title: 'Delete your account',
        href: LEGAL_LINKS.deleteAccount,
        testID: 'settings-legal-delete-account',
    },
    { id: 'support', title: 'Help & support', href: LEGAL_LINKS.support, testID: 'settings-legal-support' },
];

/** The small link at the foot of the first screen and the sign-in screen, before signing in. */
export const PRIVACY_FOOTER = {
    label: 'Privacy Policy',
    href: LEGAL_LINKS.privacy,
    hint: 'Opens in your browser',
} as const;

/** Whether `href` is one of socio.sh's pages over https: the only links `openLegalLink` opens. */
export function isLegalLink(href: string): boolean {
    try {
        const url = new URL(href);
        return url.origin === LEGAL_ORIGIN && url.username === '' && url.password === '';
    } catch {
        return false;
    }
}

/** Opens one of socio.sh's pages with `open` (the in-app browser); anything else is ignored. */
export function openLegalLink(href: string, open: (url: string) => Promise<unknown>): void {
    if (!isLegalLink(href)) {
        console.warn('[legal] not a socio.sh page');
        return;
    }
    open(href).catch((error: unknown) => console.warn('[legal] browser not opened', error));
}
