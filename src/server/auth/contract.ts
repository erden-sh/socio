/**
 * What other features may know of auth: its tags, the slices of its services
 * they call, and plain types and constants. It imports only `effect`,
 * `@socio/*` packages and, with `import type`, `hono`, and holds no logic.
 *
 * The route guards (`requireAdmin`, `requireOperator`), `RateLimits` and
 * `localRequest` live in `@socio/foundation/http`, and the sign-in link
 * message in `@socio/foundation/auth/sign-in-links`; `isAdmin` and
 * `isOperator` (an alias of it since CB-390) in `@socio/shared/roles`. `auth/layer.ts` implements the
 * tags; `AuthConfig` is built from the startup configuration by the
 * composition root (`composition/auth.ts`).
 */
import { Context } from 'effect';
import type { Hono } from 'hono';

import type { SignInLink } from '@socio/foundation/auth/sign-in-links';
import type { AppEnv } from '@socio/foundation/http/app-env';
import type {
    SavedAccessPolicy,
    SignInCeiling,
    StepUpChallenge,
    StepUpMethod,
    StepUpProof,
} from '@socio/shared/access-policy';
import type {
    AssetKind,
    AssetTransfer,
    DeactivationImpact,
    OwnedKind,
    PersonPurgePlan,
    PersonPurgeResult,
    PersonReach,
    SignInLinkVia,
    SignInMethods,
    TransferParties,
} from '@socio/shared/auth';
import type { Branding } from '@socio/shared/branding';
import type { DeviceErrorCode, SocialProvider } from '@socio/shared/device-sign-in';
import type { WorkspaceManifest } from '@socio/shared/device-sign-in';
import type { PersonAccess, PersonTrail, PersonTrailSource } from '@socio/shared/people';
import type { User } from '@socio/shared/types';
import type { SignInView } from '@socio/shared/web/web';

export { SIGN_IN_LINK_SECONDS, type SignInLink } from '@socio/foundation/auth/sign-in-links';

// ── Sign-in links ─────────────────────────────────────────────────────────

/** The client page a sign-in link opens; its button completes the sign-in. */
export const SIGN_IN_LINK_PATH = '/sign-in-link';
/**
 * What "Send me a sign-in link" always answers, so it never tells whether an
 * account exists or can receive links.
 */
export const SIGN_IN_LINK_SENT = 'If that account can receive links, one is on its way.';

/**
 * Delivers one-time sign-in links to a person on a channel they have proven
 * is theirs. Telegram now (the account's linked Telegram user); email can
 * be added the same way with the optional mailer.
 */
/** Devices ending, for the audit and the push cleanup (CB-352). */
export interface DeviceEnding {
    /** The app user who did it (the person, an admin, `system`). */
    actor: string;
    /** The person's app user id. */
    userId: string;
    /** Signed out (sessions end; the device may sign in again), or marked so with or without erase. */
    how: 'signed_out' | 'revoked' | 'revoked_and_erase';
    /** Why, for admins reading the audit (CB-379). */
    reason: DeviceEndReason;
    devices: { id: string; label: string }[];
}

/** Why devices ended, as the audit row tells admins (CB-379). */
export type DeviceEndReason =
    | 'devices_list'
    | 'admin_devices'
    | 'admin_sessions'
    | 'admin_session'
    | 'deactivated'
    | 'left_workspace'
    | 'signed_in_while_deactivated'
    | 'sign_out'
    | 'sign_out_everywhere'
    | 'other_sessions_revoked'
    | 'session_revoked'
    | 'password_changed'
    | 'password_reset'
    | 'session_ended';

