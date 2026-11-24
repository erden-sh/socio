// What the relay hands APNs and FCM, and the interface their clients fill.
//
// The relay never decrypts: `p` is the Web Push body (RFC 8291 aes128gcm) as base64url, and the
// phone's extension (iOS) or service (Android) decrypts it with its own keys. `s` is the
// registration id, so the phone knows which workspace's keys to use.

export type Platform = 'ios' | 'android';
export type ApnsEnv = 'sandbox' | 'production';

/** The alert iOS shows when the extension can't decrypt in time, and the generic fallback's text. */
export const GENERIC_ALERT = { title: 'Socio', body: 'Open the app' } as const;

/** APNs caps the payload at 4096 bytes and FCM the message's data at 4096 bytes. */
export const PROVIDER_LIMIT = 4096;

export type ApnsPayload =
    | { aps: { alert: typeof GENERIC_ALERT; 'mutable-content': 1; sound: 'default' }; s: string; p: string }
    | { aps: { alert: typeof GENERIC_ALERT; sound: 'default' }; s: string };

/** FCM data messages only (never a notification message, which would bypass the app's service). */
export type FcmData = { s: string; p: string } | { s: string; g: '1' };

export interface Target {
    id: string;
    platform: Platform;
    nativeToken: string;
    bundleId: string;
    /** iOS only: which APNs host the registration's build talks to. */
    apnsEnv: ApnsEnv | null;
}

export interface Delivery {
    target: Target;
    /** The APNs payload for iOS, the FCM data for Android. */
    message: ApnsPayload | FcmData;
    /** True for the generic "Open the app" alert, which carries no ciphertext. */
    generic: boolean;
    /** Seconds the provider may hold the push (Web Push's TTL): `apns-expiration`, FCM `ttl`. */
    ttl: number;
    /**
     * Web Push's Topic, for FCM's `collapse_key` only: it replaces undelivered messages, as Topic
     * means. Never `apns-collapse-id`, which replaces notifications already shown.
     */
    topic?: string;
    nowMs: number;
}

/**
 * sent: the provider took it. gone: the native token is permanently invalid (the relay answers
 * 410). too-large: the provider refused the size (resent once as the generic alert). failed:
 * anything else (503). Every user-visible push goes at APNs priority 10 and FCM high.
 */
export type Outcome = 'sent' | 'gone' | 'too-large' | 'failed';

export interface Providers {
    send(delivery: Delivery): Promise<Outcome>;
}

/** No provider at all: every push is a provider failure (503). */
export const noProviders: Providers = {
    send: async () => 'failed',
};

/** iOS to APNs, Android to FCM (apns-client.ts and fcm-client.ts). */
export function nativeProviders(clients: { apns: Providers; fcm: Providers }): Providers {
    return {
        send: (delivery) =>
            delivery.target.platform === 'ios' ? clients.apns.send(delivery) : clients.fcm.send(delivery),
    };
}

/** The provider message for a push: with the ciphertext, or the generic alert when `p` is absent. */
export function messageFor(target: Pick<Target, 'id' | 'platform'>, p?: string): ApnsPayload | FcmData {
    if (target.platform === 'ios') {
        return p
            ? { aps: { alert: GENERIC_ALERT, 'mutable-content': 1, sound: 'default' }, s: target.id, p }
            : { aps: { alert: GENERIC_ALERT, sound: 'default' }, s: target.id };
    }
    return p ? { s: target.id, p } : { s: target.id, g: '1' };
}

/** Whether a provider message fits under the 4096-byte limit, measured as its JSON. */
export const fits = (message: ApnsPayload | FcmData) =>
    new TextEncoder().encode(JSON.stringify(message)).length <= PROVIDER_LIMIT;
