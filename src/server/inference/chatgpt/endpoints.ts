/**
 * Where a ChatGPT-plan connection talks to, taken from the pinned Codex CLI
 * (`@openai/codex` 0.161.0, tag `rust-v0.161.0`, commit 9790114 in
 * github.com/openai/codex, Apache-2.0). Paths below are under `codex-rs/`:
 *
 * - Public client id `app_EMoamEEZ73f0CkXaXp7hrann` and the refresh/revoke
 *   URLs: `login/src/auth/manager.rs` (`CLIENT_ID`, `REFRESH_TOKEN_URL`,
 *   `REVOKE_TOKEN_URL`).
 * - Issuer `https://auth.openai.com`: `login/src/server.rs` (`DEFAULT_ISSUER`).
 * - Device-code login (`codex login --device-auth`): `login/src/device_code_auth.rs`.
 * - ChatGPT backend `https://chatgpt.com/backend-api/codex`:
 *   `model-provider-info/src/lib.rs` (`CHATGPT_CODEX_BASE_URL`), with
 *   `/responses` from `codex-api/src/endpoint/responses.rs`.
 * - `originator: codex_cli_rs` and the `name/version (suffix)` User-Agent:
 *   `login/src/auth/default_client.rs`.
 *
 * Tests point `issuer` and `codexBaseUrl` at a loopback fake; nothing else
 * changes them.
 */
export interface ChatGptEndpoints {
    /** OpenAI's auth server: device code, token and revoke endpoints. */
    issuer: string;
    /** The ChatGPT backend the Codex CLI uses on a ChatGPT plan. */
    codexBaseUrl: string;
}

export const CHATGPT_ENDPOINTS: ChatGptEndpoints = {
    issuer: 'https://auth.openai.com',
    codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
};

/** The Codex CLI's public OAuth client, so sign-in matches `codex login --device-auth`. */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
/** The CLI version these endpoints and request shapes were read from. */
export const CODEX_CLI_VERSION = '0.161.0';
/** The CLI's default `originator` header (`DEFAULT_ORIGINATOR`). */
export const CODEX_ORIGINATOR = 'codex_cli_rs';
/**
 * The CLI's User-Agent is `codex_cli_rs/<version> (<os>; <arch>) <terminal>`
 * plus an integrator suffix in parentheses. We send the name and version with
 * our own suffix: no host details, and never anything about the user.
 */
export const CODEX_USER_AGENT = `${CODEX_ORIGINATOR}/${CODEX_CLI_VERSION} (socio)`;

/** The CLI gives up on a device code after 15 minutes (`poll_for_token`). */
export const DEVICE_CODE_TTL_MS = 15 * 60_000;
/** Refresh this long before the access token expires (`CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES`). */
export const REFRESH_WINDOW_MS = 5 * 60_000;

export const trimSlash = (url: string) => url.replace(/\/+$/, '');

export const deviceUrls = (issuer: string) => {
    const base = trimSlash(issuer);
    return {
        userCode: `${base}/api/accounts/deviceauth/usercode`,
        token: `${base}/api/accounts/deviceauth/token`,
        verification: `${base}/codex/device`,
        redirect: `${base}/deviceauth/callback`,
    };
};
export const tokenUrl = (issuer: string) => `${trimSlash(issuer)}/oauth/token`;
export const revokeUrl = (issuer: string) => `${trimSlash(issuer)}/oauth/revoke`;
export const responsesUrl = (codexBaseUrl: string) => `${trimSlash(codexBaseUrl)}/responses`;
