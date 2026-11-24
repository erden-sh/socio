// The coding sessions service is built from the tags at the gateways' step,
// with nothing keyed by a platform. Building one registers its approvals,
// its credential holder and its revocation listener, so a second one in a
// runtime would register them twice. Each runtime builds exactly one, and
// every reader in that runtime (the coding tags, the gateways' module
// through `HostedGateway`, the bridges' `CodingConfig`) shares it; two
// runtimes in one process never share one.
import { Context } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import { CODING_SESSION_CAPABILITIES } from '@socio/shared/coding/coding-sessions';

import { CodingConfig, GatewayExchanges, Sessions } from '../src/server/coding/contract.js';
import { CodingService } from '../src/server/coding/layer.js';
import { HostedGateway } from '../src/server/gateway/adopted.js';

import { makeTestRuntime, type TestRuntime } from './helpers/test-runtime.js';

/** Every coding sessions service constructed, in order. */
const built = vi.hoisted(() => ({ services: [] as object[] }));

vi.mock('../src/server/coding/sessions.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/server/coding/sessions.js')>();
    const Base = actual.CodingSessions as unknown as new (...args: unknown[]) => object;
    const Counted = class extends Base {
        constructor(...args: unknown[]) {
            super(...args);
            built.services.push(this);
        }
    };
    Object.defineProperty(Counted, 'name', { value: actual.CodingSessions.name });
    return { ...actual, CodingSessions: Counted as unknown as typeof actual.CodingSessions };
});

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    built.services.length = 0;
});

async function runtime(): Promise<TestRuntime> {
    const made = await makeTestRuntime();
    cleanup.push(made.dispose);
    return made;
}

it('builds the coding sessions service exactly once per runtime, shared by every reader in it', async () => {
    const first = await runtime();
    expect(built.services).toHaveLength(1);
    const second = await runtime();
    expect(built.services).toHaveLength(2);
    expect(built.services[0]).not.toBe(built.services[1]);

    for (const [index, { edge, platform }] of [first, second].entries()) {
        const services = edge.services;
        const service = Context.get(services, CodingService);
        expect(service).toBe(built.services[index]);
        // The coding tags are over that one service.
        expect(Context.get(services, Sessions)).toBe(service);
        expect(Context.get(services, GatewayExchanges)).toBe(service.exchanges);
        expect(Context.get(services, CodingConfig).sessions).toBe(service.currentConfig);
        // The gateways' module drives the same one: configuring it shows
        // through `HostedGateway`'s view, and only in this runtime.
        const hosted = Context.get(services, HostedGateway).coding;
        expect(hosted.sessions.configured).toBe(false);
        service.configure({
            supervisorUrl: 'http://127.0.0.1:9',
            supervisorToken: 'supervisor-token',
            egressSecret: 'egress-secret',
        });
        expect(hosted.sessions.configured).toBe(true);
        // Its approvals are registered once, on this runtime's approvals.
        const capabilities = platform.approvals.capabilities().map((capability) => capability.id);
        for (const id of Object.values(CODING_SESSION_CAPABILITIES)) {
            expect(capabilities.filter((capability) => capability === id)).toEqual([id]);
        }
    }
    // Configuring the first runtime's service left the second's alone until
    // its own turn above: the two never share one.
    expect(built.services).toHaveLength(2);
});
