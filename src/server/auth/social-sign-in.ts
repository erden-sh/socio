import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { AuthContext } from 'better-auth';

import { sessionAllowed, type SavedAccessPolicy, type SignInMethodId } from '@socio/shared/access-policy';
import {
    socialLinkBodySchema,
    socialNonceSchema,
    socialRedeemBodySchema,
    socialStartBodySchema,
    type AppVariant,
    type DeviceErrorCode,
    type DevicePlatform,
    type SocialLink,
    type SocialProvider,
} from '@socio/shared/device-sign-in';

import type { SocialVerifier } from './contract.js';

/**
 * The Socio app's native Google and Apple sign-in (CB-570). The app asks
 * this server for a nonce (`start`), has the platform make an ID token with
 * it, and sends the token here; a verifier (Socio's cloud services, through
 * `SocialVerifier`) checks the token and names the provider's subject. The
 * server itself holds no Google or Apple client id and calls neither.
 *
 * What makes a token made for one server useless on another: every token
 * must carry a nonce this server issued, for this provider and purpose,
 * unexpired and unused, and the nonce is used up in the one statement that
 * finds it. A sign-in finds its account only by the provider's subject in
 * an existing link: it never makes an account and never matches an email.
 * Links are made only by a signed-in person, with a nonce issued to that
 * same session.
 */

/** How long a nonce waits for its token; and how long used and expired ones are kept. */
export const SOCIAL_NONCE_MS = 5 * 60_000;
const NONCE_KEEP_MS = 24 * 60 * 60_000;

/** The Better Auth account row's `providerId` for each provider's links. */
export const NATIVE_PROVIDER_IDS: Readonly<Record<SocialProvider, string>> = {
    google: 'google-native',
    apple: 'apple-native',
};
const PROVIDER_BY_ID = new Map(Object.entries(NATIVE_PROVIDER_IDS).map(([provider, id]) => [id, provider]));
/** The provider a link's account row is for, if it is one. */
export const nativeProviderOf = (providerId: string) => PROVIDER_BY_ID.get(providerId) as SocialProvider | undefined;

export const socialNonceHash = (nonce: string) => createHash('sha256').update(nonce).digest('base64url');

/** The HTTP status of each refusal this file answers. */
const STATUS = {
    code_invalid: 400,
    not_authorized: 401,
    invalid_token: 401,
    nonce_invalid: 401,
    method_off: 403,
    deactivated: 403,
    not_linked: 404,
    already_linked_other: 409,
    last_method: 409,
    too_many: 429,
    provider_unavailable: 503,
} as const satisfies Partial<Record<DeviceErrorCode, number>>;
export type SocialRefusalCode = keyof typeof STATUS;

const WORDS: Record<SocialRefusalCode, string> = {
    code_invalid: 'This request is not valid.',
    not_authorized: 'Sign in to link an account.',
    invalid_token: 'This sign-in could not be verified. Try again.',
    nonce_invalid: 'This sign-in has expired or was used already. Try again.',
    method_off: 'This way of signing in is turned off here.',
    deactivated: 'This account is deactivated.',
    not_linked: 'No Socio account here is linked to this account. Sign in another way, then link it in Settings.',
    already_linked_other: 'This account is linked to another person here.',
    last_method: 'This is your only way to sign in. Add another before you unlink it.',
    too_many: 'Too many tries. Try again in a minute.',
    provider_unavailable: 'This way of signing in isn’t available on this server right now.',
};

/** A refusal as the app's routes answer it: `{ error, code }` with its status. */
export interface SocialRefusal {
    ok: false;
    status: (typeof STATUS)[SocialRefusalCode];
    body: { error: string; code: SocialRefusalCode };
}
export const socialRefusal = (code: SocialRefusalCode): SocialRefusal => ({
    ok: false,
    status: STATUS[code],
    body: { error: WORDS[code], code },
});

const toIso = (value: unknown) => {
    const ms =
        typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
    return new Date(Number.isFinite(ms) ? ms : Date.parse(String(value))).toISOString();
};

