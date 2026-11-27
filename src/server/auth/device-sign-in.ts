import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { AuthContext, BetterAuthPlugin } from 'better-auth';

import { RateLimits } from '@socio/foundation/http/rate-limits';
import { sessionAllowed, type SavedAccessPolicy, type SignInMethodId } from '@socio/shared/access-policy';
import {
    appLink,
    CODE_ALPHABET,
    codeRedeemBodySchema,
    codeRequestBodySchema,
    deviceApproveBodySchema,
    deviceRedeemBodySchema,
    deviceStartQuerySchema,
    PAIRING_CODE_LENGTH,
    pairBodySchema,
    pairCancelBodySchema,
    pairClaimBodySchema,
    pairConfirmBodySchema,
    pairRedeemBodySchema,
    SHEET_CODE_LENGTH,
    SIGN_IN_CODE_LENGTH,
    type PairState,
    type AppVariant,
    type DeviceErrorCode,
    type DevicePlatform,
} from '@socio/shared/device-sign-in';

import type { DeviceFacts } from './devices.js';
import type { SocialRefusal, SocialSignIn } from './social-sign-in.js';

/**
 * The system sign-in sheet's one-time code (CB-352): the app opens
 * `GET /api/auth/device/start` in the sheet with a PKCE challenge; the web's
 * Continue page (signed in, after a click) approves it, which mints a code
 * and sends the browser to the link domain's callback with the code in the
 * fragment; the app redeems the code with its verifier for a device session
 * that carries the approving session's sign-in method.
 */

/** How long a started request waits for Continue, and a minted code for its redeem. */
export const DEVICE_REQUEST_MS = 10 * 60_000;
export const SHEET_CODE_MS = 5 * 60_000;
/**
 * How long a start's challenge and state stay taken: far past any wait the app
 * keeps for its sheet, so a challenge or state copied from a log never starts
 * a second request while the first could still be pending.
 */
export const DEVICE_REQUEST_KEEP_MS = 30 * 24 * 60 * 60_000;
/** Approvals per approving session per minute (Better Auth's limits are per address only). */
const APPROVALS_PER_MINUTE = 10;

/** Add a device: the QR code's pairing code, the claim it becomes, and the page's polling. */
export const PAIRING_MS = 5 * 60_000;
export const CLAIM_MS = 2 * 60_000;
/** A claim whose page stops polling this long, before it is allowed, dies. */
export const CLAIM_POLL_MS = 15_000;
/** Wrong confirmation digits per claim, then the claim and its QR code are dead. */
export const CONFIRM_TRIES = 3;
const MINTS_PER_WINDOW = 10;
const CONFIRMS_PER_WINDOW = 10;
const PAIR_WINDOW_MS = 15 * 60_000;

/** The paths whose session is a device's, with the method and device the endpoint chose. */
export const DEVICE_SIGN_IN_PATHS: ReadonlySet<string> = new Set([
    '/device/redeem',
    '/device/pair/redeem',
    '/device/code/redeem',
    // CB-570: native Google and Apple sign-in.
    '/device/social/redeem',
]);

/** Sign-in codes the app asks for: 15 minutes, and 5 tries per request, counted in the database. */
export const SIGN_IN_CODE_MS = 15 * 60_000;
export const CODE_TRIES = 5;

/** Who a sign-in code goes to, and how: what the provider found for an email, if it can send one. */
export interface CodeTarget {
    accountId: string;
    method: Extract<SignInMethodId, 'link' | 'link:email'>;
    /** A hash of who the code goes to (the linked Telegram, the address); the redeem needs the same. */
    recipient: string;
    deliver(link: { kind: 'code'; code: string; openUrl: string; expiresAt: Date }): Promise<void>;
}

/**
 * The builds this server can make Add a device links for: production on https
 * at the default port (the production app refuses ports), preview with
 * `AUTH_APP_PREVIEW_LINKS`, development with `AUTH_APP_DEV_LINKS` (never in
 * production). Without a wanted build: preview, else production, else
 * development, as allowed.
 */
export function appLinkVariant(
    origin: string,
    allow: { previewLinks: boolean; devLinks: boolean },
    wanted?: AppVariant,
): AppVariant | null {
    const url = new URL(origin);
    const allowed: AppVariant[] = [
        ...(allow.previewLinks ? (['preview'] as const) : []),
        ...(url.protocol === 'https:' && url.port === '' ? (['production'] as const) : []),
        ...(allow.devLinks ? (['development'] as const) : []),
    ];
    if (wanted) {
        return allowed.includes(wanted) ? wanted : null;
    }
    return allowed[0] ?? null;
}

/**
 * The sheet browser's proof that it started a request: set by the start,
 * required by the approve (httpOnly, 10 minutes, the device routes only).
 */
export const DEVICE_BROWSER_COOKIE = 'socio_device_browser';

/** The web page that asks "Sign in to the Socio app?" */
export const DEVICE_CONTINUE_PATH = '/device/continue';

const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');

