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
 * - `POST /v1/social/web/start` `{provider, purpose, nonce}` → 200
 *   `{url, expiresAt}`: the cloud's one-time sign-in page for the website.
 *   409 `origin_unavailable` and 422 `provider_unavailable` mean it can't
 *   now; 429 carries `Retry-After`.
 * - `POST /v1/social/web/redeem` `{result}` → 200 `{statement}`, as verify's;
 *   422 `result_invalid` for one unknown, used, too old or not ours.
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
    type SocialWebStart,
    type SocialWebStartInput,
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

/** The config's answer, or undefined when it isn't one. `web` counts only as `true`. */
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
        config.google = { serverClientId, ...(google.web === true ? { web: true as const } : {}) };
    }
    if (answer.apple !== undefined) {
        if (!answer.apple || typeof answer.apple !== 'object') {
            return undefined;
        }
        config.apple = (answer.apple as Record<string, unknown>).web === true ? { web: true } : {};
    }
    return config;
}

/** The website flow's page, as the cloud answers it: an https address, nothing else. */
function pageUrl(value: unknown): string | undefined {
    const raw = text(value, 4096);
    if (!raw) {
        return undefined;
    }
    try {
        const url = new URL(raw);
        return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
    } catch {
        return undefined;
    }
}

/** A sealed result as the browser brings it: base64url, bounded. */
const RESULT = /^[A-Za-z0-9_-]{16,4096}$/;

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

    private refuse(code: SocialRefusal, check?: string): SocialVerdict {
        if (check) {
            this.options.log(`Social sign-in: refused (${check}).`);
        }
        return { ok: false, code };
    }

    /**
     * Posts JSON to the service, when it may be asked now: its status, its
     * JSON (null when it sent none), the error code it named, and its
     * headers. A string: why nothing could be asked or read.
     */
    private async post(
        path: string,
        payload: unknown,
    ): Promise<
        | {
              status: number;
              json: Record<string, unknown> | null;
              code?: string;
              headers: Headers;
              deploymentId: string;
          }
        | string
    > {
        if (!this.available()) {
            return '';
        }
        if (this.now() < this.coolUntil) {
            return 'the service asked to wait';
        }
        const deploymentId = this.options.cloud.status().deploymentId;
        if (!deploymentId) {
            return '';
        }
        const answer = await this.send(
            path,
            { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) },
            VERIFY_TIMEOUT_MS,
        );
        if (answer.kind !== 'answer') {
            return answer.why;
        }
        const { response } = answer;
        let body: string;
        try {
            body = await bounded(response);
        } catch {
            return 'unreadable answer';
        }
        let json: Record<string, unknown> | null = null;
        try {
            const parsed = JSON.parse(body) as unknown;
            json =
                parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                    ? (parsed as Record<string, unknown>)
                    : null;
        } catch {
            json = null;
        }
        const code = text(json?.code, 40) ?? text(json?.error, 40);
        if (response.status === 503) {
            this.coolUntil = this.now() + retryAfter(response.headers.get('retry-after'), this.now());
        }
        return { status: response.status, json, ...(code ? { code } : {}), headers: response.headers, deploymentId };
    }

    async verify(input: { provider: SocialProviderId; idToken: string; nonce: string }): Promise<SocialVerdict> {
        const refuse = (code: SocialRefusal, check?: string) => this.refuse(code, check);
        const answer = await this.post('/v1/social/verify', {
            provider: input.provider,
            idToken: input.idToken,
            nonce: input.nonce,
        });
        if (typeof answer === 'string') {
            return refuse('provider_unavailable', answer || undefined);
        }
        const { status, code, deploymentId } = answer;
        if (status === 200) {
            const statement = text(answer.json?.statement, 16 * 1024);
            if (!statement) {
                return refuse('provider_unavailable', 'an answer with no statement');
            }
            return this.statement(statement, input, deploymentId);
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
        return refuse('provider_unavailable', `http ${status}`);
    }

    async webStart(input: SocialWebStartInput): Promise<SocialWebStart> {
        const unavailable = (check?: string): SocialWebStart => {
            if (check) {
                this.options.log(`Social sign-in: the website's start was refused (${check}).`);
            }
            return { ok: false, code: 'provider_unavailable' };
        };
        const answer = await this.post('/v1/social/web/start', {
            provider: input.provider,
            purpose: input.purpose,
            nonce: input.nonce,
        });
        if (typeof answer === 'string') {
            return unavailable(answer || undefined);
        }
        const { status, code } = answer;
        if (status === 200) {
            const url = pageUrl(answer.json?.url);
            return url ? { ok: true, url } : unavailable('an answer with no https page');
        }
        if (status === 429) {
            const wait = retryAfter(answer.headers.get('retry-after'), this.now());
            this.options.log(`Social sign-in: the website's start was refused (http 429).`);
            return { ok: false, code: 'too_many', retryAfterS: Math.ceil(wait / 1000) };
        }
        // 409 origin_unavailable (no https origin on record, or paused) and
        // 422 provider_unavailable both mean: not on this website now.
        return unavailable(
            `http ${status}${code === 'origin_unavailable' || code === 'provider_unavailable' ? ` ${code}` : ''}`,
        );
    }

    async redeemWeb(input: { provider: SocialProviderId; result: string }): Promise<SocialVerdict> {
        const refuse = (code: SocialRefusal, check?: string) => this.refuse(code, check);
        // Something that was never a result costs no call out.
        if (!RESULT.test(input.result)) {
            return refuse('nonce_invalid', 'not a result');
        }
        const answer = await this.post('/v1/social/web/redeem', { result: input.result });
        if (typeof answer === 'string') {
            return refuse('provider_unavailable', answer || undefined);
        }
        const { status, code, deploymentId } = answer;
        if (status === 200) {
            const statement = text(answer.json?.statement, 16 * 1024);
            if (!statement) {
                return refuse('provider_unavailable', 'an answer with no statement');
            }
            return this.statement(statement, { provider: input.provider }, deploymentId);
        }
        if (status === 400 || (status === 422 && code === 'result_invalid')) {
            return refuse('nonce_invalid', `http ${status}${status === 422 ? ' result_invalid' : ''}`);
        }
        if (status === 429) {
            return refuse('too_many', 'http 429');
        }
        return refuse('provider_unavailable', `http ${status}`);
    }

    /** The service's statement, checked: the issuer's signature and type, then every claim. */
    private async statement(
        token: string,
        /** The nonce the statement must carry; without one (the website's), any, for the caller to match. */
        input: { provider: SocialProviderId; nonce?: string },
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
        const nonce = text(claims.nonce, 256);
        if (!nonce || (input.nonce !== undefined && nonce !== input.nonce)) {
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
            nonce,
            ...(email ? { email } : {}),
            ...(typeof claims.emailVerified === 'boolean' ? { emailVerified: claims.emailVerified } : {}),
        };
    }
}