/**
 * Runs `work` as one unit on Better Auth's own connection, inside Better
 * Auth's transaction when one is open (as devices.ts and groups.ts do):
 * synchronous, so nothing else on the connection runs in between.
 */
function atomically<T>(db: DatabaseSync, work: () => T): T {
    db.exec('SAVEPOINT socio_social');
    try {
        const result = work();
        db.exec('RELEASE socio_social');
        return result;
    } catch (error) {
        db.exec('ROLLBACK TO socio_social');
        db.exec('RELEASE socio_social');
        throw error;
    }
}

/** Whether the body carries a nonce of the right form: a body without one is refused as `nonce_invalid`. */
const nonceOf = (body: unknown) =>
    socialNonceSchema.safeParse((body as { nonce?: unknown } | null | undefined)?.nonce).success;

/** The nonce is live for this: unused, unexpired, this provider and purpose, a link's for this session. */
const NONCE_MATCH = `nonceHash = ? AND provider = ? AND purpose = ? AND usedAt IS NULL AND expiresAt > ? AND (purpose = 'signin' OR sessionId = ?)`;

/** The nonces, the links and the verifier, over the auth database. */
export class SocialSignIn {
    constructor(
        private readonly deps: {
            db: () => DatabaseSync;
            saved: () => SavedAccessPolicy;
            verifier: () => SocialVerifier | undefined;
            log: (line: string) => void;
        },
    ) {}

    private get db() {
        return this.deps.db();
    }

    /** The providers the verifier offers now, as it says them (null: none can be verified). */
    async config() {
        const verifier = this.deps.verifier();
        if (!verifier) {
            return null;
        }
        try {
            return await verifier.config();
        } catch {
            return null;
        }
    }

    /** The providers the app may offer: verified now, and on in the access policy. */
    async offered(): Promise<SocialProvider[]> {
        const config = await this.config();
        const saved = this.deps.saved();
        return (['google', 'apple'] as const).filter(
            (provider) => !!config?.[provider] && sessionAllowed(provider, saved),
        );
    }

    /** A new nonce: for a sign-in, bound to no session; for a link, to the session that asked. */
    async start(
        body: unknown,
        session: { id: string } | null,
    ): Promise<{ ok: true; answer: { nonce: string; expiresAt: string; serverClientId?: string } } | SocialRefusal> {
        const parsed = socialStartBodySchema.safeParse(body);
        if (!parsed.success) {
            return socialRefusal('code_invalid');
        }
        const { provider, purpose } = parsed.data;
        if (!sessionAllowed(provider, this.deps.saved())) {
            return socialRefusal('method_off');
        }
        if (purpose === 'link' && !session) {
            return socialRefusal('not_authorized');
        }
        const config = await this.config();
        const offered = config?.[provider];
        if (!offered) {
            return socialRefusal('provider_unavailable');
        }
        const now = Date.now();
        const nonce = randomBytes(32).toString('base64url');
        atomically(this.db, () => {
            this.db.prepare('DELETE FROM auth_social_nonce WHERE expiresAt < ?').run(now - NONCE_KEEP_MS);
            this.db
                .prepare(
                    'INSERT INTO auth_social_nonce(nonceHash, provider, purpose, sessionId, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?)',
                )
                .run(
                    socialNonceHash(nonce),
                    provider,
                    purpose,
                    purpose === 'link' ? session!.id : null,
                    now,
                    now + SOCIAL_NONCE_MS,
                );
        });
        return {
            ok: true,
            answer: {
                nonce,
                expiresAt: new Date(now + SOCIAL_NONCE_MS).toISOString(),
                ...(provider === 'google' && 'serverClientId' in offered
                    ? { serverClientId: offered.serverClientId }
                    : {}),
            },
        };
    }

    private live(nonce: string, provider: SocialProvider, purpose: 'signin' | 'link', sessionId: string | null) {
        return !!this.db
            .prepare(`SELECT 1 FROM auth_social_nonce WHERE ${NONCE_MATCH}`)
            .get(socialNonceHash(nonce), provider, purpose, Date.now(), sessionId);
    }

