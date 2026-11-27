/**
 * Native Google and Apple sign-in through Socio's cloud services (CB-570):
 * the server never talks to Google or Apple, and holds none of their
 * client ids. The app's ID token goes to the issuer's verification
 * service, which answers a statement it signs (`typ: social+jwt`) naming
 * the person. This file is the one adapter: the auth feature sees only
 * `SocialVerificationShape` (contract.ts).
 *
 * Wire (the issuer's origin, the deployment's access token for it, as sync
 * uses):
 *
 * - `GET /v1/social/config` → `{google?: {serverClientId}, apple?: {}}`.
 *   Kept 10 minutes; a failure keeps the last good answer up to an hour.
 * - `POST /v1/social/verify` `{provider, idToken, nonce}` (the raw nonce)
 *   → 200 `{statement}`, a compact JWS: header `alg: EdDSA`, `typ: social+jwt`,
 *   `kid`; claims `iss` (the issuer), `aud` (this deployment's id),
 *   `provider`, `sub`, `nonce`, `iat`, `exp` (`iat` + 60 s), and `email`,
 *   `emailVerified` when the token had them. A 403 (`insufficient_scope`)
 *   means the deployment lacks `social:verify`.
 *
 * Only while the connection is connected (not paused) with the
 * `social:verify` scope. The ID token, its email and the statement are
 * never logged: a line names the check that failed, nothing more.
 */
import {
    SOCIAL_VERIFY_SCOPE,
    type CloudShape,
    type SocialProviderConfig,
    type SocialProviderId,
    type SocialRefusal,
    type SocialVerdict,
    type SocialVerificationShape,
} from './contract.js';
import { bounded } from './issuer-client.js';
import { verifyIssuerJws } from './issuer-jws.js';

const MINUTE = 60_000;
/** The config is read again after this long, and a last good one is kept this long while reads fail. */
export const SOCIAL_CONFIG_FRESH_MS = 10 * MINUTE;
export const SOCIAL_CONFIG_KEEP_MS = 60 * MINUTE;
/** After a failed config read, none is tried again this soon. */
const CONFIG_RETRY_MS = 30_000;
/** A verification waits this long for the service. */
const VERIFY_TIMEOUT_MS = 10_000;
/** Clock slack for `iat` and `exp`, and the longest a statement may live. */
const SKEW_S = 60;
const MAX_LIFE_S = 120;
/** The service's `Retry-After`, kept within these bounds (a short backoff). */
const RETRY_AFTER_MIN = 1_000;
const RETRY_AFTER_MAX = 5 * MINUTE;
const RETRY_AFTER_DEFAULT = 30_000;

export const SOCIAL_STATEMENT_TYP = 'social+jwt';

export interface CloudSocialOptions {
    cloud: Pick<CloudShape, 'status' | 'token' | 'issuerKey'>;
    /** The issuer's origin: the service lives there. */
    issuer: string;
    /** Operational lines only: never a token, an email or a statement. */
    log(line: string): void;
    transport?: typeof fetch;
    now?: () => number;
}

type Answer = { kind: 'answer'; response: Response } | { kind: 'unavailable'; why: string };

const text = (value: unknown, max: number) =>
    typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;

function retryAfter(header: string | null, now: number): number {
    let ms = RETRY_AFTER_DEFAULT;
    if (header && /^\d+$/.test(header.trim())) {
        ms = Number(header.trim()) * 1000;
    } else if (header) {
        const at = Date.parse(header);
        ms = Number.isNaN(at) ? RETRY_AFTER_DEFAULT : at - now;
    }
    return Math.min(RETRY_AFTER_MAX, Math.max(RETRY_AFTER_MIN, ms));
}

/** The config's answer, or undefined when it isn't one. */
function parseConfig(value: unknown): SocialProviderConfig | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    const answer = value as Record<string, unknown>;
    const config: SocialProviderConfig = {};
    const google = answer.google as Record<string, unknown> | undefined;
    if (google !== undefined) {
        const serverClientId = text(google?.serverClientId, 300);
        if (!serverClientId || !/^[\x21-\x7e]+$/.test(serverClientId)) {
            return undefined;
        }
        config.google = { serverClientId };
    }
    if (answer.apple !== undefined) {
        if (!answer.apple || typeof answer.apple !== 'object') {
            return undefined;
        }
        config.apple = {};
    }
    return config;
}

