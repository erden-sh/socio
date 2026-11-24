import { createServer, type Server } from 'node:http';

import { describe, expect, it } from 'vitest';

import { swarmServiceBody, type SwarmServiceBody } from '@socio/shared/plugins/plugin-service';

import { dockerServicesFromEnv } from '../src/apps-runtime/config.js';
import { MemoryDocker } from '../src/apps-runtime/docker.js';
import { pluginProof } from '../src/apps-runtime/keys.js';
import { PluginServices } from '../src/apps-runtime/services.js';
import {
    parsePluginConstraints,
    pluginServiceErrors,
    startSocketProxy,
    type PluginNetworkInfo,
    type ProxyPolicy,
} from '../src/apps-runtime/socket-proxy.js';
import { socialStrategyManifest } from '../src/server/plugins/planner/manifest.js';

const IMAGE = `company-brain-plugin-social-strategy@sha256:${'ab'.repeat(32)}`;
const PINS = new Map([['social-strategy', IMAGE]]);
const PINNED = ['node.hostname == node-1', 'node.platform.arch == x86_64'];

function network(target: string): PluginNetworkInfo | undefined {
    return target === 'net-social'
        ? { name: 'socio-plugin-net-social-strategy', driver: 'overlay', internal: true }
        : undefined;
}

function policy(constraints: readonly string[]): ProxyPolicy {
    return { pins: PINS, constraints, infra: new Set(), network, secretNames: new Set() };
}

function body(constraints?: readonly string[]): SwarmServiceBody {
    return swarmServiceBody({
        id: 'social-strategy',
        image: IMAGE,
        spec: socialStrategyManifest.service!,
        replicas: 1,
        networkId: 'net-social',
        proof: pluginProof('runtime-secret-runtime-secret-32', 'social-strategy'),
        ...(constraints ? { constraints } : {}),
    });
}

function withPlacement(placement: unknown) {
    const spec = body() as unknown as { TaskTemplate: Record<string, unknown> };
    spec.TaskTemplate.Placement = placement;
    return spec;
}

const base = { APPS_RUNTIME_DOCKER: 'on', APPS_RUNTIME_IMAGE_ALLOW: 'company-brain-plugin-' };

