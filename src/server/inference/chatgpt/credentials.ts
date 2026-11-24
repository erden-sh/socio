import { planLabel } from './errors.js';

/**
 * One user's ChatGPT-plan sign-in. Lives only in the user's encrypted
 * connection blob and in memory while a turn uses it; never logged, never in
 * events or errors, never sent to the client.
 *
 * The ID token is not kept (`idToken` stays unset): it carries the account's
 * name and email, and everything needed from it (`accountId`, `planType`) is
 * read at sign-in and on each refresh.
 */
export interface ChatGptCredentials {
    accessToken: string;
    /** Single use: each refresh returns a new one, and the old one stops working. */
    refreshToken: string;
    idToken?: string;
    /** The ChatGPT workspace (`chatgpt_account_id`), sent as `ChatGPT-Account-ID`. */
    accountId: string;
    /** The plan id as the ID token names it, e.g. `plus`. */
    planType?: string;
    /** When the access token expires, epoch milliseconds. */
    expiresAt: number;
}

/** What the client may see about a connection: never tokens, ids, names or emails. */
export interface ChatGptPublicStatus {
    connected: boolean;
    /** Display name, e.g. "Plus". */
    plan?: string;
    /** e.g. "Connected · plan: Plus". */
    label: string;
}

export function publicStatus(credentials: ChatGptCredentials | undefined): ChatGptPublicStatus {
    if (!credentials) {
        return { connected: false, label: 'Not connected' };
    }
    const plan = planLabel(credentials.planType);
    return plan
        ? { connected: true, plan, label: `Connected · plan: ${plan}` }
        : { connected: true, label: 'Connected' };
}

interface AuthClaims {
    accountId?: string;
    planType?: string;
    /** JWT `exp`, epoch milliseconds. */
    expiresAt?: number;
}

/**
 * The claims the CLI reads from its tokens (`login/src/token_data.rs`):
 * `https://api.openai.com/auth` → `chatgpt_account_id`, `chatgpt_plan_type`,
 * plus the standard `exp`. The payload is decoded, not verified: the token
 * came straight from the issuer over TLS, and only OpenAI checks it. Email
 * and name claims are never read.
 */
export function authClaims(jwt: string | undefined): AuthClaims {
    if (!jwt) {
        return {};
    }
    const [header, payload, signature] = jwt.split('.');
    if (!header || !payload || signature === undefined) {
        return {};
    }
    let claims: unknown;
    try {
        claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
        return {};
    }
    if (claims === null || typeof claims !== 'object') {
        return {};
    }
    const all = claims as Record<string, unknown>;
    const auth = all['https://api.openai.com/auth'];
    const scoped = auth !== null && typeof auth === 'object' ? (auth as Record<string, unknown>) : {};
    const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined);
    return {
        accountId: text(scoped.chatgpt_account_id),
        planType: text(scoped.chatgpt_plan_type),
        expiresAt: typeof all.exp === 'number' && Number.isFinite(all.exp) ? all.exp * 1000 : undefined,
    };
}

export interface TokenResponse {
    access_token?: unknown;
    refresh_token?: unknown;
    id_token?: unknown;
    expires_in?: unknown;
}

/**
 * Credentials from a token endpoint answer. `previous` supplies what a
 * refresh may omit (the CLI keeps the old refresh and ID tokens when the
 * response leaves them out). Undefined when the answer can't be used.
 */
export function credentialsFrom(
    response: TokenResponse,
    previous?: ChatGptCredentials,
    now = Date.now(),
): ChatGptCredentials | undefined {
    const accessToken =
        typeof response.access_token === 'string' && response.access_token ? response.access_token : undefined;
    const refreshToken =
        typeof response.refresh_token === 'string' && response.refresh_token
            ? response.refresh_token
            : previous?.refreshToken;
    if (!accessToken || !refreshToken) {
        return undefined;
    }
    const idToken = typeof response.id_token === 'string' ? response.id_token : undefined;
    const fromId = authClaims(idToken);
    const fromAccess = authClaims(accessToken);
    const accountId = fromId.accountId ?? fromAccess.accountId ?? previous?.accountId;
    if (!accountId) {
        return undefined;
    }
    const expiresIn =
        typeof response.expires_in === 'number' && response.expires_in > 0 ? response.expires_in * 1000 : undefined;
    const planType = fromId.planType ?? fromAccess.planType ?? previous?.planType;
    return {
        accessToken,
        refreshToken,
        accountId,
        ...(planType ? { planType } : {}),
        expiresAt: fromAccess.expiresAt ?? (expiresIn ? now + expiresIn : now + 3600_000),
    };
}

/** The token values in a set of credentials, for redaction. */
export const secretsOf = (credentials: ChatGptCredentials | undefined) =>
    credentials ? [credentials.accessToken, credentials.refreshToken, credentials.idToken, credentials.accountId] : [];