/** Each reason in the words the audit row ends with. */
export const DEVICE_END_REASONS: Record<DeviceEndReason, string> = {
    devices_list: 'from the Devices list in their settings',
    admin_devices: 'by an admin, from the person page',
    admin_sessions: 'an admin signed out all their sessions',
    admin_session: 'an admin ended its last session',
    deactivated: 'the person was deactivated',
    left_workspace: 'the person left the workspace',
    signed_in_while_deactivated: 'it signed in while the person was being deactivated',
    sign_out: 'signed out on the device',
    sign_out_everywhere: 'signed out everywhere',
    other_sessions_revoked: 'signed out of their other sessions',
    session_revoked: 'its session was ended from another session',
    password_changed: 'the password was changed',
    password_reset: 'the password was reset',
    session_ended: 'its last session ended',
};

/** What a session's ending through Better Auth's own endpoint means for its device, by the endpoint's path. */
export const DEVICE_END_PATHS: Readonly<Record<string, DeviceEndReason>> = {
    '/sign-out': 'sign_out',
    '/revoke-sessions': 'sign_out_everywhere',
    '/revoke-other-sessions': 'other_sessions_revoked',
    '/revoke-session': 'session_revoked',
    '/change-password': 'password_changed',
    '/reset-password': 'password_reset',
};

/**
 * What a session check's 401 says to the app, by why its device was refused
 * (CB-352), on the session check and `GET /api/auth/session` alike (CB-379).
 */
export const DEVICE_REFUSAL_WORDS: Record<DeviceRefusalCode, string> = {
    session_expired: 'Your session expired. Sign in again.',
    session_ended: 'You were signed out. Sign in again.',
    device_revoked: 'This device was signed out and its copy should be erased.',
    deactivated: 'This account was deactivated.',
};

export interface DeviceEndHooks {
    /** Written before anything ends; a throw stops it. */
    audit(event: DeviceEnding): void | Promise<void>;
    /** Removes the person's push subscription at this endpoint, if it's theirs. */
    dropPush(userId: string, endpoint: string): Promise<void>;
}

export interface SignInLinkSender {
    /** How the link travels; admins see it ("Send sign-in link via Telegram"). */
    readonly via: SignInLinkVia;
    /** Whether this app user can receive a link now (linked, channel running). */
    canDeliver(userId: string): boolean | Promise<boolean>;
    /** Sends the link and a one-line note; never the account's email. */
    deliver(userId: string, link: SignInLink): Promise<void>;
    /**
     * Who a message to this app user reaches now (the linked Telegram account,
     * the email address), or null. Stored only hashed: a sign-in code works
     * only while it still reaches the same one (CB-352).
     */
    recipient(userId: string): string | null | Promise<string | null>;
    /** Whether the channel is running at all (the Telegram bot online); taken as true when absent. */
    available?(): boolean;
}

// ── Step-up ───────────────────────────────────────────────────────────────

/** Who is stepping up: the request's session and its sign-in account. */
export interface StepUpSession {
    /** The provider's session id (Better Auth), or a hash of the cookie (mock). */
    sessionId: string;
    /** The sign-in account (Better Auth's user id; the app user id with mock). */
    accountId: string;
}

/** A step-up's outcome, as the routes answer it. */
export type StepUpResult =
    | { ok: true; method: StepUpMethod; session: StepUpSession }
    | {
          ok: false;
          status: 401 | 403 | 429;
          error: string;
          /** This failure counts towards the lock (a wrong password or passkey). */
          counted: boolean;
          /** This failure locked step-up for the rest of the window. */
          locked: boolean;
      };

/**
 * Step-up re-authentication (CB-124): the provider's proofs (a password or
 * a passkey with Better Auth, a confirmation with mock auth), each for one
 * challenge bound to a session, an admin and one change's digest.
 */
export interface StepUpVerifier {
    begin(request: Request, user: User, digest: string): Promise<StepUpChallenge | null>;
    finish(request: Request, user: User, digest: string, proof: StepUpProof): Promise<StepUpResult>;
}

// ── The provider ──────────────────────────────────────────────────────────

/**
 * Resolves each request to a user. The mock provider serves development and
 * trusted networks; the Better Auth provider (passkeys, passwords, OAuth)
 * replaces it without touching callers.
 */