/** A code of `length` symbols, each uniform over the alphabet. */
export function newCode(length: number): string {
    let code = '';
    for (let at = 0; at < length; at++) {
        code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    return code;
}

/** Whether `verifier` is the one behind the S256 `challenge`, compared in constant time. */
export function verifierMatches(verifier: string, challenge: string): boolean {
    const made = Buffer.from(sha256(verifier));
    const stored = Buffer.from(challenge);
    return made.length === stored.length && timingSafeEqual(made, stored);
}

interface RequestRow {
    id: string;
    challenge: string;
    state: string;
    platform: DevicePlatform;
    variant: AppVariant;
    expiresAt: number;
    codeExpiresAt: number | null;
    userId: string | null;
    sessionId: string | null;
    signInMethod: SignInMethodId | null;
}

interface PairingRow {
    id: string;
    userId: string;
    sessionId: string;
    signInMethod: SignInMethodId;
    variant: AppVariant;
    expiresAt: number;
    claimId: string | null;
    challenge: string | null;
    label: string | null;
    platform: DevicePlatform | null;
    claimVariant: AppVariant | null;
    digitsMac: string | null;
    claimedAt: number | null;
    claimExpiresAt: number | null;
    lastPolledAt: number | null;
    tries: number;
    allowedAt: number | null;
    deniedAt: number | null;
    /** The device's redeem took the claim (before its checks); `redeemedAt` once it signed in. */
    usedAt: number | null;
    redeemedAt: number | null;
}

interface CodeRow {
    id: string;
    challenge: string;
    platform: DevicePlatform;
    variant: AppVariant;
    codeHash: string;
    userId: string | null;
    signInMethod: SignInMethodId | null;
    recipient: string | null;
    expiresAt: number;
    tries: number;
}

/** Where a claim stands now (`PairState`). */
export function pairState(row: PairingRow, now: number): PairState {
    if (row.redeemedAt) {
        return 'signed_in';
    }
    if (row.deniedAt) {
        return 'denied';
    }
    if (!row.claimId) {
        return row.expiresAt > now ? 'unclaimed' : 'expired';
    }
    if (row.allowedAt) {
        return (row.claimExpiresAt ?? 0) > now ? 'allowed' : 'expired';
    }
    if ((row.claimExpiresAt ?? 0) <= now || now - (row.lastPolledAt ?? 0) > CLAIM_POLL_MS) {
        return 'expired';
    }
    return 'waiting';
}

/** What the plugin needs from the provider. */
export interface DeviceSignInDeps {
    origin: string;
    /** The link domain's host for a build: development links have their own (never production's). */
    linkHostFor: (variant: AppVariant) => string;
    db: () => DatabaseSync;
    saved: () => SavedAccessPolicy;
    isBanned: (accountId: string) => boolean;
    attach: (installId: string, accountId: string, facts: DeviceFacts) => string;
    /** Signs the claims' confirmation digits (Better Auth's secret). */
    secret: string;
    /** `AUTH_APP_PREVIEW_LINKS`: links for the preview app instead of the production one. */
    previewLinks: boolean;
    /** `AUTH_APP_DEV_LINKS`: Add a device links for the development build too (never in production). */
    devLinks: boolean;
    /** The workspace's name, as its branding shows it. */
    workspaceName: () => string;
    /** Takes one of this address's sign-in link and code requests (5 per 15 minutes, shared with the web's). */
    takeCodeRequest: (headers: Headers | undefined) => boolean;
    /**
     * The account behind an email and the channel to send its code by, when
     * one can now (and its 3 per 15 minutes allow it); null otherwise.
     */
    codeTarget: (email: string) => Promise<CodeTarget | null>;
    /**
     * Whether the channel a code went by still reaches the account: a code
     * sent to a Telegram since unlinked (perhaps lost) no longer signs in.
     */
    channelReaches: (accountId: string, method: CodeTarget['method'], recipient: string) => Promise<boolean>;
    /** Native Google and Apple sign-in's nonces, links and verifier (CB-570). */
    social: SocialSignIn;
    /** After a device signed in (audit, the person's notice). Never throws into the request. */
    signedIn: (event: { accountId: string; deviceId: string; label: string; method: SignInMethodId }) => void;
}

type AuthApi = typeof import('better-auth/api');
type Cookies = typeof import('better-auth/cookies');

/** The plugin, built with Better Auth's own modules (loaded only when it is the provider). */
export function deviceSignIn(
    { APIError, createAuthEndpoint, getSessionFromCtx, sessionMiddleware }: AuthApi,
    { setSessionCookie }: Cookies,
    deps: DeviceSignInDeps,
) {
    const approvals = new RateLimits(APPROVALS_PER_MINUTE, 60_000);
    const mints = new RateLimits(MINTS_PER_WINDOW, PAIR_WINDOW_MS);
    const confirms = new RateLimits(CONFIRMS_PER_WINDOW, PAIR_WINDOW_MS);
    const polls = new RateLimits(1, 1000);
    const mac = (claimId: string, digits: string) =>
        createHmac('sha256', deps.secret).update(`socio-device-claim\u0000${claimId}\u0000${digits}`).digest();
    const claimOf = (claimId: unknown) =>
        typeof claimId === 'string' && claimId.length <= 64
            ? (deps.db().prepare('SELECT * FROM auth_device_pairing WHERE claimId = ?').get(claimId) as
                  | PairingRow
                  | undefined)
            : undefined;
    /** A QR code and its claim, by the pairing id, for the web session that minted it only. */
    const ownClaim = (pairingId: unknown, sessionId: string) => {
        const row =
            typeof pairingId === 'string' && pairingId.length <= 64
                ? (deps.db().prepare('SELECT * FROM auth_device_pairing WHERE id = ?').get(pairingId) as
                      | PairingRow
                      | undefined)
                : undefined;
        if (!row || row.sessionId !== sessionId) {
            throw refuse('FORBIDDEN', 'not_authorized', 'Only the browser that made this QR code can answer it.');
        }
        return row;
    };
    /** A device session for the person behind a confirmed claim or an approved code. */
    const signInDevice = async (
        ctx: { context: Pick<AuthContext, 'internalAdapter'> },
        grant: {
            userId: string;
            sessionId: string | null;
            signInMethod: SignInMethodId;
            label: string;
            installId: string;
            platform: DevicePlatform | null;
            variant: AppVariant | null;
        },
        now: number,
        /**
         * Runs with the final checks, synchronously, once the session exists:
         * returns the refusal that undoes it (a deny that landed meanwhile), or null.
         */
        commit: () => InstanceType<typeof APIError> | null = () => null,
        /**
         * An asynchronous check run once the session exists, before the final
         * synchronous ones (a code's channel still reaching its recipient).
         */
        recheck: () => Promise<InstanceType<typeof APIError> | null> = async () => null,
    ) => {
        /**
         * The grant still stands: what a sign-out, a ban or a policy change meanwhile
         * would undo. A code by email or Telegram has no approving session: its
         * channel was the proof.
         */
        const refusal = (at: number): InstanceType<typeof APIError> | null => {
            if (grant.sessionId !== null) {
                const approving = deps
                    .db()
                    .prepare('SELECT expiresAt FROM auth_session WHERE id = ? AND userId = ?')
                    .get(grant.sessionId, grant.userId) as { expiresAt: unknown } | undefined;
                if (!approving || toMs(approving.expiresAt) <= at) {
                    return refuse(
                        'FORBIDDEN',
                        'not_authorized',
                        'The browser that approved this signed out. Start again.',
                    );
                }
            }
            if (deps.isBanned(grant.userId)) {
                return new APIError('FORBIDDEN', { message: 'This account is deactivated.', code: 'BANNED_USER' });
            }
            if (!sessionAllowed(grant.signInMethod, deps.saved())) {
                return refuse('FORBIDDEN', 'method_off', 'This way of signing in is turned off here.');
            }
            return null;
        };
        const before = refusal(now);
        if (before) {
            throw before;
        }
        const deviceId = deps.attach(grant.installId, grant.userId, {
            label: grant.label,
            platform: grant.platform,
            variant: grant.variant,
        });
        const internal = ctx.context.internalAdapter;
        const session = await internal.createSession(
            grant.userId,
            false,
            { signInMethod: grant.signInMethod, deviceId },
            true,
        );
        const user = session && (await internal.findUserById(grant.userId));
        if (!session || !user) {
            throw refuse('FORBIDDEN', 'not_authorized', 'This sign-in could not be completed. Start again.');
        }
        // Checked again with no await before the commit: a sign-out, ban, policy
        // change or deny that landed while the session was being made wins, and
        // the session goes before any cookie does.
        const late = await recheck();
        const after = late ?? refusal(Date.now()) ?? commit();
        if (after) {
            await internal.deleteSession(session.token);
            throw after;
        }
        return { deviceId, session, user };
    };
    const refuse = (
        status: 'BAD_REQUEST' | 'FORBIDDEN' | 'TOO_MANY_REQUESTS',
        code: DeviceErrorCode,
        message: string,
    ) => new APIError(status, { message, code });
    const SOCIAL_STATUS = {
        400: 'BAD_REQUEST',
        401: 'UNAUTHORIZED',
        403: 'FORBIDDEN',
        404: 'NOT_FOUND',
        409: 'CONFLICT',
        429: 'TOO_MANY_REQUESTS',
        503: 'SERVICE_UNAVAILABLE',
    } as const;
    /** A social sign-in's refusal (CB-570) as Better Auth answers it: `{ error, code }` after the routes' reshaping. */
    const socialError = ({ status, body }: SocialRefusal) =>
        new APIError(SOCIAL_STATUS[status], { message: body.error, code: body.code });

    return {
        id: 'socio-device',
        endpoints: {
            deviceStart: createAuthEndpoint('/device/start', { method: 'GET' }, async (ctx) => {
                const parsed = deviceStartQuerySchema.safeParse(ctx.query ?? {});
                if (!parsed.success) {
                    throw refuse(
                        'BAD_REQUEST',
                        'code_invalid',
                        'This sign-in link is not valid. Start again in the app.',
                    );
                }
                const now = Date.now();
                const id = randomBytes(18).toString('base64url');
                const db = deps.db();
                db.prepare('DELETE FROM auth_device_request WHERE createdAt < ?').run(now - DEVICE_REQUEST_KEEP_MS);
                const { challenge, state, platform, variant } = parsed.data;
                // One value per browser, kept across starts, so a second sign-in
                // started in the same browser doesn't strand the first.
                const held = ctx.getCookie(DEVICE_BROWSER_COOKIE);
                const browser = held && /^[A-Za-z0-9_-]{43}$/.test(held) ? held : randomBytes(32).toString('base64url');
                try {
                    db.prepare(
                        'INSERT INTO auth_device_request(id, challenge, state, platform, variant, createdAt, expiresAt, browserHash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    ).run(id, challenge, state, platform, variant, now, now + DEVICE_REQUEST_MS, sha256(browser));
                } catch (error) {
                    // A challenge or state already used (copied from a log): answered
                    // as any other bad start link.
                    if (!/UNIQUE constraint failed/.test(String((error as Error)?.message))) {
                        throw error;
                    }
                    throw refuse(
                        'BAD_REQUEST',
                        'code_invalid',
                        'This sign-in link is not valid. Start again in the app.',
                    );
                }
                ctx.setCookie(DEVICE_BROWSER_COOKIE, browser, {
                    httpOnly: true,
                    secure: new URL(deps.origin).protocol === 'https:',
                    sameSite: 'lax',
                    path: '/api/auth/device',
                    maxAge: DEVICE_REQUEST_MS / 1000,
                });
                const to = new URL(DEVICE_CONTINUE_PATH, deps.origin);
                to.searchParams.set('request', id);
                to.searchParams.set('app', '1');
                // What the Continue page names ("on iPhone"): display only.
                to.searchParams.set('platform', platform);
                throw ctx.redirect(to.href);
            }),
            deviceApprove: createAuthEndpoint(
                '/device/approve',
                { method: 'POST', use: [sessionMiddleware] },
                async (ctx) => {
                    const parsed = deviceApproveBodySchema.safeParse(ctx.body);
                    if (!parsed.success) {
                        throw refuse('BAD_REQUEST', 'code_invalid', 'This sign-in request is not valid.');
                    }
                    const session = ctx.context.session.session as {
                        id: string;
                        userId: string;
                        signInMethod?: SignInMethodId | null;
                    };
                    if (!approvals.take(session.id)) {
                        throw refuse(
                            'TOO_MANY_REQUESTS',
                            'too_many',
                            'Too many sign-ins approved. Try again in a minute.',
                        );
                    }
                    // The page showed one account: a session that changed since
                    // (another sign-in in this browser) approves nothing.
                    if (parsed.data.session !== undefined && parsed.data.session !== session.id) {
                        throw refuse(
                            'FORBIDDEN',
                            'not_authorized',
                            'You’re signed in as someone else now. Check the account, then Continue again.',
                        );
                    }
                    const method = session.signInMethod ?? null;
                    if (!method || !sessionAllowed(method, deps.saved())) {
                        throw refuse('FORBIDDEN', 'method_off', 'Sign in again to approve this.');
                    }
                    const now = Date.now();
                    const code = newCode(SHEET_CODE_LENGTH);
                    // One approval per request: a second Continue (another tab) gets nothing.
                    const row = deps
                        .db()
                        .prepare(
                            `UPDATE auth_device_request SET codeHash = ?, codeExpiresAt = ?, userId = ?, sessionId = ?, signInMethod = ?
                             WHERE id = ? AND codeHash IS NULL AND expiresAt > ? AND browserHash = ? RETURNING state, variant`,
                        )
                        .get(
                            sha256(code),
                            now + SHEET_CODE_MS,
                            session.userId,
                            session.id,
                            method,
                            parsed.data.request,
                            now,
                            // Only the browser that started it (a request id from a log is not enough).
                            sha256(ctx.getCookie(DEVICE_BROWSER_COOKIE) ?? ''),
                        ) as Pick<RequestRow, 'state' | 'variant'> | undefined;
                    if (!row) {
                        throw refuse(
                            'BAD_REQUEST',
                            'code_expired',
                            'This sign-in request has expired. Start again in the app.',
                        );
                    }
                    const redirect = appLink(
                        {
                            kind: 'cb',
                            variant: row.variant,
                            host: new URL(deps.origin).host,
                            fields: { code, state: row.state },
                        },
                        deps.linkHostFor(row.variant),
                    );
                    return ctx.json({ redirect });
                },
            ),
            // Add a device: the signed-in web makes a QR code, the new device
            // claims it and shows 6 digits the server made, the web types them.
            devicePair: createAuthEndpoint(
                '/device/pair',
                { method: 'POST', use: [sessionMiddleware] },
                async (ctx) => {
                    const session = ctx.context.session.session as {
                        id: string;
                        userId: string;
                        signInMethod?: SignInMethodId | null;
                    };
                    const asked = pairBodySchema.safeParse(ctx.body ?? {});
                    if (!asked.success) {
                        throw refuse('BAD_REQUEST', 'code_invalid', 'This request is not valid.');
                    }
                    const variant = appLinkVariant(deps.origin, deps, asked.data.variant);
                    if (!variant) {
                        throw refuse(
                            'FORBIDDEN',
                            'not_authorized',
                            asked.data.variant
                                ? 'This server makes no links for that build of the app.'
                                : 'The Socio app reaches this workspace only on https at its default port.',
                        );
                    }
                    const method = session.signInMethod ?? null;
                    if (!method || !sessionAllowed(method, deps.saved())) {
                        throw refuse('FORBIDDEN', 'method_off', 'Sign in again to add a device.');
                    }
                    if (!mints.take(session.id)) {
                        throw refuse('TOO_MANY_REQUESTS', 'too_many', 'Too many QR codes. Try again in a few minutes.');
                    }
                    const now = Date.now();
                    const code = newCode(PAIRING_CODE_LENGTH);
                    const db = deps.db();
                    db.prepare(
                        'DELETE FROM auth_device_pairing WHERE expiresAt < ? AND coalesce(claimExpiresAt, 0) < ?',
                    ).run(now - PAIR_WINDOW_MS, now - PAIR_WINDOW_MS);
                    // A new code voids this browser's last one.
                    db.prepare(
                        'UPDATE auth_device_pairing SET deniedAt = ? WHERE sessionId = ? AND deniedAt IS NULL AND redeemedAt IS NULL',
                    ).run(now, session.id);
                    const pairingId = randomBytes(18).toString('base64url');
                    db.prepare(
                        'INSERT INTO auth_device_pairing(id, codeHash, userId, sessionId, signInMethod, variant, createdAt, expiresAt, tries) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)',
                    ).run(pairingId, sha256(code), session.userId, session.id, method, variant, now, now + PAIRING_MS);
                    const link = appLink(
                        { kind: 'd', variant, host: new URL(deps.origin).host, fields: { c: code } },
                        deps.linkHostFor(variant),
                    );
                    return ctx.json({ pairingId, link, variant, expiresAt: new Date(now + PAIRING_MS).toISOString() });
                },
            ),
            devicePairClaim: createAuthEndpoint('/device/pair/claim', { method: 'POST' }, async (ctx) => {
                const parsed = pairClaimBodySchema.safeParse(ctx.body);
                if (!parsed.success) {
                    throw refuse('BAD_REQUEST', 'code_invalid', 'This QR code is not valid.');
                }
                const { code, challenge, label, platform, variant } = parsed.data;
                const now = Date.now();
                const claimId = randomBytes(18).toString('base64url');
                // The pairing code is used up by the first claim, whoever makes it.
                const row = deps
                    .db()
                    .prepare(
                        `UPDATE auth_device_pairing SET claimId = ?, challenge = ?, label = ?, platform = ?, claimVariant = ?, claimedAt = ?, claimExpiresAt = ?, lastPolledAt = ?
                         WHERE codeHash = ? AND claimId IS NULL AND deniedAt IS NULL AND expiresAt > ? RETURNING *`,
                    )
                    .get(claimId, challenge, label, platform, variant, now, now + CLAIM_MS, now, sha256(code), now) as
                    | PairingRow
                    | undefined;
                if (!row) {
                    throw refuse(
                        'BAD_REQUEST',
                        'code_invalid',
                        'This code was already used, or has expired. Make a new one on your computer.',
                    );
                }
                if (variant !== row.variant) {
                    deps.db()
                        .prepare('UPDATE auth_device_pairing SET deniedAt = ? WHERE claimId = ?')
                        .run(now, claimId);
                    throw refuse('BAD_REQUEST', 'wrong_variant', 'This QR code was made for another build of the app.');
                }
                const digits = String(randomInt(1_000_000)).padStart(6, '0');
                deps.db()
                    .prepare('UPDATE auth_device_pairing SET digitsMac = ? WHERE claimId = ?')
                    .run(mac(claimId, digits).toString('base64url'), claimId);
                const account = deps.db().prepare('SELECT name, email FROM auth_user WHERE id = ?').get(row.userId) as {
                    name: string;
                    email: string;
                };
                return ctx.json({
                    claimId,
                    digits,
                    expiresAt: new Date(now + CLAIM_MS).toISOString(),
                    workspace: { name: deps.workspaceName(), host: new URL(deps.origin).host },
                    account: { name: account.name, email: account.email },
                });
            }),
            devicePairRedeem: createAuthEndpoint('/device/pair/redeem', { method: 'POST' }, async (ctx) => {
                const parsed = pairRedeemBodySchema.safeParse(ctx.body);
                if (!parsed.success) {
                    throw refuse('BAD_REQUEST', 'code_invalid', 'This sign-in is not valid.');
                }
                const { claimId, verifier, installId } = parsed.data;
                if (!polls.take(claimId)) {
                    throw refuse('TOO_MANY_REQUESTS', 'too_many', 'Ask again in a second.');
                }
                const now = Date.now();
                const row = claimOf(claimId);
                if (!row) {
                    throw refuse('BAD_REQUEST', 'code_invalid', 'This sign-in is not valid.');
                }
                const state = pairState(row, now);
                if (state === 'waiting') {
                    throw refuse('BAD_REQUEST', 'not_allowed_yet', 'Type the code on your computer.');
                }
                if (state !== 'allowed') {
                    throw refuse('FORBIDDEN', 'denied', 'This sign-in was refused or has expired. Make a new QR code.');
                }
                const used = deps
                    .db()
                    .prepare(
                        'UPDATE auth_device_pairing SET usedAt = ? WHERE claimId = ? AND usedAt IS NULL AND deniedAt IS NULL AND allowedAt IS NOT NULL RETURNING claimId',
                    )
                    .get(now, claimId);
                if (!used) {
                    throw refuse('BAD_REQUEST', 'code_invalid', 'This sign-in is not valid.');
                }
                // Used up; whatever fails from here ends the claim, and the web says so.
                try {
                    if (!row.challenge || !verifierMatches(verifier, row.challenge)) {
                        deps.db()
                            .prepare('UPDATE auth_device_pairing SET deniedAt = ? WHERE claimId = ?')
                            .run(now, claimId);
                        throw refuse('BAD_REQUEST', 'code_invalid', 'This sign-in is not valid.');
                    }
                    const { deviceId, session, user } = await signInDevice(
                        ctx,
                        {
                            userId: row.userId,
                            sessionId: row.sessionId,
                            signInMethod: row.signInMethod,
                            label: row.label ?? 'Socio app',
                            installId,
                            platform: row.platform,
                            variant: row.claimVariant ?? row.variant,
                        },
                        now,
                        // A "Not my device" that landed while the session was being made wins.
                        () =>
                            deps
                                .db()
                                .prepare(
                                    'UPDATE auth_device_pairing SET redeemedAt = ? WHERE claimId = ? AND deniedAt IS NULL AND redeemedAt IS NULL RETURNING claimId',
                                )
                                .get(Date.now(), claimId)
                                ? null
                                : refuse('FORBIDDEN', 'denied', 'This sign-in was refused on your computer.'),
                    );
                    await setSessionCookie(ctx, { session, user });
                    try {
                        deps.signedIn({
                            accountId: row.userId,
                            deviceId,
                            label: row.label ?? 'Socio app',
                            method: row.signInMethod,
                        });
                    } catch {
                        // The notice and audit never undo a sign-in.
                    }
                    return ctx.json({ deviceId });
                } catch (error) {
                    deps.db()
                        .prepare(
                            'UPDATE auth_device_pairing SET deniedAt = coalesce(deniedAt, ?) WHERE claimId = ? AND redeemedAt IS NULL',
                        )
                        .run(Date.now(), claimId);
                    throw error;
                }
            }),
            devicePairStatus: createAuthEndpoint(
                '/device/pair/:pairingId',
                { method: 'GET', use: [sessionMiddleware] },
                async (ctx) => {
                    const session = ctx.context.session.session as { id: string };
                    const row = ownClaim(ctx.params?.pairingId, session.id);
                    const now = Date.now();
                    const state = pairState(row, now);
                    if (state === 'waiting') {
                        deps.db()
                            .prepare('UPDATE auth_device_pairing SET lastPolledAt = ? WHERE claimId = ?')
                            .run(now, row.claimId);
                    }
                    // The device's type and the claim's time; never the digits.
                    return ctx.json({
                        state,
                        platform: row.platform,
                        label: row.label,
                        claimedAt: row.claimedAt ? new Date(row.claimedAt).toISOString() : null,
                    });
                },
            ),
            devicePairConfirm: createAuthEndpoint(
                '/device/pair/:pairingId/confirm',
                { method: 'POST', use: [sessionMiddleware] },
                async (ctx) => {
                    const session = ctx.context.session.session as { id: string };
                    const row = ownClaim(ctx.params?.pairingId, session.id);
                    const parsed = pairConfirmBodySchema.safeParse(ctx.body);
                    if (!parsed.success) {
                        throw refuse('BAD_REQUEST', 'code_invalid', 'Type the 6 digits shown on your new device.');
                    }
                    if (!confirms.take(session.id)) {
                        throw refuse(
                            'TOO_MANY_REQUESTS',
                            'too_many',
                            'Too many tries. Make a new QR code in a few minutes.',
                        );
                    }
                    const now = Date.now();
                    if (pairState(row, now) !== 'waiting' || !row.digitsMac || !row.claimId) {
                        throw refuse('FORBIDDEN', 'denied', 'That code didn’t match. Make a new QR code.');
                    }
                    const stored = Buffer.from(row.digitsMac, 'base64url');
                    const typed = mac(row.claimId, parsed.data.digits);
                    const db = deps.db();
                    if (stored.length === typed.length && timingSafeEqual(stored, typed)) {
                        const allowed = db
                            .prepare(
                                `UPDATE auth_device_pairing SET allowedAt = ? WHERE claimId = ? AND allowedAt IS NULL AND deniedAt IS NULL AND tries < ? RETURNING tries`,
                            )
                            .get(now, row.claimId, CONFIRM_TRIES) as { tries: number } | undefined;
                        if (allowed) {
                            return ctx.json({ state: 'allowed', triesLeft: CONFIRM_TRIES - allowed.tries });
                        }
                        throw refuse('FORBIDDEN', 'denied', 'That code didn’t match. Make a new QR code.');
                    }
                    // Counted in the database, so a restart doesn't reset it.
                    const counted = db
                        .prepare(
                            `UPDATE auth_device_pairing SET tries = tries + 1, deniedAt = CASE WHEN tries + 1 >= ? THEN ? ELSE deniedAt END
                             WHERE claimId = ? AND allowedAt IS NULL AND deniedAt IS NULL RETURNING tries`,
                        )
                        .get(CONFIRM_TRIES, now, row.claimId) as { tries: number } | undefined;
                    const left = counted ? Math.max(0, CONFIRM_TRIES - counted.tries) : 0;
                    return ctx.json({ state: left > 0 ? 'waiting' : 'denied', triesLeft: left }, { status: 400 });
                },
            ),
            // The new device's Cancel: its claim id (which only it holds) is the
            // proof. Ends the claim and its QR code; the same answer whatever
            // the claim, so it says nothing about anyone else's.
            devicePairCancel: createAuthEndpoint('/device/pair/cancel', { method: 'POST' }, async (ctx) => {
                const parsed = pairCancelBodySchema.safeParse(ctx.body);
                if (parsed.success) {
                    deps.db()
                        .prepare(
                            'UPDATE auth_device_pairing SET deniedAt = coalesce(deniedAt, ?) WHERE claimId = ? AND redeemedAt IS NULL',
                        )
                        .run(Date.now(), parsed.data.claimId);
                }
                return ctx.json({ state: 'denied' });
            }),
            devicePairDeny: createAuthEndpoint(
                '/device/pair/:pairingId/deny',
                { method: 'POST', use: [sessionMiddleware] },
                async (ctx) => {
                    const session = ctx.context.session.session as { id: string };
                    const row = ownClaim(ctx.params?.pairingId, session.id);
                    deps.db()
                        .prepare(
                            'UPDATE auth_device_pairing SET deniedAt = coalesce(deniedAt, ?) WHERE id = ? AND redeemedAt IS NULL',
                        )
                        .run(Date.now(), row.id);
                    return ctx.json({ state: 'denied' });
                },
            ),
            // Sign-in codes the app asks for: sent by email (while email
            // links are on) or the linked Telegram, typed into the app that asked.
            deviceCode: createAuthEndpoint('/device/code', { method: 'POST' }, async (ctx) => {
                const parsed = codeRequestBodySchema.safeParse(ctx.body);
                if (!parsed.success) {
                    throw refuse('BAD_REQUEST', 'code_invalid', 'Enter a valid email address.');
                }
                if (!deps.takeCodeRequest(ctx.headers)) {
                    throw refuse('TOO_MANY_REQUESTS', 'too_many', 'Too many requests. Try again in a few minutes.');
                }
                const { email, challenge, platform, variant } = parsed.data;
                const now = Date.now();
                const requestId = randomBytes(18).toString('base64url');
                const db = deps.db();
                db.prepare('DELETE FROM auth_device_code WHERE expiresAt < ?').run(now - SIGN_IN_CODE_MS);
                // Every request gets a row and a code, whether or not the email has
                // an account or a channel: an unknown one's code is never sent, so
                // its tries and answers are the same as a known one's.
                db.prepare(
                    'INSERT INTO auth_device_code(id, challenge, platform, variant, codeHash, createdAt, expiresAt, tries) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
                ).run(
                    requestId,
                    challenge,
                    platform,
                    variant,
                    sha256(newCode(SIGN_IN_CODE_LENGTH)),
                    now,
                    now + SIGN_IN_CODE_MS,
                );
                // Looked up and sent only once the answer is out (setImmediate runs
                // after this request's response), so it takes as long whatever the account.
                const send = async () => {
                    const target = await deps.codeTarget(email);
                    if (!target) {
                        return;
                    }
                    const code = newCode(SIGN_IN_CODE_LENGTH);
                    deps.db()
                        .prepare(
                            'UPDATE auth_device_code SET codeHash = ?, userId = ?, signInMethod = ?, recipient = ? WHERE id = ? AND usedAt IS NULL',
                        )
                        .run(sha256(code), target.accountId, target.method, target.recipient, requestId);
                    const openUrl = appLink(
                        { kind: 'c', variant, host: new URL(deps.origin).host, fields: { code } },
                        deps.linkHostFor(variant),
                    );
                    await target.deliver({ kind: 'code', code, openUrl, expiresAt: new Date(now + SIGN_IN_CODE_MS) });
                };
                setImmediate(() => {
                    send().catch(() => {
                        // Never in the answer, and never with the code or the address.
                        console.warn('Auth: a sign-in code could not be sent.');
                    });
                });
                return ctx.json({ requestId });
            }),
            deviceCodeRedeem: createAuthEndpoint('/device/code/redeem', { method: 'POST' }, async (ctx) => {
                const parsed = codeRedeemBodySchema.safeParse(ctx.body);
                if (!parsed.success) {
                    throw refuse('BAD_REQUEST', 'code_invalid', 'This code is not valid.');
                }
                const { requestId, code, verifier, installId, label, variant } = parsed.data;
                const now = Date.now();
                const db = deps.db();
                // A try counts before the code is compared; the fifth is the last.
                const row = db
                    .prepare(
                        'UPDATE auth_device_code SET tries = tries + 1 WHERE id = ? AND usedAt IS NULL AND tries < ? AND expiresAt > ? RETURNING *',
                    )
                    .get(requestId, CODE_TRIES, now) as CodeRow | undefined;
                if (!row) {
                    const stale = db
                        .prepare('SELECT expiresAt, tries FROM auth_device_code WHERE id = ?')
                        .get(requestId) as { expiresAt: number; tries: number } | undefined;
                    if (stale && stale.expiresAt <= now) {
                        throw refuse('BAD_REQUEST', 'code_expired', 'This code has expired. Ask for a new one.');
                    }
                    throw refuse(
                        stale && stale.tries >= CODE_TRIES ? 'TOO_MANY_REQUESTS' : 'BAD_REQUEST',
                        stale && stale.tries >= CODE_TRIES ? 'too_many' : 'code_invalid',
                        'This code is not valid. Ask for a new one.',
                    );
                }
                const typed = Buffer.from(sha256(code));
                const stored = Buffer.from(row.codeHash);
                if (typed.length !== stored.length || !timingSafeEqual(typed, stored)) {
                    throw refuse('BAD_REQUEST', 'code_invalid', 'That code is not right.');
                }
                const used = db
                    .prepare('UPDATE auth_device_code SET usedAt = ? WHERE id = ? AND usedAt IS NULL RETURNING id')
                    .get(now, requestId);
                if (!used || !row.userId || !row.signInMethod || !row.recipient) {
                    throw refuse('BAD_REQUEST', 'code_invalid', 'This code is not valid. Ask for a new one.');
                }
                if (!verifierMatches(verifier, row.challenge)) {
                    throw refuse('BAD_REQUEST', 'code_invalid', 'This code is not valid. Ask for a new one.');
                }
                if (variant !== row.variant) {
                    throw refuse('BAD_REQUEST', 'wrong_variant', 'This code was made for another build of the app.');
                }
                const userId = row.userId;
                const method = row.signInMethod as CodeTarget['method'];
                const recipient = row.recipient;
                const unreached = () =>
                    refuse('FORBIDDEN', 'not_authorized', 'This code’s channel no longer reaches the account.');
                if (!(await deps.channelReaches(userId, method, recipient))) {
                    throw unreached();
                }
                const { deviceId, session, user } = await signInDevice(
                    ctx,
                    {
                        userId: row.userId,
                        sessionId: null,
                        signInMethod: row.signInMethod,
                        label,
                        installId,
                        platform: row.platform,
                        variant: row.variant,
                    },
                    now,
                    undefined,
                    // An unlink or relink while the session was being made wins too.
                    async () => ((await deps.channelReaches(userId, method, recipient)) ? null : unreached()),
                );
                await setSessionCookie(ctx, { session, user });
                try {
                    deps.signedIn({ accountId: row.userId, deviceId, label, method: row.signInMethod });
                } catch {
                    // The notice and audit never undo a sign-in.
                }
                return ctx.json({ deviceId });
            }),
            // CB-570: native Google and Apple sign-in. A nonce first: a sign-in's
            // binds no session, a link's binds the signed-in session asking.
            deviceSocialStart: createAuthEndpoint('/device/social/start', { method: 'POST' }, async (ctx) => {
                const found = await getSessionFromCtx(ctx).catch(() => null);
                const started = await deps.social.start(
                    ctx.body,
                    found ? { id: (found.session as { id: string }).id } : null,
                );
                if (!started.ok) {
                    throw socialError(started);
                }
                return ctx.json(started.answer);
            }),
            deviceSocialRedeem: createAuthEndpoint('/device/social/redeem', { method: 'POST' }, async (ctx) => {
                const redeemed = await deps.social.redeem(ctx.body);
                if (!redeemed.ok) {
                    throw socialError(redeemed);
                }
                if (deps.isBanned(redeemed.accountId)) {
                    throw new APIError('FORBIDDEN', { message: 'This account is deactivated.', code: 'deactivated' });
                }
                const now = Date.now();
                const { deviceId, session, user } = await signInDevice(
                    ctx,
                    {
                        userId: redeemed.accountId,
                        sessionId: null,
                        signInMethod: redeemed.provider,
                        label: redeemed.label,
                        installId: redeemed.installId,
                        platform: redeemed.platform,
                        variant: redeemed.variant,
                    },
                    now,
                    // An unlink (or a relink elsewhere) while the session was being made wins.
                    () =>
                        deps.social.linkedAccount(redeemed.provider, redeemed.sub) === redeemed.accountId
                            ? null
                            : new APIError('NOT_FOUND', {
                                  message: 'This account is no longer linked.',
                                  code: 'not_linked',
                              }),
                );
                await setSessionCookie(ctx, { session, user });
                try {
                    deps.signedIn({
                        accountId: redeemed.accountId,
                        deviceId,
                        label: redeemed.label,
                        method: redeemed.provider,
                    });
                } catch {
                    // The notice and audit never undo a sign-in.
                }
                return ctx.json({ deviceId });
            }),
            deviceRedeem: createAuthEndpoint('/device/redeem', { method: 'POST' }, async (ctx) => {
                const parsed = deviceRedeemBodySchema.safeParse(ctx.body);
                if (!parsed.success) {
                    throw refuse('BAD_REQUEST', 'code_invalid', 'This code is not valid.');
                }
                const { code, verifier, installId, label, variant } = parsed.data;
                const now = Date.now();
                const db = deps.db();
                // Used up in the statement that finds it: two redeems can't both win,
                // and whatever is wrong below leaves it used.
                const row = db
                    .prepare(
                        'UPDATE auth_device_request SET usedAt = ? WHERE codeHash = ? AND usedAt IS NULL RETURNING *',
                    )
                    .get(now, sha256(code)) as RequestRow | undefined;
                if (!row || !row.userId || !row.signInMethod) {
                    throw refuse('BAD_REQUEST', 'code_invalid', 'This code is not valid, or was used already.');
                }
                if ((row.codeExpiresAt ?? 0) <= now) {
                    throw refuse('BAD_REQUEST', 'code_expired', 'This code has expired. Start again.');
                }
                if (!verifierMatches(verifier, row.challenge)) {
                    throw refuse('BAD_REQUEST', 'code_invalid', 'This code is not valid, or was used already.');
                }
                if (variant !== row.variant) {
                    throw refuse('BAD_REQUEST', 'wrong_variant', 'This code was made for another build of the app.');
                }
                const { deviceId, session, user } = await signInDevice(
                    ctx,
                    {
                        userId: row.userId,
                        sessionId: row.sessionId,
                        signInMethod: row.signInMethod,
                        label,
                        installId,
                        platform: row.platform,
                        variant: row.variant,
                    },
                    now,
                );
                await setSessionCookie(ctx, { session, user });
                try {
                    deps.signedIn({ accountId: row.userId, deviceId, label, method: row.signInMethod });
                } catch {
                    // The notice and audit never undo a sign-in.
                }
                return ctx.json({ deviceId });
            }),
        },
        rateLimit: [
            { pathMatcher: (path: string) => path === '/device/code/redeem', window: 60, max: 10 },
            { pathMatcher: (path: string) => path === '/device/pair/claim', window: 60, max: 10 },
            // A device polls once a second for up to 2 minutes (the per-claim limit
            // holds it to that); room for several behind one address.
            { pathMatcher: (path: string) => path === '/device/pair/redeem', window: 60, max: 600 },
            { pathMatcher: (path: string) => path === '/device/start', window: 60, max: 20 },
            { pathMatcher: (path: string) => path === '/device/redeem', window: 60, max: 10 },
            // CB-570: as the sheet's start and redeem.
            { pathMatcher: (path: string) => path === '/device/social/start', window: 60, max: 20 },
            { pathMatcher: (path: string) => path === '/device/social/redeem', window: 60, max: 10 },
        ],
    } satisfies BetterAuthPlugin;
}

function toMs(value: unknown): number {
    if (typeof value === 'number') {
        return value;
    }
    if (value instanceof Date) {
        return value.getTime();
    }
    const parsed = typeof value === 'string' ? (/^\d+$/.test(value) ? Number(value) : Date.parse(value)) : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
}
