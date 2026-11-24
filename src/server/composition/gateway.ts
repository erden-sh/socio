import { Context, Effect, Layer } from 'effect';

import { AppExtractionDelivery, type AppExtractions } from '../apps/contract.js';
/**
 * The coding gateways' construction: their layer (`gateway/layer.ts`) at their
 * step of the graph, `GatewayConfig` from the supplied configuration. The
 * runtime's gateways are made from one set of sources; after their audiences,
 * the coding sessions are built from the tags (`codingSessionsLayer`, which
 * registers their approvals and revocation listener: its place in the order
 * stays), and the sources with the coding sessions their module hosts are
 * offered as `HostedGateway` (`gateway/adopted.ts`).
 *
 * What no tag holds yet at the gateways' step is provided to it from the
 * same builders the later steps use: the exchange log's rows on the workspace's connection (coding's
 * bridge makes its own, as `ModelGateway` did), the build's releases and
 * the GitHub clients (constants). The GitHub App in force is read from its
 * late-bound port at the moment of use: github's step comes later and
 * fills it.
 */
import { GatewayExchanges } from '../coding/contract.js';
import { GatewayExchangeRows } from '../coding/infra/rows.js';
import { HostedGateway, type AdoptedGateway } from '../gateway/adopted.js';
import { Gateway, GatewayConfig, type GatewayConfigShape } from '../gateway/contract.js';
import { GatewayLive, GatewaySourcesTag, type GatewayLocal } from '../gateway/layer.js';
import { gitHubClients } from '../github/api.js';
import { GitHubClients } from '../github/contract.js';
import { ReleasesLive } from '../updates/layer.js';

import { LegacyConfig, LegacyRunner, LegacyWorkspace } from './base.js';
import { codingSessionsLayer, hostedCoding } from './coding.js';
import type { PlatformConfig } from './config.js';
import { LegacyGitHub } from './github.js';
import { Ports, type PlatformPorts } from './ports.js';

/**
 * What the gateways read of the startup configuration (the `PlatformConfig`
 * `startAppRuntime` is given, not the environment; moving env parsing here
 * is a later change). Each field is read from that object on every use, as
 * the gateways read `platform.config` before.
 */
export function gatewayConfig(config: {
    readonly codeUsers?: PlatformConfig['codeUsers'];
    readonly sessionSecret?: PlatformConfig['sessionSecret'];
    readonly appOrigin?: PlatformConfig['appOrigin'];
    readonly apps?: { readonly host?: string };
    readonly githubAccess?: PlatformConfig['githubAccess'];
}): GatewayConfigShape {
    return {
        get codeUsers() {
            return config.codeUsers ?? [];
        },
        get sessionSecret() {
            return config.sessionSecret;
        },
        get appOrigin() {
            return config.appOrigin;
        },
        get appsHost() {
            return config.apps?.host;
        },
        get githubAccess() {
            return config.githubAccess;
        },
    };
}

/** The GitHub App in force, read from its port when it is used (github's step fills it). */
const githubOf = (ports: Pick<PlatformPorts, 'github'>): GatewayLocal['github'] => ({
    inForce: () => ports.github.get().inForce(),
});

/** The gateways a runtime adopted and the app extraction delivery, which the modules' hooks read. */
export interface GatewayAdopted {
    readonly gateway: AdoptedGateway;
    readonly extractions: AppExtractions;
}

/**
 * The gateways' sources with the coding sessions their module hosts
 * (`HostedGateway`), and the app extraction route's delivery
 * (`AppExtractionDelivery`): the `Gateway` service's `deliverExtraction`,
 * over the same sources, for the modules' hooks. Built after the coding
 * sessions, which come after the audiences.
 */
const Adopted = Layer.effectContext(
    Effect.gen(function* () {
        const sources = yield* GatewaySourcesTag;
        const service = yield* Gateway;
        const gateway: AdoptedGateway = { sources, coding: yield* hostedCoding };
        const extractions: AppExtractions = (input) => service.deliverExtraction(input);
        return Context.make(HostedGateway, gateway).pipe(Context.add(AppExtractionDelivery, extractions));
    }),
);

/** `GatewayConfig`, from the supplied configuration. */
const GatewayConfigLive = Layer.effect(
    GatewayConfig,
    Effect.gen(function* () {
        return gatewayConfig(yield* LegacyConfig);
    }),
);

/** What the gateways' step reads before the steps that offer it come. */
const Early = Layer.unwrap(
    Effect.gen(function* () {
        const { db } = yield* LegacyWorkspace;
        return Layer.mergeAll(
            Layer.succeed(GatewayExchanges, new GatewayExchangeRows(db)),
            ReleasesLive,
            Layer.succeed(GitHubClients, gitHubClients),
        );
    }),
);

/**
 * The gateways' step of the graph, where the server has always made
 * them: `gateway/layer.ts`'s `GatewayLive` (its sources from the tags, the
 * audiences, `Gateway`), with `GatewayConfig`; then the coding sessions,
 * built once (`CodingService`); then the sources with those sessions,
 * offered to the modules' hooks as `HostedGateway` with
 * `AppExtractionDelivery`.
 *
 * `github`, right after github's step, fills the port the audiences read
 * the GitHub App in force from: it builds nothing and takes no listener.
 *
 * `bridges`, at the graph's end, builds nothing: `Gateway` and
 * `GatewayConfig` are offered from the gateways' own step.
 */
export const gatewayLayers = {
    audiences: Adopted.pipe(
        Layer.provideMerge(codingSessionsLayer),
        Layer.provideMerge(
            Layer.unwrap(
                Effect.gen(function* () {
                    const ports = yield* Ports;
                    return GatewayLive({
                        workspace: yield* LegacyWorkspace,
                        runtime: (yield* LegacyRunner).runtime,
                        github: githubOf(ports),
                    });
                }),
            ),
        ),
        Layer.provide(Early),
        Layer.provideMerge(GatewayConfigLive),
    ),
    github: Layer.effectDiscard(
        Effect.gen(function* () {
            (yield* Ports).github.fill(yield* LegacyGitHub);
        }),
    ),
    bridges: Layer.empty,
};