/** A device signed in through a device endpoint (CB-352): `userId` is the app user id. */
export interface DeviceSignInEvent {
    userId: string;
    deviceId: string;
    label: string;
    method: string;
}

/**
 * Native Google and Apple sign-in's verifier (CB-570): something that
 * checks an ID token made with a nonce this server issued and names the
 * provider's subject. The composition hands in the cloud's
 * (`cloud/social.ts`); tests hand in their own. Never throws.
 */
export interface SocialVerifier {
    /** The providers offered now, with Google's server client id; null while none can be verified. */
    config(): Promise<{ google?: { serverClientId: string; web?: true }; apple?: { web?: true } } | null>;
    verify(input: {
        provider: SocialProvider;
        idToken: string;
        nonce: string;
    }): Promise<
        | { ok: true; provider: SocialProvider; sub: string; email?: string; emailVerified?: boolean; nonce: string }
        | { ok: false; code: 'invalid_token' | 'nonce_invalid' | 'too_many' | 'provider_unavailable' }
    >;
    /**
     * The website's flow (through Socio's sign-in page): the page for this
     * nonce. Absent: the website offers no Google or Apple sign-in.
     */
    webStart?(input: {
        provider: SocialProvider;
        purpose: 'signin' | 'link';
        nonce: string;
    }): Promise<
        { ok: true; url: string } | { ok: false; code: 'provider_unavailable' | 'too_many'; retryAfterS?: number }
    >;
    /** The result the browser brought back, redeemed for the person; the nonce is the statement's. */
    redeemWeb?(input: {
        provider: SocialProvider;
        result: string;
    }): Promise<
        | { ok: true; provider: SocialProvider; sub: string; email?: string; emailVerified?: boolean; nonce: string }
        | { ok: false; code: 'invalid_token' | 'nonce_invalid' | 'too_many' | 'provider_unavailable' }
    >;
}

/** Why a request from the app was refused (CB-352): the 401's `code` for it. */
export type DeviceRefusalCode = Extract<
    DeviceErrorCode,
    'session_expired' | 'session_ended' | 'device_revoked' | 'deactivated'
>;

