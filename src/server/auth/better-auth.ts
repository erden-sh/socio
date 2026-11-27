import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import type { OAuthOptions, Scope } from '@better-auth/oauth-provider';
import type { BetterAuthPlugin } from 'better-auth';
import type { Context, Hono } from 'hono';
import { z } from 'zod';

import { applyConnectionPragmas } from '@socio/data/sqlite-pragmas';
import { clientHost, isLocalRedirect } from '@socio/foundation/agents/clients';
import {
    AGENT_CLIENTS_TABLE,
    AUTH_PATH,
    AUTHORIZATION_SERVER_PATH,
    MCP_PATH,
    mcpResource,
    OAUTH_SCOPES,
    PROTECTED_RESOURCE_PATH,
    protectedResourceMetadata,
    withConsentGrant,
} from '@socio/foundation/agents/oauth';
import type { AppEnv } from '@socio/foundation/http/app-env';
import { requireAdmin } from '@socio/foundation/http/guards';
import { clientAddress } from '@socio/foundation/http/network-trust';
import { RateLimits } from '@socio/foundation/http/rate-limits';
import { reportFailure, safeFailure } from '@socio/foundation/observability/failures';
import {
    codeUsersInForce,
    sessionAllowed,
    signInInForce,
    stepUpProofSchema,
    type SignInCeiling,
    type SignInInForce,
    type SignInMethodId,
} from '@socio/shared/access-policy';
import type { AgentConsentView } from '@socio/shared/agent-grants';
import { isGrantableScope } from '@socio/shared/agents/scopes';
import {
    ASSET_KINDS,
    DEACTIVATED_MESSAGE,
    type Account,
    type AssetTransfer,
    type PasswordLink,
    type PersonAssets,
    type PersonPurgePlan,
    type PersonPurgeResult,
    type DeactivationImpact,
    type RosterPerson,
    type SentSignInLink,
    type SignInMethods,
} from '@socio/shared/auth';
import { nonPersonOwnerId } from '@socio/shared/data-types';
import {
    appLink,
    devicePushBodySchema,
    socialProviderSchema,
    isLinkHost,
    type AppLinkFields,
    type AppVariant,
    type DeviceState,
    type DeviceSummary,
} from '@socio/shared/device-sign-in';
import { groupCreateSchema, groupUpdateSchema } from '@socio/shared/groups';
import {
    LEAVE_REFUSAL_MESSAGES,
    LEAVE_WORKSPACE_PATH,
    type LeaveRefusalCode,
    leaveWorkspaceCheckSchema,
    leaveWorkspaceRequestSchema,
} from '@socio/shared/leave-workspace';
import type { PersonDetail, PersonTrail } from '@socio/shared/people';
import { isAdmin, normalizeRole, ROLES } from '@socio/shared/roles';
import type { Role, User } from '@socio/shared/types';

import { AgentGrantError, type GrantsShape } from '../agents/contract.js';

import { readStoredPolicy } from './access-policy-store.js';
import { hasWayIn } from './access-policy.js';
import { AccountTurns } from './account-turns.js';
import { parseTrailBefore } from './accounts.js';
import {
    DEVICE_END_PATHS,
    SIGN_IN_LINK_PATH,
    SIGN_IN_LINK_SECONDS,
    SIGN_IN_LINK_SENT,
    type SignInLinkSender,
    type StepUpSession,
    type StepUpVerifier,
    type AccountEvent,
    type AuthProvider,
    type DeviceEndHooks,
    type DeviceEnding,
    type DeviceEndReason,
    type DeviceRefusalCode,
    type DeviceSignInEvent,
    type OwnerChange,
    type PeopleAssets,
    type PeopleFacts,
    type PersonPurge,
    type SocialVerifier,
} from './contract.js';
import { appLinkVariant, type CodeTarget, DEVICE_SIGN_IN_PATHS, deviceSignIn } from './device-sign-in.js';
import {
    DEVICE_SESSION_SECONDS,
    DEVICE_SLIDE_SECONDS,
    deviceFromUserAgent,
    Devices,
    readInstallId,
    type DeviceRow,
} from './devices.js';
import { emailSignInLinks } from './email-sign-in.js';
import {
    GroupError,
    WorkspaceGroups,
    WORKSPACE_ORGANIZATION_ID,
    splitMemberRole,
    baseRoleOf,
    workspaceOrganization,
    type WorkspaceOrganizationOptions,
} from './groups.js';
import { HostCookies } from './host-cookies.js';
import type { Mailer } from './mailer.js';
import { retireOperatorRows } from './retire-operator.js';
import { adminByEmail, claimGroups, effectiveRole, oauthAccess, type AccessRules } from './rules.js';
import { acceptableUrl, type OAuthProviderSettings } from './settings.js';
import type { BetterAuthSettings } from './settings.js';
import { NATIVE_PROVIDER_IDS, SocialSignIn, socialRefusal } from './social-sign-in.js';
import { expiredStepUp, STEP_UP_LOCKED, STEP_UP_SECONDS, StepUpChallenges } from './step-up.js';

/** A Better Auth date column's value (ISO text, or epoch milliseconds) in milliseconds; 0 when unreadable. */
function toMs(value: unknown): number {
    if (typeof value === 'number') {
        return value;
    }
    if (value instanceof Date) {
        return value.getTime();
    }
    if (typeof value === 'string') {
        const parsed = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
}

/** How often an account's last activity is written (not on every request). */
const ACTIVITY_MS = 5 * 60_000;
/** How long the boot's warm-up waits for the instance's context (OAuth discovery). */
export const WARM_CONTEXT_MS = 5_000;

/** Set by the server from the connection (or the proxy), never the client. */
export const CLIENT_IP_HEADER = 'x-socio-client-ip';
/** The client page that sets a password from a link. */
export const PASSWORD_LINK_PATH = '/reset-password';
const SESSION_SECONDS = 7 * 24 * 60 * 60;
/** Admin-made password links (invites) last three days; emailed resets an hour. */
const LINK_SECONDS = 3 * 24 * 60 * 60;
const MIN_PASSWORD = 10;
/** Better Auth's `cookiePrefix`: `cb.session_token`, `__Host-cb.…` over https. */
const COOKIE_PREFIX = 'cb';
/**
 * "Send me a sign-in link": requests per client address, and links per
 * account (admins' sends count too), per 15 minutes.
 */
const LINK_WINDOW_MS = 15 * 60_000;
const LINK_REQUESTS_PER_ADDRESS = 5;
const LINKS_PER_ACCOUNT = 3;
/**
 * The OAuth provider's endpoints agents use (CB-90); its others (client
 * management, its own consent and continue endpoints, userinfo) are not
 * served. The consent screen approves through /api/agent-consent.
 */
const OAUTH_ENDPOINTS = ['/oauth2/authorize', '/oauth2/token', '/oauth2/revoke'];
/** Discovery documents are public: any origin may read them. */
const METADATA_HEADERS = {
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=300',
};

const role = z.enum(ROLES);
const email = z.string().trim().toLowerCase().pipe(z.email());
const accountInput = z
    .object({
        email,
        name: z.string().trim().min(1).max(80),
        role,
        /** Link to an existing app user (alice, smoke-admin, …). */
        userId: z
            .string()
            .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/)
            // Never a non-person owner id: a socio's area, a plugin, the workspace (CB-224, CB-451).
            .refine((id) => !nonPersonOwnerId(id))
            .optional(),
        password: z.string().min(1).max(128).optional(),
    })
    .strict();
export type AccountInput = z.infer<typeof accountInput>;

/** The payload of an ID token Better Auth has already verified. */
const claimsOf = (token: string) => {
    try {
        const value: unknown = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
        return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
    } catch {
        return null;
    }
};
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/** How often devices whose sessions ran out lose their push subscriptions (CB-379). */
const DEVICE_PUSH_SWEEP_MS = 60 * 60_000;

/** The `?error=` a sign-in by a method turned off comes back with (CB-124). */
export const METHOD_OFF = 'METHOD_OFF';
const OFF_MESSAGES = {
    password: 'Email and password sign-in is turned off here.',
    passkey: 'Passkey sign-in is turned off here.',
    link: 'Sign-in links are turned off here.',
    provider: 'Sign-in with this provider is turned off here.',
    signUp: 'Sign-up is closed: ask an admin to add you.',
};

/**
 * How a session about to be made began (CB-124), from the endpoint making
 * it: what the access policy can turn off. Null for the rest (a
 * server-side call), which no method decides; a password change's new
 * session takes its method from the one it replaces (the session hook).
 */
export function sessionMethod(
    path: string | undefined,
    params?: Record<string, unknown>,
    body?: unknown,
): SignInMethodId | null {
    if (!path) {
        return null;
    }
    if (path === '/sign-in/email' || path === '/sign-up/email' || path === '/verify-email') {
        return 'password';
    }
    if (path === '/passkey/verify-authentication' || path === '/passkey/verify-registration') {
        return 'passkey';
    }
    if (path === '/magic-link/verify') {
        return 'link';
    }
    if (path.startsWith('/callback/') || path.startsWith('/oauth2/callback/')) {
        const id =
            (typeof params?.id === 'string' && params.id) ||
            (typeof params?.providerId === 'string' && params.providerId) ||
            path.split('/').pop();
        return id && !id.startsWith(':') ? `provider:${id}` : null;
    }
    if (path === '/sign-in/social') {
        const provider = (body as { provider?: unknown } | undefined)?.provider;
        return typeof provider === 'string' ? `provider:${provider}` : null;
    }
    return null;
}

/**
 * The 401 code for a device that was signed out (CB-352, the plan's
 * correction 10): "Sign out this device" locks the app as an ended session
 * does, keeping its copy; "Sign out and erase" has it erase its copy.
 */
const signedOutCode = (state: DeviceState): DeviceRefusalCode =>
    state === 'revoked_and_erase' ? 'device_revoked' : 'session_ended';

/** The session token in a session cookie's value (`<token>.<signature>`, URL-encoded). */
function sessionToken(value: string): string | undefined {
    let decoded: string;
    try {
        decoded = decodeURIComponent(value);
    } catch {
        return undefined;
    }
    const dot = decoded.indexOf('.');
    return dot > 0 ? decoded.slice(0, dot) : undefined;
}

/** Better Auth loads only when it is the provider (see `build`). */
type AuthApi = typeof import('better-auth/api');

/** Server-only endpoints (`auth.api.*`, no URL): account creation by admins. */
const brainPlugin = ({ APIError, createAuthEndpoint }: AuthApi) =>
    ({
        id: 'socio',
        endpoints: {
            brainCreateAccount: createAuthEndpoint.serverOnly({ method: 'POST', body: accountInput }, async (ctx) => {
                const { email, name, role, userId, password } = ctx.body;
                const internal = ctx.context.internalAdapter;
                if (await internal.findUserByEmail(email)) {
                    throw new APIError('BAD_REQUEST', {
                        message: 'An account with this email already exists.',
                    });
                }
                const { minPasswordLength, maxPasswordLength } = ctx.context.password.config;
                if (password && (password.length < minPasswordLength || password.length > maxPasswordLength)) {
                    throw new APIError('BAD_REQUEST', {
                        message: `Use a password of ${minPasswordLength} to ${maxPasswordLength} characters.`,
                    });
                }
                // The admin vouches for the address, so OAuth sign-ins with the
                // same verified email link to this account.
                const user = await internal.createUser(
                    {
                        email,
                        name,
                        emailVerified: true,
                        role,
                        ...(userId ? { appUserId: userId } : {}),
                    },
                    { method: 'admin' },
                );
                if (password) {
                    await internal.createAccount({
                        userId: user.id,
                        providerId: 'credential',
                        accountId: user.id,
                        password: await ctx.context.password.hash(password),
                    });
                }
                return ctx.json({ id: user.id });
            }),
        },
    }) satisfies BetterAuthPlugin;

/**
 * Deactivation: Better Auth's admin plugin, for its `banned` flag and the check
 * that refuses a banned user every new session, whatever the way in (password,
 * passkey, OAuth, sign-in links, email verification). Only that: its endpoints
 * (impersonation, hard removal, roles, passwords) are left out, so the account
 * routes below, with their guards, stay the only way to manage accounts.
 */
const deactivation = ({ admin }: typeof import('better-auth/plugins/admin')) =>
    ({
        // No `defaultRole`: the plugin's own "user" is no role of ours, so the
        // user create hook below still picks the role (a linked user's, else
        // member).
        ...admin({ bannedUserMessage: DEACTIVATED_MESSAGE }),
        endpoints: {},
    }) satisfies BetterAuthPlugin;

/**
 * Better Auth's context for one permission check (CB-376), whose adapter
 * reads only the runtime roles (groups) this person is in. `hasPermission`
 * reads an organization's roles with `findMany` and no limit, and the
 * adapter stops at 100 rows by default, so with every group read, a person
 * in a group past the hundredth would be refused. Their own groups, with a
 * limit of exactly that many, are all that applies; none, no read at all.
 */
function rolesOnly<C extends { adapter: { findMany: (query: never) => Promise<unknown[]> } }>(
    context: C,
    groups: readonly string[],
): C {
    type Query = { model: string; where?: { field: string; value: unknown; operator?: string }[]; limit?: number };
    const findMany = context.adapter.findMany.bind(context.adapter) as (query: Query) => Promise<unknown[]>;
    const adapter = Object.create(context.adapter, {
        findMany: {
            value: async (query: Query) => {
                if (query.model !== 'organizationRole') {
                    return findMany(query);
                }
                if (!groups.length) {
                    return [];
                }
                return findMany({
                    ...query,
                    where: [...(query.where ?? []), { field: 'role', operator: 'in', value: [...groups] }],
                    limit: groups.length,
                });
            },
        },
    }) as C['adapter'];
    return Object.assign(Object.create(context) as C, { adapter });
}

/** Replaces Better Auth's scrypt hashing (tests only: it is slow on purpose). */
export interface PasswordHasher {
    hash(password: string): Promise<string>;
    verify(data: { hash: string; password: string }): Promise<boolean>;
}

interface AuthUserRow {
    id: string;
    appUserId: string | null;
    name: string;
    email: string;
    emailVerified: number;
    role: string | null;
    createdAt: string;
    /** Deactivated: Better Auth's admin plugin's `banned`. */
    banned: number | null;
}

/**
 * Connected agents' side of Better Auth (CB-90), which agents/ implements
 * and the composition hands in (`composition/auth.ts`): the OAuth provider
 * plugin's options, over one client metadata fetcher, and the grants in
 * the auth database.
 */
export interface AgentAuthorization {
    /** The plugin's options for this origin (`agentOAuthOptions`). */
    oauthOptions(input: { origin: string; pluginScopes?: readonly string[] }): OAuthOptions<Scope[]>;
    /** Connected agents' grants on `db` (`AgentGrants`). */
    grants(db: DatabaseSync): Pick<GrantsShape, 'create' | 'discard' | 'allowedDomains' | 'clientAllowed'>;
}

/**
 * Sign-in with Better Auth inside the app: passkeys, email and password,
 * and generic OAuth/OIDC providers (Logto, Google, Clerk, …). Its tables
 * (`auth_*`, see schema.ts) are in the app's database; each sign-in account
 * is linked to an app user id (`appUserId`) that owns the data, so existing
 * users (alice, smoke-admin) carry over by linking. Invite-only unless
 * `AUTH_OPEN_SIGNUP=true`. Mounted under `/api/auth/*`.
 */
/** What a removal's step-up is bound to (CB-360): this account, under this name. */
const purgeDigest = (account: Account) =>
    createHash('sha256')
        .update(`purge\u0000${account.id}\u0000${account.userId}\u0000${account.name}`)
        .digest('base64url');

/** Why the workspace owner can't be demoted or deactivated, or leave (CB-390). */
const OWNER_STAYS_ADMIN = 'The workspace owner stays an active admin. Make another admin the owner first.';

/** What a "Make owner" step-up is bound to (CB-390): this account, under this name. */
const ownerDigest = (account: Account) =>
    createHash('sha256')
        .update(`owner\u0000${account.id}\u0000${account.userId}\u0000${account.name}`)
        .digest('base64url');

export class BetterAuthProvider implements AuthProvider {
    readonly kind = 'betterauth';
    /**
     * Opened from another site (the identity provider's redirect, an email
     * link): they skip the cross-site check and verify their own request.
     */
    readonly navigationPaths: readonly string[];
    /**
     * Agents' OAuth token and revocation endpoints (CB-90): form posts from
     * programs, not pages, so the origin and JSON checks don't apply; their
     * cookies are dropped, so a page can't ride a session through them.
     */
    readonly tokenPaths = OAUTH_ENDPOINTS.slice(1).map((path) => `${AUTH_PATH}${path}`);
    private db?: DatabaseSync;
    private instance?: ReturnType<BetterAuthProvider['build']>;
    private builtAt = 0;
    private discovery = new Map<string, Promise<string | undefined>>();
    private senders: SignInLinkSender[] = [];
    /** Email as a sign-in channel (CB-352), wherever the mailer is set up. */
    private readonly emailSender: SignInLinkSender | undefined;
    private linkRequests = new RateLimits(LINK_REQUESTS_PER_ADDRESS, LINK_WINDOW_MS);
    private linksSent = new RateLimits(LINKS_PER_ACCOUNT, LINK_WINDOW_MS);
    private listeners: ((event: AccountEvent) => void | Promise<void>)[] = [];
    private adminRevokedListeners: ((userId: string) => void | Promise<void>)[] = [];
    private ownerListeners: ((change: OwnerChange) => void | Promise<void>)[] = [];
    private deviceSignInListeners: ((event: DeviceSignInEvent) => void | Promise<void>)[] = [];
    /** The workspace's name as its branding shows it (the composition's). */
    private workspaceName?: () => string;
    private facts?: PeopleFacts;
    private assets?: PeopleAssets;
    private purger?: PersonPurge;
    /** When each account's activity was last written (`recordActivity`). */
    private activitySeen = new Map<string, number>();
    /**
     * Every cookie Better Auth reads or writes goes through here: over https
     * the browser holds `__Host-cb.*` and Better Auth sees `__Secure-cb.*`
     * built from those alone (host-cookies.ts).
     */
    readonly cookies: HostCookies;
    private agentGrants?: ReturnType<AgentAuthorization['grants']>;
    /** Step-up challenges for access policy changes (CB-124). */
    private challenges = new StepUpChallenges();
    /** The organization plugin's options, as the instance was built with them (CB-376). */
    private organizationOptions?: WorkspaceOrganizationOptions;
    private workspaceGroups?: WorkspaceGroups;
    private appDevices?: Devices;
    /** Why `resolve` refused a request from the app (CB-352), for its 401. */
    private refusals = new WeakMap<Request, DeviceRefusalCode>();
    /** The device of each request's session, once `resolve` has found it (CB-352). */
    private requestDevices = new WeakMap<Request, string>();
    private deviceEnds: DeviceEndHooks | undefined;
    private savedInviteLinks: () => boolean | undefined = () => undefined;
    /** Who verifies the app's Google and Apple sign-ins (CB-570), once wired. */
    private socialVerifier?: SocialVerifier;
    private social?: SocialSignIn;
    /** Links made per session per minute (CB-570). */
    private socialLinks = new RateLimits(10, 60_000);

    constructor(
        private settings: BetterAuthSettings,
        private databasePath: string,
        private mailer: Mailer | undefined,
        private hasher: PasswordHasher | undefined,
        /** Connected agents (CB-90): the OAuth provider's options and the grants. */
        private agents: AgentAuthorization,
    ) {
        this.cookies = new HostCookies(settings.secure, COOKIE_PREFIX);
        this.emailSender = mailer
            ? emailSignInLinks(mailer, (userId) => this.accounts().find((entry) => entry.userId === userId))
            : undefined;
        this.navigationPaths = [
            ...settings.providers.map(({ id }) => `/api/auth/callback/${id}`),
            ...(mailer ? ['/api/auth/verify-email'] : []),
            // An agent opens the authorization in the browser, from anywhere.
            `${AUTH_PATH}/oauth2/authorize`,
            // The app's sign-in sheet opens it straight from the app (CB-352).
            `${AUTH_PATH}/device/start`,
        ];
    }

