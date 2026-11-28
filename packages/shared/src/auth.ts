import type { SocialProvider } from './device-sign-in.js';
import type { KeyMadeBy } from './service-accounts.js';
import type { Role, User } from './types.js';

/** A sign-in provider button: a generic OAuth/OIDC provider from the env. */
export interface SignInProvider {
    id: string;
    name: string;
}

/** What the sign-in screen offers (`GET /api/auth/session`, Better Auth). */
export interface SignInMethods {
    passkey: boolean;
    password: boolean;
    /** Anyone may create an account with email and password. */
    signUp: boolean;
    /** "Forgot password?" sends an email (SMTP is configured). */
    emailReset: boolean;
    /** "Send me a sign-in link": a channel (Telegram) can deliver links. */
    signInLink: boolean;
    providers: SignInProvider[];
    /**
     * Google and Apple on the website, through Socio's sign-in page: on in
     * the access policy, offered for the web by the cloud, while the cloud
     * connection is connected. Absent from older servers.
     */
    social?: SocialProvider[];
}

/** How a one-time sign-in link reaches a person. */
export type SignInLinkVia = 'telegram' | 'email';

/** `GET /api/auth/session`. */
export interface AuthSession {
    provider: string;
    branding?: import('./branding.js').Branding;
    user: User | null;
    methods?: SignInMethods;
}

/**
 * What a deactivated person hears when they try to sign in, by any way
 * (Better Auth's `BANNED_USER`).
 */
export const DEACTIVATED_MESSAGE = 'This account is deactivated. Ask an admin to reactivate it.';

/** A sign-in account as admins manage it (`/api/accounts`). */
export interface Account {
    /** The Better Auth user id. */
    id: string;
    /** The app user id: conversations, tasks and memories belong to it. */
    userId: string;
    name: string;
    email: string;
    emailVerified: boolean;
    role: Role;
    /** Admin by `AUTH_ADMIN_EMAILS`: can't be demoted below admin here. */
    adminByRule: boolean;
    password: boolean;
    passkeys: number;
    /** Generic OAuth providers linked to it (ids). */
    providers: string[];
    /** A sign-in link can reach this person now (their linked Telegram). */
    signInLinkVia: SignInLinkVia | null;
    /** Can't sign in until an admin reactivates them; their content stays. */
    deactivated: boolean;
    /**
     * The workspace owner (CB-390): an admin other admins can't demote,
     * deactivate or remove, who hands ownership over with "Make owner".
     * Absent from older servers.
     */
    owner?: boolean;
    createdAt: string;
}

/** Where a person is in their life in the workspace (CB-360). */
export type PersonStatus = 'invited' | 'active' | 'deactivated';

/**
 * What a person can reach now, as counts (CB-360's roster): Spaces they
 * can read, socios' live delegated access for them (CB-232), connected
 * agents (CB-90), apps they own, live service keys they made, code access
 * (the access policy in force, CB-124) and a linked Telegram.
 */
export interface PersonReach {
    spaces: number;
    socioGrants: number;
    connectedAgents: number;
    appsOwned: number;
    keysMade: number;
    codeAccess: boolean;
    telegram: boolean;
}

/** One person in an admin's roster (`GET /api/accounts/roster`, CB-360). */
export interface RosterPerson extends Account {
    /** Invited: never signed in yet (no session and no signed-in request seen). */
    status: PersonStatus;
    /**
     * When they last used the workspace, as far as it knows (ISO): their
     * last signed-in request (written at most every 5 minutes) or newest
     * session renewal, whichever is later. Null when never.
     */
    lastActiveAt: string | null;
    /** Sessions not yet expired (signed-in browsers and devices). */
    sessions: number;
    /** The newest password link made for them (an invite or a reset), if any. */
    invite: { expiresAt: string; expired: boolean } | null;
    /** Null without an app user, or with no source wired (the auth CLI). */
    reach: PersonReach | null;
}

/** `GET /api/accounts/roster`. */
export interface Roster {
    people: RosterPerson[];
}

/**
 * What deactivating a person would end, revoke or hand over, changing
 * nothing (`GET /api/accounts/:id/deactivation-impact`, CB-360). It
 * mirrors what a deactivation does (server `auth/accounts.ts`).
 */
export interface DeactivationImpact {
    accountId: string;
    name: string;
    /** Why it would be refused (the last admin, or the workspace owner), if it would. */
    refusal: string | null;
    /** Already deactivated: nothing more would change. */
    deactivated: boolean;
    sessions: number;
    /** Live service keys they made, revoked with them: whatever uses one stops working. */
    keys: KeyMadeBy[];
    connectedAgents: number;
    socioGrants: number;
    appSessions: number;
    pluginAccess: number;
    /** Scheduled tasks paused, and kept. */
    scheduledTasks: number;
    /** Job runs stopped now. */
    jobRuns: number;
    /** Personal model subscription connections removed. */
    subscriptionConnections: number;
    /** External MCP connections disconnected. */
    mcpConnections: number;
    /** Rooms whose last active admin they are: handed to another member, or archived. */
    rooms: { handedOver: number; archived: number };
    /** Kept, still theirs: apps they own (CB-360 transfer of ownership). */
    appsOwned: number;
    /**
     * Kept, still theirs: everything they own, by kind (`ASSET_KINDS`), each
     * of which an admin can transfer to another person. Empty without an
     * app user.
     */
    owned: Partial<Record<AssetKind, number>>;
}