export interface AuthProvider {
    readonly kind: string;
    /**
     * GET endpoints the browser reaches by a top-level navigation from another
     * site (an identity provider's redirect back, an emailed link). They skip
     * the cross-site check and must verify their own request (state, PKCE).
     */
    readonly navigationPaths?: readonly string[];
    /**
     * POST endpoints programs call with a form body and no cookies (agents'
     * OAuth token and revocation endpoints, CB-90). The origin, cross-site
     * and JSON checks don't apply; the provider ignores their cookies.
     */
    readonly tokenPaths?: readonly string[];
    /**
     * The signed-in user for this request, or null. `setHeader` lets the
     * provider renew its cookie on the response (sliding sessions).
     */
    resolve(request: Request, setHeader?: (name: string, value: string) => void): Promise<User | null>;
    /** Users this provider knows about (synced into the users table). */
    users(): User[];
    /**
     * App user ids of deactivated people (Better Auth). They are not in
     * `users()`; their content keeps their name, but nothing new is given to
     * them (WorkspaceStore.useDeactivated).
     */
    deactivatedUsers?(): string[];
    /** Provider endpoints under /api/auth; they run before the auth check. */
    routes(app: Hono<AppEnv>): void;
    /** Provider endpoints that need a signed-in user (account management). */
    protectedRoutes?(app: Hono<AppEnv>): void;
    /** What the sign-in screen offers, when it isn't the mock picker. */
    signInMethods?(): Promise<SignInMethods>;
    /** Ends the request's session; returns the Set-Cookie headers to send. */
    logout?(request: Request): Promise<string[]>;
    /**
     * Boot work after the migrations, before users are synced (Better Auth:
     * flag rules for the retired operator role, the first admin, the workspace owner).
     * Returns lines for the log.
     */
    start?(): Promise<string[]>;
    /**
     * Boot work before the server listens: loads what the provider would
     * otherwise load on the first request that carries a session (Better
     * Auth: its instance, its plugins' modules), so that request doesn't
     * block the main thread (`composition/lifecycle/warm.ts`).
     */
    warm?(): Promise<void>;
    /** Channels that deliver one-time sign-in links (Telegram), once built. */
    useSignInLinks?(senders: SignInLinkSender[]): void;
    /**
     * Called when an admin deactivates or reactivates a person (Better Auth),
     * so the app ends what else acts for them (keys, mini app sessions,
     * schedules, subscription connections) and audits it (accounts.ts).
     */
    onAccountChange?(listener: (event: AccountEvent) => void | Promise<void>): void;
    /**
     * What the rest of the app knows of a person, for admins' roster and the
     * deactivation preview (CB-360, accounts.ts `peopleFacts`). Better Auth
     * only; without it the roster has no reach and the preview counts only
     * sessions.
     */
    usePeopleFacts?(facts: PeopleFacts): void;
    /**
     * What each person owns and moving it to another person (CB-360,
     * accounts.ts `assetTransfers`). Better Auth only.
     */
    usePeopleAssets?(assets: PeopleAssets): void;
    /** The purge of one person, for admins (CB-360, purge/person.ts). Better Auth only. */
    usePersonPurge?(purge: PersonPurge): void;
    /**
     * The access policy (CB-124): what the environment allows for sign-in,
     * the ceiling admins narrow. Better Auth only; mock auth has no
     * sign-in methods to narrow.
     */
    signInCeiling?(): SignInCeiling;
    /** The access policy's step-up re-authentication. */
    readonly stepUp?: StepUpVerifier;
    /** The request's session and sign-in account, if it has a session. */
    sessionOf?(request: Request): Promise<StepUpSession | null>;
    /** Which of these app users a sign-in link can reach now. */
    linkReachable?(userIds: string[]): Promise<Set<string>>;
    /**
     * Why `resolve` refused this request from the app (CB-352): only for a
     * request with an install id (`X-Socio-Install`), and only after
     * `resolve` gave null for it. The session check's 401 carries it.
     * Better Auth only.
     */
    deviceRefusal?(request: Request): DeviceRefusalCode | null;
    /** Where the workspace's name comes from (its branding), for Add a device (CB-352). Better Auth only. */
    useWorkspaceName?(name: () => string): void;
    /** After a device signed in through a device endpoint (CB-352). Better Auth only. */
    onDeviceSignIn?(listener: (event: DeviceSignInEvent) => void | Promise<void>): void;
    /** The workspace's id, random and made once (CB-352). Better Auth only. */
    workspaceId?(): string;
    /**
     * Where ended devices are audited (first) and their push subscriptions
     * removed (after), CB-352; wired by the composition.
     */
    useDeviceEnds?(hooks: DeviceEndHooks): void;
    /** An admin's saved switch for invites that open the Socio app; undefined: the environment's. */
    useSavedInviteLinks?(read: () => boolean | undefined): void;
    /** Drops the push subscriptions of devices left with no live session (after the access policy ended sessions). */
    sweepDevicePush?(): Promise<void>;
    /**
     * What `/.well-known/socio/workspace` says of sign-in (CB-352): the
     * workspace's id and origin and the ways in the app can offer now.
     */
    workspaceManifest?(): Promise<{ id: string; origin: string; methods: WorkspaceManifest['methods'] }>;
    /** Who verifies the app's Google and Apple sign-ins (CB-570); none: they aren't offered. Better Auth only. */
    useSocialVerifier?(verifier: SocialVerifier): void;
    /**
     * Whether this app user may run code (CB-376): with Better Auth, the
     * organization plugin's `code:run` permission (admins have it, others
     * through a group); with mock auth, admins only. Read on every use.
     */
    mayRunCode?(userId: string): Promise<boolean>;
    /**
     * The `CODE_USERS` migration (CB-376), at boot: once per database, a
     * "Code" group from the list in force (`ceiling` as narrowed under
     * Settings → Access). Better Auth only. Returns lines for the log.
     */
    seedCodeGroup?(ceiling: readonly string[]): Promise<string[]>;
    /**
     * Called when an admin is demoted to member, so plugin sessions and
     * unused launch codes end (the same rows deactivation ends).
     */
    onAdminRevoked?(listener: (userId: string) => void | Promise<void>): void;
    /**
     * After the workspace owner changed (CB-390): a transfer, or the owner
     * replaced at boot or after a deactivation from the server's shell. The
     * composition tells every admin. Better Auth only.
     */
    onOwnerChanged?(listener: (change: OwnerChange) => void | Promise<void>): void;
}