    /** Closed for good (`close`): nothing opens the database again, a sweep under way included. */
    private closed = false;

    private database() {
        if (!this.db && this.closed) {
            throw new Error('The auth database is closed.');
        }
        if (!this.db) {
            this.db = new DatabaseSync(this.databasePath);
            applyConnectionPragmas(this.db);
            this.db.exec('PRAGMA foreign_keys=ON;');
        }
        return this.db;
    }

    /** Groups (CB-376): the workspace organization's rows, in the same database. */
    groups() {
        this.workspaceGroups ??= new WorkspaceGroups(this.database());
        return this.workspaceGroups;
    }

    /** The app's devices (CB-352), in the same database. */
    devices() {
        this.appDevices ??= new Devices(() => this.database());
        return this.appDevices;
    }

    /** The workspace's id (CB-352): random, made once by auth migration 8. */
    workspaceId() {
        return this.devices().workspaceId();
    }

    /**
     * The device a session about to be made belongs to (CB-352): the one its
     * request's install id names, for this person. A password change's new
     * session keeps the one it replaces. None without an install id (the web).
     */
    private sessionDevice(
        ctx: { path?: string; headers?: Headers; context: { session?: { session: unknown } | null } } | null,
        userId: string,
    ): string | undefined {
        if (ctx?.path === '/change-password') {
            const deviceId = (ctx.context.session?.session as { deviceId?: string | null } | undefined)?.deviceId;
            if (deviceId) {
                this.devices().renewed(deviceId, Date.now() + DEVICE_SESSION_SECONDS * 1000);
            }
            return deviceId ?? undefined;
        }
        const installId = readInstallId(ctx?.headers);
        // A deactivated person gets no session (the admin plugin refuses it):
        // their attempt binds nothing.
        if (!installId || this.isBanned(userId)) {
            return undefined;
        }
        return this.devices().attach(installId, userId, deviceFromUserAgent(ctx?.headers?.get('user-agent')));
    }

    /**
     * Set-Cookie headers (as the browser gets them) whose session cookie, for
     * a device's session, lives as long as that session: Better Auth gives
     * every session cookie seven days, and the app reads the expiry from the
     * cookie (CB-352). A cookie without a Max-Age (don't remember me) or one
     * clearing the session is left as it is.
     */
    private deviceCookies(setCookies: string[], now = Date.now()): string[] {
        const name = `${this.cookies.sessionCookie}=`;
        return setCookies.map((header) => {
            const maxAge = /;\s*max-age=(\d+)/i.exec(header);
            if (!header.startsWith(name) || !maxAge || maxAge[1] === '0') {
                return header;
            }
            const token = sessionToken(header.slice(name.length, header.indexOf(';')));
            const row = token
                ? (this.database()
                      .prepare('SELECT deviceId, expiresAt FROM auth_session WHERE token = ?')
                      .get(token) as { deviceId: string | null; expiresAt: unknown } | undefined)
                : undefined;
            if (!row?.deviceId) {
                return header;
            }
            const left = Math.max(1, Math.floor((toMs(row.expiresAt) - now) / 1000));
            return header.replace(/(;\s*max-age=)\d+/i, `$1${left}`);
        });
    }

    /** A response whose device session cookie lives as long as its session (`deviceCookies`). */
    private withDeviceCookies(response: Response): Response {
        const cookies = response.headers.getSetCookie();
        const fixed = this.deviceCookies(cookies);
        if (fixed.every((cookie, index) => cookie === cookies[index])) {
            return response;
        }
        const headers = new Headers(response.headers);
        headers.delete('set-cookie');
        for (const cookie of fixed) {
            headers.append('set-cookie', cookie);
        }
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }

    /**
     * Why `resolve` refused this request from the app (CB-352): its session
     * expired or ended, its device was signed out, or its person was
     * deactivated. Null for a request without an install id, or one that
     * wasn't refused.
     */
    deviceRefusal(request: Request): DeviceRefusalCode | null {
        return this.refusals.get(request) ?? null;
    }

    /** Connected agents' grants, in the same database. */
    private grants() {
        this.agentGrants ??= this.agents.grants(this.database());
        return this.agentGrants;
    }

    /** The Better Auth instance; rebuilt when a provider's discovery failed. */
    auth(): ReturnType<BetterAuthProvider['build']> {
        if (!this.instance) {
            this.instance = this.build();
            this.builtAt = Date.now();
        }
        return this.instance;
    }

    private async build() {
        // Imported here, so mock auth (and every test using it) never loads them.
        const [
            { betterAuth },
            api,
            { genericOAuth },
            { magicLink },
            { passkey },
            adminPlugin,
            { oauthProvider },
            { organization },
            access,
            orgAccess,
            cookieApi,
        ] = await Promise.all([
            import('better-auth'),
            import('better-auth/api'),
            import('better-auth/plugins/generic-oauth'),
            import('better-auth/plugins/magic-link'),
            import('@better-auth/passkey'),
            import('better-auth/plugins/admin'),
            import('@better-auth/oauth-provider'),
            import('better-auth/plugins/organization'),
            import('better-auth/plugins/access'),
            import('better-auth/plugins/organization/access'),
            import('better-auth/cookies'),
        ]);
        const { settings, mailer } = this;
        const groupsOptions = workspaceOrganization(access, orgAccess);
        this.organizationOptions = groupsOptions;
        // The environment's: these options are fixed when the instance is
        // built. What is in force per request (CB-124) is `this.rules()`.
        const envRules = settings.rules;
        const url = new URL(settings.origin);
        return betterAuth({
            appName: 'Socio',
            baseURL: settings.origin,
            basePath: '/api/auth',
            secret: settings.secret,
            trustedOrigins: [settings.origin],
            database: this.database(),
            telemetry: { enabled: false },
            // Messages only: arguments can carry request details.
            logger: {
                level: 'warn',
                log: (level, message) => (level === 'error' ? console.error : console.warn)(`Auth: ${message}`),
            },
            onAPIError: { errorURL: `${settings.origin}/` },
            emailAndPassword: {
                enabled: settings.password,
                disableSignUp: !envRules.openSignUp,
                minPasswordLength: MIN_PASSWORD,
                requireEmailVerification: envRules.openSignUp && !!mailer,
                revokeSessionsOnPasswordReset: true,
                ...(this.hasher ? { password: this.hasher } : {}),
                ...(mailer
                    ? {
                          sendResetPassword: async ({ user, token }) => {
                              await mailer.send({
                                  to: user.email,
                                  subject: 'Reset your Socio password',
                                  text: `Set a new password here (the link works for an hour):\n\n${settings.origin}${PASSWORD_LINK_PATH}?token=${token}\n\nIf you didn't ask for this, ignore this email.`,
                              });
                          },
                      }
                    : {}),
            },
            ...(mailer
                ? {
                      emailVerification: {
                          sendOnSignUp: true,
                          autoSignInAfterVerification: true,
                          sendVerificationEmail: async ({ user, url }) => {
                              await mailer.send({
                                  to: user.email,
                                  subject: 'Confirm your Socio email',
                                  text: `Confirm your email address here:\n\n${url}`,
                              });
                          },
                      },
                  }
                : {}),
            user: {
                modelName: 'auth_user',
                additionalFields: {
                    appUserId: {
                        type: 'string',
                        required: false,
                        input: false,
                        unique: true,
                    },
                    role: { type: 'string', required: false, input: false },
                },
                validateUserInfo: async ({ user, source }, ctx) => {
                    if (source.method === 'admin') {
                        return;
                    }
                    if (source.method === 'oauth' && source.oauth) {
                        const provider = settings.providers.find((entry) => entry.id === source.oauth!.providerId);
                        if (!provider) {
                            return { error: 'unknown_provider' };
                        }
                        const inForce = this.inForce();
                        // Turned off in the access policy (CB-124).
                        if (!inForce.providers.includes(provider.id)) {
                            return {
                                error: METHOD_OFF,
                                errorDescription: OFF_MESSAGES.provider,
                            };
                        }
                        const access = oauthAccess(this.rules(inForce), provider, {
                            email: text(user.email),
                            emailVerified: user.emailVerified === true,
                            groups: claimGroups(source.oauth.profile, provider.groupsClaim),
                        });
                        if (source.action === 'create-user') {
                            if (!access.join) {
                                return {
                                    error: 'not_invited',
                                    errorDescription:
                                        'This account is not invited to this workspace. Ask an admin to add you.',
                                };
                            }
                            // The record about to be stored (createUser validates it as is).
                            if (access.admin) {
                                user.role = 'admin';
                            }
                            return;
                        }
                        // Signing in again: an admin group or email promotes, never
                        // demotes.
                        if (access.admin && typeof user.id === 'string') {
                            const stored = await ctx.context.internalAdapter.findUserById(user.id);
                            if (normalizeRole((stored as { role?: unknown } | null)?.role) !== 'admin') {
                                await ctx.context.internalAdapter.updateUser(user.id, {
                                    role: 'admin',
                                });
                            }
                        }
                        return;
                    }
                    if (source.action === 'create-user' && !this.inForce().openSignUp) {
                        return { error: 'sign_up_closed' };
                    }
                },
            },
            session: {
                modelName: 'auth_session',
                // How the session began (CB-124): a method the access policy turns
                // off ends the sessions it made.
                additionalFields: {
                    signInMethod: { type: 'string', required: false, input: false },
                    // The app's device (CB-352): its sessions last 30 days.
                    deviceId: { type: 'string', required: false, input: false },
                },
                expiresIn: SESSION_SECONDS,
                // Sliding: each day of use extends the session to seven days again.
                updateAge: 24 * 60 * 60,
            },
            account: {
                modelName: 'auth_account',
                encryptOAuthTokens: true,
                accountLinking: { enabled: true, allowDifferentEmails: false },
            },
            verification: { modelName: 'auth_verification' },
            databaseHooks: {
                session: {
                    create: {
                        // Every new session, whatever the way in: a method turned off
                        // in the access policy makes none (CB-124; the routes refuse
                        // its endpoints first, with a message). Nor does a way in
                        // `sessionMethod` doesn't know: with no method recorded, the
                        // policy couldn't end it, so `sessionAllowed` refuses it.
                        before: async (session, ctx) => {
                            // Nobody deactivated gets a session, even by a sign-in
                            // that passed its own check before the ban (CB-352:
                            // deactivation's last device pass relies on it).
                            const person = this.database()
                                .prepare('SELECT banned FROM auth_user WHERE id = ?')
                                .get(session.userId) as { banned: unknown } | undefined;
                            if (person?.banned) {
                                return false;
                            }
                            // A password change's new session carries on the one it
                            // replaces: the person proved nothing new about how they
                            // came in. One with no method makes none either.
                            // A device endpoint chose the method (the approving
                            // session's, CB-352) and the device itself.
                            if (ctx?.path && DEVICE_SIGN_IN_PATHS.has(ctx.path)) {
                                const chosen = session as {
                                    signInMethod?: SignInMethodId | null;
                                    deviceId?: string | null;
                                };
                                const method = chosen.signInMethod ?? null;
                                if (
                                    !chosen.deviceId ||
                                    !sessionAllowed(method, readStoredPolicy(this.database()).saved)
                                ) {
                                    return false;
                                }
                                this.devices().renewed(chosen.deviceId, Date.now() + DEVICE_SESSION_SECONDS * 1000);
                                return {
                                    data: {
                                        ...session,
                                        signInMethod: method,
                                        deviceId: chosen.deviceId,
                                        expiresAt: new Date(Date.now() + DEVICE_SESSION_SECONDS * 1000),
                                    },
                                };
                            }
                            const method =
                                ctx?.path === '/change-password'
                                    ? ((
                                          ctx.context.session?.session as
                                              | { signInMethod?: SignInMethodId | null }
                                              | undefined
                                      )?.signInMethod ?? null)
                                    : ctx?.path === '/magic-link/verify'
                                      ? // An emailed link is `link:email` (CB-352).
                                        this.linkVia((ctx.query as { token?: unknown } | undefined)?.token) === 'email'
                                          ? 'link:email'
                                          : 'link'
                                      : sessionMethod(ctx?.path, ctx?.params, ctx?.body);
                            if (!sessionAllowed(method, readStoredPolicy(this.database()).saved)) {
                                return false;
                            }
                            const deviceId = this.sessionDevice(ctx, String(session.userId));
                            return {
                                data: {
                                    ...session,
                                    signInMethod: method,
                                    ...(deviceId
                                        ? {
                                              deviceId,
                                              expiresAt: new Date(Date.now() + DEVICE_SESSION_SECONDS * 1000),
                                          }
                                        : {}),
                                },
                            };
                        },
                        // The ban check above and the session's insert are two
                        // steps, and a deactivation (in this process or another)
                        // can ban and make its last device pass in between
                        // (CB-379). Once the session is in, it reads the ban
                        // again: deactivation bans before that pass, so a
                        // session it missed sees it and ends here.
                        after: async (session) => {
                            await this.endIfDeactivated(
                                session as { id: string; userId: string; deviceId?: string | null },
                            );
                        },
                    },
                    update: {
                        // Better Auth's own renewal sets seven days; a device's
                        // session renews to 30 (CB-352). It renews in `resolve`
                        // first, so this is for a renewal Better Auth makes itself.
                        before: async (data, ctx) => {
                            const current = ctx?.context.session?.session as { deviceId?: string | null } | undefined;
                            if (!data.expiresAt || !current?.deviceId) {
                                return;
                            }
                            const expiresAt = Date.now() + DEVICE_SESSION_SECONDS * 1000;
                            this.devices().renewed(current.deviceId, expiresAt);
                            return { data: { ...data, expiresAt: new Date(expiresAt) } };
                        },
                    },
                    // Every session Better Auth ends, however (signing out, sign
                    // out everywhere, a revoke, a password change or reset), only
                    // once it has checked the request: `before` notes a device's
                    // last session (no writes: Better Auth may hold a transaction
                    // on this database), and `after`, once the session is gone,
                    // audits that device's sign-out and drops the push
                    // subscriptions of the person's devices left with no live
                    // session (CB-352).
                    delete: {
                        before: async (session, ctx) => {
                            this.noteDeviceSessionEnding(
                                session as { id: string; userId: string; deviceId?: string | null },
                                (ctx?.context.session?.user as { id?: string } | undefined)?.id,
                                ctx?.path,
                            );
                        },
                        after: async (session) => {
                            await this.deviceSessionEnded(
                                session as { id: string; userId: string; deviceId?: string | null },
                            );
                        },
                    },
                },
                user: {
                    // Every account is a member of the workspace organization,
                    // its base role following Socio's (CB-376).
                    update: {
                        after: async (user) => {
                            this.groups().syncBaseRole(String(user.id));
                            this.ownerOnceThereIsAnAdmin();
                        },
                    },
                    create: {
                        after: async (user) => {
                            this.groups().syncBaseRole(String(user.id));
                            this.ownerOnceThereIsAnAdmin();
                        },
                        before: async (user) => {
                            const email = String(user.email).toLowerCase();
                            const explicit = (user as { appUserId?: unknown }).appUserId;
                            // AUTH_LINK_USERS links only verified addresses.
                            // Never a socio's area's, a plugin's or the workspace's owner id (CB-224, CB-451).
                            const linked =
                                typeof explicit === 'string' && !nonPersonOwnerId(explicit)
                                    ? explicit
                                    : user.emailVerified
                                      ? this.availableLink(email)
                                      : undefined;
                            const stored = (user as { role?: unknown }).role;
                            return {
                                data: {
                                    ...user,
                                    appUserId: linked ?? this.newAppUserId(),
                                    role: ROLES.includes(stored as Role)
                                        ? stored
                                        : ((linked && this.appRole(linked)) ?? 'member'),
                                },
                            };
                        },
                    },
                },
            },
            rateLimit: {
                enabled: true,
                storage: 'memory',
                window: 60,
                max: 100,
                customRules: {
                    // Per client address; generous enough for the test scripts.
                    '/sign-in/email': { window: 60, max: 30 },
                    '/sign-in/social': { window: 60, max: 20 },
                    '/sign-up/email': { window: 60, max: 5 },
                    '/passkey/verify-authentication': { window: 60, max: 10 },
                    '/reset-password': { window: 60, max: 10 },
                    '/change-password': { window: 60, max: 5 },
                },
            },
            advanced: {
                // Over https the browser gets these as `__Host-cb.*` (see `cookies`).
                cookiePrefix: COOKIE_PREFIX,
                useSecureCookies: settings.secure,
                // The session cookie is never sent on cross-site requests; the
                // OAuth state cookie stays Lax so the provider's redirect back works.
                cookies: { session_token: { attributes: { sameSite: 'strict' } } },
                ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
                // Better Auth relaxes these under test runners; keep them as in
                // production so the tests check the real behavior.
                disableOriginCheck: false,
                disableCSRFCheck: false,
            },
            plugins: [
                brainPlugin(api),
                deactivation(adminPlugin),
                // The app's sign-in sheet (CB-352): /api/auth/device/{start,approve,redeem}.
                deviceSignIn(api, cookieApi, {
                    origin: settings.origin,
                    linkHostFor: (variant) => (variant === 'development' ? settings.devLinkHost : settings.linkHost),
                    secret: settings.secret,
                    previewLinks: settings.previewLinks,
                    devLinks: settings.devLinks,
                    workspaceName: () => this.workspaceName?.() ?? new URL(settings.origin).host,
                    db: () => this.database(),
                    saved: () => readStoredPolicy(this.database()).saved,
                    isBanned: (accountId) => this.isBanned(accountId),
                    attach: (installId, accountId, facts) => this.devices().attach(installId, accountId, facts),
                    signedIn: (event) => this.deviceSignedIn(event),
                    takeCodeRequest: (headers) =>
                        this.linkRequests.take(`ip:${headers?.get(CLIENT_IP_HEADER) ?? 'unknown'}`),
                    codeTarget: (email) => this.codeTarget(email),
                    channelReaches: (accountId, method, recipient) => this.channelReaches(accountId, method, recipient),
                    social: this.socialSignIn(),
                }),
                // Groups (CB-376): the one workspace organization, its runtime
                // roles. Its endpoints are never served (`routes`); groups
                // change through the admin routes below.
                organization(groupsOptions),
                // One-time sign-in links, for existing accounts only. The public
                // request endpoint is not mounted (see routes): links are asked for
                // through /api/auth/sign-in-link and travel by a SignInLinkSender.
                magicLink({
                    disableSignUp: true,
                    storeToken: 'hashed',
                    expiresIn: SIGN_IN_LINK_SECONDS,
                    sendMagicLink: async ({ token, metadata }) => {
                        const userId = String(metadata?.userId ?? '');
                        const sender = this.allSenders().find((entry) => entry.via === metadata?.via);
                        if (!sender || !userId) {
                            throw new Error('No way to send links.');
                        }
                        // Which channel the link went by: an emailed link signs in as
                        // `link:email`, under the email key (CB-352).
                        this.recordLinkVia(token, sender.via);
                        // A page that asks for a click, so link previews and scanners
                        // that open it don't use the link up.
                        await sender.deliver(userId, {
                            // An emailed link's token has its own prefix, which only
                            // this version strips: a previous one can't redeem it as
                            // a Telegram link (CB-352).
                            url: `${settings.origin}${SIGN_IN_LINK_PATH}?token=${encodeURIComponent(
                                sender.via === 'email' ? sealEmailedToken(token, settings.secret) : token,
                            )}`,
                            expiresAt: new Date(Date.now() + SIGN_IN_LINK_SECONDS * 1000),
                        });
                    },
                }),
                passkey({
                    rpID: url.hostname,
                    rpName: 'Socio',
                    origin: settings.origin,
                    schema: { passkey: { modelName: 'auth_passkey' } },
                }),
                genericOAuth({
                    config: settings.providers.map((provider) => ({
                        providerId: provider.id,
                        name: provider.name,
                        discoveryUrl: provider.discoveryUrl,
                        clientId: provider.clientId,
                        clientSecret: provider.clientSecret,
                        ...(provider.clientSecret ? { authentication: 'basic' as const } : {}),
                        scopes: provider.scopes,
                        pkce: true,
                        requireIdTokenVerification: true,
                        // Signing out here doesn't sign people out of their provider.
                        disableProviderLogout: true,
                        getUserInfo: async (tokens) => this.userInfo(provider, tokens),
                    })),
                }),
                // Connected agents (CB-90): the authorization server for /mcp.
                oauthProvider(
                    this.agents.oauthOptions({
                        origin: settings.origin,
                        pluginScopes: settings.pluginScopes?.scopes,
                    }),
                ),
            ],
        });
    }

