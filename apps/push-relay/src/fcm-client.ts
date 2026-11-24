// The FCM HTTP v1 client: data messages only, at high priority. Ported from T3 Code's
// infra/relay/src/agentActivity/FcmClient.ts (MIT, T3 Tools Inc; see vendor/t3code/SYNC.md),
// without Effect: the access token is cached until it expires (upstream: a fixed 50 minutes), the
// TTL and collapse key come from the push, and a refused size is told apart from other failures.

import { GOOGLE_TOKEN_URL, signFcmAssertion } from './fcm-assertion-signer';
import { fingerprint, loggable, STAGE_TIMEOUT_MS } from './pem';
import type { Delivery, Outcome } from './providers';

export const FCM_ORIGIN = 'https://fcm.googleapis.com';

/** The fields of FCM_SERVICE_ACCOUNT_JSON the relay uses. */
export interface FcmServiceAccount {
    projectId: string;
    clientEmail: string;
    privateKey: string;
}

/** The service account from its JSON key, or undefined when it's absent or incomplete. */
export function parseServiceAccount(json: string | undefined): FcmServiceAccount | undefined {
    if (!json) {
        return undefined;
    }
    try {
        const value = JSON.parse(json) as Record<string, unknown>;
        const { project_id: projectId, client_email: clientEmail, private_key: privateKey } = value;
        return typeof projectId === 'string' &&
            projectId &&
            typeof clientEmail === 'string' &&
            clientEmail &&
            typeof privateKey === 'string' &&
            privateKey
            ? { projectId, clientEmail, privateKey }
            : undefined;
    } catch {
        return undefined;
    }
}

/** A token is renewed this long before Google says it expires. */
const EXPIRY_MARGIN_MS = 60_000;

interface Cached {
    token: string;
    expiresAtMs: number;
}

/** FCM access tokens, cached per service account until they expire. Never written anywhere. */
export class FcmAccessTokens {
    private readonly cache = new Map<string, Cached>();
    private readonly pending = new Map<string, Promise<Cached>>();
    private readonly doFetch: typeof fetch;
    private readonly tokenUrl: string;

    constructor(options: { fetch?: typeof fetch; tokenUrl?: string } = {}) {
        this.doFetch = options.fetch ?? ((input, init) => fetch(input, init));
        this.tokenUrl = options.tokenUrl ?? GOOGLE_TOKEN_URL;
    }

    async get(account: FcmServiceAccount, nowMs: number): Promise<string> {
        const key = `${account.clientEmail}:${await fingerprint(account.privateKey)}`;
        const cached = this.cache.get(key);
        if (cached && nowMs < cached.expiresAtMs - EXPIRY_MARGIN_MS) {
            return cached.token;
        }
        let authorizing = this.pending.get(key);
        if (!authorizing) {
            authorizing = this.authorize(account, nowMs);
            this.pending.set(key, authorizing);
            authorizing
                .then((fresh) => this.cache.set(key, fresh))
                .catch(() => {})
                .finally(() => this.pending.delete(key));
        }
        return (await authorizing).token;
    }

    /** Drops a token FCM refused (401); a newer one stays. */
    invalidate(token: string) {
        for (const [key, cached] of this.cache) {
            if (cached.token === token) {
                this.cache.delete(key);
            }
        }
    }

    private async authorize(account: FcmServiceAccount, nowMs: number): Promise<Cached> {
        const assertion = await signFcmAssertion({
            privateKey: account.privateKey,
            clientEmail: account.clientEmail,
            issuedAt: Math.floor(nowMs / 1000),
        });
        const response = await this.doFetch(this.tokenUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
            signal: AbortSignal.timeout(STAGE_TIMEOUT_MS),
        });
        if (response.status !== 200) {
            await response.body?.cancel().catch(() => {});
            throw new Error(`token endpoint answered ${response.status}`);
        }
        const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
        if (typeof body.access_token !== 'string' || !body.access_token) {
            throw new Error('token endpoint gave no access token');
        }
        const expiresIn =
            typeof body.expires_in === 'number' && Number.isFinite(body.expires_in)
                ? Math.min(Math.max(body.expires_in, 120), 3600)
                : 3600;
        return { token: body.access_token, expiresAtMs: nowMs + expiresIn * 1000 };
    }
}

