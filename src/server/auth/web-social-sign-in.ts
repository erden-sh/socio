import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { BetterAuthPlugin } from 'better-auth';
import { z } from 'zod';

import { sessionAllowed, type SavedAccessPolicy } from '@socio/shared/access-policy';
import type { SocialLink, SocialProvider } from '@socio/shared/device-sign-in';
import {
    WEB_SOCIAL_LINK_HOME,
    webSocialStartBodySchema,
    type WebSocialLinkResult,
    type WebSocialSignInError,
} from '@socio/shared/web-social';

import type { SocialVerifier } from './contract.js';
import { atomically, socialNonceHash, socialRefusal, type SocialRefusal, type SocialSignIn } from './social-sign-in.js';

/**
 * Google and Apple on the website, through Socio's sign-in page
 * (memos/proposals/cloud/AUTH-WEB-SOCIAL.md). The server starts every flow:
 * it makes a nonce as the app's sign-in does, binds it to this browser with
 * a cookie (`binding`, only its SHA-256 stored), and has the cloud make a
 * one-time page for it. The browser comes back with a sealed result, which
 * the cloud redeems for the same statement the app's sign-in gets; it
 * counts only for the nonce on this browser's row, for that row's provider.
 *
 * What stops a login CSRF (an attacker's result in a victim's browser): the
 * result's statement names the attacker's nonce, which is on the
 * attacker's row, not on the row the victim's cookie names. A link's nonce
 * is bound to the session that asked, as the app's is, and a link is made
 * by the same unit of work as the app's (`SocialSignIn.linkChecked`).
 * Nothing about `next` reaches the cloud.
 */

/** How long a website flow may take: a password and two-factor at the provider fit (the app's stays 5 minutes). */
export const WEB_SOCIAL_NONCE_MS = 10 * 60_000;
/** Website flows waiting at once, for the whole server: a start beyond them is refused as too many. */
export const WEB_SOCIAL_PENDING_MAX = 200;
const NONCE_KEEP_MS = 24 * 60 * 60_000;

const PURPOSE = { signin: 'web-signin', link: 'web-link' } as const;
type RowPurpose = (typeof PURPOSE)[keyof typeof PURPOSE];

