// The APNs client: one alert push per delivery, over fetch. The request follows T3 Code's
// sendPushNotificationRequest in infra/relay/src/agentActivity/ApnsClient.ts (MIT, T3 Tools Inc;
// see vendor/t3code/SYNC.md), without Effect, plus `apns-expiration` and no `apns-collapse-id`.
//
// APNs speaks HTTP/2 only. A Worker's fetch negotiates it with Apple; the tests' fakes are
// HTTP/1.1 (node:http), so only a real forward to Apple proves the transport.

import type { ApnsCredentials } from './apns-jwt';
import type { ApnsProviderTokens, SharedTokens } from './apns-provider-tokens';
import { STAGE_TIMEOUT_MS, loggable } from './pem';
import type { ApnsEnv, Delivery, Outcome } from './providers';

export const APNS_HOSTS: Readonly<Record<ApnsEnv, string>> = {
    sandbox: 'https://api.sandbox.push.apple.com',
    production: 'https://api.push.apple.com',
};

export interface ApnsClientDeps {
    /** Undefined when the relay has no APNs key: every iOS push is then a provider failure (503). */
    credentials: ApnsCredentials | undefined;
    tokens: ApnsProviderTokens;
    /** Where isolates share the provider token (D1 in the Worker); without it, each signs its own. */
    shared?: SharedTokens;
    fetch?: typeof fetch;
    /** Tests point these at fakes. */
    hosts?: Readonly<Record<ApnsEnv, string>>;
    log: (event: string) => void;
}

/** Reasons that mean this device token will never take a push again (the relay answers 410). */
const GONE_REASONS = new Set(['BadDeviceToken', 'Unregistered']);
/**
 * Reasons that are the relay's problem, not the phone's: retryable failures (503), never gone.
 * TooManyProviderTokenUpdates means tokens were signed too often; the token is kept, never
 * replaced, since replacing it is what APNs counts. InvalidProviderToken is a wrong key id or team
 * id; signing again can't fix it.
 */
export const RETRYABLE_REASONS = new Set([
    'TooManyProviderTokenUpdates',
    'TooManyRequests',
    'InvalidProviderToken',
    'ExpiredProviderToken',
]);

/** What an APNs answer means for the relay: permanent failures are gone, size is too-large, the rest failed. */
export function apnsOutcome(status: number, reason: string | undefined): Outcome {
    if (status === 200) {
        return 'sent';
    }
    if (reason !== undefined && RETRYABLE_REASONS.has(reason)) {
        return 'failed';
    }
    if (status === 410 || (reason !== undefined && GONE_REASONS.has(reason))) {
        return 'gone';
    }
    if (status === 413 || reason === 'PayloadTooLarge') {
        return 'too-large';
    }
    return 'failed';
}

async function reasonOf(response: Response): Promise<string | undefined> {
    try {
        const body: unknown = JSON.parse(await response.text());
        const reason = (body as { reason?: unknown } | null)?.reason;
        return typeof reason === 'string' ? reason : undefined;
    } catch {
        return undefined;
    }
}

export function apnsClient(deps: ApnsClientDeps) {
    const doFetch = deps.fetch ?? ((input, init) => fetch(input, init));
    const hosts = deps.hosts ?? APNS_HOSTS;

    return {
        async send(delivery: Delivery): Promise<Outcome> {
            const { target } = delivery;
            if (!deps.credentials) {
                deps.log('apns not configured');
                return 'failed';
            }
            if (!target.apnsEnv) {
                return 'failed';
            }
            let jwt: string;
            try {
                jwt = await deps.tokens.get(deps.credentials, delivery.nowMs, deps.shared);
            } catch {
                deps.log('apns key unusable');
                return 'failed';
            }
            const nowS = Math.floor(delivery.nowMs / 1000);
            let response: Response;
            let reason: string | undefined;
            try {
                response = await doFetch(
                    `${hosts[target.apnsEnv]}/3/device/${encodeURIComponent(target.nativeToken)}`,
                    {
                        method: 'POST',
                        headers: {
                            authorization: `bearer ${jwt}`,
                            'apns-push-type': 'alert',
                            // Every user-visible push goes at once.
                            'apns-priority': '10',
                            'apns-topic': target.bundleId,
                            // 0: deliver now or never, as Web Push's TTL 0 means.
                            'apns-expiration': String(delivery.ttl > 0 ? nowS + delivery.ttl : 0),
                            // No apns-collapse-id: it would replace a notification already shown.
                            'content-type': 'application/json',
                        },
                        body: JSON.stringify(delivery.message),
                        signal: AbortSignal.timeout(STAGE_TIMEOUT_MS),
                    },
                );
                reason = response.status === 200 ? undefined : await reasonOf(response);
            } catch (error) {
                // The name only: the URL in a fetch error holds the device token.
                deps.log(`apns unreachable ${(error as Error)?.name ?? 'error'}`);
                return 'failed';
            }
            if (response.status === 200) {
                await response.body?.cancel().catch(() => {});
                return 'sent';
            }
            // Only an expired token is replaced (here and in the shared row); see RETRYABLE_REASONS.
            if (reason === 'ExpiredProviderToken') {
                await deps.tokens.expire(deps.credentials, jwt, deps.shared);
            }
            const outcome = apnsOutcome(response.status, reason);
            deps.log(`apns ${response.status} ${loggable(reason)}`);
            return outcome;
        },
    };
}
