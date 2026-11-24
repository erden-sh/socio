/**
 * The coding gateway's internal listener: its start and stop. It stays a step
 * the boot and the shutdown call, not a finalizer on the gateways' layer scope:
 * it starts once the pages are mounted, on every runtime, and closes as the
 * server closes, after the runtime is disposed
 * (`composition/lifecycle/index.ts`); a finalizer would close it earlier, with
 * the runtime. Its settings come from the environment the entry hands it
 * (`gatewayConfigFromEnv`, which throws on a malformed `GATEWAY_PORT` or
 * `GATEWAY_SUBNET`), as before; moving that parsing into composition is a
 * later change.
 */
import { Context } from 'effect';

import { HostedGateway } from '../../gateway/adopted.js';
import { createGatewayServer, gatewayConfigFromEnv } from '../../gateway/server.js';
import type { AppEdge } from '../../main.js';

/**
 * The coding gateway's internal listener (CB-239) runs on every runtime,
 * once built and configured, over the gateways the runtime built (its
 * `HostedGateway`).
 */
export function startGateway(edge: AppEdge, env: Record<string, string | undefined>) {
    const { sources } = Context.get(edge.services, HostedGateway);
    const gateway = createGatewayServer(sources, gatewayConfigFromEnv(env));
    void gateway?.listen();
    return gateway;
}

export async function stopGateway(gateway: ReturnType<typeof startGateway>) {
    await gateway?.close();
}

/** The coding gateway's steps, as lifecycle/index.ts runs them: its start and stop. */
export const gatewayLifecycle = { start: startGateway, stop: stopGateway };