    /**
     * The person behind a verified ID token (OpenID Connect only: no ID
     * token, no sign-in). Claims the token lacks (email, the groups claim)
     * come from the userinfo endpoint, for the same subject.
     */
    private async userInfo(provider: OAuthProviderSettings, tokens: { idToken?: string; accessToken?: string }) {
        const claims = tokens.idToken ? claimsOf(tokens.idToken) : null;
        if (!claims || !text(claims.sub)) {
            return null;
        }
        let profile = claims;
        const groupsWanted = provider.adminGroups.length || provider.allowedGroups.length;
        if (tokens.accessToken && (!text(claims.email) || (groupsWanted && !(provider.groupsClaim in claims)))) {
            const endpoint = await this.userinfoEndpoint(provider);
            const response = endpoint
                ? await fetch(endpoint, {
                      headers: { Authorization: `Bearer ${tokens.accessToken}` },
                  }).catch(() => undefined)
                : undefined;
            const info = response?.ok
                ? ((await response.json().catch(() => null)) as Record<string, unknown> | null)
                : null;
            if (info?.sub === claims.sub) {
                profile = { ...info, ...claims };
            }
        }
        const email = text(profile.email);
        return {
            ...profile,
            id: String(claims.sub),
            sub: String(claims.sub),
            email,
            emailVerified: profile.email_verified === true,
            name: text(profile.name) ?? text(profile.preferred_username) ?? email?.split('@')[0] ?? 'New user',
            image: text(profile.picture),
        };
    }

    private userinfoEndpoint(provider: OAuthProviderSettings) {
        let endpoint = this.discovery.get(provider.id);
        if (!endpoint) {
            endpoint = fetch(provider.discoveryUrl)
                .then((response) => (response.ok ? response.json() : null))
                .then((document: { userinfo_endpoint?: unknown } | null) => {
                    const url = text(document?.userinfo_endpoint);
                    return url && acceptableUrl(url) ? url : undefined;
                })
                .catch(() => undefined);
            void endpoint.then((url) => {
                if (!url) {
                    this.discovery.delete(provider.id);
                }
            });
            this.discovery.set(provider.id, endpoint);
        }
        return endpoint;
    }

    /**
     * Discovery runs when the instance starts; a provider that was down then
     * is missing. A sign-in with it rebuilds the instance, at most every 30 s.
     */
    private async ensureProviders() {
        if (!this.settings.providers.length) {
            return;
        }
        const context = await (await this.auth()).$context;
        const ready = new Set(context.socialProviders.map((entry) => entry.id));
        if (this.settings.providers.some((entry) => !ready.has(entry.id)) && Date.now() - this.builtAt > 30_000) {
            this.instance = undefined;
        }
    }

    /** An `AUTH_LINK_USERS` target for this email, unless already linked. */
    private availableLink(email: string) {
        const id = this.settings.rules.links.get(email);
        // Never a non-person owner id (CB-451), whatever the settings hold.
        return id &&
            !nonPersonOwnerId(id) &&
            !this.database().prepare('SELECT 1 FROM auth_user WHERE appUserId=?').get(id)
            ? id
            : undefined;
    }
    /** The role an existing app user has (from mock auth days). */
    private appRole(id: string): Role | undefined {
        const row = this.database().prepare('SELECT role FROM users WHERE id=?').get(id) as
            | { role: unknown }
            | undefined;
        return row ? normalizeRole(row.role) : undefined;
    }
    private newAppUserId() {
        const db = this.database();
        for (;;) {
            const id = `u-${randomBytes(6).toString('hex')}`;
            if (
                !db.prepare('SELECT 1 FROM users WHERE id=?').get(id) &&
                !db.prepare('SELECT 1 FROM auth_user WHERE appUserId=?').get(id)
            ) {
                return id;
            }
        }
    }

    /** What the environment allows for sign-in (CB-124): the ceiling. */
    signInCeiling(): SignInCeiling {
        const { settings } = this;
        return {
            password: settings.password,
            passkey: settings.passkey,
            // The Telegram bot (any channel but email) delivers links.
            signInLink: this.senders.some((sender) => sender.via !== 'email'),
            // CB-352: the email channel is wired where SMTP is set up, so
            // email can carry links and codes once an admin turns them on.
            emailLinks: this.allSenders().some((sender) => sender.via === 'email'),
            openSignUp: settings.rules.openSignUp,
            // CB-570: no setting gates them; they are offered only while the
            // cloud connection verifies them (`workspaceManifest`).
            google: true,
            apple: true,
            providers: settings.providers.map(({ id, name }) => ({ id, name })),
            allowedEmails: [...settings.rules.allowedEmails],
            allowedDomains: [...settings.rules.allowedDomains],
            adminEmails: [...settings.rules.adminEmails],
        };
    }

    /**
     * Sign-in as it is in force (CB-124): the environment's, narrowed by
     * what admins saved. Read on every use, so a change applies at once.
     */
    inForce(): SignInInForce {
        return signInInForce(this.signInCeiling(), readStoredPolicy(this.database()).saved);
    }

    /** The access rules in force: the environment's lists, narrowed. */
    private rules(inForce = this.inForce()): AccessRules {
        return {
            ...this.settings.rules,
            adminEmails: new Set(inForce.adminEmails),
            allowedEmails: new Set(inForce.allowedEmails),
            allowedDomains: new Set(inForce.allowedDomains),
            openSignUp: inForce.openSignUp,
        };
    }

    private appUser(
        user: {
            appUserId?: unknown;
            name: string;
            email: string;
            emailVerified: boolean | number;
            role?: unknown;
        },
        rules = this.rules(),
    ): User | null {
        if (typeof user.appUserId !== 'string') {
            return null;
        }
        return {
            id: user.appUserId,
            name: user.name,
            role: effectiveRole(rules, {
                ...user,
                emailVerified: !!user.emailVerified,
            }),
        };
    }

    /** Who may use the app: deactivated people are not among them. */
    users(): User[] {
        const rows = this.database()
            .prepare(
                'SELECT appUserId, name, email, emailVerified, role FROM auth_user WHERE appUserId IS NOT NULL AND NOT coalesce(banned, 0) ORDER BY createdAt, id',
            )
            .all() as unknown as AuthUserRow[];
        const rules = this.rules();
        return rows.map((row) => this.appUser(row, rules)!);
    }

    /** App user ids of deactivated people (Better Auth's `banned`). */
    deactivatedUsers(): string[] {
        return this.database()
            .prepare('SELECT appUserId FROM auth_user WHERE appUserId IS NOT NULL AND coalesce(banned, 0)')
            .all()
            .map((row) => String(row.appUserId));
    }

    async resolve(request: Request, setHeader?: (name: string, value: string) => void): Promise<User | null> {
        const installId = readInstallId(request.headers);
        const refuse = (code: DeviceRefusalCode) => {
            if (installId) {
                this.refusals.set(request, code);
            }
            return null;
        };
        // The install id's device says why a request without a usable session
        // was refused (CB-352). It never refuses a session that is valid: a
        // session is bound to a device only when it is made, so a session from
        // before (or from the web) that now carries an install id stays as it
        // is, and a device session answers to its own device below.
        const device = installId ? this.devices().byInstallId(installId) : undefined;
        const now = Date.now();
        const noSession = (fallback: DeviceRefusalCode | null) => {
            if (!device) {
                return fallback ? refuse(fallback) : null;
            }
            // A deactivated person's app erases its copy, with or without a cookie.
            if (this.isBanned(device.userId)) {
                return refuse('deactivated');
            }
            if (device.state !== 'active') {
                return refuse(signedOutCode(device.state));
            }
            // The app's jar drops a cookie once it expires: the device says why.
            return refuse(fallback === 'session_expired' ? fallback : this.devices().endedHow(device, now));
        };
        if (!this.cookies.hasSession(request.headers)) {
            return noSession(null);
        }
        // What the session was before Better Auth looks it up (it deletes an
        // expired one), for the app's 401 code.
        const value = this.cookies.sessionValue(request.headers);
        const token = installId && value ? sessionToken(value) : undefined;
        const before = token
            ? (this.database().prepare('SELECT expiresAt FROM auth_session WHERE token = ?').get(token) as
                  | { expiresAt: unknown }
                  | undefined)
            : undefined;
        const auth = await this.auth();
        const { headers, response } = await auth.api.getSession({
            headers: this.cookies.incoming(request.headers),
            returnHeaders: true,
        });
        // A sliding refresh renews the cookie along with the session.
        for (const cookie of this.deviceCookies(this.cookies.outgoing(headers.getSetCookie()))) {
            setHeader?.('Set-Cookie', cookie);
        }
        // A deactivation ends every session; this covers one made meanwhile.
        if (!response || (response.user as { banned?: unknown }).banned) {
            if (response) {
                return refuse('deactivated');
            }
            // Better Auth deleted an expired session on an earlier look: the device remembers.
            return noSession(before && toMs(before.expiresAt) <= now ? 'session_expired' : 'session_ended');
        }
        // A session from a method turned off since (CB-124) is over, even one
        // made while the change was being saved.
        const saved = readStoredPolicy(this.database()).saved;
        const session = response.session as {
            signInMethod?: string | null;
            deviceId?: string | null;
            expiresAt: unknown;
        };
        if (!sessionAllowed(session.signInMethod, saved)) {
            await this.endSession(response.session.token);
            return refuse('session_ended');
        }
        if (session.deviceId) {
            const own = this.devices().byId(session.deviceId);
            if (!own || own.state !== 'active') {
                this.endSignedOutDeviceSession(request.headers);
                return refuse(signedOutCode(own?.state ?? 'revoked'));
            }
            // As Better Auth does, a session signed in without "remember me" isn't renewed.
            if (!this.cookies.hasCookie(request.headers, 'dont_remember')) {
                await this.slideDeviceSession(auth, session.deviceId, value, toMs(session.expiresAt), now, setHeader);
            }
            this.devices().touch(session.deviceId, now);
            this.requestDevices.set(request, session.deviceId);
        }
        this.recordActivity(response.user.id);
        return this.appUser(response.user, this.rules(signInInForce(this.signInCeiling(), saved)));
    }

    /**
     * A device's session renews to 30 days at most once a day (CB-352).
     * Better Auth's own renewal counts from its seven days, so it would first
     * renew a 30-day session on its 24th day, to seven days: this renews it
     * first, with its cookie.
     */
    private async slideDeviceSession(
        auth: Awaited<ReturnType<BetterAuthProvider['build']>>,
        deviceId: string,
        value: string | undefined,
        expiresAt: number,
        now: number,
        setHeader?: (name: string, value: string) => void,
    ) {
        const token = value ? sessionToken(value) : undefined;
        if (!token || expiresAt - DEVICE_SESSION_SECONDS * 1000 + DEVICE_SLIDE_SECONDS * 1000 > now) {
            return;
        }
        const context = await auth.$context;
        const updated = await context.internalAdapter.updateSession(token, {
            expiresAt: new Date(now + DEVICE_SESSION_SECONDS * 1000),
            updatedAt: new Date(now),
        });
        if (updated) {
            this.devices().renewed(deviceId, now + DEVICE_SESSION_SECONDS * 1000);
            setHeader?.('Set-Cookie', this.cookies.sessionSetCookie(value!, DEVICE_SESSION_SECONDS));
        }
    }

    /**
     * Ends the request's session when its device was signed out (CB-352): a
     * session Better Auth inserted for a device after it was taken over or
     * signed out (a racing sign-in) must not reach any endpoint. Signing out
     * a device ends its sessions as well; this covers the rest.
     */
    private endSignedOutDeviceSession(headers: Headers) {
        const value = this.cookies.sessionValue(headers);
        const token = value ? sessionToken(value) : undefined;
        if (!token) {
            return;
        }
        this.database()
            .prepare(
                `DELETE FROM auth_session WHERE token = ? AND deviceId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM auth_device d WHERE d.id = auth_session.deviceId AND d.state = 'active')`,
            )
            .run(token);
    }

    /**
     * A session made for a person deactivated meanwhile (CB-379): its device
     * erases (audited, as the deactivation's) and the session goes, without
     * Better Auth's sign-out hooks. A failed audit leaves the device as it
     * is: the session still goes, and the app's next request is refused as
     * `deactivated` all the same.
     */
    private async endIfDeactivated(session: { id: string; userId: string; deviceId?: string | null }) {
        if (!session?.userId || !this.isBanned(session.userId)) {
            return;
        }
        try {
            if (session.deviceId) {
                await this.endDevices(session.userId, 'system', 'revoked_and_erase', 'signed_in_while_deactivated', {
                    only: [session.deviceId],
                });
            }
        } catch (error) {
            reportFailure('Ending a deactivated person’s new device failed', [safeFailure(error)]);
        } finally {
            this.database().prepare('DELETE FROM auth_session WHERE id = ?').run(session.id);
        }
    }

    private isBanned(accountId: string) {
        const row = this.database().prepare('SELECT banned FROM auth_user WHERE id = ?').get(accountId) as
            | { banned: number | null }
            | undefined;
        return !!row?.banned;
    }

    /**
     * Notes that this account made a signed-in request (CB-360's "last
     * active"), at most once every few minutes per account and process.
     */
    private recordActivity(accountId: string, now = Date.now()) {
        if ((this.activitySeen.get(accountId) ?? 0) + ACTIVITY_MS > now) {
            return;
        }
        this.activitySeen.set(accountId, now);
        try {
            this.database()
                .prepare(
                    `INSERT INTO auth_activity(accountId, firstAt, lastAt) VALUES (?, ?, ?)
           ON CONFLICT(accountId) DO UPDATE SET lastAt = max(lastAt, excluded.lastAt)`,
                )
                .run(accountId, now, now);
        } catch (error) {
            // Never in the way of the request.
            reportFailure('Recording account activity failed', [safeFailure(error)]);
        }
    }

    /**
     * Ends the request's session (`headers`, already through
     * `cookies.incoming`) when the access policy refuses it (no
     * method recorded, or one turned off since), before Better Auth's own
     * endpoints read it: they check no policy. This also catches a session
     * with no method that the previous release made during a start-first
     * upgrade, after auth migration 7 ran (a password change under way).
     */
    private async endRefusedSession(request: Headers, headers: Headers) {
        // The browser's cookie names: `headers` has them as Better Auth reads them.
        if (!this.cookies.hasSession(request)) {
            return;
        }
        const found = await (await this.auth()).api.getSession({ headers, query: { disableRefresh: true } });
        if (
            found &&
            !sessionAllowed(
                (found.session as { signInMethod?: string | null }).signInMethod,
                readStoredPolicy(this.database()).saved,
            )
        ) {
            await this.endSession(found.session.token);
        }
    }

    /** Deletes one session, by its token. */
    private async endSession(token: string) {
        await (await (await this.auth()).$context).internalAdapter.deleteSession(token);
    }

    /** The request's session and its sign-in account (CB-124 step-up). */
    async sessionOf(request: Request): Promise<StepUpSession | null> {
        if (!this.cookies.hasSession(request.headers)) {
            return null;
        }
        const found = await (await this.auth()).api.getSession({ headers: this.cookies.incoming(request.headers) });
        if (!found || (found.user as { banned?: unknown }).banned) {
            return null;
        }
        return { sessionId: found.session.id, accountId: found.user.id };
    }

    /**
     * Which of these app users a Telegram sign-in link can reach now (the
     * policy's `signInLink`); email reaches everyone, counted by `emailLinks`.
     */
    async linkReachable(userIds: string[]) {
        const reachable = new Set<string>();
        for (const id of userIds) {
            for (const sender of this.senders) {
                if (sender.via !== 'email' && (await sender.canDeliver(id))) {
                    reachable.add(id);
                    break;
                }
            }
        }
        return reachable;
    }

    /**
     * Step-up re-authentication for access policy changes (CB-124): a
     * password or a passkey (with user verification) the operator has set
     * up, while that method is in force. Each challenge works once, for its
     * session and its change; five failed proofs in 15 minutes lock it.
     */
    readonly stepUp: StepUpVerifier = {
        begin: async (request, user, digest) => {
            const session = await this.sessionOf(request);
            const account = session ? this.accounts().find((entry) => entry.id === session.accountId) : undefined;
            if (!session || !account || account.userId !== user.id) {
                return null;
            }
            if (this.challenges.locked(session.accountId)) {
                return {
                    ...this.challenges.create({ session, userId: user.id, digest }),
                    methods: [],
                    reason: STEP_UP_LOCKED,
                };
            }
            const inForce = this.inForce();
            const methods: ('password' | 'passkey')[] = [];
            if (inForce.password && account.password) {
                methods.push('password');
            }
            let passkey: Record<string, unknown> | undefined;
            if (inForce.passkey && account.passkeys > 0) {
                const { generateAuthenticationOptions } = await import('@simplewebauthn/server');
                const options = await generateAuthenticationOptions({
                    rpID: new URL(this.settings.origin).hostname,
                    userVerification: 'required',
                    timeout: STEP_UP_SECONDS * 1000,
                    allowCredentials: this.passkeysOf(account.id).map((row) => ({
                        id: row.credentialID,
                        transports: row.transports?.split(',') as never,
                    })),
                });
                passkey = options as unknown as Record<string, unknown>;
                methods.push('passkey');
            }
            const created = this.challenges.create({
                session,
                userId: user.id,
                digest,
                ...(passkey ? { passkeyChallenge: String(passkey.challenge) } : {}),
            });
            return {
                ...created,
                methods,
                ...(passkey ? { passkey } : {}),
                ...(methods.length
                    ? {}
                    : {
                          reason: 'Confirming a change needs a password or a passkey that is on here. Add one under Settings → Profile.',
                      }),
            };
        },
        finish: async (request, user, digest, proof) => {
            const session = await this.sessionOf(request);
            if (!session) {
                return {
                    ok: false,
                    status: 401,
                    error: 'Sign in to continue.',
                    counted: false,
                    locked: false,
                };
            }
            const challenge = this.challenges.take(proof.id, {
                session,
                userId: user.id,
                digest,
            });
            if (!challenge || !('password' in proof || 'passkey' in proof)) {
                return expiredStepUp();
            }
            // Counted before the check, so proofs sent at once can't outrun it.
            const attempt = this.challenges.attempt(session.accountId);
            if (attempt === 'locked') {
                return {
                    ok: false,
                    status: 429,
                    error: STEP_UP_LOCKED,
                    counted: false,
                    locked: false,
                };
            }
            const inForce = this.inForce();
            let method: 'password' | 'passkey';
            let ok: boolean;
            if ('password' in proof) {
                method = 'password';
                ok = inForce.password && (await this.passwordMatches(session.accountId, proof.password));
            } else {
                method = 'passkey';
                ok =
                    inForce.passkey &&
                    !!challenge.passkeyChallenge &&
                    (await this.passkeyMatches(session.accountId, proof.passkey, challenge.passkeyChallenge));
            }
            if (ok) {
                this.challenges.passed(session.accountId);
                return { ok: true, method, session };
            }
            const locked = attempt === 'last';
            return {
                ok: false,
                status: locked ? 429 : 403,
                error: locked
                    ? STEP_UP_LOCKED
                    : method === 'password'
                      ? 'That password is not right.'
                      : 'The passkey did not confirm it.',
                counted: true,
                locked,
            };
        },
    };

