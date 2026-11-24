// The push relay's Worker: registrations, the Web Push
// receiver and the quotas, forwarding to APNs and FCM. A provider whose credentials
// aren't set answers 503 for its platform's pushes.
// WebCrypto and fetch only: no runtime dependency, no Effect and no `nodejs_compat`.
// wrangler.toml binds these: D1 `DB` with migrations/, the five `[[ratelimits]]` with the
// numbers in `QUOTAS` (src/quotas.ts), the daily cron (the 60-day expiry and the write budget's
// cleanup), `RELAY_ORIGIN` and `REGISTRATION_WRITE_BUDGET` per environment, and every log, trace,
// Logpush and metric off. Workers request logs would record each request's URL (which holds the
// registration id) and headers (CF-Connecting-IP), which the relay promises never to keep; its
// own log lines carry no IP, id, token, key or secret. README.md says how to run it and what it
// keeps; the deploy pipeline deploys it and sets the provider keys as secrets.

import { apnsClient } from './apns-client';
import type { ApnsCredentials } from './apns-jwt';
import { ApnsProviderTokens, d1SharedTokens } from './apns-provider-tokens';
import { FcmAccessTokens, fcmClient, parseServiceAccount } from './fcm-client';
import { nativeProviders } from './providers';
import { rateLimitQuotas, type RateLimitBindings } from './quotas';
import { createRelay } from './relay';
import { writeBudgetFrom } from './write-budget';

export interface Env extends RateLimitBindings {
    /** D1, migrated with migrations/. */
    DB: D1Database;
    /** The relay's own origin, e.g. https://<relay host>: the VAPID audience and the endpoints' origin. */
    RELAY_ORIGIN: string;
    /**
     * The D1 write budget, billed rows written a minute (src/write-budget.ts): a cost bound on
     * Workers Paid, which the relay assumes. 50 by default; it can be raised here.
     */
    REGISTRATION_WRITE_BUDGET?: string;
    // Secrets, set by the deploy pipeline as Worker secrets, never by hand.
    /** The APNs authentication key (.p8, PEM), for sandbox and production. */
    APNS_KEY_P8?: string;
    APNS_KEY_ID?: string;
    APNS_TEAM_ID?: string;
    /** The Firebase service account's JSON key, with the "Firebase Cloud Messaging API Admin" role. */
    FCM_SERVICE_ACCOUNT_JSON?: string;
}

const log = (event: string) => console.log(`push-relay: ${event}`);

// Per isolate: the APNs provider token and the FCM access token are reused across requests. The
// APNs token is also shared between isolates through D1, so the fleet signs about once per 50
// minutes and never trips TooManyProviderTokenUpdates (apns-provider-tokens.ts).
const apnsTokens = new ApnsProviderTokens(log);
const fcmTokens = new FcmAccessTokens();

function apnsCredentials(env: Env): ApnsCredentials | undefined {
    return env.APNS_KEY_P8 && env.APNS_KEY_ID && env.APNS_TEAM_ID
        ? { privateKey: env.APNS_KEY_P8, keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID }
        : undefined;
}

export const relayFor = (env: Env) =>
    createRelay({
        db: env.DB,
        quotas: rateLimitQuotas(env, log),
        providers: nativeProviders({
            apns: apnsClient({
                credentials: apnsCredentials(env),
                tokens: apnsTokens,
                shared: d1SharedTokens(env.DB),
                log,
            }),
            fcm: fcmClient({ account: parseServiceAccount(env.FCM_SERVICE_ACCOUNT_JSON), tokens: fcmTokens, log }),
        }),
        origin: env.RELAY_ORIGIN,
        writeBudget: writeBudgetFrom(env.REGISTRATION_WRITE_BUDGET),
        log,
    });

export default {
    fetch: (request, env) => relayFor(env).fetch(request),
    async scheduled(_controller, env) {
        await relayFor(env).expire();
    },
} satisfies ExportedHandler<Env>;
