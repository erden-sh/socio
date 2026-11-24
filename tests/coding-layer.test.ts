// Coding's layers build one coding sessions service from the tags it reads and
// offer it as `Sessions`, `Tools` and `GatewayExchanges`; the composition's
// step offers the service the gateways' step built from the tags, never a
// second one, with `CodingConfig` from the supplied configuration.
import { Context, Effect, Layer } from 'effect';
import { afterEach, expect, it } from 'vitest';

import type { DotTurn } from '@socio/foundation/turns/turn';

import { Actors, type ActorsShape } from '../src/server/actors/contract.js';
import { Approvals, type ApprovalsShape } from '../src/server/approvals/contract.js';
import {
    CodingConfig,
    CodingGateway,
    GatewayExchanges,
    Sessions,
    Tools,
    type CodingGatewayShape,
    type CodingSessionsConfig,
} from '../src/server/coding/contract.js';
import { CodingHost, CodingLive, CodingService, CodingServiceLive } from '../src/server/coding/layer.js';
import { CodingSessions } from '../src/server/coding/sessions.js';
import { LegacyConfig } from '../src/server/composition/base.js';
import { codingLayers } from '../src/server/composition/coding.js';
import type { PlatformConfig } from '../src/server/composition/config.js';
import { Computers, type ComputersShape } from '../src/server/computers/contract.js';
import { Flags, type FlagsShape } from '../src/server/flags/contract.js';
import { Inference, type InferenceShape } from '../src/server/inference/contract.js';
import { Notifier, type NotifierShape } from '../src/server/notifications/contract.js';
import { RuntimeIdentity, type RuntimeIdentityShape } from '../src/server/runtime/contract.js';
import { Limits, WorkspaceSettings, type LimitsShape } from '../src/server/settings/contract.js';
import { Links, type LinksShape } from '../src/server/telegram/contract.js';
import { Runner, type RunnerShape } from '../src/server/turns/contract.js';
import {
    Conversations,
    People,
    Socios,
    type ConversationsShape,
    type PeopleShape,
    type SociosShape,
} from '../src/server/workspace/contract.js';

import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
    for (const fn of cleanup.splice(0).reverse()) {
        fn();
    }
});

function database() {
    const db = testDatabase();
    cleanup.push(() => db.close());
    return db;
}

const sessionsConfig: CodingSessionsConfig = {
    retentionDays: 14,
    disabledHarnesses: [],
    pollSeconds: 10,
    retryMs: 2_000,
    hostMode: false,
};

/** What building a service registers on the actors, the approvals and the runtime. */
function recorded() {
    const seen = {
        capabilities: [] as string[],
        holders: [] as string[],
        revocationListeners: 0,
        attached: [] as unknown[],
    };
    const actors = {
        audit: { recordIn: () => undefined, recordSoon: () => undefined, decision: () => undefined },
        credentials: {
            holders: { register: (kind: string) => void seen.holders.push(kind) },
        },
        revocations: { onRevoked: () => void (seen.revocationListeners += 1) },
    } as unknown as ActorsShape;
    const approvals = {
        register: (definition: { capability: string }) => void seen.capabilities.push(definition.capability),
    } as unknown as ApprovalsShape;
    const runtime = {
        attach: (db: unknown) => {
            seen.attached.push(db);
            return {} as ReturnType<RuntimeIdentityShape['attach']>;
        },
    } as unknown as RuntimeIdentityShape;
    return { seen, actors, approvals, runtime };
}

const turn = { userId: 'alice', threadId: 't1', dot: { id: 'd1' }, check: () => undefined } as unknown as DotTurn;

