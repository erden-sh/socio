/**
 * The coding gateways' layer: their sources (`sources.ts`) from the other
 * features' tags, the two audience policies registered over them
 * (`gateway:model`, then `gateway:git`, which builds both gateways, as at
 * platform start before), and `Gateway` over the same gateways, offered as
 * coding's `CodingGateway` too (the port coding sessions call). It
 * reads `GatewayConfig`, which the composition builds from the supplied
 * configuration. Only the composition (`composition/gateway.ts`) and tests
 * import this file.
 *
 * Not built here: the listener (`createGatewayServer`), which the boot step
 * starts on every runtime once the graph is built and stops as the server
 * closes (`composition/lifecycle/gateway.ts`), after the runtime is
 * disposed; and the coding sessions the gateways' module hosts, which are
 * coding's own (`adopted.ts`, `HostedCoding`).
 */
import { Context, Effect, Layer } from 'effect';

import { Actors } from '../actors/contract.js';
import { Approvals } from '../approvals/contract.js';
import { Apps } from '../apps/contract.js';
import { CodeAccess } from '../auth/contract.js';
import { CodingGateway, GatewayExchanges } from '../coding/contract.js';
import { Data } from '../dataspace/contract.js';
import { Flags } from '../flags/contract.js';
import { GitHubClients } from '../github/contract.js';
import { Inference } from '../inference/contract.js';
import { Releases } from '../updates/contract.js';

import { Gateway, GatewayConfig } from './contract.js';
import { registerGitAudience } from './git.js';
import { registerModelAudience } from './model.js';
import { gatewayService } from './service.js';
import type { GatewaySources } from './sources.js';

/**
 * What a platform's gateways are made from (`sources.ts`), as the layer
 * built them: the composition adopts them for the platform (`adopted.ts`).
 */
export class GatewaySourcesTag extends Context.Service<GatewaySourcesTag, GatewaySources>()(
    'socio/gateway/GatewaySources',
) {}

/**
 * What no tag holds at the gateways' step: the workspace slices and the
 * runtime's identity (the boot step's), and the GitHub App in force, whose
 * service github's step builds later, read at the moment of use.
 */
export type GatewayLocal = Pick<GatewaySources, 'workspace' | 'runtime' | 'github'>;

/** The sources, from the tags and `local`. */
export const makeGatewaySources = (local: GatewayLocal) =>
    Effect.gen(function* () {
        const sources: GatewaySources = {
            actors: yield* Actors,
            approvals: yield* Approvals,
            apps: yield* Apps,
            data: yield* Data,
            flags: yield* Flags,
            github: local.github,
            githubClients: yield* GitHubClients,
            inference: yield* Inference,
            runtime: local.runtime,
            codeAccess: yield* CodeAccess,
            exchanges: yield* GatewayExchanges,
            releases: yield* Releases,
            workspace: local.workspace,
            config: yield* GatewayConfig,
        };
        return sources;
    });

/**
 * The gateways' audience policies (CB-239) over `sources`: the
 * model gateway's, then the Git gateway's, each building its gateway.
 */
export function registerGatewayAudiences(sources: GatewaySources) {
    registerModelAudience(sources);
    registerGitAudience(sources);
}

/**
 * The gateways' step: their sources from the tags, the audiences
 * registered over them, offered as `GatewaySourcesTag`, with `Gateway` and,
 * the same value, `CodingGateway`.
 */
export const GatewayLive = (local: GatewayLocal) =>
    Layer.effectContext(
        Effect.gen(function* () {
            const sources = yield* makeGatewaySources(local);
            registerGatewayAudiences(sources);
            const gateway = gatewayService(sources);
            return Context.make(GatewaySourcesTag, sources).pipe(
                Context.add(Gateway, gateway),
                Context.add(CodingGateway, gateway),
            );
        }),
    );
