import { readJson } from '../net/read-body';
import type { RelayFetch } from '../net/relay-fetch';

// The push relay's app API (apps/push-relay/src/relay.ts), over
// relayFetch: a registration's id and secret are the app's, chosen and kept
// before the first call (subscription.ts), and the secret is the only
// credential. Nothing personal goes in: the native token, the app's bundle id
// and APNs host, the workspace server's VAPID key. Every answer is an outcome
// by status alone, but a 403 to a refresh or delete, which is `forbidden` only
// with the relay's own problem JSON; no answer at all is `offline`.

/** What the app registers a workspace with. */
export interface RelayRegistration {
    readonly id: string;
    readonly secret: string;
    readonly platform: 'ios' | 'android';
    readonly nativeToken: string;
    /** The installed variant's id (variant.ts), one of the relay's three. */
    readonly bundleId: string;
    /** APNs' host on iOS, by the variant's `aps-environment`; null on Android. */
    readonly apnsEnv: 'sandbox' | 'production' | null;
    /** The workspace server's VAPID public key (`pushKey`), which the registration is bound to. */
    readonly vapidKey: string;
}

export type RegisterOutcome =
    | { readonly kind: 'registered'; readonly endpoint: string }
    /** 403: the id is someone else's; 409: it is bound to another key or app. A new id fixes both. */
    | { readonly kind: 'taken' }
    | { readonly kind: 'refused'; readonly status: number }
    | { readonly kind: 'offline' };

export type RelayWriteOutcome =
    | { readonly kind: 'done' }
    /** 410: the relay has no such registration (expired, or deleted). */
    | { readonly kind: 'gone' }
    /**
     * 403 with the relay's own answer (`{"error": "secret"}`): the secret
     * isn't the registration's. A 403 without it (a proxy's, a firewall's) is
     * `refused`.
     */
    | { readonly kind: 'forbidden' }
    | { readonly kind: 'refused'; readonly status: number }
    | { readonly kind: 'offline' };

export interface RelayClient {
    /** `POST /v1/registrations`: 201 new, 200 the same again (a retry), with the endpoint. */
    register(registration: RelayRegistration): Promise<RegisterOutcome>;
    /** `PUT /v1/registrations/:id`: the daily refresh, with a new native token when it changed. */
    refresh(id: string, secret: string, nativeToken?: string): Promise<RelayWriteOutcome>;
    /** `DELETE /v1/registrations/:id`. */
    remove(id: string, secret: string): Promise<RelayWriteOutcome>;
}

/** Whether a 403 is the relay's own: its JSON problem `{"error": "secret"}` (apps/push-relay/src/relay.ts). */
async function relaysSecretProblem(answer: Response): Promise<boolean> {
    const body = (await readJson(answer).catch(() => null)) as { error?: unknown } | null;
    return body?.error === 'secret';
}

async function writeOutcome(answer: Response): Promise<RelayWriteOutcome> {
    const { status } = answer;
    if (status >= 200 && status < 300) {
        return { kind: 'done' };
    }
    if (status === 410) {
        return { kind: 'gone' };
    }
    if (status === 403 && (await relaysSecretProblem(answer))) {
        return { kind: 'forbidden' };
    }
    return { kind: 'refused', status };
}

export function createRelayClient(relay: RelayFetch, origin: string): RelayClient {
    const send = async (path: string, init: Parameters<RelayFetch>[1]): Promise<Response | null> => {
        try {
            return await relay(path, init);
        } catch {
            return null;
        }
    };
    const path = (id: string) => `/v1/registrations/${encodeURIComponent(id)}`;
    return {
        async register(registration) {
            const answer = await send('/v1/registrations', { method: 'POST', json: registration });
            if (answer === null) {
                return { kind: 'offline' };
            }
            if (answer.status === 403 || answer.status === 409) {
                return { kind: 'taken' };
            }
            if (answer.status !== 200 && answer.status !== 201) {
                return { kind: 'refused', status: answer.status };
            }
            const body = (await readJson(answer).catch(() => null)) as { endpoint?: unknown } | null;
            // The endpoint is the relay's for this id, on its own origin: anything else isn't taken.
            const expected = `${origin}/v1/push/${registration.id}`;
            return body?.endpoint === expected
                ? { kind: 'registered', endpoint: expected }
                : { kind: 'refused', status: answer.status };
        },
        async refresh(id, secret, nativeToken) {
            const answer = await send(path(id), {
                method: 'PUT',
                json: nativeToken === undefined ? { secret } : { secret, nativeToken },
            });
            return answer === null ? { kind: 'offline' } : writeOutcome(answer);
        },
        async remove(id, secret) {
            const answer = await send(path(id), { method: 'DELETE', json: { secret } });
            return answer === null ? { kind: 'offline' } : writeOutcome(answer);
        },
    };
}