describe('plugin placement constraints', () => {
    it('parses APPS_RUNTIME_PLUGIN_CONSTRAINTS into canonical constraints', () => {
        expect(dockerServicesFromEnv(base)?.constraints).toEqual([]);
        expect(dockerServicesFromEnv({ ...base, APPS_RUNTIME_PLUGIN_CONSTRAINTS: '  ' })?.constraints).toEqual([]);
        expect(
            dockerServicesFromEnv({
                ...base,
                APPS_RUNTIME_PLUGIN_CONSTRAINTS: 'node.hostname==node-1, node.labels.socio.plugins != false,,',
            })?.constraints,
        ).toEqual(['node.hostname == node-1', 'node.labels.socio.plugins != false']);
        expect(parsePluginConstraints('node.role == manager, node.role == manager')).toEqual(['node.role == manager']);
        expect(parsePluginConstraints('engine.labels.zone == a/b:1')).toEqual(['engine.labels.zone == a/b:1']);
    });

    it('refuses a malformed constraint at startup and names the right variable', () => {
        for (const bad of [
            'node.hostname = node-1',
            'node.hostname node-1',
            'hostname == node-1',
            'node.labels. == x',
            'node.hostname == two words',
            'node.hostname == ',
            'node.hostname == $(id)',
            'node.platform.arch ~= arm64',
        ]) {
            expect(() => dockerServicesFromEnv({ ...base, APPS_RUNTIME_PLUGIN_CONSTRAINTS: bad })).toThrow(
                /^APPS_RUNTIME_PLUGIN_CONSTRAINTS entry .* is not <key> ==\|!= <value>/,
            );
            expect(() => parsePluginConstraints(bad)).toThrow(/^SOCKET_PROXY_PLUGIN_CONSTRAINTS entry/);
        }
    });

    it('puts the constraints on the service body only when set', () => {
        expect(body().TaskTemplate.Placement).toBeUndefined();
        expect(body([]).TaskTemplate.Placement).toBeUndefined();
        expect(body(PINNED).TaskTemplate.Placement).toEqual({ Constraints: PINNED });
    });

    it('applies the constraints on every plugin service the runtime creates and updates', async () => {
        const engine = new MemoryDocker();
        const plugins = new PluginServices(engine, {
            allow: ['company-brain-plugin-'],
            maxReplicas: 5,
            secret: 'runtime-secret-runtime-secret-32',
            pull: false,
            pins: PINS,
            requireDigest: true,
            constraints: PINNED,
        });
        const spec = { ...socialStrategyManifest.service!, image: 'company-brain-plugin-social-strategy' };
        await plugins.ensure('social-strategy', spec);
        const name = 'socio-plugin-social-strategy';
        expect(engine.specNamed(name)?.TaskTemplate.Placement).toEqual({ Constraints: PINNED });
        await plugins.ensure('social-strategy', { ...spec, replicas: 1 });
        expect(engine.specNamed(name)?.TaskTemplate.Placement).toEqual({ Constraints: PINNED });
        await plugins.scale('social-strategy', 0);
        expect(engine.specNamed(name)?.TaskTemplate.Placement).toEqual({ Constraints: PINNED });

        const unpinned = new MemoryDocker();
        await new PluginServices(unpinned, {
            allow: ['company-brain-plugin-'],
            maxReplicas: 5,
            secret: 'runtime-secret-runtime-secret-32',
            pull: false,
            pins: PINS,
        }).ensure('social-strategy', spec);
        expect(unpinned.specNamed(name)?.TaskTemplate.Placement).toBeUndefined();
    });

    it('lets the proxy accept exactly its own constraints', () => {
        expect(pluginServiceErrors(body(PINNED), policy(PINNED))).toEqual([]);
        expect(pluginServiceErrors(body([...PINNED].reverse()), policy(PINNED))).toEqual([]);
        expect(pluginServiceErrors(body(), policy([]))).toEqual([]);
        expect(pluginServiceErrors(body(), { ...policy([]), constraints: undefined })).toEqual([]);
    });

    it('lets the proxy refuse any other placement', () => {
        const refused = (spec: unknown, constraints: readonly string[]) =>
            pluginServiceErrors(spec, policy(constraints)).join(' ');
        // Unset on the proxy: no placement at all.
        expect(refused(body(PINNED), [])).toMatch(/Placement is not allowed/);
        expect(refused(withPlacement({}), [])).toMatch(/Placement is not allowed/);
        // Set on the proxy: required, and exactly that list.
        expect(refused(body(), PINNED)).toMatch(/SOCKET_PROXY_PLUGIN_CONSTRAINTS/);
        expect(refused(body([PINNED[0]!]), PINNED)).toMatch(/Placement must be exactly/);
        expect(refused(body([...PINNED, 'node.role == manager']), PINNED)).toMatch(/Placement must be exactly/);
        expect(refused(body(['node.hostname == pi1', PINNED[1]!]), PINNED)).toMatch(/Placement must be exactly/);
        expect(refused(body([PINNED[0]!, PINNED[0]!]), [PINNED[0]!, PINNED[0]!])).toMatch(/Placement must be/);
        expect(refused(withPlacement({ Constraints: PINNED, Preferences: [] }), PINNED)).toMatch(/exactly/);
        expect(refused(withPlacement({ Constraints: PINNED, MaxReplicas: 1 }), PINNED)).toMatch(/exactly/);
        expect(refused(withPlacement({ Constraints: PINNED, Platforms: [{ Architecture: 'arm64' }] }), PINNED)).toMatch(
            /exactly/,
        );
        expect(refused(withPlacement({ constraints: PINNED }), PINNED)).toMatch(/exactly/);
        expect(refused(withPlacement({ Constraints: 'node.hostname == node-1' }), PINNED)).toMatch(/exactly/);
        // A case-folded Placement key is a collision, not a second field.
        const folded = body(PINNED) as unknown as { TaskTemplate: Record<string, unknown> };
        folded.TaskTemplate.placement = { Constraints: ['node.hostname == pi1'] };
        expect(refused(folded, PINNED)).toMatch(/collides/);
    });

    it('forwards a pinned create through the proxy and refuses one placed elsewhere', async () => {
        const created: unknown[] = [];
        const engine = createServer(async (req, res) => {
            res.setHeader('content-type', 'application/json');
            if (req.url?.startsWith('/v1.44/networks/')) {
                res.end(
                    JSON.stringify({
                        Id: 'net-social',
                        Name: 'socio-plugin-net-social-strategy',
                        Driver: 'overlay',
                        Internal: true,
                    }),
                );
                return;
            }
            if (req.method === 'GET' && (req.url?.startsWith('/v1.44/services') || req.url === '/v1.44/tasks')) {
                res.end('[]');
                return;
            }
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
                chunks.push(Buffer.from(chunk as Uint8Array));
            }
            created.push(JSON.parse(Buffer.concat(chunks).toString()));
            res.end(JSON.stringify({ ID: 'svc1' }));
        });
        const enginePort = await listen(engine);
        const proxy = startSocketProxy({
            listenHost: '127.0.0.1',
            listenPort: 0,
            upstream: `http://127.0.0.1:${enginePort}`,
            pins: PINS,
            constraints: parsePluginConstraints('node.hostname==node-1,node.platform.arch==x86_64'),
            infra: new Set(),
            secretNames: new Set(),
            log: () => {},
        });
        const server = await proxy.listen();
        const address = server.address();
        const endpoint = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
        const create = (spec: unknown) =>
            fetch(`${endpoint}/v1.44/services/create`, { method: 'POST', body: JSON.stringify(spec) });
        try {
            expect((await create(body(PINNED))).status).toBe(200);
            expect(created).toHaveLength(1);
            expect((created[0] as SwarmServiceBody).TaskTemplate.Placement).toEqual({ Constraints: PINNED });
            expect((await create(body())).status).toBe(403);
            expect((await create(body(['node.hostname == pi1', PINNED[1]!]))).status).toBe(403);
            expect((await create(withPlacement({ Constraints: PINNED, Preferences: [] }))).status).toBe(403);
            expect(created).toHaveLength(1);
        } finally {
            server.close();
            engine.close();
        }
    });
});

function listen(server: Server) {
    return new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            resolve(typeof address === 'object' && address ? address.port : 0);
        });
    });
}