    /**
     * Uses the nonce up, in one statement: of two requests with one nonce,
     * one wins. Sync, so a caller's unit of work holds it with what follows.
     */
    private claim(nonce: string, provider: SocialProvider, purpose: 'signin' | 'link', sessionId: string | null) {
        const now = Date.now();
        return !!this.db
            .prepare(`UPDATE auth_social_nonce SET usedAt = ? WHERE ${NONCE_MATCH} RETURNING nonceHash`)
            .get(now, socialNonceHash(nonce), provider, purpose, now, sessionId);
    }

    /**
     * The token checked for this nonce: the nonce first (a cheap refusal
     * for one this server never issued, with no call out), then the
     * verifier, whose answer must name this provider and this nonce.
     */
    private async verified(
        input: { provider: SocialProvider; idToken: string; nonce: string },
        purpose: 'signin' | 'link',
        sessionId: string | null,
    ): Promise<{ ok: true; sub: string; email?: string } | SocialRefusal> {
        if (!this.live(input.nonce, input.provider, purpose, sessionId)) {
            this.deps.log('Social sign-in: refused (nonce).');
            return socialRefusal('nonce_invalid');
        }
        const verifier = this.deps.verifier();
        if (!verifier) {
            return socialRefusal('provider_unavailable');
        }
        let verdict: Awaited<ReturnType<SocialVerifier['verify']>>;
        try {
            verdict = await verifier.verify(input);
        } catch {
            return socialRefusal('provider_unavailable');
        }
        if (!verdict.ok) {
            return socialRefusal(verdict.code);
        }
        if (verdict.provider !== input.provider || verdict.nonce !== input.nonce || !verdict.sub) {
            this.deps.log('Social sign-in: refused (the verifier named another provider or nonce).');
            return socialRefusal('invalid_token');
        }
        return { ok: true, sub: verdict.sub, ...(verdict.email ? { email: verdict.email } : {}) };
    }

    /** The account linked to this subject, by the link alone. */
    linkedAccount(provider: SocialProvider, sub: string): string | undefined {
        return (
            this.db
                .prepare('SELECT userId FROM auth_account WHERE providerId = ? AND accountId = ?')
                .get(NATIVE_PROVIDER_IDS[provider], sub) as { userId: string } | undefined
        )?.userId;
    }

    /**
     * A sign-in's checks up to the account: the policy, the token for a
     * sign-in nonce, the nonce used up, the link. What signs the device in
     * is the caller's (`deviceSignIn`'s), with `stillLinked` as its last check.
     */
    async redeem(body: unknown): Promise<
        | {
              ok: true;
              accountId: string;
              provider: SocialProvider;
              sub: string;
              installId: string;
              platform: DevicePlatform;
              label: string;
              variant: AppVariant | null;
          }
        | SocialRefusal
    > {
        const parsed = socialRedeemBodySchema.safeParse(body);
        if (!parsed.success) {
            return socialRefusal(nonceOf(body) ? 'code_invalid' : 'nonce_invalid');
        }
        const { provider, idToken, nonce, installId, platform, label, variant } = parsed.data;
        if (!sessionAllowed(provider, this.deps.saved())) {
            return socialRefusal('method_off');
        }
        const checked = await this.verified({ provider, idToken, nonce }, 'signin', null);
        if (!checked.ok) {
            return checked;
        }
        // Used up whatever follows: a refusal below leaves it used.
        if (!this.claim(nonce, provider, 'signin', null)) {
            this.deps.log('Social sign-in: refused (nonce used meanwhile).');
            return socialRefusal('nonce_invalid');
        }
        const accountId = this.linkedAccount(provider, checked.sub);
        if (!accountId) {
            return socialRefusal('not_linked');
        }
        return {
            ok: true,
            accountId,
            provider,
            sub: checked.sub,
            installId,
            platform,
            label: label ?? 'Socio app',
            variant: variant ?? null,
        };
    }