/** Every tag the service reads, over fakes that record what building it registers. */
function serviceTags(db: ReturnType<typeof database>, { actors, approvals, runtime }: ReturnType<typeof recorded>) {
    return Layer.mergeAll(
        Layer.succeed(CodingHost, {
            db,
            draining: () => false,
            telegram: () => undefined,
            turnOutcome: () => Promise.reject(new Error('no turn here')),
            log: () => undefined,
        }),
        Layer.succeed(CodingConfig, { sessions: sessionsConfig, sessionSecret: 'secret' }),
        Layer.succeed(Actors, actors),
        Layer.succeed(Approvals, approvals),
        Layer.succeed(Computers, {} as ComputersShape),
        Layer.succeed(Flags, {} as FlagsShape),
        Layer.succeed(CodingGateway, {} as CodingGatewayShape),
        Layer.succeed(Inference, {} as InferenceShape),
        Layer.succeed(Limits, {} as LimitsShape),
        Layer.succeed(Notifier, {} as NotifierShape),
        Layer.succeed(Runner, {} as RunnerShape),
        Layer.succeed(RuntimeIdentity, runtime),
        Layer.succeed(WorkspaceSettings, { settings: () => ({}) } as never),
        Layer.succeed(Conversations, {} as ConversationsShape),
        Layer.succeed(People, {} as PeopleShape),
        Layer.succeed(Socios, {} as SociosShape),
        Layer.succeed(Links, {} as LinksShape),
    );
}

it('builds one service from the tags and offers it as Sessions, Tools and GatewayExchanges', async () => {
    const db = database();
    const fakes = recorded();
    const { seen } = fakes;
    const layer = CodingLive.pipe(Layer.provideMerge(CodingServiceLive), Layer.provide(serviceTags(db, fakes)));
    const context = await Effect.runPromise(Layer.build(layer).pipe(Effect.scoped));
    const service = Context.get(context, CodingService);
    expect(service).toBeInstanceOf(CodingSessions);
    expect(Context.get(context, Sessions)).toBe(service);
    expect(Context.get(context, GatewayExchanges)).toBe(service.exchanges);
    // Built once: the two start approvals and the five runtime ones, the
    // prompt-run credential holder and one revocation listener, and the
    // runtime's ownership on the workspace's connection.
    expect(seen.capabilities).toHaveLength(7);
    expect(seen.holders).toEqual(['prompt-run']);
    expect(seen.revocationListeners).toBe(1);
    expect(seen.attached).toEqual([db]);
    // `CodingConfig.sessions` is the service's configuration: no supervisor,
    // so not configured, and no tools for a turn.
    expect(service.configured).toBe(false);
    expect(service.currentConfig).toBe(sessionsConfig);
    expect(Context.get(context, Tools).dotTools(turn)).toEqual([]);
});

it("offers the service the gateways' step built, never a second one, with CodingConfig from the configuration", async () => {
    const db = database();
    const fakes = recorded();
    const { seen, actors } = fakes;
    const config = {
        sessionSecret: 'secret',
        appOrigin: 'https://brain.example',
        notificationLimits: { dot: 5 },
    } as unknown as PlatformConfig;
    // The gateways' step built it first (`codingSessionsLayer`): the bridges
    // read it from the chain.
    const gateways = CodingServiceLive.pipe(Layer.provide(serviceTags(db, fakes)));
    const layer = codingLayers.bridges.pipe(
        Layer.provideMerge(gateways),
        Layer.provide(Layer.mergeAll(Layer.succeed(LegacyConfig, config), Layer.succeed(Actors, actors))),
    );
    const context = await Effect.runPromise(Layer.build(layer).pipe(Effect.scoped));
    const built = Context.get(context, CodingService);
    expect(Context.get(context, Sessions)).toBe(built);
    expect(Context.get(context, GatewayExchanges)).toBe(built.exchanges);
    // Nothing registered twice.
    expect(seen.capabilities).toHaveLength(7);
    expect(seen.revocationListeners).toBe(1);
    const coding = Context.get(context, CodingConfig);
    expect(coding).toMatchObject({
        sessionSecret: 'secret',
        appOrigin: 'https://brain.example',
        notificationLimits: { dot: 5 },
    });
    // `sessions` is the service's own, as `configure()` changes it.
    expect(coding.sessions).toBe(built.currentConfig);
    built.configure({ egressSecret: 'egress' });
    expect(coding.sessions.egressSecret).toBe('egress');
});