export class CloudSocial implements SocialVerificationShape {
    private readonly transport: typeof fetch;
    private readonly now: () => number;
    private kept?: { value: SocialProviderConfig; at: number };
    private reading?: Promise<void>;
    private configNotBefore = 0;
    /** The service's `Retry-After`: no verification is sent before it. */
    private coolUntil = 0;
    private saidScope = false;

    constructor(private readonly options: CloudSocialOptions) {
        this.transport = options.transport ?? fetch;
        this.now = options.now ?? Date.now;
    }

    /** Connected (not paused) and granted `social:verify`. */
    private available(): boolean {
        const status = this.options.cloud.status();
        return status.connection === 'connected' && status.scopes.includes(SOCIAL_VERIFY_SCOPE);
    }

    /**
     * One request to the service with the deployment's token: on a 401 the
     * token is renewed and the request sent again, once (§3.3).
     */
    private async send(path: string, init: RequestInit, timeoutMs: number): Promise<Answer> {
        const { issuer, cloud } = this.options;
        let token = await cloud.token(issuer);
        for (let attempt = 0; ; attempt++) {
            if (!token) {
                return { kind: 'unavailable', why: 'no token' };
            }
            let response: Response;
            try {
                response = await this.transport(`${issuer}${path}`, {
                    ...init,
                    redirect: 'error',
                    signal: AbortSignal.timeout(timeoutMs),
                    headers: {
                        accept: 'application/json, application/jwt',
                        ...(init.headers as Record<string, string> | undefined),
                        authorization: `Bearer ${token}`,
                    },
                });
            } catch {
                return { kind: 'unavailable', why: 'unreachable' };
            }
            if (response.status === 401 && attempt === 0) {
                await response.body?.cancel().catch(() => undefined);
                token = await cloud.token(issuer, { renew: true });
                continue;
            }
            if (response.status === 401) {
                await response.body?.cancel().catch(() => undefined);
                return { kind: 'unavailable', why: 'token refused' };
            }
            if (response.status === 403) {
                await response.body?.cancel().catch(() => undefined);
                if (!this.saidScope) {
                    this.saidScope = true;
                    this.options.log(
                        `Social sign-in: the cloud services refused this deployment (403): its connection lacks the ${SOCIAL_VERIFY_SCOPE} scope.`,
                    );
                }
                return { kind: 'unavailable', why: 'scope' };
            }
            return { kind: 'answer', response };
        }
    }

    async config(): Promise<SocialProviderConfig | null> {
        if (!this.available()) {
            return null;
        }
        const now = this.now();
        if (
            (!this.kept || now - this.kept.at >= SOCIAL_CONFIG_FRESH_MS) &&
            (this.reading || now >= this.configNotBefore)
        ) {
            this.reading ??= this.readConfig().finally(() => {
                this.reading = undefined;
            });
            await this.reading;
        }
        const kept = this.kept;
        return kept && this.now() - kept.at < SOCIAL_CONFIG_KEEP_MS ? kept.value : null;
    }

    private async readConfig() {
        const at = this.now();
        this.configNotBefore = at + CONFIG_RETRY_MS;
        const answer = await this.send('/v1/social/config', { method: 'GET' }, VERIFY_TIMEOUT_MS);
        if (answer.kind !== 'answer') {
            this.options.log(`Social sign-in: the config could not be read (${answer.why}).`);
            return;
        }
        let value: SocialProviderConfig | undefined;
        try {
            value = answer.response.ok ? parseConfig(JSON.parse(await bounded(answer.response))) : undefined;
        } catch {
            value = undefined;
        }
        if (!answer.response.ok) {
            await answer.response.body?.cancel().catch(() => undefined);
        }
        if (!value) {
            this.options.log(`Social sign-in: the config could not be read (http ${answer.response.status}).`);
            return;
        }
        this.kept = { value, at };
    }

