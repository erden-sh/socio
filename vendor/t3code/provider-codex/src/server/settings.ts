import { CodexSettings } from '@t3tools/contracts';
import * as Schema from 'effect/Schema';

/**
 * Socio's Codex provider settings (CB-326): a thin extension of T3's
 * `CodexSettings` (contracts) with the gateway route Socio runs every Codex
 * instance on. T3's `CodexSettings` already carries the fields a managed
 * Codex needs (`binaryPath`, `homePath`, `shadowHomePath`, `launchArgs`,
 * `setupMode`, `enabled`, `customModels`); Socio's gateway config
 * (`base_url`, the `with-token` auth command, the env-var name) is fixed per
 * harness (see Socio's `gatewayAuth.ts`), so it is not a setting — it is
 * built by the driver from the harness route.
 *
 * Re-exported unchanged so the driver imports one settings module.
 */
export { CodexSettings };

/**
 * The gateway route a Codex instance runs on, built by the driver (not a
 * stored setting): the gateway base URL, the `with-token` auth command, and
 * the env var the auth command writes the session's `cbgw_` into. Mirrors
 * T3's `CodexManagedRuntime` `model_providers.X.auth={command,args}` shape,
 * with `with-token` (deployment/coding/with-token) as the command and Socio's
 * gateway as the base URL.
 */
export const GatewayRoute = Schema.Struct({
    baseUrl: Schema.String,
    envKey: Schema.String,
    authCommand: Schema.String,
    authArgs: Schema.Array(Schema.String),
});
export type GatewayRoute = typeof GatewayRoute.Type;
