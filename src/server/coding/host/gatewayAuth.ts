/**
 * The gateway-token injection for the session host (CB-326 step 2): the
 * generalization of T3 Code's `CodexManagedRuntime` auth-command pattern
 * (`model_providers.X.auth=
 * {command,args}`) to every harness a session host runs.
 *
 * T3's Codex managed runtime starts `codex` with `model_providers.openai_token_sharing`
 * whose `auth.command` is the server itself, run as a child, that prints the
 * holder's access token to stdout for codex to read (a private Unix-socket
 * broker, `CodexManagedTokenBroker.ts`). Socio already has the simpler form:
 * `with-token` (deployment/coding/with-token) reads the session's `cbgw_` from
 * `/run/socio/token` into the one environment variable the harness reads its key
 * from, so the token is never in argv or the exec's environment. The one-shot
 * adapters (coding-sandbox.mjs) build each harness's argv+env around it today.
 *
 * The session host replaces the one-shot exec, so it needs the same per-harness
 * facts as a config the vendored drivers consume: the gateway's `base_url`, the
 * auth command (`with-token`) and the env-var name each harness's provider
 * config points its key at, and the wire API. This module holds those facts in
 * one place so the host (CB-326 step 3) and the drivers share them.
 */

/** The gateway as every harness sees it, through the coding egress proxy. */
export const GATEWAY_URL = 'http://gateway.socio.internal';

/** The sandbox tool that reads the session's `cbgw_` into a named env var. */
export const WITH_TOKEN = '/usr/local/lib/socio/with-token';

/**
 * The wire API a harness speaks to the gateway. Codex and Grok use the
 * Responses API; Claude Code speaks Anthropic Messages; Gemini CLI speaks the
 * Gemini API. OpenCode speaks the gateway's OpenAI-compatible Chat Completions.
 */
export type GatewayWireApi = 'responses' | 'messages' | 'gemini' | 'chat';

/**
 * One harness's gateway route: how its provider config reaches the gateway
 * with the session's `cbgw_`. The `envVar` is the one variable `with-token`
 * writes the token into and the harness reads its key from; `authCommand`
 * runs `with-token <envVar> <harness binary>`.
 */
export interface GatewayRoute {
    readonly harness: string;
    readonly wireApi: GatewayWireApi;
    /** The env var the harness reads its gateway key from. */
    readonly envVar: string;
    /** The gateway base URL the harness points at. */
    readonly baseUrl: string;
}

/**
 * The gateway route for each harness the session host runs. The env-var names
 * match the one-shot adapters in coding-sandbox.mjs (and with-token's allowlist),
 * so the existing sandbox image and `with-token` tool carry over unchanged.
 */
export const GATEWAY_ROUTES: Readonly<Record<string, GatewayRoute>> = {
    codex: {
        harness: 'codex',
        wireApi: 'responses',
        envVar: 'SOCIO_GATEWAY_TOKEN',
        baseUrl: `${GATEWAY_URL}/v1`,
    },
    grok: {
        harness: 'grok',
        wireApi: 'responses',
        envVar: 'SOCIO_GATEWAY_TOKEN',
        baseUrl: `${GATEWAY_URL}/v1`,
    },
    'claude-code': {
        harness: 'claude-code',
        wireApi: 'messages',
        envVar: 'ANTHROPIC_AUTH_TOKEN',
        baseUrl: GATEWAY_URL,
    },
    'gemini-cli': {
        harness: 'gemini-cli',
        wireApi: 'gemini',
        envVar: 'GEMINI_API_KEY',
        baseUrl: GATEWAY_URL,
    },
    opencode: {
        harness: 'opencode',
        wireApi: 'chat',
        envVar: 'SOCIO_GATEWAY_TOKEN',
        baseUrl: `${GATEWAY_URL}/v1`,
    },
};

/** The auth command + args a provider config points at, mirroring T3's pattern. */
export interface AuthCommand {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
}

/**
 * The `with-token` auth command for a harness: `with-token <envVar> <binary>`,
 * the same shape the one-shot adapters exec. The provider's model config points
 * its `auth.command` here; running it prints the session's `cbgw_` into the
 * harness's key env var (T3's broker replaced by the sandbox's token file).
 */
export const authCommandFor = (route: GatewayRoute, binary: string): AuthCommand => ({
    command: WITH_TOKEN,
    args: [route.envVar, binary],
});