    private passkeysOf(accountId: string) {
        return this.database()
            .prepare('SELECT id, credentialID, publicKey, counter, transports FROM auth_passkey WHERE userId = ?')
            .all(accountId) as unknown as {
            id: string;
            credentialID: string;
            publicKey: string;
            counter: number;
            transports: string | null;
        }[];
    }

    /** The account's own password, checked as sign-in checks it. */
    private async passwordMatches(accountId: string, password: string) {
        const context = await (await this.auth()).$context;
        const accounts = await context.internalAdapter.findAccounts(accountId);
        const hash = accounts.find((entry) => entry.providerId === 'credential' && entry.password)?.password;
        if (!hash) {
            return false;
        }
        return context.password.verify({ hash, password }).catch(() => false);
    }

    /**
     * One of the account's own passkeys signed this challenge, for this
     * origin, with the person verified (PIN, fingerprint, face).
     */
    private async passkeyMatches(accountId: string, response: Record<string, unknown>, expectedChallenge: string) {
        const row = this.passkeysOf(accountId).find((entry) => entry.credentialID === response.id);
        if (!row) {
            return false;
        }
        const { verifyAuthenticationResponse } = await import('@simplewebauthn/server');
        try {
            const { verified, authenticationInfo } = await verifyAuthenticationResponse({
                response: response as never,
                expectedChallenge,
                expectedOrigin: this.settings.origin,
                expectedRPID: new URL(this.settings.origin).hostname,
                credential: {
                    id: row.credentialID,
                    publicKey: new Uint8Array(Buffer.from(row.publicKey, 'base64')),
                    counter: Number(row.counter),
                    transports: row.transports?.split(',') as never,
                },
                requireUserVerification: true,
            });
            if (!verified) {
                return false;
            }
            this.database()
                .prepare('UPDATE auth_passkey SET counter = ? WHERE id = ?')
                .run(authenticationInfo.newCounter, row.id);
            return true;
        } catch {
            return false;
        }
    }

    signInMethods(): SignInMethods {
        const { settings, mailer } = this;
        const inForce = this.inForce();
        return {
            passkey: inForce.passkey,
            password: inForce.password,
            signUp: inForce.password && inForce.openSignUp,
            emailReset: inForce.password && !!mailer,
            // Links by Telegram, or by email while email links are on (CB-352).
            signInLink: inForce.signInLink || (inForce.emailLinks && !!this.emailSender),
            providers: settings.providers
                .filter(({ id }) => inForce.providers.includes(id))
                .map(({ id, name }) => ({ id, name })),
        };
    }

    /** The manifest's sign-in part (CB-352): what the app can offer on this workspace now. */
    async workspaceManifest() {
        const { settings } = this;
        const social = await this.socialSignIn().offered();
        const inForce = this.inForce();
        const running = (sender: SignInLinkSender) => sender.available?.() ?? true;
        const email =
            inForce.emailLinks && this.allSenders().some((sender) => sender.via === 'email' && running(sender));
        const telegram = inForce.signInLink && this.senders.some((sender) => sender.via !== 'email' && running(sender));
        return {
            id: this.workspaceId(),
            origin: settings.origin,
            methods: {
                password: inForce.password,
                passkey: inForce.passkey,
                // The sheet signs in through the web, whatever the web's way in.
                sheet: true,
                signInCodes: email ? ('email' as const) : telegram ? ('telegram' as const) : null,
                addDevice: appLinkVariant(settings.origin, settings) !== null,
                // CB-570: verified by the cloud now, and on in the access policy.
                social,
            },
        };
    }

    useSocialVerifier(verifier: SocialVerifier) {
        this.socialVerifier = verifier;
    }

    /** Native Google and Apple sign-in (CB-570): the nonces and links, in the auth database. */
    socialSignIn() {
        this.social ??= new SocialSignIn({
            db: () => this.database(),
            saved: () => readStoredPolicy(this.database()).saved,
            verifier: () => this.socialVerifier,
            log: (line) => console.log(line),
        });
        return this.social;
    }

    useSavedInviteLinks(read: () => boolean | undefined) {
        this.savedInviteLinks = read;
    }

    /**
     * The build invites and "Send me a link for the app" are for (CB-352):
     * none unless an admin (or the environment) turned them on. Preview
     * with `AUTH_APP_PREVIEW_LINKS`, else production, which needs https at the
     * default port (a production link never carries a port); else none, and
     * an invite is the web's own link as before.
     */
    private inviteVariant() {
        if (!(this.savedInviteLinks() ?? this.settings.appInviteLinks)) {
            return null;
        }
        // The link page forwards to https only, and takes only hosts it can
        // show: any other workspace keeps the web's own link.
        const origin = new URL(this.settings.origin);
        if (origin.protocol !== 'https:' || !isLinkHost(origin.host)) {
            return null;
        }
        return appLinkVariant(this.settings.origin, { previewLinks: this.settings.previewLinks, devLinks: false });
    }

    /** A link domain link for this workspace, of this kind, for the invite build. */
    private workspaceAppLink<K extends 'i' | 'w'>(variant: AppVariant, kind: K, fields: AppLinkFields[K]) {
        return appLink({ kind, variant, host: new URL(this.settings.origin).host, fields }, this.settings.linkHost);
    }

    useDeviceEnds(hooks: DeviceEndHooks) {
        this.deviceEnds = hooks;
    }

    /**
     * One person's device endings and push endpoint changes, one at a time
     * (CB-352), in this process and across processes (CB-379, account-turns.ts).
     */
    private deviceTurns?: AccountTurns;
    private inTurn<T>(accountId: string, work: () => Promise<T>): Promise<T> {
        this.deviceTurns ??= new AccountTurns(() => this.database());
        return this.deviceTurns.run(accountId, work);
    }

    /**
     * Ends a person's devices (CB-352): audited first, with why
     * (CB-379), then their state and sessions in one transaction, then their
     * push subscriptions. `only` picks some; `except` keeps one (the device
     * asking). Signed out (`signed_out`) leaves the device free to sign in again.
     */
    private endDevices(
        accountId: string,
        actor: string,
        how: DeviceEnding['how'],
        reason: DeviceEndReason,
        options: Parameters<BetterAuthProvider['endDevicesNow']>[4] = {},
    ) {
        return this.inTurn(accountId, () => this.endDevicesNow(accountId, actor, how, reason, options));
    }

    private async endDevicesNow(
        accountId: string,
        actor: string,
        how: DeviceEnding['how'],
        reason: DeviceEndReason,
        { only, except }: { only?: readonly string[]; except?: string } = {},
    ) {
        const account = this.accounts().find((entry) => entry.id === accountId);
        // Only what this changes: signing out ends live devices, a revoke an
        // active one, an erase any not already erasing (never downgraded).
        const changes = (device: DeviceRow) =>
            how === 'revoked_and_erase' ? device.state !== 'revoked_and_erase' : device.state === 'active';
        const ids = this.devices()
            .listFor(accountId)
            .filter((device) => (only ? only.includes(device.id) : true) && device.id !== except)
            .filter(changes);
        let ended: DeviceRow[] = [];
        if (ids.length) {
            await this.deviceEnds?.audit({
                actor,
                userId: account?.userId || accountId,
                how,
                reason,
                devices: ids.map(({ id, label }) => ({ id, label })),
            });
            ended = this.devices().end(
                accountId,
                ids.map((device) => device.id),
                how === 'signed_out' ? null : how,
            );
        }
        await this.dropLeftoverPush(accountId, ended);
        return ended;
    }

    /**
     * Device sessions Better Auth is ending, by device: the sessions still to
     * go in this ending, who asked, and why (CB-379).
     */
    private readonly endingDevices = new Map<
        string,
        { label: string; by: string | undefined; reason: DeviceEndReason; pending: Set<string> }
    >();
    /** Who asked to end a session that is ended outside a request (an admin's revoke of one session), and why. */
    private readonly sessionEndBy = new Map<string, { by: string; reason: DeviceEndReason }>();

    /**
     * A session Better Auth is about to end, having checked the request: an
     * active device's is noted, with every other of its sessions this same
     * ending takes, for `deviceSessionEnded`. Reads only.
     */
    private noteDeviceSessionEnding(
        session: { id: string; userId: string; deviceId?: string | null },
        by: string | undefined,
        path: string | undefined,
    ) {
        const device = session.deviceId ? this.devices().byId(session.deviceId) : undefined;
        if (device?.state !== 'active') {
            return;
        }
        const outside = this.sessionEndBy.get(session.id);
        const noted = this.endingDevices.get(device.id) ?? {
            label: device.label,
            by: by ?? outside?.by,
            reason: (path ? DEVICE_END_PATHS[path] : undefined) ?? outside?.reason ?? 'session_ended',
            pending: new Set<string>(),
        };
        noted.pending.add(session.id);
        this.endingDevices.set(device.id, noted);
    }

    /**
     * A session Better Auth ended. Once the last of a device's sessions this
     * ending takes is gone, and the device has no live session left, that is
     * its sign-out: audited once (by whoever asked, else the device's own
     * person). Then the person's devices with no live session lose their push
     * subscriptions. The session is gone whatever the audit does, so a failed
     * one is reported and the cleanup still runs.
     */
    private async deviceSessionEnded(session: { id: string; userId: string; deviceId?: string | null }) {
        this.sessionEndBy.delete(session.id);
        const deviceId = session.deviceId ?? undefined;
        const noted = deviceId ? this.endingDevices.get(deviceId) : undefined;
        noted?.pending.delete(session.id);
        const signOut = deviceId && noted && !noted.pending.size ? noted : undefined;
        if (deviceId && signOut) {
            this.endingDevices.delete(deviceId);
        }
        await this.inTurn(session.userId, async () => {
            if (deviceId && signOut && !this.devices().sessionMethod(deviceId)) {
                const userId = (id: string | undefined) => this.accounts().find((entry) => entry.id === id)?.userId;
                const person = userId(session.userId) || session.userId;
                try {
                    await this.deviceEnds?.audit({
                        actor: userId(signOut.by) || signOut.by || person,
                        userId: person,
                        how: 'signed_out',
                        reason: signOut.reason,
                        devices: [{ id: deviceId, label: signOut.label }],
                    });
                } catch (error) {
                    reportFailure('Device sign-out audit failed', [safeFailure(error)]);
                }
            }
            await this.dropLeftoverPush(session.userId);
        });
    }

    /**
     * Push subscriptions to drop (in the person's turn): the devices just
     * ended, and any of theirs signed out or with no live session left,
     * however its sessions went (a password change or reset, the access
     * policy, a cleanup that failed before: an endpoint is kept until its
     * subscription is gone).
     */
    /**
     * Makes this endpoint the device's push subscription, in the person's
     * turn: the one it replaces is kept to clean up and tried at once. A
     * device signed out (or signing out) takes none, and the subscription is
     * cleaned up instead, unless a live device of theirs holds it.
     */
    private bindPush(accountId: string, deviceId: string, endpoint: string) {
        return this.inTurn(accountId, () => this.bindPushNow(accountId, deviceId, endpoint));
    }

    /** `bindPush` inside a turn already taken. */
    private async bindPushNow(accountId: string, deviceId: string, endpoint: string) {
        const device = this.devices().byId(deviceId);
        if (device?.userId !== accountId || device.state !== 'active' || !this.devices().sessionMethod(deviceId)) {
            const held = this.devices()
                .listFor(accountId)
                .some((other) => other.id !== deviceId && other.state === 'active' && other.pushEndpoint === endpoint);
            if (!held) {
                this.devices().leaveForCleanup(accountId, endpoint);
                await this.dropLeftoverPush(accountId);
            }
            return false;
        }
        this.devices().setPush(deviceId, endpoint);
        await this.dropLeftoverPush(accountId);
        return true;
    }

    private async dropLeftoverPush(accountId: string, ended: readonly DeviceRow[] = []) {
        // With nothing wired to remove a subscription (a CLI with no
        // notifications), every endpoint stays recorded for one that has.
        if (!this.deviceEnds) {
            return;
        }
        const userId = this.accounts().find((entry) => entry.id === accountId)?.userId;
        const pending = new Map(ended.map((device) => [device.id, device]));
        for (const device of this.devices().listFor(accountId)) {
            if (device.pushEndpoint && (device.state !== 'active' || !this.devices().sessionMethod(device.id))) {
                pending.set(device.id, device);
            }
        }
        for (const device of pending.values()) {
            if (!device.pushEndpoint || !userId) {
                continue;
            }
            try {
                await this.deviceEnds?.dropPush(userId, device.pushEndpoint);
                this.devices().clearPush(device.id, device.pushEndpoint);
            } catch (error) {
                reportFailure('Push subscription cleanup failed', [safeFailure(error)]);
            }
        }
        // Endpoints no device holds any more (replaced, or refused while
        // signing out), never one a live device of theirs took back.
        const live = new Set(
            this.devices()
                .listFor(accountId)
                .filter((device) => device.state === 'active' && device.pushEndpoint)
                .map((device) => device.pushEndpoint),
        );
        for (const endpoint of this.devices().leftovers(accountId)) {
            if (live.has(endpoint)) {
                this.devices().cleaned(accountId, endpoint);
                continue;
            }
            if (!userId) {
                continue;
            }
            try {
                await this.deviceEnds?.dropPush(userId, endpoint);
                this.devices().cleaned(accountId, endpoint);
            } catch (error) {
                reportFailure('Push subscription cleanup failed', [safeFailure(error)]);
            }
        }
    }

    /**
     * Drops the push subscriptions of every device left with no live session:
     * after an access policy change ends sessions, and hourly (CB-379) for
     * sessions that simply ran out, which nothing else notices.
     */
    async sweepDevicePush() {
        for (const accountId of this.devices().withPush()) {
            // A close stops the sweep between people, and in a turn not yet started.
            if (this.closed) {
                return;
            }
            await this.inTurn(accountId, async () => {
                if (this.closed) {
                    return;
                }
                try {
                    await this.dropLeftoverPush(accountId);
                } catch (error) {
                    // Closed under it: what is left is the next sweep's, after a restart.
                    if (!this.closed) {
                        throw error;
                    }
                }
            });
        }
    }

    private pushSweep?: ReturnType<typeof setInterval>;
    /** Runs `sweepDevicePush` every `everyMs`, one run at a time, until `close`. */
    startPushSweep(everyMs = DEVICE_PUSH_SWEEP_MS) {
        if (this.pushSweep) {
            return;
        }
        let running = false;
        this.pushSweep = setInterval(() => {
            if (running) {
                return;
            }
            running = true;
            this.sweepDevicePush()
                .catch((error: unknown) => reportFailure('Device push sweep failed', [safeFailure(error)]))
                .finally(() => {
                    running = false;
                });
        }, everyMs);
        this.pushSweep.unref();
    }

    /** One of the person's devices as the Devices list shows it. */
    private deviceSummary(device: DeviceRow, current: string | undefined): DeviceSummary {
        return {
            id: device.id,
            label: device.label,
            platform: device.platform,
            variant: device.variant,
            state: device.state,
            signInMethod: device.state === 'active' ? this.devices().sessionMethod(device.id) : null,
            createdAt: new Date(device.createdAt).toISOString(),
            lastSeenAt: device.lastSeenAt === null ? null : new Date(device.lastSeenAt).toISOString(),
            current: device.id === current,
        };
    }

    useSignInLinks(senders: SignInLinkSender[]) {
        this.senders = senders;
    }

    /** Every sign-in channel: email first (CB-352), then the others. */
    private allSenders(): SignInLinkSender[] {
        return [...(this.emailSender ? [this.emailSender] : []), ...this.senders];
    }

    /**
     * The first channel that can reach this app user now, if any, among those
     * the policy has on: email while `emailLinks`, the others while `signInLink`.
     */
    private async senderFor(userId: string) {
        const inForce = this.inForce();
        for (const sender of this.allSenders()) {
            const on = sender.via === 'email' ? inForce.emailLinks : inForce.signInLink;
            if (on && (await sender.canDeliver(userId))) {
                return sender;
            }
        }
        return undefined;
    }

    /**
     * Better Auth's own sign-out endpoints, before they run (CB-352):
     * every session (sign out everywhere), the others, or one by its token.
     */
    /** Notes which channel a sign-in link's token went by, for its verify (CB-352). */
    private recordLinkVia(token: string, via: SignInLinkSender['via']) {
        const now = Date.now();
        const db = this.database();
        db.prepare('DELETE FROM auth_link_via WHERE expiresAt < ?').run(now);
        db.prepare('INSERT OR REPLACE INTO auth_link_via(tokenHash, via, expiresAt) VALUES (?, ?, ?)').run(
            linkTokenHash(token),
            via,
            now + SIGN_IN_LINK_SECONDS * 1000,
        );
    }

    /** The channel a sign-in link's token went by; links sent before CB-352 went by Telegram. */
    private linkVia(token: unknown): SignInLinkSender['via'] {
        if (typeof token !== 'string' || !token) {
            return 'telegram';
        }
        const row = this.database()
            .prepare('SELECT via FROM auth_link_via WHERE tokenHash = ?')
            .get(linkTokenHash(token)) as { via: SignInLinkSender['via'] } | undefined;
        return row?.via ?? 'telegram';
    }

    /**
     * Sends the account a one-time sign-in link through the first channel
     * that can reach it. Null when none can, or when the account has had its
     * share of links in this window.
     */
    async sendSignInLink(account: Account): Promise<SentSignInLink | null> {
        const sender = await this.senderFor(account.userId);
        if (account.deactivated || !sender || !this.linksSent.take(account.id)) {
            return null;
        }
        await (
            await this.auth()
        ).api.signInMagicLink({
            body: {
                email: account.email,
                callbackURL: '/',
                errorCallbackURL: '/',
                metadata: { userId: account.userId, via: sender.via },
            },
            headers: new Headers(),
        });
        return {
            via: sender.via,
            expiresAt: new Date(Date.now() + SIGN_IN_LINK_SECONDS * 1000).toISOString(),
        };
    }

    async logout(request: Request) {
        const { headers } = await (
            await this.auth()
        ).api.signOut({
            headers: this.cookies.incoming(request.headers),
            returnHeaders: true,
        });
        return this.cookies.outgoing(headers.getSetCookie());
    }

    /** The client address for rate limiting, from the socket or the proxy. */
    private clientIp(c: Context<AppEnv>) {
        // CB-309: X-Forwarded-For counts only from the reverse proxy, never
        // from a socio's computer, which could otherwise pick a fresh address
        // per attempt.
        return clientAddress(c, this.settings.trustProxy, this.settings.network);
    }