/** The workspace owner changed (CB-390); already audited by the provider. */
export interface OwnerChange {
    to: { userId: string; name: string };
    /** The previous owner, if there was one still on the workspace. */
    from: { userId: string; name: string } | null;
    /** Who did it: an app user id, `system` (boot) or `cli`. */
    by: string;
    /**
     * `transferred`: the owner handed it over; `first_admin`: the first
     * owner recorded; `replaced`: the previous owner is no longer an active
     * admin, so the earliest-created active admin took over.
     */
    how: 'transferred' | 'first_admin' | 'replaced';
}

/**
 * What other features know of one person (CB-360): what they can reach,
 * and what a deactivation would change, read without changing anything.
 */
export interface PeopleFacts {
    reach(userId: string): Promise<PersonReach>;
    deactivationImpact(userId: string): Promise<DeactivationEffects>;
    /** What `reach` counts, listed: the person page's Access (`GET /api/accounts/:id`). */
    access(userId: string): Promise<PersonAccess>;
    /**
     * A page of the person's audit trail, newest first, from the four audit
     * sources (`GET /api/accounts/:id/audit`). `before` is a `next` it
     * returned, or epoch milliseconds (strictly older).
     */
    trail(userId: string, before: TrailBefore | undefined, limit: number): Promise<PersonTrail>;
    /** An admin's action on the person, in the workspace audit (a device signed out). */
    audit(entry: { actor: string; userId: string; action: 'revoke'; detail: string }): void;
}

/**
 * What a person owns, by kind, and moving it to another person (CB-360):
 * accounts.ts `assetTransfers`, over each feature's ownership slice.
 */
export interface PeopleAssets {
    assets(userId: string): OwnedKind[];
    /**
     * Moves `kinds` (all when empty) from `parties.from` to `parties.to`,
     * audited for both as `by`; what moved, by kind.
     */
    transfer(parties: TransferParties, kinds: readonly AssetKind[], by: string): Promise<AssetTransfer['kinds']>;
}

/**
 * The purge of one person (CB-360's "Remove permanently"), with the CLI's
 * planner, backup, checks and audit (`pnpm run purge`); purge/person.ts
 * implements it. Never cascades: what the person owns is refused until it
 * is transferred.
 */
export interface PersonPurge {
    plan(userId: string): Promise<Omit<PersonPurgePlan, 'accountId' | 'name'>>;
    /**
     * Refuses (throws) while the plan does, or when, under the write lock,
     * the person is not deactivated under `confirmed.name`; `actor` is the
     * admin, for the audit line.
     */
    apply(
        userId: string,
        actor: string,
        confirmed: { name: string },
    ): Promise<Omit<PersonPurgeResult, 'accountId' | 'name'>>;
}

/** Where a trail page starts (`parseTrailBefore`): a line's place, or a time. */
export type TrailBefore = { at: number; source: PersonTrailSource; id: number } | { at: number };

/** The part of a deactivation's impact other features own (`DeactivationImpact`). */
export type DeactivationEffects = Omit<
    DeactivationImpact,
    'accountId' | 'name' | 'refusal' | 'deactivated' | 'sessions' | 'owned'
