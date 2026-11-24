/**
 * Socio's `provider-codex` (CB-326): a Codex `ProviderDriver` written over
 * the vendored `effect-codex-app-server` JSON-RPC client and Socio's
 * gateway-token pattern, instead of an extraction of T3's `CodexAdapterV2`
 * (which drags ~4,500 lines of T3-app-server internals).
 *
 * This slice lands the driver skeleton + the orchestration adapter (event
 * stream + session/turn methods) over the `CodexAppServerClient`. The full
 * event mapping, textGeneration, usage and the managed snapshot follow; the
 * rarer adapter methods (fork, rollback, MCP apps, subagents) are typed
 * errors until wired. Nothing imports this package yet; step 3 wires it into
 * the session host.
 */
export { CodexSettings, type GatewayRoute } from './settings.ts';
export { CodexDriver, CODEX_DRIVER_KIND, type CodexDriverEnv } from './driver.ts';
export { makeAdapter, makeSessionRuntime, CodexAdapterNotImplemented } from './adapter.ts';
