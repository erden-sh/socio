// What the site says about Ingenio and Socio, in one place, as the owner confirmed it on
// 2026-11-16. The pages, the extras (security.txt, llms.txt) and the tests read these; tests/facts.test.ts holds the ones the code decides
// (cookie, relay, phone) to the code.

export const ORIGIN = 'https://socio.sh';
export const PUBLISHER = 'Ingenio Ventures Inc.';
export const SUPPORT_EMAIL = 'support@ingenioventures.com';
export const PRIVACY_EMAIL = 'privacy@ingenioventures.com';
export const SECURITY_EMAIL = 'security@ingenioventures.com';
export const GOVERNING_LAW = 'the State of Florida, USA';
/** The legal pages' "Last updated" date. */
export const LEGAL_UPDATED = 'November 16, 2026';
/** Erasure after removal completes within this many days (delete-account, privacy). */
export const ERASURE_DAYS = 30;
/** Form entries are deleted this many months after the last contact. */
export const FORM_RETENTION_MONTHS = 12;
/** The facts the code decides; tests/facts.test.ts reads each from its source. */
export const SESSION_COOKIE = '__Host-cb.session_token';
export const SESSION_DAYS = 7;
export const RELAY_EXPIRE_DAYS = 60;
export const PHONE_LOCK_DAYS = 30;
export const PHONE_ERASE_DAYS = 30;

/**
 * The menu paths the pages give, label by label, as the clients show them today. Only real
 * paths: tests/facts.test.ts finds each label in the app's or the web client's source.
 */
export const MENU_PATHS = {
    /** The app: the More tab, its Account row, the Sign out button. */
    appSignOut: ['More', 'Account', 'Sign out'],
    /** The app: notification settings, under More's Settings row. */
    appNotifications: ['More', 'Settings & setup', 'Notifications'],
    /** The web: the user menu's Add a device. */
    webAddDevice: ['Add a device'],
    /** The web: the user menu's last item. */
    webSignOut: ['Sign out'],
    /** The web, for an admin: the People settings. */
    webPeople: ['Settings', 'People'],
    /** The web, for an admin: the button at the foot of a person's page. */
    webDeactivate: ['Deactivate…'],
    /** The web: the Account group's Profile settings, and its Leave workspace button (CB-383). */
    webLeave: ['Settings', 'Account', 'Profile', 'Leave workspace'],
    /** The app: the account sheet's Leave workspace row, under Sign out (CB-383). */
    appLeave: ['More', 'Account', 'Leave workspace'],
} as const satisfies Record<string, readonly string[]>;

/** Things that wait for launch, off until then. */
export const LAUNCH = {
    /** The App Store and Google Play badges: hidden until the apps are listed. */
    storeBadges: false,
    /** The public repository (erden-sh org): none yet, so /self-host says "coming soon". */
    repoUrl: null as string | null,
};

export const ERDEN_URL = 'https://erden.sh';

/** Every page: its path, its file in dist/, and its title and description for search and link previews. */
export const PAGES = {
    home: {
        path: '/',
        file: 'index.html',
        title: 'Socio: your team’s workspace, with AI socios',
        desc: 'Chat, rooms, pages, a board and approvals in one place, with AI socios that do the busywork. On the web and on your phone.',
    },
    'self-host': {
        path: '/self-host',
        file: 'self-host.html',
        title: 'Run Socio yourself · Socio',
        desc: 'Socio’s code is coming soon under the Sustainable Use License: free to run for your own team, on your own servers.',
    },
    hosted: {
        path: '/hosted',
        file: 'hosted.html',
        title: 'Hosted Socio, early access · Socio',
        desc: 'We run Socio for small businesses: updates, backups and support included. Join the early-access waitlist.',
    },
    support: {
        path: '/support',
        file: 'support.html',
        title: 'Support · Socio',
        desc: 'Answers about signing in, invites, notifications and your account, and how to reach a person.',
    },
    privacy: {
        path: '/privacy',
        file: 'privacy.html',
        title: 'Privacy Policy · Socio',
        desc: 'What Socio collects, why, who sees it and how long we keep it.',
    },
    terms: {
        path: '/terms',
        file: 'terms.html',
        title: 'Terms of Service · Socio',
        desc: 'The terms for Ingenio Ventures’ hosted Socio service and the Socio apps.',
    },
    cookies: {
        path: '/cookies',
        file: 'cookies.html',
        title: 'Cookie Policy · Socio',
        desc: 'The cookies and storage socio.sh and the Socio apps use, and how to change your choice.',
    },
    'delete-account': {
        path: '/delete-account',
        file: 'delete-account.html',
        title: 'Delete your account · Socio',
        desc: 'How to leave a workspace, how your admin removes an account, and what happens to your data.',
    },
} as const;

export type PageKey = keyof typeof PAGES;
export const PAGE_KEYS = Object.keys(PAGES) as PageKey[];