interface Row {
    nonceHash: string;
    provider: SocialProvider;
    purpose: RowPurpose;
    sessionId: string | null;
    next: string;
    expiresAt: number;
    redeemStartedAt: number | null;
    usedAt: number | null;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');
/** A binding cookie as this server makes them: 32 random bytes, base64url. */
const BINDING = /^[A-Za-z0-9_-]{43}$/;

/** A leading `//`, any backslash, any control character. */
// oxlint-disable-next-line no-control-regex -- control characters are what this refuses
const UNSAFE = /^\/\/|[\\\u0000-\u001f\u007f]/;

/**
 * Where to go after: a path on this origin, as given, else `fallback`.
 * Normalized first (`/a/../b` is `/b`), then the result is checked, so
 * nothing that normalizes to another host passes (`/a/..//evil` would be
 * `//evil`, protocol-relative). Refused: anything absolute or
 * protocol-relative, backslashes (which browsers read as slashes) and
 * slashes or backslashes percent-encoded at the start, control
 * characters, and the API.
 */
export function safeNext(value: unknown, origin: string, fallback = '/'): string {
    if (typeof value !== 'string' || !value.startsWith('/') || value.length > 2048 || UNSAFE.test(value)) {
        return fallback;
    }
    let url: URL;
    try {
        url = new URL(value, origin);
    } catch {
        return fallback;
    }
    const next = `${url.pathname}${url.search}${url.hash}`;
    if (
        url.origin !== new URL(origin).origin ||
        !next.startsWith('/') ||
        UNSAFE.test(next) ||
        /^\/(\/|%2f|%5c)/i.test(next) ||
        url.pathname === '/api' ||
        url.pathname.startsWith('/api/') ||
        // Checked as the redirect will be read: still this origin.
        new URL(next, origin).origin !== new URL(origin).origin
    ) {
        return fallback;
    }
    return next;
}

/** Where the landing page goes on: the one place a result is redeemed. */
export const WEB_SOCIAL_COMPLETE_PATH = '/api/auth/web/social/complete';

const escapeHtml = (text: string) => text.replace(/[&"'<>]/g, (char) => `&#${char.charCodeAt(0)};`);

/**
 * The page the browser lands on back from Socio's sign-in page: a form of
 * this origin, sent at once by a script with this response's CSP nonce,
 * and a Continue button without JavaScript. The form's request is
 * same-origin, so the session cookie (SameSite=Strict) comes along, which
 * the cross-site return itself can't carry.
 */
export function webSocialLanding(action: string, fields: Record<string, string | undefined>, nonce: string): string {
    const inputs = Object.entries(fields)
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
        .join('');
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Signing in</title></head><body style="font-family:system-ui,sans-serif;margin:2rem"><form id="continue" method="get" action="${escapeHtml(action)}">${inputs}<p>Finishing signing in…</p><button type="submit">Continue</button></form><script nonce="${escapeHtml(nonce)}">document.getElementById('continue').submit()</script></body></html>`;
}

export type WebSocialStarted = { ok: true; url: string; binding: string; maxAgeS: number };
export type WebSocialStartRefusal = SocialRefusal & { retryAfterS?: number };

/** How a callback ended: a sign-in's account, a link made, or why not, with where to go. */
export type WebSocialFinish =
    | { ok: true; purpose: 'signin'; accountId: string; provider: SocialProvider; sub: string; next: string }
    | {
          ok: true;
          purpose: 'link';
          next: string;
          link: SocialLink;
          changed: boolean;
          sessionsEnded: number;
          accountId: string;
      }
    | { ok: false; purpose: 'signin'; code: WebSocialSignInError; next: string }
    | { ok: false; purpose: 'link'; code: Exclude<WebSocialLinkResult, 'linked'>; next: string };

/** What the provider's page may send back as `?error=`: a closed list, anything else is a failure. */
const RETURNED_ERRORS = new Set(['canceled', 'provider_unavailable', 'expired']);

export class WebSocialSignIn {
    constructor(
        private readonly deps: {
            db: () => DatabaseSync;
            saved: () => SavedAccessPolicy;
            verifier: () => SocialVerifier | undefined;
            social: SocialSignIn;
            origin: string;
            log: (line: string) => void;
            now?: () => number;
        },
    ) {}

    private get db() {
        return this.deps.db();
    }

    private now() {
        return this.deps.now?.() ?? Date.now();
    }

    /**
     * The providers the website may offer: on in the access policy, and
     * offered for the web by the cloud now (which needs the connection).
     * The app's list (`SocialSignIn.offered`) is not this one.
     */
    async offered(): Promise<SocialProvider[]> {
        const verifier = this.deps.verifier();
        if (!verifier?.webStart || !verifier.redeemWeb) {
            return [];
        }
        const config = await this.deps.social.config();
        const saved = this.deps.saved();
        return (['google', 'apple'] as const).filter(
            (provider) => config?.[provider]?.web === true && sessionAllowed(provider, saved),
        );
    }

    /**
     * A new flow: the nonce and binding stored, the cloud's page made for
     * the nonce. A link needs the signed-in session, and binds it.
     */
    async start(
        body: unknown,
        session: { sessionId: string; accountId: string } | null,
    ): Promise<WebSocialStarted | WebSocialStartRefusal> {
        const parsed = webSocialStartBodySchema.safeParse(body);
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
        const verifier = this.deps.verifier();
        if (!verifier?.webStart || !(await this.offered()).includes(provider)) {
            return socialRefusal('provider_unavailable');
        }
        const now = this.now();
        const nonce = randomBytes(32).toString('base64url');
        const binding = randomBytes(32).toString('base64url');
        const next = safeNext(parsed.data.next, this.deps.origin, purpose === 'link' ? WEB_SOCIAL_LINK_HOME : '/');
        const stored = atomically(this.db, () => {
            this.db.prepare('DELETE FROM auth_social_web_nonce WHERE expiresAt < ?').run(now - NONCE_KEEP_MS);
            const pending = this.db
                .prepare('SELECT COUNT(*) AS n FROM auth_social_web_nonce WHERE usedAt IS NULL AND expiresAt > ?')
                .get(now) as { n: number };
            if (Number(pending.n) >= WEB_SOCIAL_PENDING_MAX) {
                return false;
            }
            this.db
                .prepare(
                    'INSERT INTO auth_social_web_nonce(nonceHash, bindHash, provider, purpose, sessionId, next, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                )
                .run(
                    socialNonceHash(nonce),
                    sha256(binding),
                    provider,
                    PURPOSE[purpose],
                    purpose === 'link' ? session!.sessionId : null,
                    next,
                    now,
                    now + WEB_SOCIAL_NONCE_MS,
                );
            return true;
        });
        if (!stored) {
            this.deps.log('Social sign-in: a website start was refused (too many waiting).');
            return socialRefusal('too_many');
        }
        let page: Awaited<ReturnType<NonNullable<SocialVerifier['webStart']>>>;
        try {
            page = await verifier.webStart({ provider, purpose, nonce });
        } catch {
            page = { ok: false, code: 'provider_unavailable' };
        }
        if (!page.ok) {
            // A start that went nowhere leaves nothing waiting.
            this.db.prepare('DELETE FROM auth_social_web_nonce WHERE nonceHash = ?').run(socialNonceHash(nonce));
            return page.code === 'too_many'
                ? { ...socialRefusal('too_many'), ...(page.retryAfterS ? { retryAfterS: page.retryAfterS } : {}) }
                : socialRefusal('provider_unavailable');
        }
        return { ok: true, url: page.url, binding, maxAgeS: WEB_SOCIAL_NONCE_MS / 1000 };
    }

    /**
     * The browser's return: its binding cookie, and the cloud's result or a
     * provider's error. The row the cookie names decides the purpose, the
     * provider and where to go; nothing the request says does.
     */
    async finish(
        input: { binding?: string; result?: string; error?: string },
        session: { sessionId: string; accountId: string } | null,
    ): Promise<WebSocialFinish> {
        const now = this.now();
        const row =
            input.binding && BINDING.test(input.binding)
                ? (this.db
                      .prepare('SELECT * FROM auth_social_web_nonce WHERE bindHash = ?')
                      .get(sha256(input.binding)) as Row | undefined)
                : undefined;
        // No row: a signed-in person was linking, else signing in.
        const purpose: 'signin' | 'link' = row
            ? row.purpose === 'web-link'
                ? 'link'
                : 'signin'
            : session
              ? 'link'
              : 'signin';
        const next = row?.next ?? (purpose === 'link' ? WEB_SOCIAL_LINK_HOME : '/');
        type Shared = WebSocialSignInError & Exclude<WebSocialLinkResult, 'linked'>;
        const fail = (code: Shared): WebSocialFinish =>
            purpose === 'link' ? { ok: false, purpose, code, next } : { ok: false, purpose, code, next };
        const failLink = (code: Exclude<WebSocialLinkResult, 'linked'>): WebSocialFinish => ({
            ok: false,
            purpose: 'link',
            code,
            next,
        });
        if (!row || row.usedAt !== null || row.redeemStartedAt !== null || row.expiresAt <= now) {
            this.deps.log('Social sign-in: a website return was refused (no live flow for this browser).');
            return fail('nonce_invalid');
        }
        const claim = () =>
            !!this.db
                .prepare(
                    'UPDATE auth_social_web_nonce SET usedAt = ? WHERE nonceHash = ? AND usedAt IS NULL AND expiresAt > ? RETURNING nonceHash',
                )
                .get(this.now(), row.nonceHash, this.now());
        /** The flow's spent: no second try with this binding, whatever happened. */
        const spend = () =>
            this.db
                .prepare('UPDATE auth_social_web_nonce SET usedAt = ? WHERE nonceHash = ? AND usedAt IS NULL')
                .run(this.now(), row.nonceHash);
        // One attempt per flow, taken before anything goes out: of two returns
        // with one binding, one goes on; a refused redeem isn't tried again.
        const taken = !!this.db
            .prepare(
                'UPDATE auth_social_web_nonce SET redeemStartedAt = ? WHERE nonceHash = ? AND redeemStartedAt IS NULL AND usedAt IS NULL AND expiresAt > ? RETURNING nonceHash',
            )
            .get(this.now(), row.nonceHash, this.now());
        if (!taken) {
            this.deps.log('Social sign-in: a website return was refused (its flow was taken already).');
            return fail('nonce_invalid');
        }
        if (input.error !== undefined || !input.result) {
            // The provider's page came back without a result: the flow is over.
            claim();
            const code = input.error && RETURNED_ERRORS.has(input.error) ? input.error : 'failed';
            return fail(code as 'canceled' | 'provider_unavailable' | 'expired' | 'failed');
        }
        if (purpose === 'link' && (!session || session.sessionId !== row.sessionId)) {
            spend();
            this.deps.log('Social sign-in: a website link was refused (another session).');
            return failLink('not_authorized');
        }
        if (!sessionAllowed(row.provider, this.deps.saved())) {
            claim();
            return fail('method_off');
        }
        const verifier = this.deps.verifier();
        if (!verifier?.redeemWeb) {
            spend();
            return fail('provider_unavailable');
        }
        let verdict: Awaited<ReturnType<NonNullable<SocialVerifier['redeemWeb']>>>;
        try {
            verdict = await verifier.redeemWeb({ provider: row.provider, result: input.result });
        } catch {
            verdict = { ok: false, code: 'provider_unavailable' };
        }
        if (!verdict.ok) {
            spend();
            return fail(verdict.code === 'invalid_token' ? 'failed' : verdict.code);
        }
        // The statement must be for this browser's flow: its nonce, its provider.
        if (verdict.provider !== row.provider || socialNonceHash(verdict.nonce) !== row.nonceHash || !verdict.sub) {
            spend();
            this.deps.log('Social sign-in: a website return was refused (the statement is for another flow).');
            return fail('nonce_invalid');
        }
        if (purpose === 'link') {
            const linked = this.deps.social.linkChecked(
                row.provider,
                { sub: verdict.sub, ...(verdict.email ? { email: verdict.email } : {}) },
                session!,
                claim,
            );
            if (!linked.ok) {
                const code = linked.body.code;
                return failLink(
                    code === 'already_linked_other' ||
                        code === 'method_off' ||
                        code === 'deactivated' ||
                        code === 'not_authorized' ||
                        code === 'nonce_invalid'
                        ? code
                        : 'failed',
                );
            }
            return { ok: true, purpose: 'link', next, accountId: session!.accountId, ...linkedParts(linked) };
        }
        // Used up whatever follows: a refusal below leaves it used.
        if (!claim()) {
            return fail('nonce_invalid');
        }
        const accountId = this.deps.social.linkedAccount(row.provider, verdict.sub);
        if (!accountId) {
            return { ok: false, purpose: 'signin', code: 'not_linked', next };
        }
        return { ok: true, purpose: 'signin', accountId, provider: row.provider, sub: verdict.sub, next };
    }
}

const linkedParts = (linked: { link: SocialLink; changed: boolean; sessionsEnded: number }) => ({
    link: linked.link,
    changed: linked.changed,
    sessionsEnded: linked.sessionsEnded,
});

/** The plugin endpoint that finishes a return: only the callback route calls it (`auth.api`), never a browser. */
export const WEB_SOCIAL_FINISH_PATH = '/web/social/finish';

type AuthApi = typeof import('better-auth/api');
const finishBody = z.object({
    binding: z.string().max(8192).optional(),
    result: z.string().max(8192).optional(),
    error: z.string().max(8192).optional(),
});
type Cookies = typeof import('better-auth/cookies');

/** What the finish answers the callback route: how it ended, and where to go. */
export type WebSocialFinished =
    | { ok: true; purpose: 'signin'; next: string }
    | {
          ok: true;
          purpose: 'link';
          next: string;
          changed: boolean;
          sessionsEnded: number;
          accountId: string;
          provider: SocialProvider;
      }
    | Extract<WebSocialFinish, { ok: false }>;

/**
 * The finish, as a Better Auth endpoint: a sign-in's web session is made
 * here, with Better Auth's own session maker and cookie, and the session
 * hook takes its method (`google` or `apple`) from this path alone. Called
 * with the browser's cookies; the binding and result are the callback's.
 */
export function webSocialPlugin(
    { createAuthEndpoint, getSessionFromCtx }: AuthApi,
    { setSessionCookie }: Cookies,
    deps: {
        web: () => WebSocialSignIn;
        social: () => SocialSignIn;
        saved: () => SavedAccessPolicy;
        isBanned: (accountId: string) => boolean;
    },
) {
    return {
        id: 'socio-web-social',
        endpoints: {
            webSocialFinish: createAuthEndpoint(
                WEB_SOCIAL_FINISH_PATH,
                { method: 'POST', body: finishBody },
                async (ctx) => {
                    const body = ctx.body;
                    const text = (value: unknown) =>
                        typeof value === 'string' && value.length <= 8192 ? value : undefined;
                    const found = await getSessionFromCtx(ctx).catch(() => null);
                    const session =
                        found && !(found.user as { banned?: unknown }).banned
                            ? { sessionId: (found.session as { id: string }).id, accountId: found.user.id }
                            : null;
                    const done = await deps
                        .web()
                        .finish(
                            { binding: text(body.binding), result: text(body.result), error: text(body.error) },
                            session,
                        );
                    if (!done.ok) {
                        return ctx.json<WebSocialFinished>(done);
                    }
                    if (done.purpose === 'link') {
                        return ctx.json<WebSocialFinished>({
                            ok: true,
                            purpose: 'link',
                            next: done.next,
                            changed: done.changed,
                            sessionsEnded: done.sessionsEnded,
                            accountId: done.accountId,
                            provider: done.link.provider,
                        });
                    }
                    const refused = (code: WebSocialSignInError) =>
                        ctx.json<WebSocialFinished>({ ok: false, purpose: 'signin', code, next: done.next });
                    /** Why the sign-in no longer stands: an unlink, a ban or a policy change meanwhile. */
                    const standing = (): WebSocialSignInError | null =>
                        deps.isBanned(done.accountId)
                            ? 'deactivated'
                            : !sessionAllowed(done.provider, deps.saved())
                              ? 'method_off'
                              : deps.social().linkedAccount(done.provider, done.sub) !== done.accountId
                                ? 'not_linked'
                                : null;
                    const before = standing();
                    if (before) {
                        return refused(before);
                    }
                    const internal = ctx.context.internalAdapter;
                    let made: Awaited<ReturnType<typeof internal.createSession>> | null = null;
                    try {
                        made = await internal.createSession(
                            done.accountId,
                            false,
                            { signInMethod: done.provider },
                            true,
                        );
                    } catch {
                        made = null;
                    }
                    const user = made && (await internal.findUserById(done.accountId));
                    if (!made || !user) {
                        return refused(standing() ?? 'failed');
                    }
                    // Checked again before the cookie: what landed while the session was made wins.
                    const after = standing();
                    if (after) {
                        await internal.deleteSession(made.token);
                        return refused(after);
                    }
                    await setSessionCookie(ctx, { session: made, user });
                    return ctx.json<WebSocialFinished>({ ok: true, purpose: 'signin', next: done.next });
                },
            ),
        },
    } satisfies BetterAuthPlugin;
}
