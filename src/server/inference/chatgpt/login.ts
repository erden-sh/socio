import { ChatGptError } from '@socio/foundation/inference/chatgpt-errors';

import { credentialsFrom, type ChatGptCredentials } from './credentials.js';
import { CODEX_CLIENT_ID, DEVICE_CODE_TTL_MS, deviceUrls, tokenUrl } from './endpoints.js';
import { authPost, endpointsOf, type ChatGptHttpOptions } from './http.js';

export type LoginFailure = 'expired' | 'denied' | 'failed';
export type LoginPoll = 'pending' | { credentials: ChatGptCredentials } | { error: LoginFailure; message: string };

export interface DeviceLogin {
    /** Shown to the user, who types it at `verificationUrl`. */
    userCode: string;
    verificationUrl: string;
    /** Epoch milliseconds; the CLI allows 15 minutes. */
    expiresAt: number;
    /** How often asking makes sense: the server's interval (5 s by default). */
    intervalMs: number;
    /**
     * Asks once whether the user has finished. Calls closer together than the
     * server's interval, and concurrent calls, share one request; after a final
     * answer every call returns it again. Drop the login once it is final.
     */
    poll(): Promise<LoginPoll>;
}

export interface StartLoginOptions extends ChatGptHttpOptions {
    now?: () => number;
}

const LOGIN_MESSAGES: Record<LoginFailure, string> = {
    expired: 'The sign-in code expired. Start again to get a new code.',
    denied: 'ChatGPT did not approve this sign-in. Start again if you meant to connect.',
    failed: 'ChatGPT sign-in did not complete. Please start again.',
};
const failure = (error: LoginFailure): LoginPoll => ({
    error,
    message: LOGIN_MESSAGES[error],
});

/**
 * Starts the Codex CLI's ChatGPT device-code sign-in on the server, as
 * `codex login --device-auth` does (`login/src/device_code_auth.rs` in the
 * pinned CLI, see endpoints.ts):
 *
 * 1. POST `{issuer}/api/accounts/deviceauth/usercode` `{client_id}` (JSON)
 *    → `{device_auth_id, user_code, interval}`; the user opens
 *    `{issuer}/codex/device` and enters the code.
 * 2. POST `{issuer}/api/accounts/deviceauth/token`
 *    `{device_auth_id, user_code}` (JSON): 403/404 while the user hasn't
 *    finished; 200 → `{authorization_code, code_verifier, code_challenge}`.
 * 3. POST `{issuer}/oauth/token` (form): `grant_type=authorization_code`,
 *    `client_id`, `code`, `redirect_uri={issuer}/deviceauth/callback`,
 *    `code_verifier` (`exchange_code_for_tokens` in `login/src/server.rs`)
 *    → `{id_token, access_token, refresh_token}`.
 *
 * The CLI treats any other answer to step 2 as a failed sign-in; here a 4xx
 * is `denied` and anything else (5xx, network) stays `pending` until the
 * code expires, so one blip doesn't end a sign-in.
 */
export async function startLogin(options: StartLoginOptions = {}): Promise<DeviceLogin> {
    const now = options.now ?? Date.now;
    const urls = deviceUrls(endpointsOf(options).issuer);
    const started = await authPost(options, urls.userCode, {
        client_id: CODEX_CLIENT_ID,
    });
    if (started.status === 404) {
        throw new ChatGptError('chatgpt_login_unavailable', { status: 404 });
    }
    if (started.status < 200 || started.status > 299) {
        throw new ChatGptError(started.status >= 500 ? 'chatgpt_unavailable' : 'chatgpt_rejected', {
            status: started.status,
        });
    }
    let body: Record<string, unknown>;
    try {
        body = JSON.parse(started.text) as Record<string, unknown>;
    } catch {
        throw new ChatGptError('chatgpt_unavailable', { providerCode: 'bad_json' });
    }
    const deviceAuthId = body.device_auth_id;
    const userCode = body.user_code ?? body.usercode;
    if (typeof deviceAuthId !== 'string' || typeof userCode !== 'string') {
        throw new ChatGptError('chatgpt_unavailable', {
            providerCode: 'bad_device_code',
        });
    }
    // The CLI parses `interval` as a string of seconds; accept a number too.
    const seconds = Number(String(body.interval ?? '').trim());
    const intervalMs = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 60) * 1000 : 5000;
    const expiresAt = now() + DEVICE_CODE_TTL_MS;

    let final: LoginPoll | undefined;
    let inFlight: Promise<LoginPoll> | undefined;
    let lastPoll = -Infinity;

    const ask = async (): Promise<LoginPoll> => {
        lastPoll = now();
        const polled = await authPost(options, urls.token, {
            device_auth_id: deviceAuthId,
            user_code: userCode,
        }).catch((error: unknown) => {
            if (error instanceof ChatGptError) {
                return undefined;
            }
            throw error;
        });
        if (!polled || polled.status >= 500 || polled.status === 429) {
            return 'pending';
        }
        if (polled.status === 403 || polled.status === 404) {
            return 'pending';
        }
        if (polled.status < 200 || polled.status > 299) {
            return failure('denied');
        }
        let code: Record<string, unknown>;
        try {
            code = JSON.parse(polled.text) as Record<string, unknown>;
        } catch {
            return failure('failed');
        }
        if (typeof code.authorization_code !== 'string' || typeof code.code_verifier !== 'string') {
            return failure('failed');
        }
        const exchanged = await authPost(
            options,
            tokenUrl(endpointsOf(options).issuer),
            {
                grant_type: 'authorization_code',
                client_id: CODEX_CLIENT_ID,
                code: code.authorization_code,
                redirect_uri: urls.redirect,
                code_verifier: code.code_verifier,
            },
            { form: true },
        ).catch(() => undefined);
        // The authorization code is single use: a failed exchange can't be
        // retried, so it ends the sign-in.
        if (!exchanged || exchanged.status < 200 || exchanged.status > 299) {
            return failure('failed');
        }
        let tokens: Record<string, unknown>;
        try {
            tokens = JSON.parse(exchanged.text) as Record<string, unknown>;
        } catch {
            return failure('failed');
        }
        const credentials = credentialsFrom(tokens, undefined, now());
        return credentials ? { credentials } : failure('failed');
    };

    return {
        userCode,
        verificationUrl: urls.verification,
        expiresAt,
        intervalMs,
        poll: async () => {
            if (final) {
                return final;
            }
            if (inFlight) {
                return inFlight;
            }
            if (now() >= expiresAt) {
                return (final = failure('expired'));
            }
            if (now() - lastPoll < intervalMs) {
                return 'pending';
            }
            inFlight = ask()
                .then((result) => {
                    if (result !== 'pending') {
                        final = result;
                    } else if (now() >= expiresAt) {
                        final = failure('expired');
                    }
                    return final ?? 'pending';
                })
                .finally(() => (inFlight = undefined));
            return inFlight;
        },
    };
}
