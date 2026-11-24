import { createHash } from 'node:crypto';

import { ChatGptError } from '@socio/foundation/inference/chatgpt-errors';

import { authClaims, credentialsFrom, type ChatGptCredentials } from './credentials.js';
import { CODEX_CLIENT_ID, REFRESH_WINDOW_MS, revokeUrl, tokenUrl } from './endpoints.js';
import { oauthErrorCode } from './errors.js';
import { authPost, endpointsOf, type ChatGptHttpOptions } from './http.js';

export type SaveCredentials = (credentials: ChatGptCredentials) => Promise<void>;

export interface EnsureFreshOptions extends ChatGptHttpOptions {
    /** Refresh even if the access token isn't near expiry (after a 401). */
    force?: boolean;
    /** Called once when the sign-in can't be refreshed; the user must connect again. */
    markNeedsRelogin?: () => Promise<void>;
    now?: () => number;
}

// One refresh per refresh token at a time, process-wide. A refresh token
// belongs to exactly one connection, so this is single-flight per
// connection. Results stay a while so a caller still holding the old
// (now spent) token gets the rotated credentials instead of reusing it.
const inFlight = new Map<string, Promise<ChatGptCredentials>>();
const rotated = new Map<string, { credentials: ChatGptCredentials; until: number }>();
const ROTATED_TTL_MS = 5 * 60_000;
const keyOf = (refreshToken: string) => createHash('sha256').update(refreshToken).digest('base64url');

/** Refresh-token errors the CLI treats as permanent (`classify_refresh_token_failure`). */
const PERMANENT = new Set([
    'invalid_grant',
    'refresh_token_expired',
    'refresh_token_reused',
    'refresh_token_invalidated',
]);

/**
 * Credentials whose access token is good for at least five more minutes,
 * refreshing them first if needed (`login/src/auth/manager.rs`: JSON POST
 * `{client_id, grant_type: "refresh_token", refresh_token}` to
 * `{issuer}/oauth/token`, refreshed within
 * `CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES` of expiry).
 *
 * Refresh tokens rotate and are single use, so: one refresh per connection
 * at a time; the rotated credentials are saved with `save` before they are
 * returned (if saving fails, so does this, and the access token goes
 * unused); and `invalid_grant`, an expired, reused or revoked refresh
 * token, a 401, or an ID token for a different account marks the
 * connection as needing a new sign-in (`chatgpt_needs_relogin`). A network
 * or server failure keeps the old credentials while their access token
 * still works, unless the refresh was forced (the backend already refused
 * that token).
 */
export async function ensureFresh(
    credentials: ChatGptCredentials,
    save: SaveCredentials,
    options: EnsureFreshOptions = {},
): Promise<ChatGptCredentials> {
    const now = options.now ?? Date.now;
    if (!options.force && credentials.expiresAt - now() > REFRESH_WINDOW_MS) {
        return credentials;
    }
    const key = keyOf(credentials.refreshToken);
    const recent = rotated.get(key);
    if (recent && recent.until > now()) {
        if (!options.force || recent.credentials.expiresAt - now() > REFRESH_WINDOW_MS) {
            return recent.credentials;
        }
    }
    const running = inFlight.get(key);
    if (running) {
        return running;
    }
    const refresh = refreshOnce(credentials, save, options, now).finally(() => inFlight.delete(key));
    inFlight.set(key, refresh);
    return refresh;
}

async function refreshOnce(
    credentials: ChatGptCredentials,
    save: SaveCredentials,
    options: EnsureFreshOptions,
    now: () => number,
): Promise<ChatGptCredentials> {
    const needsRelogin = async (status?: number, providerCode?: string) => {
        await options.markNeedsRelogin?.().catch(() => {});
        return new ChatGptError('chatgpt_needs_relogin', { status, providerCode });
    };
    let answer: { status: number; text: string };
    try {
        answer = await authPost(
            options,
            tokenUrl(endpointsOf(options).issuer),
            {
                client_id: CODEX_CLIENT_ID,
                grant_type: 'refresh_token',
                refresh_token: credentials.refreshToken,
            },
            { originator: true },
        );
    } catch (error) {
        if (!options.force && credentials.expiresAt > now()) {
            return credentials;
        }
        throw error;
    }
    if (answer.status < 200 || answer.status > 299) {
        const code = oauthErrorCode(answer.text);
        if (answer.status === 401 || (code && PERMANENT.has(code.toLowerCase()))) {
            throw await needsRelogin(answer.status, code);
        }
        if (!options.force && credentials.expiresAt > now()) {
            return credentials;
        }
        throw new ChatGptError('chatgpt_unavailable', {
            status: answer.status,
            providerCode: code,
        });
    }
    let body: Record<string, unknown>;
    try {
        body = JSON.parse(answer.text) as Record<string, unknown>;
    } catch {
        throw new ChatGptError('chatgpt_unavailable', { providerCode: 'bad_json' });
    }
    // The CLI refuses a refresh that comes back for another account.
    const newAccount = authClaims(typeof body.id_token === 'string' ? body.id_token : undefined).accountId;
    if (newAccount && newAccount !== credentials.accountId) {
        throw await needsRelogin(answer.status, 'account_mismatch');
    }
    const next = credentialsFrom(body, credentials, now());
    if (!next) {
        throw new ChatGptError('chatgpt_unavailable', {
            providerCode: 'bad_token_response',
        });
    }
    // Persist first: the old refresh token is spent, so these are the only
    // credentials that will work from now on.
    await save(next);
    rotated.set(keyOf(credentials.refreshToken), {
        credentials: next,
        until: now() + ROTATED_TTL_MS,
    });
    for (const [key, entry] of rotated) {
        if (entry.until <= now()) {
            rotated.delete(key);
        }
    }
    return next;
}

/**
 * Revokes a connection's refresh token on disconnect, best effort, as
 * `codex logout` does (`login/src/auth/revoke.rs`: JSON POST
 * `{token, token_type_hint: "refresh_token", client_id}` to
 * `{issuer}/oauth/revoke`). The caller deletes the stored credentials
 * whatever this returns.
 */
export async function revoke(credentials: ChatGptCredentials, options: ChatGptHttpOptions = {}): Promise<boolean> {
    try {
        const answer = await authPost(
            options,
            revokeUrl(endpointsOf(options).issuer),
            {
                token: credentials.refreshToken,
                token_type_hint: 'refresh_token',
                client_id: CODEX_CLIENT_ID,
            },
            { originator: true },
        );
        return answer.status >= 200 && answer.status <= 299;
    } catch {
        return false;
    }
}

/** Forget cached rotations (tests). */
export function resetRefreshState() {
    inFlight.clear();
    rotated.clear();
}
