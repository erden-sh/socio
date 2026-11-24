/**
 * Coding sessions' part of the graph: the runtime's one coding sessions
 * service, built from the tags at the gateways' step (`codingSessionsLayer`,
 * placed by `composition/gateway.ts`), what the gateways' module hosts of it
 * (`hostedCoding`), and coding's layers (`coding/layer.ts`) over it at the
 * graph's end, with `CodingConfig` built here from the supplied startup
 * configuration.
 *
 * The service is built at the gateways' step, as it always was, after the
 * gateways' audiences: its construction registers approvals and a
 * revocation listener, and `codingConfigFromEnv` throws there on a
 * malformed `CODING_*` setting. Nothing keys it by a platform: each graph
 * builds it once, and the later steps take it from `CodingService`.
 */
import { Context, Effect, Layer } from 'effect';

import { Actors } from '../actors/contract.js';
import type { CodingConfigShape, CodingSessionsConfig } from '../coding/contract.js';
import { CodingConfig } from '../coding/contract.js';
import { CodingHost, CodingLive, CodingService, CodingServiceLive } from '../coding/layer.js';
import type { CodingParts } from '../coding/parts.js';
import { sessionRoutes } from '../coding/routes.js';
import { codingConfigFromEnv } from '../coding/sessions.js';
import { sessionTools } from '../coding/tools.js';
import { Computers, type ComputersShape } from '../computers/contract.js';
import { Flags } from '../flags/contract.js';
import type { HostedCoding } from '../gateway/adopted.js';

import { LegacyConfig, LegacyModuleContext, LegacyWorkspace } from './base.js';
import type { PlatformConfig } from './config.js';
import { Ports } from './ports.js';

/**
 * `CodingConfig` from the supplied startup configuration (`PlatformConfig`;
 * moving env parsing here is a later change). `sessions` is the service's
 * own, read on every use: the environment's coding settings as the service
 * read them when it was built (`codingConfigFromEnv`), and as `configure()`
 * changed them since, never a second copy.
 */
export const codingConfig = (
    config: Pick<PlatformConfig, 'sessionSecret' | 'appOrigin' | 'notificationLimits'>,
    sessions: () => CodingSessionsConfig,
): CodingConfigShape => ({
    get sessions() {
        return sessions();
    },
    sessionSecret: config.sessionSecret,
    appOrigin: config.appOrigin,
    notificationLimits: config.notificationLimits,
});

/**
 * What the coding sessions need that no feature's tag offers yet
 * (`CodingHost`): the workspace's connection, and the drain, the Telegram
 * channel and a socio's turn from the ports, each read at the moment of
 * use (the drain and the channel are set after the graph is built, the
 * turns' step comes after the gateways'), and the modules' log.
 */
const CodingHostHere = Layer.effect(
    CodingHost,
    Effect.gen(function* () {
        const ports = yield* Ports;
        const { db } = yield* LegacyWorkspace;
        const context = yield* LegacyModuleContext;
        return CodingHost.of({
            db,
            draining: () => ports.draining.get(),
            telegram: () => ports.telegram.peek(),
            turnOutcome: (threadId, prompt, signal, options) =>
                ports.turns.get().turnOutcome(threadId, prompt, signal, options),
            log: (line) => context.log(line),
        });
    }),
);

/**
 * `CodingConfig` as the service is built with it: the environment's coding
 * settings, parsed here, once (`codingConfigFromEnv` throws on a malformed
 * `CODING_*` setting, so a bad one fails the gateways' step, as before),
 * and the startup configuration's fields, read on every use.
 */
const CodingConfigAtBuild = Layer.effect(
    CodingConfig,
    Effect.gen(function* () {
        const config = yield* LegacyConfig;
        const sessions = codingConfigFromEnv(process.env, config);
        return CodingConfig.of({
            sessions,
            get sessionSecret() {
                return config.sessionSecret;
            },
            get appOrigin() {
                return config.appOrigin;
            },
            get notificationLimits() {
                return config.notificationLimits;
            },
        });
    }),
);

/**
 * The computers, as the coding sessions read them (`CodingParts['computers']`,
 * their disk only), from their port at the moment of use: the computers'
 * step comes after the gateways'. Provided to the service alone, never
 * offered to the graph.
 */
const ComputersDiskHere = Layer.effect(
    Computers,
    Effect.gen(function* () {
        const ports = yield* Ports;
        const computers: CodingParts['computers'] = {
            get disk() {
                return ports.computers.get().disk;
            },
        };
        // The service reads no other member (`CodingParts['computers']`).
        return computers as unknown as ComputersShape;
    }),
);

/**
 * The runtime's one coding sessions service (`CodingService`), built from
 * the tags (`CodingServiceLive`) at the gateways' step, after the
 * audiences: building it registers its approvals, its credential holder
 * and its revocation listener, so its place in the chain stays where
 * it always was. Each graph builds it once; `codingLayers.bridges`
 * and the gateways' module (`hostedCoding`) take that one.
 */
export const codingSessionsLayer = CodingServiceLive.pipe(
    Layer.provide(Layer.mergeAll(CodingHostHere, CodingConfigAtBuild, ComputersDiskHere)),
);

/**
 * The coding sessions the gateways' module hosts (`HostedCoding`), over
 * the runtime's service: its tick and stop, the socio's tools for a turn
 * (`sessionTools`, each refusal audited through `Actors`) and its routes
 * under `/api/gateway/sessions` (`sessionRoutes`, behind the
 * `coding-sessions` flag).
 */
export const hostedCoding = Effect.gen(function* () {
    const service = yield* CodingService;
    const actors = yield* Actors;
    const flags = yield* Flags;
    const audit = {
        get audit() {
            return actors.audit;
        },
    };
    const coding: HostedCoding = {
        sessions: {
            get configured() {
                return service.configured;
            },
            tick: () => service.tick(),
            shutdown: () => service.shutdown(),
        },
        tools: { dotTools: (turn) => sessionTools(service, audit, turn) },
        routes: () => sessionRoutes({ sessions: () => service, flags, actors: audit }),
    };
    return coding;
});

/**
 * Coding's step of the graph, at its end: `Sessions`, `Tools` and
 * `GatewayExchanges` (`CodingLive`) over the service the gateways' step
 * built (`CodingService`), and `CodingConfig`. None builds anything or
 * takes a listener.
 */
export const codingLayers = {
    bridges: Layer.merge(
        CodingLive,
        Layer.effectContext(
            Effect.gen(function* () {
                const service = yield* CodingService;
                return Context.make(
                    CodingConfig,
                    codingConfig(yield* LegacyConfig, () => service.currentConfig),
                );
            }),
        ),
    ),
};