    /**
     * Links this Google or Apple account to the session's account. The
     * nonce must have been issued to this session for a link; it is used
     * up in the same unit of work as the link.
     */
    async link(
        body: unknown,
        session: { sessionId: string; accountId: string },
    ): Promise<{ ok: true; changed: boolean; link: SocialLink } | SocialRefusal> {
        const parsed = socialLinkBodySchema.safeParse(body);
        if (!parsed.success) {
            return socialRefusal(nonceOf(body) ? 'code_invalid' : 'nonce_invalid');
        }
        const { provider, idToken, nonce } = parsed.data;
        if (!sessionAllowed(provider, this.deps.saved())) {
            return socialRefusal('method_off');
        }
        const checked = await this.verified({ provider, idToken, nonce }, 'link', session.sessionId);
        if (!checked.ok) {
            return checked;
        }
        const providerId = NATIVE_PROVIDER_IDS[provider];
        return atomically(this.db, () => {
            if (!this.claim(nonce, provider, 'link', session.sessionId)) {
                return socialRefusal('nonce_invalid');
            }
            const existing = this.db
                .prepare('SELECT userId, createdAt, linkEmail FROM auth_account WHERE providerId = ? AND accountId = ?')
                .get(providerId, checked.sub) as
                | { userId: string; createdAt: unknown; linkEmail: string | null }
                | undefined;
            if (existing && existing.userId !== session.accountId) {
                return socialRefusal('already_linked_other');
            }
            if (existing) {
                return {
                    ok: true as const,
                    changed: false,
                    link: {
                        provider,
                        linkedAt: toIso(existing.createdAt),
                        ...(existing.linkEmail ? { email: existing.linkEmail } : {}),
                    },
                };
            }
            // One link per provider and account: a new one replaces the old.
            this.db
                .prepare('DELETE FROM auth_account WHERE userId = ? AND providerId = ?')
                .run(session.accountId, providerId);
            const now = new Date().toISOString();
            this.db
                .prepare(
                    'INSERT INTO auth_account(id, accountId, providerId, userId, linkEmail, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
                )
                .run(randomUUID(), checked.sub, providerId, session.accountId, checked.email ?? null, now, now);
            return {
                ok: true as const,
                changed: true,
                link: { provider, linkedAt: now, ...(checked.email ? { email: checked.email } : {}) },
            };
        });
    }

    /** The account's links, for the person. */
    links(accountId: string): SocialLink[] {
        const rows = this.db
            .prepare(
                `SELECT providerId, createdAt, linkEmail FROM auth_account WHERE userId = ? AND providerId IN ('google-native', 'apple-native') ORDER BY providerId`,
            )
            .all(accountId) as { providerId: string; createdAt: unknown; linkEmail: string | null }[];
        return rows.flatMap((row) => {
            const provider = nativeProviderOf(row.providerId);
            return provider
                ? [{ provider, linkedAt: toIso(row.createdAt), ...(row.linkEmail ? { email: row.linkEmail } : {}) }]
                : [];
        });
    }

    /**
     * Unlinks the provider from the account, unless that leaves it no way
     * to sign in (`otherWayIn`, read in the same unit of work).
     */
    async unlink(
        accountId: string,
        provider: SocialProvider,
        otherWayIn: () => boolean,
    ): Promise<{ ok: true } | SocialRefusal> {
        const providerId = NATIVE_PROVIDER_IDS[provider];
        return atomically(this.db, () => {
            const row = this.db
                .prepare('SELECT id FROM auth_account WHERE userId = ? AND providerId = ?')
                .get(accountId, providerId) as { id: string } | undefined;
            if (!row) {
                return socialRefusal('not_linked');
            }
            if (!otherWayIn()) {
                return socialRefusal('last_method');
            }
            this.db.prepare('DELETE FROM auth_account WHERE id = ?').run(row.id);
            return { ok: true as const };
        });
    }
}

/** What `deviceSignIn` hands the social redeem: its own device session maker. */
export type SignInDevice = (
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
    commit?: () => unknown,
) => Promise<{ deviceId: string; session: unknown; user: unknown }>;