interface FcmError {
    error?: {
        code?: number;
        message?: unknown;
        status?: unknown;
        details?: { '@type'?: unknown; errorCode?: unknown }[];
    };
}

const errorCodeOf = (body: FcmError) =>
    body.error?.details?.find((detail) => detail['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError')
        ?.errorCode;

/**
 * What an FCM answer means for the relay. Gone only on FCM's UNREGISTERED: a 404 alone
 * can be a wrong project id, and treating that as gone would delete every phone's subscription.
 * A refused size is INVALID_ARGUMENT like other bad requests, so it's told by its message
 * ("Message is too big"; the legacy API's MessageTooBig).
 */
export function fcmOutcome(status: number, body: FcmError | undefined): Outcome {
    if (status >= 200 && status < 300) {
        return 'sent';
    }
    if (body && errorCodeOf(body) === 'UNREGISTERED') {
        return 'gone';
    }
    const message = body?.error?.message;
    if (typeof message === 'string' && /too big|MessageTooBig/i.test(message)) {
        return 'too-large';
    }
    return 'failed';
}

export interface FcmClientDeps {
    /** Undefined when the relay has no service account: every Android push is then a provider failure (503). */
    account: FcmServiceAccount | undefined;
    tokens: FcmAccessTokens;
    fetch?: typeof fetch;
    /** Tests point this at a fake. */
    origin?: string;
    log: (event: string) => void;
}

export function fcmClient(deps: FcmClientDeps) {
    const doFetch = deps.fetch ?? ((input, init) => fetch(input, init));
    const origin = deps.origin ?? FCM_ORIGIN;

    return {
        async send(delivery: Delivery): Promise<Outcome> {
            const { account } = deps;
            if (!account) {
                deps.log('fcm not configured');
                return 'failed';
            }
            let token: string;
            try {
                token = await deps.tokens.get(account, delivery.nowMs);
            } catch (error) {
                deps.log(`fcm authorize failed ${(error as Error)?.name ?? 'error'}`);
                return 'failed';
            }
            const { target } = delivery;
            let response: Response;
            let body: FcmError | undefined;
            try {
                response = await doFetch(
                    `${origin}/v1/projects/${encodeURIComponent(account.projectId)}/messages:send`,
                    {
                        method: 'POST',
                        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                        body: JSON.stringify({
                            message: {
                                token: target.nativeToken,
                                // Data only: a notification message would skip the app's service.
                                data: delivery.message,
                                android: {
                                    priority: 'HIGH',
                                    ttl: `${delivery.ttl}s`,
                                    // Replaces only undelivered messages, as Web Push's Topic does.
                                    ...(delivery.topic ? { collapse_key: delivery.topic } : {}),
                                    restricted_package_name: target.bundleId,
                                },
                            },
                        }),
                        signal: AbortSignal.timeout(STAGE_TIMEOUT_MS),
                    },
                );
                if (response.status >= 200 && response.status < 300) {
                    await response.body?.cancel().catch(() => {});
                    return 'sent';
                }
                body = (await response.json().catch(() => undefined)) as FcmError | undefined;
            } catch (error) {
                deps.log(`fcm unreachable ${(error as Error)?.name ?? 'error'}`);
                return 'failed';
            }
            if (response.status === 401) {
                deps.tokens.invalidate(token);
            }
            const errorCode = body ? errorCodeOf(body) : undefined;
            deps.log(`fcm ${response.status} ${loggable(errorCode ?? body?.error?.status)}`);
            return fcmOutcome(response.status, body);
        },
    };
}
