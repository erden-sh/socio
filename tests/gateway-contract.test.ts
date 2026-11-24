// The gateway contract: the tags other features will reach `gateway/` through,
// `gatewayService` serving `Gateway` with the gateways coding sessions and
// the apps' extraction route call today; coding's port (`CodingGateway`) with its
// error is in coding's contract.
import { Context, Effect, Layer } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import { GitProxyError } from '../src/server/coding/contract.js';
import { gatewaySourcesOf } from '../src/server/gateway/adopted.js';
import * as contract from '../src/server/gateway/contract.js';
import { Gateway, GatewayConfig } from '../src/server/gateway/contract.js';
import { gitGateway } from '../src/server/gateway/git.js';
import { modelGateway } from '../src/server/gateway/model.js';
import { gatewayService } from '../src/server/gateway/service.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function runtime() {
    const built = await makeTestRuntime({
        config: {
            apiKey: '',
            model: '',
            sessionSecret: 'gateway-contract-secret-0123456789ab',
        },
        codeRunners: ['alice'],
    });
    cleanup.push(built.dispose);
    return built;
}

async function platform() {
    return (await runtime()).platform;
}

it('declares its tags under socio/gateway', () => {
    expect(Gateway.key).toBe('socio/gateway/Gateway');
    expect(GatewayConfig.key).toBe('socio/gateway/GatewayConfig');
});

it('keeps GitProxyError a plain Error class', () => {
    const error = new GitProxyError(403, 'grant_missing', 'No.');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('Error');
    expect({ status: error.status, reason: error.reason, message: error.message }).toEqual({
        status: 403,
        reason: 'grant_missing',
        message: 'No.',
    });
    expect(Object.keys(contract).sort()).toEqual(['Gateway', 'GatewayConfig']);
});

it('serves Gateway with the platform’s own gateways', async () => {
    const built = await platform();
    const service = gatewayService(gatewaySourcesOf(built));
    const program = Effect.gen(function* () {
        const gateway = yield* Gateway;
        return {
            alice: yield* Effect.promise(() => gateway.mayRunCode('alice')),
            bob: yield* Effect.promise(() => gateway.mayRunCode('bob')),
            gitMayUseCode: yield* Effect.promise(() => gateway.git.mayUseCode('alice')),
            sameModel: gateway.model === modelGateway(built),
            sameGit: gateway.git === gitGateway(built),
            limits: gateway.model.settings.limits(),
            personalPlans: gateway.model.options.personalPlans(),
            tokens: gateway.model.ledger.session('no-such-session', gateway.model.settings.limits()).used,
            repository: gateway.git.repos.get('acme/app'),
            refused: yield* Effect.promise(() =>
                gateway
                    .openSessionPullRequest({
                        grantId: 'no-such-grant',
                        personId: 'alice',
                        socioId: 'rulo',
                        title: 'A title',
                        summary: 'A summary',
                    })
                    .then(
                        () => undefined,
                        (error: unknown) => error,
                    ),
            ),
            delivery: yield* Effect.promise(() =>
                gateway.deliverExtraction({
                    id: '00000000-0000-0000-0000-000000000000',
                    appId: 'some-app',
                    obo: undefined,
                }),
            ),
        };
    });
    const result = await Effect.runPromise(program.pipe(Effect.provide(Layer.succeed(Gateway, service))));
    expect(result).toMatchObject({
        alice: true,
        bob: false,
        gitMayUseCode: true,
        sameModel: true,
        sameGit: true,
        limits: modelGateway(built).settings.limits(),
        personalPlans: modelGateway(built).options.personalPlans(),
        tokens: 0,
        repository: undefined,
        delivery: { status: 404, error: 'No such extraction.' },
    });
    expect(result.refused).toBeInstanceOf(GitProxyError);
    expect(result.refused).toMatchObject({ status: 403, reason: 'grant_missing' });
});

it('delivers the apps’ extractions through the Gateway service', async () => {
    const built = await runtime();
    const gateway = Context.getUnsafe(built.edge.services as Context.Context<never>, Gateway);
    const delivery = vi.spyOn(gateway, 'deliverExtraction');
    const input = { id: '00000000-0000-0000-0000-000000000000', appId: 'some-app', obo: undefined };
    expect(await built.platform.gatewayAdopted.extractions(input)).toEqual({
        status: 404,
        error: 'No such extraction.',
    });
    expect(delivery).toHaveBeenCalledExactlyOnceWith(input);
});