    async verify(input: { provider: SocialProviderId; idToken: string; nonce: string }): Promise<SocialVerdict> {
        const refuse = (code: SocialRefusal, check?: string): SocialVerdict => {
            if (check) {
                this.options.log(`Social sign-in: refused (${check}).`);
            }
            return { ok: false, code };
        };
        if (!this.available()) {
            return refuse('provider_unavailable');
        }
        if (this.now() < this.coolUntil) {
            return refuse('provider_unavailable', 'the service asked to wait');
        }
        const deploymentId = this.options.cloud.status().deploymentId;
        if (!deploymentId) {
            return refuse('provider_unavailable');
        }
        const answer = await this.send(
            '/v1/social/verify',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ provider: input.provider, idToken: input.idToken, nonce: input.nonce }),
            },
            VERIFY_TIMEOUT_MS,
        );
        if (answer.kind !== 'answer') {
            return refuse('provider_unavailable', answer.why);
        }
        const { response } = answer;
        let body: string;
        try {
            body = await bounded(response);
        } catch {
            return refuse('provider_unavailable', 'unreadable answer');
        }
        const status = response.status;
        if (status === 200) {
            let statement: string | undefined;
            try {
                const json = JSON.parse(body) as { statement?: unknown } | null;
                statement = text(json?.statement, 16 * 1024);
            } catch {
                statement = undefined;
            }
            if (!statement) {
                return refuse('provider_unavailable', 'an answer with no statement');
            }
            return this.statement(statement, input, deploymentId);
        }
        let code: string | undefined;
        try {
            const json = JSON.parse(body) as { code?: unknown; error?: unknown } | null;
            code = text(json?.code, 40) ?? text(json?.error, 40);
        } catch {
            code = undefined;
        }
        if (status === 400) {
            return refuse('invalid_token', 'http 400');
        }
        if (status === 422) {
            if (code === 'invalid_token' || code === 'wrong_audience' || code === 'expired') {
                return refuse('invalid_token', `422 ${code}`);
            }
            if (code === 'nonce_mismatch') {
                return refuse('nonce_invalid', '422 nonce_mismatch');
            }
            return refuse('provider_unavailable', `422 ${code === 'provider_unavailable' ? code : 'unknown'}`);
        }
        if (status === 429) {
            return refuse('too_many', 'http 429');
        }
        if (status === 503) {
            this.coolUntil = this.now() + retryAfter(response.headers.get('retry-after'), this.now());
        }
        return refuse('provider_unavailable', `http ${status}`);
    }

    /** The service's statement, checked: the issuer's signature and type, then every claim. */
    private async statement(
        token: string,
        input: { provider: SocialProviderId; nonce: string },
        deploymentId: string,
    ): Promise<SocialVerdict> {
        const bad = (check: string): SocialVerdict => {
            this.options.log(`Social sign-in: the cloud's statement failed its ${check} check.`);
            return { ok: false, code: 'invalid_token' };
        };
        let checked;
        try {
            checked = await verifyIssuerJws(token, {
                typ: SOCIAL_STATEMENT_TYP,
                key: (kid) => this.options.cloud.issuerKey(kid),
            });
        } catch {
            this.options.log('Social sign-in: the issuer’s keys could not be read.');
            return { ok: false, code: 'provider_unavailable' };
        }
        if (!checked.ok) {
            return bad(checked.check);
        }
        const claims = checked.claims;
        const now = Math.floor(this.now() / 1000);
        if (claims.iss !== this.options.issuer) {
            return bad('iss');
        }
        if (claims.aud !== deploymentId) {
            return bad('aud');
        }
        const iat = claims.iat;
        const exp = claims.exp;
        if (
            typeof iat !== 'number' ||
            typeof exp !== 'number' ||
            !Number.isFinite(iat) ||
            !Number.isFinite(exp) ||
            iat > now + SKEW_S ||
            exp <= now - SKEW_S ||
            exp < iat ||
            exp - iat > MAX_LIFE_S
        ) {
            return bad('time');
        }
        if (claims.provider !== input.provider) {
            return bad('provider');
        }
        if (claims.nonce !== input.nonce) {
            return bad('nonce');
        }
        const sub = text(claims.sub, 255);
        if (!sub) {
            return bad('sub');
        }
        const email = text(claims.email, 320);
        return {
            ok: true,
            provider: input.provider,
            sub,
            nonce: input.nonce,
            ...(email ? { email } : {}),
            ...(typeof claims.emailVerified === 'boolean' ? { emailVerified: claims.emailVerified } : {}),
        };
    }
}
