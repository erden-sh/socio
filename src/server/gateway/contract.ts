/**
 * What other features may know of the coding gateways (CB-239): their tags,
 * the slices of the model and Git gateways they call, their error and plain
 * types. It imports only `effect`, `@socio/*`, other contracts and
 * `import type` from `node:*`, and holds no logic.
 *
 * The tags were added here, and the listener's `GatewayConfig` (`server.ts`)
 * moved here as `GatewayListenerConfig` so that the name `GatewayConfig` is
 * the config tag below.
 *
 * What coding sessions call of the gateways is coding's port
 * (`CodingGateway` in `coding/contract.ts`), with its slices, plain types
 * and `GitProxyError`: coding sits below the gateways in the folder order,
 * so it states what it needs and the gateways implement it. `Gateway` is
 * that port and the apps' extraction delivery. What the extraction route
 * reads (`ExtractionAwarePolicy`, `ExtractionDelivery`) is apps' own
 * (`apps/contract.ts`), for the same reason.
 *
 * `gatewayService(sources)` (`service.ts`) serves `Gateway`; `ModelGateway`,
 * `CodingSettings`, `GatewayOptions`, `GatewayLedger` and `GitRepositories`
 * implement their slices, and `GitGateway` extends its. The layer
 * (`layer.ts`) provides `Gateway`, and `CodingGateway` as the same value;
 * the composition (`composition/gateway.ts`) builds `GatewayConfig` from
 * the supplied configuration.
 *
 * Not here, on purpose:
 * - The gateways themselves (`ModelGateway`, `gitGateway`, `Extractions`),
 *   their routes and the listener (`createGatewayServer`): the gateway's
 *   module and the composition build them; other features get `Gateway`.
 * - `codeUsersFromEnv` and `gatewayConfigFromEnv`: only entry code (the
 *   server entry, `composition/lifecycle/gateway.ts`) reads the environment.
 *   The listener's settings (`GatewayListenerConfig`) aren't in
 *   `GatewayConfig`: the listener's boot step reads them from the
 *   environment the entry hands it, as before; moving that parsing into
 *   the composition is a later change.
 */
import { Context } from 'effect';

import type { ExtractionDelivery } from '../apps/contract.js';
import type { CodingGatewayShape } from '../coding/contract.js';
import type { GitHubOptions } from '../github/contract.js';

// ── Plain types ──────────────────────────────────────────────────────────

/** The coding gateway's internal listener (`GATEWAY_*`, `CODING_EGRESS_SECRET`). */
export interface GatewayListenerConfig {
    /** `GATEWAY_PORT` (default 4340); never routed by the public proxy. */
    port: number;
    /** `CODING_EGRESS_SECRET`: the stamp key's source; unset, no gateway. */
    egressSecret?: string;
    /** The gateway network's subnet, in CIDR form (`GATEWAY_SUBNET`). */
    subnet?: string;
    /** The bind address (`GATEWAY_HOST`); all interfaces by default. */
    host?: string;
}

// ── Gateway ──────────────────────────────────────────────────────────────

/**
 * What other features call of the gateways: coding sessions (their port,
 * `CodingGateway`: `mayRunCode`, the Git and model gateways,
 * `openSessionPullRequest`) and the apps' extraction route
 * (`deliverExtraction`). The gateways are built on first use, as today.
 */
export interface GatewayShape extends CodingGatewayShape {
    /** Delivery for the route `GET /api/apps/actor/extractions/:id` (CB-239). */
    deliverExtraction(input: { id: string; appId: string; obo: string | undefined }): Promise<ExtractionDelivery>;
}

export class Gateway extends Context.Service<Gateway, GatewayShape>()('socio/gateway/Gateway') {}

// ── GatewayConfig ────────────────────────────────────────────────────────

/** What the gateways read of the platform's configuration. */
export interface GatewayConfigShape {
    /**
     * `config.codeUsers ?? []`: `CODE_USERS`, deprecated (CB-376). Only the
     * boot's migration to a "Code" group reads it; code access is a
     * permission (`CodeAccess`).
     */
    readonly codeUsers: readonly string[];
    /** `config.sessionSecret`: keys the socios' commit identities and extraction ids. */
    readonly sessionSecret?: string;
    /** `config.appOrigin`: the commit identities' host when `appsHost` is unset. */
    readonly appOrigin?: string;
    /** `config.apps?.host`. */
    readonly appsHost?: string;
    /** `config.githubAccess`: how the Git gateway reaches GitHub (its hosts, a test's transport). */
    readonly githubAccess?: GitHubOptions;
}

export class GatewayConfig extends Context.Service<GatewayConfig, GatewayConfigShape>()(
    'socio/gateway/GatewayConfig',
) {}
