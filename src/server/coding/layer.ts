/**
 * Coding's layers: they implement `contract.ts`'s `Sessions`, `Tools` and
 * `GatewayExchanges` over one coding sessions service, and build that
 * service from the tags it reads (`codingParts`): the actors, the
 * approvals, the computers' disk, the flags, the gateways (`CodingGateway`),
 * inference, the limits, the notifier, the runner, the runtime identity,
 * the settings, the workspace's slices with the Telegram links, and
 * `CodingConfig`. What no tag offers yet comes in `CodingHost`. Only the
 * composition root (`composition/coding.ts`) and tests import this file.
 *
 * The service stays the promise-based `CodingSessions`: its callers (the
 * gateway's module, the routes, the tools) await it as before.
 */
import { Context, Effect, Layer } from 'effect';

import { Actors } from '../actors/contract.js';
import { Approvals } from '../approvals/contract.js';
import { Computers } from '../computers/contract.js';
import { Flags } from '../flags/contract.js';
import { Inference } from '../inference/contract.js';
import { Notifier } from '../notifications/contract.js';
import { RuntimeIdentity } from '../runtime/contract.js';
import { Limits, WorkspaceSettings } from '../settings/contract.js';
import { Links } from '../telegram/contract.js';
import { Runner } from '../turns/contract.js';
import { Conversations, People, Socios } from '../workspace/contract.js';

import { CodingConfig, CodingGateway, GatewayExchanges, Sessions, Tools } from './contract.js';
import type { CodingHostShape, CodingParts } from './parts.js';
import { CodingSessions } from './sessions.js';
import { sessionTools } from './tools.js';

/** What the coding sessions need that no feature's tag offers yet (`parts.ts`). */
export class CodingHost extends Context.Service<CodingHost, CodingHostShape>()('socio/coding/CodingHost') {}

/**
 * The coding sessions service, whole, as this folder and the composition
 * use it; other features see `Sessions` and `Tools`.
 */
export class CodingService extends Context.Service<CodingService, CodingSessions>()('socio/coding/CodingSessions') {}

/**
 * The service's parts, from the tags. Each slice is the tag's own value,
 * read when the service calls it; the workspace's members come from its
 * slices (`Conversations`, `People`, `Socios`) and `Links`.
 */
export const codingParts = Effect.gen(function* () {
    const conversations = yield* Conversations;
    const people = yield* People;
    const socios = yield* Socios;
    const links = yield* Links;
    const parts: CodingParts = {
        host: yield* CodingHost,
        config: yield* CodingConfig,
        actors: yield* Actors,
        approvals: yield* Approvals,
        computers: yield* Computers,
        flags: yield* Flags,
        gateway: yield* CodingGateway,
        inference: yield* Inference,
        limits: yield* Limits,
        notifications: yield* Notifier,
        runner: yield* Runner,
        runtime: yield* RuntimeIdentity,
        settings: yield* WorkspaceSettings,
        workspace: {
            thread: (id) => conversations.thread(id),
            allows: (userId, id, action, check) => conversations.allows(userId, id, action, check),
            users: () => people.users(),
            hasUser: (userId) => people.hasUser(userId),
            isDeactivated: (userId) => people.isDeactivated(userId),
            dot: (id) => socios.dot(id),
            canUseDot: (userId, dotId) => socios.canUseDot(userId, dotId),
            telegram: links,
        },
    };
    return parts;
});

/**
 * The service, built once from the tags. Building it registers what its
 * constructor always has: the two start approvals, the five runtime
 * approvals, the `prompt-run` credential holder and the revocation
 * listener; and attaches the runtime's ownership to the connection.
 */
export const CodingServiceLive = Layer.effect(
    CodingService,
    Effect.map(codingParts, (parts) => new CodingSessions(parts)),
);

/**
 * `Sessions`, `Tools` and `GatewayExchanges` over the service: the service
 * itself, its tools for a turn (each refusal audited through `Actors`),
 * and its exchange log's rows.
 */
export const CodingLive = Layer.effectContext(
    Effect.gen(function* () {
        const service = yield* CodingService;
        const actors = yield* Actors;
        return Context.make(Sessions, Sessions.of(service)).pipe(
            Context.add(Tools, Tools.of({ dotTools: (turn) => sessionTools(service, actors, turn) })),
            Context.add(GatewayExchanges, GatewayExchanges.of(service.exchanges)),
        );
    }),
);