/** A one-time link that sets (or resets) an account's password. */
export interface PasswordLink {
    url: string;
    expiresAt: string;
    /** Also emailed to the account (SMTP is configured). */
    emailed: boolean;
}

/** A one-time sign-in link an admin sent (`/api/accounts/:id/sign-in-link`). */
export interface SentSignInLink {
    via: SignInLinkVia;
    expiresAt: string;
}

// ── Ownership transfer and permanent removal (CB-360) ─────────────────────

/**
 * What one person's assets can be moved to another as (CB-360): the
 * company owns everything its people make, so an admin can hand all of it,
 * or chosen kinds, to another active person.
 *
 * - `apps`: mini apps they own. Moving them moves `data` too: an app's
 *   bundles are files in its owner's data space and it reads its owner's
 *   datasets.
 * - `schedules`: scheduled tasks, saved jobs and goals, with the
 *   conversations those schedules run in.
 * - `socios`: their personal socios.
 * - `spaces`: their Space memberships, as member or editor.
 * - `data`: their data space: datasets (private scratch areas too), files
 *   and media, folders, embeds, and the grants they gave socios on them.
 * - `conversations`: their own conversations (not rooms).
 * - `memories`: what socios remember about their work; the new owner gets
 *   them as proposals to keep or discard.
 */
export const ASSET_KINDS = ['apps', 'schedules', 'socios', 'spaces', 'data', 'conversations', 'memories'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** How many items a kind lists at most (`count` has them all). */
export const OWNED_ITEMS_SHOWN = 200;

/** One thing a person owns. */
export interface OwnedItem {
    id: string;
    name: string;
    /** What it is within its kind: `task`, `job`, `goal`, `dataset`, `file`, `editor`, ... */
    type: string;
    /** Deleted and kept (it can be restored): it moves too. */
    deleted?: boolean;
}

/** What a feature holds of one person: how many, and the first `OWNED_ITEMS_SHOWN`. */
export interface OwnedList {
    count: number;
    items: OwnedItem[];
}

/** Live items first, then deleted ones, capped at `OWNED_ITEMS_SHOWN`. */
export function ownedList(items: readonly OwnedItem[]): OwnedList {
    const live = items.filter((item) => !item.deleted);
    const deleted = items.filter((item) => item.deleted);
    return { count: items.length, items: [...live, ...deleted].slice(0, OWNED_ITEMS_SHOWN) };
}

/**
 * The first of `base`, `base 2`, `base 3`, ... that `taken` refuses, kept
 * within `max` characters: what a moved item is renamed to when the new
 * owner has one by that name already.
 */
export function freeName(base: string, taken: (name: string) => boolean, max = 80) {
    if (!taken(base)) {
        return base;
    }
    for (let n = 2; ; n++) {
        const suffix = ` ${n}`;
        const name = `${base.slice(0, Math.max(1, max - suffix.length)).trimEnd()}${suffix}`;
        if (!taken(name)) {
            return name;
        }
    }
}

/** Who a transfer moves from and to, by app user id and name (for renames and notes). */
export interface TransferParties {
    from: string;
    to: string;
    fromName: string;
    toName: string;
}

/**
 * What follows a moved conversation (CB-360): a row keyed by the person
 * and the conversation (its page or context link, its episodes, its
 * learning evidence, its Telegram chat) moves with it, or is dropped
 * when it can't.
 */
export interface ThreadFollower {
    followThreads(parties: TransferParties, threadIds: readonly string[]): TransferTally;
}

/** One kind of what a person owns (`GET /api/accounts/:id/assets`). */
export interface OwnedKind {
    kind: AssetKind;
    /** Every item, deleted ones too. */
    count: number;
    /** Up to `OWNED_ITEMS_SHOWN` of them, live ones first. */
    items: OwnedItem[];
}

/** `GET /api/accounts/:id/assets`: empty for an account with no app user. */
export interface PersonAssets {
    accountId: string;
    name: string;
    kinds: OwnedKind[];
}

/** What moving one kind did: rows moved by what they are, and what was renamed or merged. */
export interface TransferTally {
    moved: Record<string, number>;
    notes: string[];
}

/** `POST /api/accounts/:id/transfer`. */
export interface AssetTransfer {
    from: { accountId: string; name: string };
    to: { accountId: string; name: string };
    kinds: Array<{ kind: AssetKind } & TransferTally>;
}

/**
 * `POST /api/accounts/:id/purge` with `apply: false`: the purge planner's
 * dry run for this one person (the CLI's `pnpm run purge` plan).
 */
export interface PersonPurgePlan {
    accountId: string;
    name: string;
    /** Why it won't run; empty when it may. */
    refusals: string[];
    /** Records that go, by kind (users, socios, ...). */
    targets: Record<string, number>;
    /** Rows each table loses. */
    tables: Array<{ table: string; rows: number }>;
    /** History that stays, naming an id that will no longer resolve. */
    kept: Array<{ table: string; column: string; rows: number }>;
    files: { count: number; bytes: number };
    objects: { count: number; bytes: number };
}

/** `POST /api/accounts/:id/purge` with `apply: true`. */
export interface PersonPurgeResult {
    accountId: string;
    name: string;
    /** Rows deleted, in total and by table. */
    rows: number;
    tables: Array<{ table: string; rows: number }>;
    /** Where the database, files and objects were backed up first. */
    backup: string;
    /** Files and objects removed after the commit; an error means `pnpm run purge --resume <backup>` finishes it. */
    cleanup: { files: number; bytes: number; objects: number } | { error: string };
}