    routes(app: Hono<AppEnv>) {
        // Connected agents (CB-90): an MCP client finds the authorization
        // server from /mcp's Protected Resource Metadata (RFC 9728), then the
        // server's own metadata (RFC 8414), at the issuer's path or the root.
        const { origin } = this.settings;
        for (const path of [`${PROTECTED_RESOURCE_PATH}${MCP_PATH}`, PROTECTED_RESOURCE_PATH]) {
            app.get(path, (c) =>
                c.json(protectedResourceMetadata(origin, this.settings.pluginScopes?.scopes), 200, METADATA_HEADERS),
            );
        }
        for (const path of [`${AUTHORIZATION_SERVER_PATH}${AUTH_PATH}`, AUTHORIZATION_SERVER_PATH]) {
            app.get(path, async (c) => {
                const { oauthProviderAuthServerMetadata } = await import('@better-auth/oauth-provider');
                return oauthProviderAuthServerMetadata(await this.auth(), {
                    headers: METADATA_HEADERS,
                })(c.req.raw);
            });
        }
        // "Send me a sign-in link". The answer, and how long it takes, are the
        // same whether or not the account exists or can receive links.
        app.post('/api/auth/sign-in-link', async (c) => {
            if (!this.linkRequests.take(`ip:${this.clientIp(c) ?? 'unknown'}`)) {
                return c.json({ error: 'Too many requests. Try again in a few minutes.' }, 429);
            }
            const parsed = z
                .object({ email })
                .strict()
                .safeParse(await c.req.json().catch(() => null));
            if (!parsed.success) {
                return c.json({ error: 'Enter a valid email address.' }, 400);
            }
            void this.requestSignInLink(parsed.data.email).catch((error) =>
                reportFailure('Sign-in link failed', [safeFailure(error)]),
            );
            return c.json({ ok: true, message: SIGN_IN_LINK_SENT });
        });
        app.on(['GET', 'POST'], '/api/auth/*', async (c, next) => {
            const path = c.req.path.slice('/api/auth'.length);
            // The Devices list is an ordinary route behind the session check.
            if (
                path === '/devices' ||
                path === '/device/send-link' ||
                path === '/device/app-link' ||
                // CB-570: linking Google and Apple, behind the session check.
                path === '/social/link' ||
                path === '/social/links'
            ) {
                return next();
            }
            // Signing sessions out through Better Auth ends their devices too
            // (their push subscriptions, audited), before it deletes the sessions.
            // Better Auth's own endpoints read the session without `resolve`:
            // a signed-out device's session ends before they see it (CB-352).
            this.endSignedOutDeviceSession(c.req.raw.headers);
            if (!this.settings.passkey && path.startsWith('/passkey/')) {
                return c.json({ error: 'Passkeys are turned off.' }, 404);
            }
            // Links are asked for through /api/auth/sign-in-link only; the admin
            // plugin's endpoints are not built (see `deactivation`).
            if (
                path === '/sign-in/magic-link' ||
                path.startsWith('/admin/') ||
                // Groups (CB-376) change only through the admin routes.
                /^\/+organization(\/|$)/i.test(path) ||
                (path.startsWith('/oauth2/') && !OAUTH_ENDPOINTS.includes(path))
            ) {
                return c.json({ error: 'Not found.' }, 404);
            }
            // CB-570: Google and Apple links are unlinked through /api/auth/social/link
            // only, which keeps a way in.
            if (path === '/unlink-account') {
                const body = (await c.req.raw
                    .clone()
                    .json()
                    .catch(() => null)) as { providerId?: unknown } | null;
                if (Object.values(NATIVE_PROVIDER_IDS).includes(String(body?.providerId))) {
                    return c.json({ error: 'Not found.' }, 404);
                }
            }
            const off = await this.methodOff(c, path);
            if (off) {
                return off;
            }
            // An emailed link reaches Better Auth without its prefix; one whose
            // prefix was taken off (to pass as a Telegram link) reaches it as
            // no link at all.
            let forward = c.req.raw;
            if (path === '/magic-link/verify') {
                const link = linkToken(c.req.query('token'), this.settings.secret);
                const url = new URL(c.req.url);
                url.searchParams.set(
                    'token',
                    link.emailed === (this.linkVia(link.token) === 'email') ? link.token : 'refused',
                );
                forward = new Request(url, c.req.raw);
            }
            if (path === '/sign-in/social' || path.startsWith('/callback/')) {
                await this.ensureProviders();
            }
            const headers = this.cookies.incoming(new Headers(c.req.raw.headers));
            if (this.tokenPaths.includes(c.req.path)) {
                headers.delete('cookie');
            } else {
                // A session the policy refuses reaches no endpoint here either.
                await this.endRefusedSession(c.req.raw.headers, headers);
            }
            headers.delete(CLIENT_IP_HEADER);
            const ip = this.clientIp(c);
            if (ip) {
                headers.set(CLIENT_IP_HEADER, ip);
            }
            const response = this.withDeviceCookies(
                this.cookies.response(await (await this.auth()).handler(new Request(forward, { headers }))),
            );
            // Errors in the app's shape ({ error, code }), as the client expects;
            // OAuth's own (RFC 6749 section 5.2) for agents.
            if (
                response.ok ||
                path.startsWith('/oauth2/') ||
                !response.headers.get('content-type')?.includes('application/json')
            ) {
                return response;
            }
            const body = (await response
                .clone()
                .json()
                .catch(() => null)) as { message?: string; code?: string } | null;
            if (!body?.message) {
                return response;
            }
            // A deactivated person following a link (a sign-in link's Continue,
            // an email confirmation): the sign-in screen says why, as it does
            // for OAuth, instead of a JSON page.
            if (c.req.method === 'GET' && body.code === 'BANNED_USER') {
                const to = new URL('/', this.settings.origin);
                to.searchParams.set('error', body.code);
                return new Response(null, {
                    status: 302,
                    headers: { location: to.href, 'cache-control': 'no-store' },
                });
            }
            const reply = new Headers(response.headers);
            reply.delete('content-length');
            // Better Auth's own address limits carry no code: the app's device
            // endpoints answer theirs in the device contract (CB-352).
            const code = body.code ?? (response.status === 429 && path.startsWith('/device/') ? 'too_many' : undefined);
            return new Response(JSON.stringify({ error: body.message, code }), {
                status: response.status,
                headers: reply,
            });
        });
    }

    /**
     * The answer for a sign-in endpoint whose method the access policy
     * turned off (CB-124), if this is one: JSON for the app's own calls, a
     * redirect to the sign-in screen for a provider's or a link's GET.
     */
    private async methodOff(c: Context<AppEnv>, path: string) {
        // Only what the policy narrowed: what the environment leaves off,
        // Better Auth refuses as it always did.
        const ceiling = this.signInCeiling();
        const narrowed = this.inForce();
        const inForce = {
            ...narrowed,
            password: narrowed.password || !ceiling.password,
            openSignUp: narrowed.openSignUp || !ceiling.openSignUp,
            passkey: narrowed.passkey || !ceiling.passkey,
            signInLink: narrowed.signInLink || !ceiling.signInLink,
        };
        const configured = new Set(ceiling.providers.map(({ id }) => id));
        const refuse = (message: string) => {
            if (c.req.method === 'GET') {
                const to = new URL('/', this.settings.origin);
                to.searchParams.set('error', METHOD_OFF);
                return new Response(null, {
                    status: 302,
                    headers: { location: to.href, 'cache-control': 'no-store' },
                });
            }
            return c.json({ error: message, code: METHOD_OFF }, 403);
        };
        if ((path === '/sign-in/email' || path === '/sign-up/email') && !inForce.password) {
            return refuse(OFF_MESSAGES.password);
        }
        if (path === '/sign-up/email' && !inForce.openSignUp) {
            return refuse(OFF_MESSAGES.signUp);
        }
        if (
            (path === '/passkey/generate-authenticate-options' || path === '/passkey/verify-authentication') &&
            !inForce.passkey
        ) {
            return refuse(OFF_MESSAGES.passkey);
        }
        if (path === '/magic-link/verify') {
            const byEmail = this.linkVia(linkToken(c.req.query('token'), this.settings.secret).token) === 'email';
            if (byEmail ? !inForce.emailLinks : !inForce.signInLink) {
                return refuse(OFF_MESSAGES.link);
            }
        }
        let provider: string | undefined;
        if (path.startsWith('/callback/') || path.startsWith('/oauth2/callback/')) {
            provider = path.split('/').pop();
        } else if (path === '/sign-in/social' || path === '/link-social') {
            const body = (await c.req.raw
                .clone()
                .json()
                .catch(() => null)) as { provider?: unknown } | null;
            if (typeof body?.provider === 'string') {
                provider = body.provider;
            }
        }
        if (provider !== undefined && configured.has(provider) && !inForce.providers.includes(provider)) {
            return refuse(OFF_MESSAGES.provider);
        }
        return undefined;
    }

    /**
     * Where a sign-in code for this email goes (CB-352), if anywhere now:
     * by email while email links are on, else to the linked Telegram while
     * Telegram links are on. Never to a deactivated account, and within the
     * account's 3 per 15 minutes (shared with the web's links).
     */
    private async codeTarget(email: string): Promise<CodeTarget | null> {
        const account = this.accounts().find((entry) => entry.email === email);
        if (!account || account.deactivated) {
            return null;
        }
        const inForce = this.inForce();
        const viaEmail = inForce.emailLinks;
        if (!viaEmail && !inForce.signInLink) {
            return null;
        }
        let sender: SignInLinkSender | undefined;
        for (const entry of this.allSenders()) {
            if ((entry.via === 'email') === viaEmail && (await entry.canDeliver(account.userId))) {
                sender = entry;
                break;
            }
        }
        if (!sender || !this.linksSent.take(account.id)) {
            return null;
        }
        const to = await sender.recipient(account.userId);
        if (!to) {
            return null;
        }
        const chosen = sender;
        return {
            accountId: account.id,
            method: viaEmail ? 'link:email' : 'link',
            recipient: recipientHash(chosen.via, to),
            deliver: (link) => chosen.deliver(account.userId, link),
        };
    }

    /** Whether a sender of that kind (email, or another) still reaches this account. */
    private async channelReaches(accountId: string, method: CodeTarget['method'], recipient: string) {
        const row = this.database().prepare('SELECT appUserId FROM auth_user WHERE id = ?').get(accountId) as
            | { appUserId: string | null }
            | undefined;
        if (!row?.appUserId) {
            return false;
        }
        for (const sender of this.allSenders()) {
            if ((sender.via === 'email') !== (method === 'link:email') || !(await sender.canDeliver(row.appUserId))) {
                continue;
            }
            const to = await sender.recipient(row.appUserId);
            if (to && recipientHash(sender.via, to) === recipient) {
                return true;
            }
        }
        return false;
    }

    /** A link for the account with this email, if it can receive one now. */
    private async requestSignInLink(address: string) {
        const account = this.accounts().find((entry) => entry.email === address);
        if (account) {
            await this.sendSignInLink(account);
        }
    }

    /**
     * The authorization request behind the consent screen (CB-90), from the
     * plugin's signed query: which agent, from which domain, asking for
     * what. Throws when the query is not one this server signed, or the
     * agent asked for another resource than this workspace's MCP endpoint.
     */
    private async agentConsentRequest(query: string, user: User) {
        const { verifyOAuthQueryParams } = await import('@better-auth/oauth-provider');
        const expired = new AgentGrantError(
            'This approval has expired or is not valid. Connect again from your agent.',
        );
        if (!(await verifyOAuthQueryParams(query, this.settings.secret).catch(() => false))) {
            throw expired;
        }
        const params = new URLSearchParams(query);
        const clientId = params.get('client_id') ?? '';
        const redirectUri = params.get('redirect_uri') ?? '';
        const resource = mcpResource(this.settings.origin);
        const resources = params.getAll('resource');
        if (resources.length !== 1 || resources[0] !== resource) {
            throw new AgentGrantError(
                `The agent must ask for this workspace's MCP endpoint, ${resource}. Connect it to that address.`,
            );
        }
        const client = this.database()
            .prepare(`SELECT name, icon, uri FROM "${AGENT_CLIENTS_TABLE}" WHERE "clientId"=?`)
            .get(clientId) as { name: string | null; icon: string | null; uri: string | null } | undefined;
        if (!client) {
            throw expired;
        }
        const host = clientHost(clientId);
        const localApp = isLocalRedirect(redirectUri);
        const grants = this.grants();
        const view: AgentConsentView = {
            clientId,
            clientName: client.name || host,
            logoUri: client.icon,
            clientUri: client.uri,
            metadataHost: host,
            clientDomain: localApp ? null : host,
            localApp,
            redirectUri,
            scopes: (params.get('scope') ?? '')
                .split(' ')
                .filter(
                    (scope) => OAUTH_SCOPES.includes(scope) || !!this.settings.pluginScopes?.scopes.includes(scope),
                ),

            personName: user.name,
            refusal: grants.clientAllowed(clientId)
                ? null
                : `This workspace's admins allow agents from ${(grants.allowedDomains() ?? []).join(', ') || 'no domains'} only, and ${host} is not one of them.`,
        };
        // Plain words for the per-plugin scopes asked for (CB-254).
        const labels = Object.fromEntries(
            view.scopes.flatMap((scope) => {
                const label = this.settings.pluginScopes?.labels[scope];
                return label ? [[scope, label]] : [];
            }),
        );
        if (Object.keys(labels).length) {
            view.scopeLabels = labels;
        }
        return { view, resource };
    }