>;

/** A person deactivated or reactivated. */
export interface AccountEvent {
    action: 'deactivate' | 'reactivate';
    /** The app user id: their content belongs to it. */
    userId: string;
    /** Their name, for the audit line. */
    name: string;
    /** The admin's app user id (the person's own when they left, CB-383). */
    by: string;
    /** They left the workspace on their own (CB-383), rather than an admin deactivating them. */
    left?: boolean;
}

export interface AuthSetup {
    provider: AuthProvider;
    /** Cookies get Secure when the app is served over https. */
    secureCookies: boolean;
}

/**
 * The auth provider and its cookie setting, built once at boot
 * (`authFromEnv`). The server's entry passes it to `createApp`; pages read
 * the provider's kind and sign-in methods from it.
 */
export class Auth extends Context.Service<Auth, AuthSetup>()('socio/auth/Auth') {}

// ── Request users ─────────────────────────────────────────────────────────

/** Sets a header on the response: Better Auth renews its cookie this way. */
export type SetHeader = (name: string, value: string) => void;

/**
 * A request's user, or null; recorded in the workspace the first time it is
 * seen with a name and role (`requestUserResolver`, auth/request-user.ts).
 */
export type RequestUserResolver = (request: Request, setHeader: SetHeader) => Promise<User | null>;

/** What the API's auth check and the page services call to name a request's user. */
export interface RequestUsersShape {
    readonly resolve: RequestUserResolver;
}

export class RequestUsers extends Context.Service<RequestUsers, RequestUsersShape>()('socio/auth/RequestUsers') {}

// ── The access policy ─────────────────────────────────────────────────────

/** The saved access policy (CB-124), as `readStoredPolicy` reads it. */
export interface StoredPolicy {
    /** 0 before anything was saved. */
    version: number;
    saved: SavedAccessPolicy;
    updatedAt: number | null;
    updatedBy: string | null;
    /** The row didn't parse: nothing is narrowed (the environment applies). */
    unreadable: boolean;
}

/** The saved access policy, read on every use. */
export interface AccessPolicyReaderShape {
    readonly read: () => StoredPolicy;
}

export class AccessPolicyReader extends Context.Service<AccessPolicyReader, AccessPolicyReaderShape>()(
    'socio/auth/AccessPolicyReader',
) {}

// ── Code access ───────────────────────────────────────────────────────────

/**
 * Who may run code (CB-376): the provider's `mayRunCode`, read on every
 * use, so taking someone out of a group (or deleting it) applies to their
 * next check. The gateways and coding sessions ask it
 * (gateway/code-users.ts); without a provider check, nobody may.
 */
export interface CodeAccessShape {
    readonly mayRunCode: (userId: string) => Promise<boolean>;
}

export class CodeAccess extends Context.Service<CodeAccess, CodeAccessShape>()('socio/auth/CodeAccess') {}

// ── Views ─────────────────────────────────────────────────────────────────

/** What the pages and live state read of auth: the sign-in screen's view. */
export interface AuthViewsShape {
    /** `GET /api/auth/session` without the user: what the sign-in screen offers. */
    readonly signInView: (provider: AuthProvider, branding?: Branding) => Promise<SignInView>;
}

/**
 * Auth's views (`auth/sign-in-view.ts`), for `live/` to read instead of its
 * own copy.
 */
export class AuthViews extends Context.Service<AuthViews, AuthViewsShape>()('socio/auth/AuthViews') {}

// ── Config ────────────────────────────────────────────────────────────────

/** What auth reads of the process's settings, built once from the startup configuration. */
export interface AuthConfigShape {
    /**
     * `CODE_USERS`, deprecated (CB-376): who could run code before groups;
     * the boot seeds the "Code" group from it once.
     */
    readonly codeCeiling: readonly string[];
}

export class AuthConfig extends Context.Service<AuthConfig, AuthConfigShape>()('socio/auth/AuthConfig') {}