    /** The plugin's consent, as the person: the redirect it answers with. */
    private async oauthConsent(c: Context<AppEnv>, query: string, accept: boolean) {
        const headers = this.cookies.incoming(new Headers(c.req.raw.headers));
        for (const name of [CLIENT_IP_HEADER, 'content-length', 'content-encoding']) {
            headers.delete(name);
        }
        const ip = this.clientIp(c);
        if (ip) {
            headers.set(CLIENT_IP_HEADER, ip);
        }
        headers.set('origin', this.settings.origin);
        headers.set('content-type', 'application/json');
        headers.set('accept', 'application/json');
        const response = await (
            await this.auth()
        ).handler(
            new Request(`${this.settings.origin}${AUTH_PATH}/oauth2/consent`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ accept, oauth_query: query }),
            }),
        );
        const body = (await response.json().catch(() => null)) as {
            url?: unknown;
        } | null;
        return response.ok && typeof body?.url === 'string' ? body.url : undefined;
    }

    /** Admin account management, after the sign-in check. */
    protectedRoutes(app: Hono<AppEnv>) {
        // CB-352: the person's own devices; ordinary routes behind the
        // session check.
        const accountOf = (c: Context<AppEnv>) => this.accounts().find((entry) => entry.userId === c.get('user').id);
        app.get('/api/auth/devices', (c) => {
            const account = accountOf(c);
            const current = this.requestDevices.get(c.req.raw);
            return c.json({
                devices: account
                    ? this.devices()
                          .listFor(account.id)
                          .map((device) => this.deviceSummary(device, current))
                    : [],
            });
        });
        app.delete('/api/auth/devices/:id', async (c) => {
            const account = accountOf(c);
            const device = account && this.devices().byId(c.req.param('id'));
            if (!account || device?.userId !== account.id) {
                return c.json({ error: 'Device not found.' }, 404);
            }
            // Again is fine: already signed out (or erasing), nothing changes.
            const how = c.req.query('erase') === '1' ? 'revoked_and_erase' : 'revoked';
            await this.endDevices(account.id, c.get('user').id, how, 'devices_list', { only: [device.id] });
            return c.json({ ok: true });
        });
        // CB-383: a person leaves the workspace on their own (shared
        // leave-workspace.ts). Only their own session, never a service key,
        // data token or plugin service acting for them.
        const ownSession = (c: Context<AppEnv>) =>
            !c.get('serviceKey') && !c.get('dataToken') && !c.get('pluginService');
        app.get(LEAVE_WORKSPACE_PATH, (c) => {
            const account = ownSession(c) ? accountOf(c) : undefined;
            if (!account) {
                return c.json({ error: 'Only a person signed in to their own account can leave.' }, 403);
            }
            const code = this.leaveRefusal(account);
            return c.json(
                leaveWorkspaceCheckSchema.parse({
                    allowed: !code,
                    refusal: code ? { code, message: LEAVE_REFUSAL_MESSAGES[code] } : null,
                }),
            );
        });
        app.post(LEAVE_WORKSPACE_PATH, async (c) => {
            const account = ownSession(c) ? accountOf(c) : undefined;
            if (!account) {
                return c.json({ error: 'Only a person signed in to their own account can leave.' }, 403);
            }
            if (!leaveWorkspaceRequestSchema.safeParse(await c.req.json().catch(() => null)).success) {
                return c.json({ error: 'Confirm that you want to leave: send { "confirm": "leave" }.' }, 400);
            }
            const by = c.get('user').id;
            return this.oneMembershipChange(async () => {
                // Read again inside the turn: a role or another leave may have changed meanwhile.
                const current = this.accounts().find((entry) => entry.id === account.id);
                const code = current ? this.leaveRefusal(current) : 'already_left';
                if (code || !current) {
                    return c.json({ error: LEAVE_REFUSAL_MESSAGES[code ?? 'already_left'], code }, 409);
                }
                await this.deactivate(current.id, by, { left: true });
                console.log(`Accounts: user=${by} left the workspace.`);
                return c.json({ ok: true });
            });
        });
        // "Send me a link for the app": the workspace's link-domain link,
        // by the person's own channel; it fills in the workspace and signs
        // nobody in. As limited as sign-in links.
        // "Get the app": the same workspace link, to show as a QR code
        // to a colleague. It carries no code and signs nobody in.
        // CB-570: the person's own Google and Apple links. Only their own
        // signed-in session: the link's nonce is bound to it.
        const ownSocial = async (c: Context<AppEnv>) => {
            if (!ownSession(c)) {
                return undefined;
            }
            const account = accountOf(c);
            const session = await this.sessionOf(c.req.raw);
            return account && session?.accountId === account.id ? { account, session } : undefined;
        };
        const answer = (c: Context<AppEnv>, refusal: ReturnType<typeof socialRefusal>) =>
            c.json(refusal.body, refusal.status);
        app.post('/api/auth/social/link', async (c) => {
            const own = await ownSocial(c);
            if (!own) {
                return answer(c, socialRefusal('not_authorized'));
            }
            if (!this.socialLinks.take(own.session.sessionId)) {
                return answer(c, socialRefusal('too_many'));
            }
            const linked = await this.socialSignIn().link(await c.req.json().catch(() => null), own.session);
            if (!linked.ok) {
                return answer(c, linked);
            }
            if (linked.changed) {
                console.log(`Auth: user=${own.account.userId} linked ${linked.link.provider} sign-in.`);
            }
            return c.json(linked.link);
        });
        app.get('/api/auth/social/links', async (c) => {
            const own = await ownSocial(c);
            if (!own) {
                return answer(c, socialRefusal('not_authorized'));
            }
            return c.json(this.socialSignIn().links(own.account.id));
        });
        app.delete('/api/auth/social/link/:provider', async (c) => {
            const own = await ownSocial(c);
            if (!own) {
                return answer(c, socialRefusal('not_authorized'));
            }
            const provider = socialProviderSchema.safeParse(c.req.param('provider'));
            if (!provider.success) {
                return answer(c, socialRefusal('not_linked'));
            }
            const providerId = NATIVE_PROVIDER_IDS[provider.data];
            // Read before the unit of work: whether a sign-in link can reach them.
            const reachable = await this.linkReachable([own.account.userId]);
            const unlinked = await this.socialSignIn().unlink(own.account.id, provider.data, () => {
                const now = this.accounts().find((entry) => entry.id === own.account.id);
                return (
                    !!now &&
                    hasWayIn(
                        {
                            ...now,
                            appUserId: now.userId,
                            providers: now.providers.filter((id) => id !== providerId),
                            linkReachable: reachable.has(now.userId),
                        },
                        this.inForce(),
                    )
                );
            });
            if (!unlinked.ok) {
                return answer(c, unlinked);
            }
            console.log(`Auth: user=${own.account.userId} unlinked ${provider.data} sign-in.`);
            return c.json({ ok: true });
        });
        app.get('/api/auth/device/app-link', (c) => {
            const variant = this.inviteVariant();
            // None is an answer, not an error: most workspaces send no app links.
            return c.json({ url: variant ? this.workspaceAppLink(variant, 'w', {}) : null });
        });
        app.post('/api/auth/device/send-link', async (c) => {
            const account = accountOf(c);
            const variant = this.inviteVariant();
            if (!account || !variant) {
                return c.json({ error: 'This workspace doesn’t send links for the Socio app.' }, 409);
            }
            const sender = await this.senderFor(account.userId);
            if (!sender) {
                return c.json({ error: 'There is no way to send you a link: no email or Telegram reaches you.' }, 409);
            }
            if (!this.linksSent.take(account.id)) {
                return c.json({ error: 'Several links went to you in the last 15 minutes. Try again later.' }, 429);
            }
            try {
                await sender.deliver(account.userId, { kind: 'app', url: this.workspaceAppLink(variant, 'w', {}) });
            } catch (error) {
                reportFailure('App link failed', [safeFailure(error)]);
                return c.json({ error: 'The link could not be sent. Try again later.' }, 502);
            }
            return c.json({ via: sender.via });
        });
        app.put('/api/auth/device/push', async (c) => {
            const parsed = devicePushBodySchema.safeParse(await c.req.json().catch(() => null));
            if (!parsed.success) {
                return c.json({ error: 'Send the push subscription’s https endpoint.' }, 400);
            }
            const deviceId = this.requestDevices.get(c.req.raw);
            if (!deviceId) {
                return c.json({ error: 'Only the Socio app’s own session can say this.' }, 403);
            }
            const account = accountOf(c);
            if (!account) {
                return c.json({ error: 'Sign in to continue.', code: 'sign_in' }, 401);
            }
            return (await this.bindPush(account.id, deviceId, parsed.data.endpoint))
                ? c.json({ ok: true })
                : c.json({ error: 'This device is signed out.', code: 'session_ended' }, 401);
        });
        // A push subscription the app makes is its device's as it is made:
        // no sign-out in between leaves one nobody would clean up.
        app.post('/api/notifications/push/subscriptions', async (c, next) => {
            const deviceId = this.requestDevices.get(c.req.raw);
            const body = deviceId
                ? ((await c.req.raw
                      .clone()
                      .json()
                      .catch(() => null)) as { endpoint?: unknown } | null)
                : null;
            const account = accountOf(c);
            if (!deviceId || !account) {
                return next();
            }
            // Stored and bound in the person's turn, so no cleanup of
            // theirs runs in between.
            await this.inTurn(account.id, async () => {
                await next();
                const endpoint = devicePushBodySchema.safeParse({ endpoint: body?.endpoint });
                if (c.res.status === 201 && endpoint.success) {
                    await this.bindPushNow(account.id, deviceId, endpoint.data.endpoint);
                }
            });
        });
        // Connected agents (CB-90): the consent screen's request and answer.
        // Approving records the grant, then lets the plugin issue the code
        // for it; denying sends the agent `access_denied`.
        const consentQuery = z.string().min(1).max(8000);
        const refused = (c: Context<AppEnv>, error: unknown) => {
            if (error instanceof AgentGrantError) {
                return c.json({ error: error.message }, error.status);
            }
            throw error;
        };
        app.get('/api/agent-consent', async (c) => {
            const query = consentQuery.safeParse(c.req.query('query'));
            if (!query.success) {
                return c.json({ error: 'Connect again from your agent.' }, 400);
            }
            try {
                const { view } = await this.agentConsentRequest(query.data, c.get('user'));
                return c.json(view);
            } catch (error) {
                return refused(c, error);
            }
        });
        app.post('/api/agent-consent', async (c) => {
            const parsed = z
                .object({
                    query: consentQuery,
                    accept: z.boolean(),
                    label: z.string().trim().max(80).optional(),
                })
                .strict()
                .safeParse(await c.req.json().catch(() => null));
            if (!parsed.success) {
                return c.json({ error: 'Approve or deny the agent.' }, 400);
            }
            const { query, accept, label } = parsed.data;
            const user = c.get('user');
            try {
                const { view, resource } = await this.agentConsentRequest(query, user);
                if (!accept) {
                    const url = await this.oauthConsent(c, query, false);
                    return url ? c.json({ url }) : c.json({ error: 'Connect again from your agent.' }, 400);
                }
                if (view.refusal) {
                    return c.json({ error: view.refusal }, 403);
                }
                if (!view.scopes.some((scope) => isGrantableScope(scope))) {
                    return c.json({ error: 'The agent asked for nothing it could use here.' }, 400);
                }
                const session = await (
                    await this.auth()
                ).api.getSession({ headers: this.cookies.incoming(c.req.raw.headers) });
                if (!session) {
                    return c.json({ error: 'Sign in to continue.' }, 401);
                }
                const grants = this.grants();
                const grant = grants.create({
                    userId: user.id,
                    authUserId: session.user.id,
                    clientId: view.clientId,
                    clientName: view.clientName,
                    clientDomain: view.clientDomain,
                    label: label || view.clientName,
                    scopes: view.scopes,
                    resource,
                    redirectUri: view.redirectUri,
                });
                const url = await withConsentGrant(grant.grantId, () => this.oauthConsent(c, query, true)).catch(
                    () => undefined,
                );
                if (!url || !new URL(url).searchParams.has('code')) {
                    grants.discard(grant.grantId);
                    return c.json(
                        {
                            error: 'The agent could not be connected. Connect again from your agent.',
                        },
                        400,
                    );
                }
                return c.json({ url });
            } catch (error) {
                return refused(c, error);
            }
        });

        const bad = (c: Context<AppEnv>, error: unknown) =>
            c.json(
                {
                    error: error instanceof Error ? error.message : 'Could not change this.',
                },
                400,
            );
        const OWNER_ONLY = {
            error: 'This is the workspace owner’s account: only the owner can change it. The owner can make another admin the owner first.',
        };
        const DEACTIVATED = {
            error: 'This person is deactivated. Reactivate them first.',
        };
        // The account a route names (CB-390: admins manage every account).
        // `change`: the route acts on the account, so the workspace owner's is
        // refused to everyone but the owner: no other admin demotes,
        // deactivates or removes the owner, ends their sessions or devices,
        // moves what they own or makes them a password link. Looking stays open
        // to every admin.
        const target = (c: Context<AppEnv>, change = false) => {
            const account = this.accounts().find((a) => a.id === c.req.param('id'));
            if (!account) {
                return { response: c.json({ error: 'Account not found.' }, 404) };
            }
            if (change && this.isOwner(account) && account.userId !== c.get('user').id) {
                return { response: c.json(OWNER_ONLY, 403) };
            }
            return { account };
        };
        app.get('/api/accounts', requireAdmin, async (c) =>
            c.json({
                accounts: await this.listedAccounts(),
                unlinked: this.unlinkedUsers(),
            }),
        );
        // CB-360: each person with their status, last use, sign-in methods,
        // invite and what they can reach (counts), for admins' People view.
        app.get('/api/accounts/roster', requireAdmin, async (c) => c.json({ people: await this.roster() }));
        // What deactivating this person would end, revoke or hand over; changes nothing.
        app.get('/api/accounts/:id/deactivation-impact', requireAdmin, async (c) => {
            const { account, response } = target(c);
            if (!account) {
                return response;
            }
            return c.json(await this.deactivationImpact(account));
        });
        // CB-360's person page: the roster's fields, devices, sign-in and
        // what they can reach, listed. No token, hash or secret.
        app.get('/api/accounts/:id', requireAdmin, async (c) => {
            const { account, response } = target(c);
            if (!account) {
                return response;
            }
            return c.json(await this.personDetail(account));
        });
        // Their audit trail, newest first: `before` is a page's `next` (or
        // epoch milliseconds), `limit` 1 to 200 (50).
        app.get('/api/accounts/:id/audit', requireAdmin, async (c) => {
            const { account, response } = target(c);
            if (!account) {
                return response;
            }
            const before = c.req.query('before') || undefined;
            const cursor = before === undefined ? undefined : parseTrailBefore(before);
            const limitText = c.req.query('limit') || '50';
            const limit = /^\d{1,3}$/.test(limitText) ? Number(limitText) : 0;
            if ((before !== undefined && !cursor) || limit < 1 || limit > 200) {
                return c.json({ error: 'Page with `before` from the last page and a limit from 1 to 200.' }, 400);
            }
            const trail: PersonTrail =
                account.userId && this.facts
                    ? await this.facts.trail(account.userId, cursor, limit)
                    : { lines: [], next: null };
            return c.json(trail);
        });
        // CB-360: what this person owns, by kind; empty without an app user.
        app.get('/api/accounts/:id/assets', requireAdmin, (c) => {
            const { account, response } = target(c);
            if (!account) {
                return response;
            }
            const assets: PersonAssets = {
                accountId: account.id,
                name: account.name,
                kinds: account.userId && this.assets ? this.assets.assets(account.userId) : [],
            };
            return c.json(assets);
        });
        // CB-360: hands everything this person owns, or the chosen kinds, to
        // another active person; the company owns its people's work.
        app.post('/api/accounts/:id/transfer', requireAdmin, async (c) => {
            const parsed = z
                .object({
                    to: z.string().min(1).max(200),
                    kinds: z.array(z.enum(ASSET_KINDS)).max(ASSET_KINDS.length).optional(),
                })
                .strict()
                .safeParse(await c.req.json().catch(() => null));
            if (!parsed.success) {
                return c.json({ error: `Name the new owner (to), and any of: ${ASSET_KINDS.join(', ')}.` }, 400);
            }
            const { account, response } = target(c, true);
            if (!account) {
                return response;
            }
            if (!this.assets) {
                return c.json({ error: 'Transfers aren’t available on this server.' }, 501);
            }
            const recipient = this.accounts().find((a) => a.id === parsed.data.to);
            const refusal = this.transferRefusal(account, recipient);
            if (refusal || !recipient) {
                return c.json({ error: refusal ?? 'Account not found.' }, 400);
            }
            try {
                const kinds = await this.assets.transfer(
                    { from: account.userId, to: recipient.userId, fromName: account.name, toName: recipient.name },
                    parsed.data.kinds ?? [],
                    c.get('user').id,
                );
                const result: AssetTransfer = {
                    from: { accountId: account.id, name: account.name },
                    to: { accountId: recipient.id, name: recipient.name },
                    kinds,
                };
                return c.json(result);
            } catch (error) {
                // The data space's refusals (a file it can't open, one that
                // changed meanwhile, storage down) carry their status.
                const status = (error as { status?: unknown }).status;
                if (status === 400 || status === 409 || status === 503) {
                    return c.json({ error: (error as Error).message }, status);
                }
                throw error;
            }
        });
        // CB-360: admins remove a person for good (CB-390), in person: the
        // purge's dry run first, then, with their name typed and a step-up,
        // the same backup, checks and audit as `pnpm run purge --apply`.
        const inPerson = (c: Context<AppEnv>) =>
            c.get('serviceKey') || c.get('dataToken')
                ? c.json({ error: 'People are removed in person, not with a key.' }, 403)
                : undefined;
        app.post('/api/accounts/:id/purge/step-up', requireAdmin, async (c) => {
            const { account, response } = target(c, true);
            if (!account) {
                return response;
            }
            const refused = inPerson(c);
            if (refused) {
                return refused;
            }
            const challenge = await this.stepUp.begin(c.req.raw, c.get('user'), purgeDigest(account));
            if (!challenge) {
                return c.json({ error: 'Confirming a removal needs your own signed-in session.' }, 401);
            }
            return c.json(challenge);
        });
        app.post('/api/accounts/:id/purge', requireAdmin, async (c) => {
            const parsed = z
                .object({
                    apply: z.boolean(),
                    confirmName: z.string().max(200).optional(),
                    stepUp: stepUpProofSchema.optional(),
                })
                .strict()
                .safeParse(await c.req.json().catch(() => null));
            if (!parsed.success) {
                return c.json({ error: 'Say whether to apply it; to apply, type their name and confirm.' }, 400);
            }
            const { account, response } = target(c, true);
            if (!account) {
                return response;
            }
            const refused = inPerson(c);
            if (refused) {
                return refused;
            }
            if (!this.purger) {
                return c.json({ error: 'Permanent removal isn’t available on this server.' }, 501);
            }
            if (!account.userId) {
                return c.json({ error: 'This account has no app user to remove.' }, 400);
            }
            const user = c.get('user');
            const own = this.purgeRefusal(account, user);
            if (!parsed.data.apply) {
                const plan = await this.purger.plan(account.userId);
                const result: PersonPurgePlan = {
                    accountId: account.id,
                    name: account.name,
                    ...plan,
                    refusals: [...(own ? [own] : []), ...plan.refusals],
                };
                return c.json(result);
            }
            if (own) {
                return c.json({ error: own }, 409);
            }
            if (parsed.data.confirmName !== account.name) {
                return c.json({ error: 'Type their name exactly as shown to confirm.' }, 400);
            }
            if (!parsed.data.stepUp) {
                return c.json({ error: 'Confirm it’s you first (step-up).' }, 401);
            }
            const proof = await this.stepUp.finish(c.req.raw, user, purgeDigest(account), parsed.data.stepUp);
            if (!proof.ok) {
                return c.json({ error: proof.error }, proof.status);
            }
            // Read again: the account may have changed while they confirmed.
            const now = this.accounts().find((a) => a.id === account.id);
            const changed =
                !now || now.userId !== account.userId || now.name !== account.name
                    ? 'This account changed while you confirmed: check it again.'
                    : this.purgeRefusal(now, user);
            if (changed) {
                return c.json({ error: changed }, 409);
            }
            try {
                const done = await this.purger.apply(account.userId, user.id, { name: account.name });
                const result: PersonPurgeResult = { accountId: account.id, name: account.name, ...done };
                return c.json(result);
            } catch (error) {
                return c.json({ error: error instanceof Error ? error.message : 'The purge failed.' }, 409);
            }
        });
        app.post('/api/accounts', requireAdmin, async (c) => {
            const parsed = accountInput.safeParse(await c.req.json().catch(() => null));
            if (!parsed.success) {
                return c.json({ error: 'Enter a name, a valid email and a role.' }, 400);
            }
            try {
                const id = await this.createAccount(parsed.data);
                const link = parsed.data.password ? undefined : await this.passwordLink(id);
                return c.json(
                    {
                        account: await this.listed(this.accounts().find((a) => a.id === id)),
                        link,
                    },
                    201,
                );
            } catch (error) {
                return bad(c, error);
            }
        });
        app.patch('/api/accounts/:id', requireAdmin, async (c) => {
            const parsed = z
                .object({ role })
                .strict()
                .safeParse(await c.req.json().catch(() => null));
            if (!parsed.success) {
                return c.json({ error: 'Unknown role.' }, 400);
            }
            const { account, response } = target(c, true);
            if (!account) {
                return response;
            }
            const next = parsed.data.role;
            if (next === 'member' && account.adminByRule) {
                return c.json(
                    {
                        error: 'This account is an admin by AUTH_ADMIN_EMAILS; an admin can take it off that list under Settings → Access.',
                    },
                    400,
                );
            }
            // One at a time with leaving and deactivating (CB-383).
            const changed = await this.oneMembershipChange(async () => {
                const current = this.accounts().find((entry) => entry.id === account.id) ?? account;
                if (next === 'member' && this.isOwner(current)) {
                    return OWNER_STAYS_ADMIN;
                }
                if (next === 'member' && this.lastAdmin(current)) {
                    return 'Keep at least one admin.';
                }
                const context = await (await this.auth()).$context;
                await context.internalAdapter.updateUser(account.id, { role: next });
                return undefined;
            });
            if (changed) {
                return c.json({ error: changed }, 400);
            }
            if (isAdmin(account) && !isAdmin({ role: next }) && account.userId) {
                await this.notifyAdminRevoked(account.userId);
            }
            return c.json(await this.listed(this.accounts().find((a) => a.id === account.id)));
        });
        this.groupRoutes(app);
        app.post('/api/accounts/:id/password-link', requireAdmin, async (c) => {
            const { account, response } = target(c, true);
            if (!account) {
                return response;
            }
            if (account.deactivated) {
                return c.json(DEACTIVATED, 409);
            }
            return c.json(await this.passwordLink(account.id));
        });
        // A one-time sign-in link, sent to the person (their linked Telegram);
        // the admin never sees it.
        app.post('/api/accounts/:id/sign-in-link', requireAdmin, async (c) => {
            const { account, response } = target(c);
            if (!account) {
                return response;
            }
            if (account.deactivated) {
                return c.json(DEACTIVATED, 409);
            }
            const inForce = this.inForce();
            if (!inForce.signInLink && !(inForce.emailLinks && this.emailSender)) {
                return c.json(
                    {
                        error: 'Sign-in links are turned off (Settings → Access). Make a password link instead.',
                    },
                    409,
                );
            }
            const sender = await this.senderFor(account.userId);
            if (!sender) {
                return c.json(
                    {
                        error: 'This person has no linked Telegram, or the bot is not running. Make a password link instead.',
                    },
                    409,
                );
            }
            const sent = await this.sendSignInLink(account).catch((error) => {
                reportFailure('Sign-in link failed', [safeFailure(error)]);
                return undefined;
            });
            if (sent === undefined) {
                return c.json(
                    {
                        error:
                            sender.via === 'email'
                                ? 'The mail server did not take the message.'
                                : 'Telegram did not take the message.',
                    },
                    502,
                );
            }
            if (!sent) {
                return c.json(
                    {
                        error: 'Several links went to this person in the last 15 minutes. Try again later.',
                    },
                    429,
                );
            }
            return c.json(sent);
        });
        app.delete('/api/accounts/:id/sessions', requireAdmin, async (c) => {
            const { account, response } = target(c, true);
            if (!account) {
                return response;
            }
            await this.endDevices(account.id, c.get('user').id, 'signed_out', 'admin_sessions');
            const context = await (await this.auth()).$context;
            await context.internalAdapter.deleteUserSessions(account.id);
            return c.json({ ok: true });
        });
        // CB-352: a person's devices, for admins beside their sessions.
        app.get('/api/accounts/:id/devices', requireAdmin, (c) => {
            const { account, response } = target(c);
            if (!account) {
                return response;
            }
            return c.json({
                devices: this.devices()
                    .listFor(account.id)
                    .map((device) => this.deviceSummary(device, undefined)),
            });
        });
        app.delete('/api/accounts/:id/devices/:deviceId', requireAdmin, async (c) => {
            const { account, response } = target(c, true);
            if (!account) {
                return response;
            }
            const device = this.devices().byId(c.req.param('deviceId'));
            if (device?.userId !== account.id) {
                return c.json({ error: 'Device not found.' }, 404);
            }
            const how = c.req.query('erase') === '1' ? 'revoked_and_erase' : 'revoked';
            await this.endDevices(account.id, c.get('user').id, how, 'admin_devices', { only: [device.id] });
            return c.json({ ok: true });
        });
        // Signs out one device (CB-360), audited; its token never leaves here.
        app.delete('/api/accounts/:id/sessions/:sessionId', requireAdmin, async (c) => {
            const { account, response } = target(c, true);
            if (!account) {
                return response;
            }
            const session = this.database()
                .prepare('SELECT token, userAgent, deviceId FROM auth_session WHERE id=? AND userId=?')
                .get(c.req.param('sessionId'), account.id) as
                | { token: string; userAgent: string | null; deviceId: string | null }
                | undefined;
            if (!session) {
                return c.json({ error: 'Session not found.' }, 404);
            }
            // Only this session: its device signs out (audited as the
            // admin's) if it was the device's last one.
            const sessionId = c.req.param('sessionId');
            this.sessionEndBy.set(sessionId, { by: c.get('user').id, reason: 'admin_session' });
            const context = await (await this.auth()).$context;
            try {
                await context.internalAdapter.deleteSession(session.token);
            } finally {
                this.sessionEndBy.delete(sessionId);
            }
            this.facts?.audit({
                actor: c.get('user').id,
                userId: account.userId || account.id,
                action: 'revoke',
                detail: `a session of ${account.name}${session.userAgent ? ` (${session.userAgent.slice(0, 120)})` : ''}`,
            });
            return c.json({ ok: true });
        });
        // Deactivates: no sign-in, sessions end; the person's content stays
        // theirs. DELETE is the old "Remove".
        const deactivate = async (c: Context<AppEnv>) => {
            const { account, response } = target(c, true);
            if (!account) {
                return response;
            }
            // One at a time with people leaving (CB-383), so two can't each
            // see the other as the admin who stays.
            return this.oneMembershipChange(async () => {
                const current = this.accounts().find((entry) => entry.id === account.id) ?? account;
                const refusal = this.deactivationRefusal(current);
                if (refusal) {
                    return c.json({ error: refusal }, 400);
                }
                return c.json(await this.listed(await this.deactivate(account.id, c.get('user').id)));
            });
        };
        app.post('/api/accounts/:id/deactivate', requireAdmin, deactivate);
        app.delete('/api/accounts/:id', requireAdmin, deactivate);
        app.post('/api/accounts/:id/reactivate', requireAdmin, async (c) => {
            const { account, response } = target(c);
            if (!account) {
                return response;
            }
            return c.json(await this.listed(await this.reactivate(account.id, c.get('user').id)));
        });
        // CB-390: the workspace owner hands ownership to another active
        // admin, in person: their name typed and a step-up. The previous
        // owner stays an admin. Audited, and every admin is told.
        const ownerTransfer = (c: Context<AppEnv>, account: Account) => {
            if (c.get('serviceKey') || c.get('dataToken')) {
                return 'Ownership is handed over in person, not with a key.';
            }
            const owner = this.ownerAccount();
            if (!owner || owner.userId !== c.get('user').id) {
                return 'Only the workspace owner can make someone else the owner.';
            }
            return this.ownerRefusal(account);
        };
        app.post('/api/accounts/:id/owner/step-up', requireAdmin, async (c) => {
            const { account, response } = target(c);
            if (!account) {
                return response;
            }
            const refused = ownerTransfer(c, account);
            if (refused) {
                return c.json({ error: refused }, 403);
            }
            const challenge = await this.stepUp.begin(c.req.raw, c.get('user'), ownerDigest(account));
            if (!challenge) {
                return c.json({ error: 'Confirming a new owner needs your own signed-in session.' }, 401);
            }
            return c.json(challenge);
        });
        app.post('/api/accounts/:id/owner', requireAdmin, async (c) => {
            const parsed = z
                .object({ confirmName: z.string().max(200), stepUp: stepUpProofSchema.optional() })
                .strict()
                .safeParse(await c.req.json().catch(() => null));
            if (!parsed.success) {
                return c.json({ error: 'Type their name and confirm.' }, 400);
            }
            const { account, response } = target(c);
            if (!account) {
                return response;
            }
            const refused = ownerTransfer(c, account);
            if (refused) {
                return c.json({ error: refused }, 403);
            }
            if (parsed.data.confirmName !== account.name) {
                return c.json({ error: 'Type their name exactly as shown to confirm.' }, 400);
            }
            if (!parsed.data.stepUp) {
                return c.json({ error: 'Confirm it’s you first (step-up).' }, 401);
            }
            const user = c.get('user');
            const proof = await this.stepUp.finish(c.req.raw, user, ownerDigest(account), parsed.data.stepUp);
            if (!proof.ok) {
                return c.json({ error: proof.error }, proof.status);
            }
            // One at a time with role changes, leaving and deactivating: read
            // again, as either side may have changed while they confirmed.
            const changed = await this.oneMembershipChange(async () => {
                const now = this.accounts().find((a) => a.id === account.id);
                if (!now || now.userId !== account.userId || now.name !== account.name) {
                    return 'This account changed while you confirmed: check it again.';
                }
                const again = ownerTransfer(c, now);
                if (again) {
                    return again;
                }
                this.setOwner(now, user.id, 'transferred');
                return undefined;
            });
            if (changed) {
                return c.json({ error: changed }, 409);
            }
            return c.json(await this.listed(this.accounts().find((a) => a.id === account.id)));
        });
    }

    /**
     * Why this account can't be deactivated, if it can't: the last active
     * operator or admin (the routes and the auth CLI).
     */
    /**
     * Groups (CB-376), for admins: create, rename, choose permissions,
     * delete, and add or remove people. The only way groups change: the
     * organization plugin's own endpoints are not served.
     */
    private groupRoutes(app: Hono<AppEnv>) {
        const failed = (c: Context<AppEnv>, error: unknown) => {
            if (error instanceof GroupError) {
                return c.json({ error: error.message }, error.status);
            }
            throw error;
        };
        const log = (c: Context<AppEnv>, what: string) => console.log(`Groups: ${what} by user=${c.get('user').id}.`);
        app.get('/api/groups', requireAdmin, (c) => c.json({ groups: this.groups().list() }));
        app.post('/api/groups', requireAdmin, async (c) => {
            const parsed = groupCreateSchema.safeParse(await c.req.json().catch(() => null));
            if (!parsed.success) {
                return c.json({ error: 'Name the group (up to 60 characters) and choose its permissions.' }, 400);
            }
            try {
                const group = this.groups().create(parsed.data.name, parsed.data.permissions);
                log(c, `group ${group.id} created`);
                return c.json(group, 201);
            } catch (error) {
                return failed(c, error);
            }
        });
        app.patch('/api/groups/:id', requireAdmin, async (c) => {
            const parsed = groupUpdateSchema.safeParse(await c.req.json().catch(() => null));
            if (!parsed.success) {
                return c.json({ error: 'Give the group a name (up to 60 characters) or permissions.' }, 400);
            }
            try {
                const group = this.groups().update(c.req.param('id'), parsed.data);
                log(c, `group ${group.id} changed`);
                return c.json(group);
            } catch (error) {
                return failed(c, error);
            }
        });
        app.delete('/api/groups/:id', requireAdmin, (c) => {
            try {
                const group = this.groups().delete(c.req.param('id'));
                log(c, `group ${group.id} deleted (${group.members.length} member(s))`);
                return c.json({ ok: true });
            } catch (error) {
                return failed(c, error);
            }
        });
        const membership = (inGroup: boolean) => (c: Context<AppEnv>) => {
            try {
                const id = c.req.param('id')!;
                const accountId = c.req.param('accountId')!;
                if (this.groups().setMembership(accountId, id, inGroup)) {
                    log(c, `account ${accountId} ${inGroup ? 'added to' : 'removed from'} group ${id}`);
                }
                return c.json(this.groups().get(id));
            } catch (error) {
                return failed(c, error);
            }
        };
        app.put('/api/groups/:id/members/:accountId', requireAdmin, membership(true));
        app.delete('/api/groups/:id/members/:accountId', requireAdmin, membership(false));
    }

    /**
     * Why `account` can't leave on its own, if it can't (CB-383): the
     * workspace owner hands ownership over first, and the last admin stays
     * (CB-390: the plain last-admin rule).
     */
    leaveRefusal(account: Account): LeaveRefusalCode | undefined {
        if (account.deactivated) {
            return 'already_left';
        }
        if (this.isOwner(account)) {
            return 'owner';
        }
        if (this.lastAdmin(account)) {
            return 'last_admin';
        }
        return undefined;
    }

    /**
     * Leaving and deactivating, one at a time (CB-383): each checks who
     * would remain, then waits on audits before the ban lands, so two at
     * once could otherwise both pass the last-admin check.
     */
    private membershipTurn: Promise<unknown> = Promise.resolve();
    private oneMembershipChange<T>(work: () => Promise<T>): Promise<T> {
        const mine = this.membershipTurn.catch(() => undefined).then(work);
        this.membershipTurn = mine.catch(() => undefined);
        return mine;
    }

    /**
     * Why this account can't be deactivated, if it can't (the routes and the
     * auth CLI): the last active admin, or the workspace owner. Only the
     * server's shell (`shell`) may deactivate the owner, at a verified
     * customer contact's request; ownership then passes on (`ensureOwner`).
     */
    deactivationRefusal(account: Account, { shell = false }: { shell?: boolean } = {}): string | undefined {
        if (this.lastAdmin(account)) {
            return 'Keep at least one admin.';
        }
        if (!shell && !account.deactivated && this.isOwner(account)) {
            return OWNER_STAYS_ADMIN;
        }
        return undefined;
    }

    /**
     * Why `account`'s assets can't move to `recipient`, if they can't
     * (CB-360): the new owner is another person, active, with an app user,
     * never a service account.
     */
    private transferRefusal(account: Account, recipient: Account | undefined): string | undefined {
        if (!account.userId) {
            return 'This account has no app user: it owns nothing.';
        }
        if (!recipient) {
            return 'The new owner’s account was not found.';
        }
        if (recipient.id === account.id || recipient.userId === account.userId) {
            return 'Choose someone else as the new owner.';
        }
        if (recipient.deactivated) {
            return 'The new owner is deactivated: choose an active person.';
        }
        if (!recipient.userId) {
            return 'The new owner hasn’t signed in yet: choose a person with an app user.';
        }
        if (this.database().prepare('SELECT 1 FROM service_accounts WHERE userId=?').get(recipient.userId)) {
            return 'A service account can’t own a person’s work: choose a person.';
        }
        return undefined;
    }

    /**
     * Why `account` can't be removed for good by `by`, if it can't (CB-360):
     * never yourself, never the last admin or the workspace owner, and only
     * once deactivated, so their sessions and keys have ended first.
     */
    private purgeRefusal(account: Account, by: User): string | undefined {
        if (account.userId === by.id) {
            return 'You can’t remove yourself.';
        }
        const last = this.deactivationRefusal(account);
        if (last) {
            return last;
        }
        if (this.isOwner(account)) {
            return OWNER_STAYS_ADMIN;
        }
        if (!account.deactivated) {
            return 'Deactivate them first.';
        }
        return undefined;
    }

    /**
     * The only active admin: someone must keep managing the workspace.
     * Deactivated accounts don't count, and aren't guarded. Only the
     * company's own admins count (`companyAdmin`).
     */
    private lastAdmin(account: Account) {
        return (
            this.companyAdmin(account) &&
            this.accounts().filter((a) => a.id !== account.id && this.companyAdmin(a)).length === 0
        );
    }

    /**
     * An active admin of the company's own: what "keep at least one admin" and
     * the sign-in policy's confirming admin count (CB-390). Support accounts
     * will never count here, whatever their role; until they exist, every
     * active admin does.
     */
    private companyAdmin(account: Account) {
        return !account.deactivated && isAdmin(account);
    }

    /** The workspace owner's account id, as recorded (CB-390), if any. */
    private ownerId(): string | undefined {
        const row = this.database().prepare('SELECT accountId FROM auth_workspace_owner WHERE id = 1').get() as
            | { accountId: string }
            | undefined;
        return row?.accountId;
    }

    /** Whether `account` is the workspace owner (CB-390). */
    isOwner(account: Pick<Account, 'id'>) {
        return this.ownerId() === account.id;
    }

    /** The workspace owner's account, if one is recorded and still there. */
    ownerAccount(): Account | undefined {
        const id = this.ownerId();
        return id ? this.accounts().find((a) => a.id === id) : undefined;
    }

    /**
     * Why `account` can't be the workspace owner, if it can't: an active
     * company admin, a person with an app user, never a service account,
     * and not already the owner.
     */
    private ownerRefusal(account: Account): string | undefined {
        if (this.isOwner(account)) {
            return 'They are the workspace owner already.';
        }
        if (account.deactivated) {
            return 'Choose an active admin as the new owner.';
        }
        if (!this.companyAdmin(account)) {
            return 'Only an admin can be the workspace owner: make them an admin first.';
        }
        if (!account.userId) {
            return 'The new owner hasn’t signed in yet: choose an admin with an app user.';
        }
        if (this.database().prepare('SELECT 1 FROM service_accounts WHERE userId=?').get(account.userId)) {
            return 'A service account can’t own the workspace: choose a person.';
        }
        return undefined;
    }

    /**
     * Records `account` as the workspace owner, with a workspace audit line,
     * and tells every listener (each admin hears of it).
     */
    private setOwner(account: Account, by: string, how: OwnerChange['how']) {
        const previous = this.ownerAccount();
        const now = Date.now();
        const db = this.database();
        db.prepare(
            'INSERT INTO auth_workspace_owner(id, accountId, since) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET accountId = excluded.accountId, since = excluded.since',
        ).run(account.id, now);
        // An admin in its own right, not only by an email rule another admin
        // could narrow away (Settings → Access). A stored `operator` stays
        // (it reads as admin; see retire-operator.ts).
        db.prepare(
            `UPDATE auth_user SET role = 'admin' WHERE id = ? AND coalesce(role, '') NOT IN ('admin', 'operator')`,
        ).run(account.id);
        const detail =
            how === 'transferred'
                ? `workspace.owner.transferred: from ${previous?.name ?? 'nobody'} to ${account.name}`
                : `workspace owner: ${account.name} (${how === 'first_admin' ? 'the first admin' : 'the previous owner is no longer an active admin'})`;
        db.prepare(
            'INSERT INTO workspace_audit(actor, action, targetKind, targetId, detail, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(
            by,
            how === 'transferred' ? 'transfer' : 'update',
            'workspace_owner',
            account.userId || account.id,
            detail,
            now,
        );
        const change: OwnerChange = {
            to: { userId: account.userId, name: account.name },
            from: previous && previous.id !== account.id ? { userId: previous.userId, name: previous.name } : null,
            by,
            how,
        };
        for (const listener of this.ownerListeners) {
            void Promise.resolve()
                .then(() => listener(change))
                .catch((error) => reportFailure('A workspace owner notice failed', [safeFailure(error)]));
        }
    }

    /**
     * The first admin to appear on a workspace with no owner becomes it at
     * once (created, promoted, or signed in by OAuth), not at the next boot.
     */
    private ownerOnceThereIsAnAdmin() {
        if (!this.ownerId()) {
            for (const line of this.ensureOwner()) {
                console.log(line);
            }
        }
    }

    /** After the workspace owner changed (CB-390): each admin hears of it. */
    onOwnerChanged(listener: (change: OwnerChange) => void | Promise<void>) {
        this.ownerListeners.push(listener);
    }

    /**
     * Keeps the workspace's one owner (CB-390): when none is recorded, or
     * the recorded one is no longer an active admin (deactivated from the
     * server's shell, say), the earliest-created active company admin that
     * can be the owner becomes it. With no such admin, nothing changes: the
     * next first admin (`AUTH_FIRST_ADMIN_EMAIL`) becomes the owner at boot.
     * `by` names the actor for the audit line. Returns lines for the log.
     */
    ensureOwner(by = 'system'): string[] {
        const current = this.ownerAccount();
        if (current && this.companyAdmin(current)) {
            return [];
        }
        const next = this.accounts().find((account) => !this.ownerRefusal(account));
        if (!next) {
            return current || this.ownerId()
                ? ['Auth: the workspace owner is no longer an active admin, and no other admin can take over yet.']
                : [];
        }
        this.setOwner(next, by, current || this.ownerId() ? 'replaced' : 'first_admin');
        return [`Auth: ${next.name} (user ${next.userId}) is now the workspace owner.`];
    }

    accounts(): Account[] {
        const rows = this.database()
            .prepare(
                `SELECT u.id, u.appUserId, u.name, u.email, u.emailVerified, u.role, u.createdAt, u.banned,
          EXISTS(SELECT 1 FROM auth_account a WHERE a.userId=u.id AND a.providerId='credential' AND a.password IS NOT NULL) AS password,
          (SELECT COUNT(*) FROM auth_passkey p WHERE p.userId=u.id) AS passkeys,
          (SELECT group_concat(a.providerId) FROM auth_account a WHERE a.userId=u.id AND a.providerId<>'credential') AS providers
        FROM auth_user u ORDER BY u.createdAt, u.id`,
            )
            .all() as unknown as (AuthUserRow & {
            password: number;
            passkeys: number;
            providers: string | null;
        })[];
        const rules = this.rules();
        const ownerId = this.ownerId();
        return rows.map((row) => ({
            id: row.id,
            userId: row.appUserId ?? '',
            name: row.name,
            email: row.email,
            emailVerified: !!row.emailVerified,
            role: effectiveRole(rules, {
                ...row,
                emailVerified: !!row.emailVerified,
            }),
            adminByRule: adminByEmail(rules, row.email, !!row.emailVerified),
            password: !!row.password,
            passkeys: Number(row.passkeys),
            providers: row.providers ? row.providers.split(',') : [],
            // Set as admins see the account (`listed`): a sender may have to
            // look its link up.
            signInLinkVia: null,
            deactivated: !!row.banned,
            owner: row.id === ownerId,
            createdAt: row.createdAt,
        }));
    }

    /**
     * The accounts as admins see them: each with the channel a sign-in link
     * would reach it on now, if any.
     */
    listedAccounts() {
        return Promise.all(this.accounts().map((account) => this.listed(account)));
    }

    /** Where the roster's reach and the deactivation preview come from (composition). */
    usePeopleFacts(facts: PeopleFacts) {
        this.facts = facts;
    }
    /** What people own, and moving it (CB-360, composition). */
    usePeopleAssets(assets: PeopleAssets) {
        this.assets = assets;
    }
    /** Admins' permanent removal (CB-360, composition). */
    usePersonPurge(purge: PersonPurge) {
        this.purger = purge;
    }

    /**
     * Every account as admins' roster shows it (CB-360): `listedAccounts`,
     * plus status, last use, live sessions, the newest password link and
     * what they can reach. Invited means never seen: no session row and no
     * signed-in request recorded (`auth_activity`). The app's users table
     * can't say it: the boot writes every account into it.
     */
    async roster(now = Date.now(), only?: Account[]): Promise<RosterPerson[]> {
        const db = this.database();
        const sessions = db.prepare('SELECT userId, updatedAt, expiresAt FROM auth_session').all() as {
            userId: string;
            updatedAt: unknown;
            expiresAt: unknown;
        }[];
        const links = db
            .prepare(
                "SELECT value AS userId, createdAt, expiresAt FROM auth_verification WHERE identifier LIKE 'reset-password:%'",
            )
            .all() as { userId: string; createdAt: unknown; expiresAt: unknown }[];
        const activity = new Map(
            (
                db.prepare('SELECT accountId, lastAt FROM auth_activity').all() as {
                    accountId: string;
                    lastAt: number;
                }[]
            ).map((row) => [row.accountId, Number(row.lastAt)]),
        );
        const people: RosterPerson[] = [];
        for (const account of only ?? (await this.listedAccounts())) {
            const own = sessions.filter((session) => session.userId === account.id);
            const lastActive = Math.max(
                0,
                ...own.map((session) => toMs(session.updatedAt)),
                activity.get(account.id) ?? 0,
            );
            // The link made last: an admin's invite or an emailed reset.
            const newestLink = links
                .filter((link) => link.userId === account.id)
                .map((link) => ({ createdAt: toMs(link.createdAt), expiresAt: toMs(link.expiresAt) }))
                .reduce<{ createdAt: number; expiresAt: number } | undefined>(
                    (newest, link) => (newest && newest.createdAt >= link.createdAt ? newest : link),
                    undefined,
                );
            people.push({
                ...account,
                status: account.deactivated ? 'deactivated' : lastActive ? 'active' : 'invited',
                lastActiveAt: lastActive ? new Date(lastActive).toISOString() : null,
                sessions: own.filter((session) => toMs(session.expiresAt) > now).length,
                invite: newestLink
                    ? {
                          expiresAt: new Date(newestLink.expiresAt).toISOString(),
                          expired: newestLink.expiresAt <= now,
                      }
                    : null,
                reach: account.userId && this.facts ? await this.facts.reach(account.userId) : null,
            });
        }
        return people;
    }

    /**
     * One person as admins' person page shows them (CB-360): the roster's
     * fields, their signed-in devices, passkeys, password and providers,
     * and what they can reach, listed. Never a token, hash or secret.
     */
    async personDetail(account: Account, now = Date.now()): Promise<PersonDetail> {
        const [person] = await this.roster(now, [await this.listed(account)]);
        const db = this.database();
        const iso = (value: unknown) => new Date(toMs(value)).toISOString();
        const sessions = (
            db
                .prepare(
                    'SELECT id, createdAt, updatedAt, expiresAt, userAgent, signInMethod, ipAddress FROM auth_session WHERE userId=?',
                )
                .all(account.id) as {
                id: string;
                createdAt: unknown;
                updatedAt: unknown;
                expiresAt: unknown;
                userAgent: string | null;
                signInMethod: string | null;
                ipAddress: string | null;
            }[]
        )
            .filter((session) => toMs(session.expiresAt) > now)
            .sort((a, b) => toMs(b.updatedAt) - toMs(a.updatedAt) || a.id.localeCompare(b.id))
            .map((session) => ({
                id: session.id,
                createdAt: iso(session.createdAt),
                renewedAt: iso(session.updatedAt),
                expiresAt: iso(session.expiresAt),
                userAgent: session.userAgent || null,
                signInMethod: session.signInMethod || null,
                ip: session.ipAddress || null,
            }));
        const passkeys = (
            db
                .prepare('SELECT id, name, createdAt FROM auth_passkey WHERE userId=? ORDER BY createdAt, id')
                .all(account.id) as {
                id: string;
                name: string | null;
                createdAt: unknown;
            }[]
        ).map((passkey) => ({
            id: passkey.id,
            name: passkey.name || null,
            createdAt: passkey.createdAt === null || passkey.createdAt === undefined ? null : iso(passkey.createdAt),
        }));
        return {
            person: person!,
            signIn: { sessions, passkeys, password: account.password, providers: account.providers },
            access: account.userId && this.facts ? await this.facts.access(account.userId) : null,
            groups: this.groups().groupsOf(account.id),
        };
    }

    /**
     * What deactivating this account would end, revoke or hand over
     * (CB-360), as `deactivate` and the app's `accountLifecycle` would do
     * it now. Changes nothing.
     */
    async deactivationImpact(account: Account, now = Date.now()): Promise<DeactivationImpact> {
        const sessions = (
            this.database().prepare('SELECT expiresAt FROM auth_session WHERE userId=?').all(account.id) as {
                expiresAt: unknown;
            }[]
        ).filter((session) => toMs(session.expiresAt) > now).length;
        const none = {
            keys: [],
            connectedAgents: 0,
            socioGrants: 0,
            appSessions: 0,
            pluginAccess: 0,
            scheduledTasks: 0,
            jobRuns: 0,
            subscriptionConnections: 0,
            mcpConnections: 0,
            rooms: { handedOver: 0, archived: 0 },
            appsOwned: 0,
        };
        const owned = Object.fromEntries(
            (account.userId && this.assets ? this.assets.assets(account.userId) : [])
                .filter((kind) => kind.count)
                .map((kind) => [kind.kind, kind.count]),
        );
        const facts = account.userId ? this.facts : undefined;
        // Already deactivated: nothing more ends; what they own is still theirs.
        const effects = !facts
            ? none
            : account.deactivated
              ? { ...none, appsOwned: (await facts.reach(account.userId)).appsOwned }
              : await facts.deactivationImpact(account.userId);
        return {
            accountId: account.id,
            name: account.name,
            refusal: account.deactivated ? null : (this.deactivationRefusal(account) ?? null),
            deactivated: account.deactivated,
            sessions: account.deactivated ? 0 : sessions,
            ...effects,
            owned,
        };
    }

    /** One account as admins see it (`listedAccounts`). */
    private async listed<T extends Account | undefined>(account: T): Promise<T> {
        if (!account) {
            return account;
        }
        return {
            ...account,
            signInLinkVia:
                (!account.deactivated && account.userId && (await this.senderFor(account.userId))?.via) || null,
        };
    }

    /** App users (from mock auth, or removed accounts) no account links to. */
    unlinkedUsers(): User[] {
        return this.database()
            .prepare(
                // Service accounts (CB-57) never get a sign-in account.
                'SELECT id, name, role FROM users WHERE id NOT IN (SELECT appUserId FROM auth_user WHERE appUserId IS NOT NULL) AND id NOT IN (SELECT userId FROM service_accounts) ORDER BY createdAt, id',
            )
            .all() as unknown as User[];
    }

    /**
     * Creates an account (admins and the CLI). `userId` links it to an
     * existing app user so their conversations, tasks and memories carry
     * over. Returns the account id.
     */
    async createAccount(input: AccountInput): Promise<string> {
        const parsed = accountInput.safeParse(input);
        if (!parsed.success) {
            throw new Error(
                `Enter a name, a valid email and a role (${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}).`,
            );
        }
        const data = parsed.data;
        if (data.userId) {
            if (!this.database().prepare('SELECT 1 FROM users WHERE id=?').get(data.userId)) {
                throw new Error(`There is no app user "${data.userId}" to link.`);
            }
            if (this.database().prepare('SELECT 1 FROM service_accounts WHERE userId=?').get(data.userId)) {
                throw new Error(`"${data.userId}" is a service account; nobody signs in as it.`);
            }
            if (!this.unlinkedUsers().some((user) => user.id === data.userId)) {
                throw new Error(`"${data.userId}" is already linked to an account.`);
            }
        }
        try {
            const { id } = await (await this.auth()).api.brainCreateAccount({ body: data });
            return id;
        } catch (error) {
            const { isAPIError } = await import('better-auth/api');
            if (isAPIError(error)) {
                throw new Error(error.message, { cause: error });
            }
            throw error;
        }
    }

    /**
     * Builds the instance at boot rather than on the first request with a
     * session cookie, which imports Better Auth, its plugins and passkeys'
     * X.509 code and evaluates them on the main thread: about 0.6 s on a
     * fast machine over a copy of a production database, with `/healthz` held for
     * as long. Its context (OAuth discovery included) gets at most
     * `WARM_CONTEXT_MS`: a provider that is down then is retried by a
     * sign-in with it, as before (`ensureProviders`).
     */
    async warm(): Promise<void> {
        const instance = await this.auth();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                instance.$context.catch(() => undefined),
                new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, WARM_CONTEXT_MS);
                    timer.unref();
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Whether this app user may run code (CB-376): the organization plugin's
     * `hasPermission` for `code:run`, over their member role in the
     * workspace organization. The base role is the one in force now (an
     * `AUTH_ADMIN_EMAILS` admin is an admin), the groups are their member
     * row's. The plugin reads the groups' permissions from the database on
     * every call (no memory cache), so a change applies at once. A
     * deactivated person may not.
     */
    async mayRunCode(appUserId: string): Promise<boolean> {
        const row = this.database()
            .prepare('SELECT id, email, emailVerified, role, banned FROM auth_user WHERE appUserId=?')
            .get(appUserId) as Pick<AuthUserRow, 'id' | 'email' | 'emailVerified' | 'role' | 'banned'> | undefined;
        if (!row || row.banned) {
            return false;
        }
        const base = baseRoleOf(effectiveRole(this.rules(), { ...row, emailVerified: !!row.emailVerified }));
        const { groups } = splitMemberRole(this.groups().memberRole(row.id));
        const context = await (await this.auth()).$context;
        const { hasPermission } = await import('better-auth/plugins/organization');
        return hasPermission(
            {
                organizationId: WORKSPACE_ORGANIZATION_ID,
                role: [base, ...groups].join(','),
                options: this.organizationOptions!,
                permissions: { code: ['run'] },
                useMemoryCache: false,
            },
            { context: rolesOnly(context, groups) } as Parameters<typeof hasPermission>[1],
        );
    }

    /**
     * The `CODE_USERS` migration (CB-376), at boot: once per database, a
     * "Code" group from the list in force (`CODE_USERS` as narrowed under
     * Settings → Access), with its non-admins. Returns lines for the log.
     */
    async seedCodeGroup(ceiling: readonly string[]): Promise<string[]> {
        this.groups().ensureWorkspace();
        return this.groups().seedCodeGroup(codeUsersInForce(ceiling, readStoredPolicy(this.database()).saved));
    }

    /**
     * The boot step (CB-390): flag rules for the retired operator role, then the first
     * admin (`AUTH_FIRST_ADMIN_EMAIL`, linked to `AUTH_FIRST_ADMIN_LINK`;
     * the former `AUTH_OPERATOR_*` names are read as aliases), then the
     * workspace owner. The first admin is made only while the workspace has
     * no active admin, so it never re-promotes an account the company's
     * admins demoted or deactivated: it makes an existing account with that
     * (verified) email an admin, or creates the account, verified and
     * without a password (the first sign-in is by a link). Never relinks or
     * takes over another account's app user.
     */
    async start(): Promise<string[]> {
        // Every account a member of the workspace organization (CB-376).
        this.groups().ensureWorkspace();
        // Expired device sessions' push subscriptions (CB-379).
        this.startPushSweep();
        const lines = retireOperatorRows(this.database());
        lines.push(...(await this.ensureFirstAdmin()));
        lines.push(...this.ensureOwner());
        return lines;
    }

    private async ensureFirstAdmin(): Promise<string[]> {
        const wanted = this.settings.firstAdmin;
        if (!wanted) {
            return [];
        }
        const accounts = this.accounts();
        if (accounts.some((account) => this.companyAdmin(account))) {
            return [];
        }
        const name = wanted.envName;
        const existing = accounts.find((account) => account.email === wanted.email);
        const context = await (await this.auth()).$context;
        if (existing) {
            if (!existing.emailVerified) {
                return [
                    `Auth: the ${name}_EMAIL account has an unconfirmed email, so it was not made the first admin. Remove it under People, or use the auth command.`,
                ];
            }
            if (existing.deactivated) {
                return [
                    `Auth: the ${name}_EMAIL account is deactivated, so it was not made the first admin. Reactivate it with the auth command.`,
                ];
            }
            await context.internalAdapter.updateUser(existing.id, {
                role: 'admin',
            });
            return [
                `Auth: made the ${name}_EMAIL account (user ${existing.userId}) the first admin.`,
                ...(wanted.link && wanted.link !== existing.userId
                    ? [
                          `Auth: that account is linked to ${existing.userId}, not ${name}_LINK=${wanted.link}; links are not changed at boot.`,
                      ]
                    : []),
            ];
        }
        if (wanted.link && accounts.some((account) => account.userId === wanted.link)) {
            return [
                `Auth: no first admin created: ${wanted.link} (${name}_LINK) is already linked to another account.`,
            ];
        }
        const appUser = wanted.link
            ? (this.database().prepare('SELECT name FROM users WHERE id=?').get(wanted.link) as
                  | { name: string }
                  | undefined)
            : undefined;
        // Straight to the endpoint: on a fresh database the linked id has no
        // users row yet (boot records it right after).
        const { id } = await (
            await this.auth()
        ).api.brainCreateAccount({
            body: {
                email: wanted.email,
                name: appUser?.name ?? wanted.email.split('@')[0],
                role: 'admin',
                ...(wanted.link ? { userId: wanted.link } : {}),
            },
        });
        const account = this.accounts().find((entry) => entry.id === id)!;
        return [
            `Auth: created the first admin's account (${name}_EMAIL) for user ${account.userId}. Sign in with a link: "Send me a sign-in link" (Telegram), or \`auth password-link\`.`,
        ];
    }

    /**
     * A one-time link that sets the account's password (an invite, or a
     * reset). Shown to the admin; also emailed when SMTP is configured.
     */
    async passwordLink(accountId: string): Promise<PasswordLink> {
        const context = await (await this.auth()).$context;
        const user = await context.internalAdapter.findUserById(accountId);
        if (!user) {
            throw new Error('Account not found.');
        }
        const token = randomBytes(24).toString('base64url');
        const expiresAt = new Date(Date.now() + LINK_SECONDS * 1000);
        await context.internalAdapter.createVerificationValue({
            identifier: `reset-password:${token}`,
            value: user.id,
            expiresAt,
        });
        // On the link domain when the workspace has it on: the token only
        // in the fragment, and the link page opens the app or this page.
        const variant = this.inviteVariant();
        const url = variant
            ? this.workspaceAppLink(variant, 'i', { t: token })
            : `${this.settings.origin}${PASSWORD_LINK_PATH}?token=${token}`;
        let emailed = false;
        if (this.mailer) {
            emailed = await this.mailer
                .send({
                    to: user.email,
                    subject: 'Your Socio account',
                    text: `Set your password here (the link works for three days):\n\n${url}`,
                })
                .then(() => true)
                .catch(() => false);
        }
        return { url, expiresAt: expiresAt.toISOString(), emailed };
    }

    onAccountChange(listener: (event: AccountEvent) => void | Promise<void>) {
        this.listeners.push(listener);
    }

    /** Demotion off admin. The app ends that person's plugin sessions and codes. */
    /** Where the workspace's name comes from (its branding), for Add a device's claim (CB-352). */
    useWorkspaceName(name: () => string) {
        this.workspaceName = name;
    }

    /** After a device signed in through a device endpoint (CB-352): the audit and the person's notice. */
    onDeviceSignIn(listener: (event: DeviceSignInEvent) => void | Promise<void>) {
        this.deviceSignInListeners.push(listener);
    }

    private deviceSignedIn(event: { accountId: string; deviceId: string; label: string; method: SignInMethodId }) {
        const row = this.database().prepare('SELECT appUserId FROM auth_user WHERE id = ?').get(event.accountId) as
            | { appUserId: string | null }
            | undefined;
        if (!row?.appUserId) {
            return;
        }
        const out: DeviceSignInEvent = {
            userId: row.appUserId,
            deviceId: event.deviceId,
            label: event.label,
            method: event.method,
        };
        for (const listener of this.deviceSignInListeners) {
            void Promise.resolve()
                .then(() => listener(out))
                .catch((error) => reportFailure('A device sign-in notice failed', [safeFailure(error)]));
        }
    }

    onAdminRevoked(listener: (userId: string) => void | Promise<void>) {
        this.adminRevokedListeners.push(listener);
    }

    private async notifyAdminRevoked(userId: string) {
        for (const listener of this.adminRevokedListeners) {
            await Promise.resolve(listener(userId)).catch((error: unknown) =>
                reportFailure('Admin demotion follow-up failed', [safeFailure(error)]),
            );
        }
    }

    private async changed(event: AccountEvent) {
        for (const listener of this.listeners) {
            await Promise.resolve(listener(event)).catch((error: unknown) =>
                reportFailure(`Account ${event.action} follow-up failed`, [safeFailure(error)]),
            );
        }
    }

    /**
     * Deactivates an account (instead of removing it): Better Auth refuses
     * it every new session from now on, its sessions end at once, and the
     * app hears of it (`onAccountChange`) to end what else acts for the
     * person. Their passkeys, password and links stay, for a reactivation.
     * `by` is the admin's app user id. Returns the account.
     */
    async deactivate(accountId: string, by: string, { left = false }: { left?: boolean } = {}): Promise<Account> {
        const account = this.requireAccount(accountId);
        const context = await (await this.auth()).$context;
        const reason = left ? 'left_workspace' : 'deactivated';
        // Every device of theirs erases its copy (CB-352): audited first, so a
        // failed audit leaves the person as they were and the call can be made
        // again. Already deactivated, it finishes whatever was left undone.
        await this.endDevices(accountId, by, 'revoked_and_erase', reason);
        if (account.deactivated) {
            await context.internalAdapter.deleteUserSessions(accountId);
            return account;
        }
        await context.internalAdapter.updateUser(accountId, {
            banned: true,
            banReason: left ? 'Left the workspace' : 'Deactivated',
            banExpires: null,
        });
        // A device that signed in while the first pass waited on its audit:
        // no sign-in gets past the ban, so this pass erases the last of them.
        await this.endDevices(accountId, by, 'revoked_and_erase', reason);
        await context.internalAdapter.deleteUserSessions(accountId);
        // The owner, deactivated from the server's shell (CB-390): ownership
        // passes to the earliest-created active admin.
        if (this.isOwner(account)) {
            for (const line of this.ensureOwner(by)) {
                console.log(line);
            }
        }
        if (account.userId) {
            await this.changed({
                action: 'deactivate',
                userId: account.userId,
                name: account.name,
                by,
                ...(left ? { left } : {}),
            });
        }
        return this.requireAccount(accountId);
    }

    /** Lets a deactivated account sign in again; old sessions stay ended. */
    async reactivate(accountId: string, by: string): Promise<Account> {
        const account = this.requireAccount(accountId);
        if (!account.deactivated) {
            return account;
        }
        const context = await (await this.auth()).$context;
        await context.internalAdapter.updateUser(accountId, {
            banned: false,
            banReason: null,
            banExpires: null,
        });
        if (account.userId) {
            await this.changed({
                action: 'reactivate',
                userId: account.userId,
                name: account.name,
                by,
            });
        }
        return this.requireAccount(accountId);
    }

    private requireAccount(accountId: string) {
        const account = this.accounts().find((a) => a.id === accountId);
        if (!account) {
            throw new Error('Account not found.');
        }
        return account;
    }

    close() {
        this.closed = true;
        if (this.pushSweep) {
            clearInterval(this.pushSweep);
            this.pushSweep = undefined;
        }
        this.db?.close();
        this.db = undefined;
        this.instance = undefined;
    }
}

/** Where a sign-in code went, hashed: compared at redeem, never shown. */
function recipientHash(via: string, to: string) {
    return createHash('sha256').update(`${via}:${to}`).digest('base64url');
}

/** A sign-in link's token, as `auth_link_via` keys it. */
function linkTokenHash(token: string) {
    return createHash('sha256').update(token).digest('base64url');
}

/** Better Auth's endpoints that sign sessions out, whose devices end with them (CB-352). */
/** What an emailed sign-in link's token starts with (CB-352). */
const EMAILED_LINK_PREFIX = 'e.';

/** The key emailed links' tokens are sealed with, from the server's secret. */
const emailedLinkKey = (secret: string) =>
    createHash('sha256').update(`socio emailed sign-in link\0${secret}`).digest();

/**
 * An emailed link's token, sealed (AES-256-GCM): Better Auth's own token is
 * never in the email, so a previous version, which can't open the envelope,
 * can't redeem it as a Telegram link, prefix or not (CB-352).
 */
function sealEmailedToken(token: string, secret: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', emailedLinkKey(secret), iv);
    const sealed = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return `${EMAILED_LINK_PREFIX}${Buffer.concat([iv, sealed, cipher.getAuthTag()]).toString('base64url')}`;
}

/** A sign-in link's token as Better Auth knows it, and whether it came as an emailed one ('' when it won't open). */
function linkToken(given: string | undefined, secret: string) {
    const value = given ?? '';
    if (!value.startsWith(EMAILED_LINK_PREFIX)) {
        return { token: value, emailed: false };
    }
    try {
        const raw = Buffer.from(value.slice(EMAILED_LINK_PREFIX.length), 'base64url');
        const decipher = createDecipheriv('aes-256-gcm', emailedLinkKey(secret), raw.subarray(0, 12));
        decipher.setAuthTag(raw.subarray(raw.length - 16));
        const token = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString(
            'utf8',
        );
        return { token, emailed: true };
    } catch {
        return { token: '', emailed: true };
    }
}
