import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { startDiskUsageProxy } from '../deployment/computers/disk-usage-proxy.mjs';
import {
    ComputerDiskUsage,
    DISK_USAGE_EVERY_MS,
    DISK_USAGE_FRESH_MS,
} from '../src/server/computers/computer-disk-usage.js';
import { ComputerService } from '../src/server/computers/computer-service.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

// CB-197: computers' disk usage through the read-only Docker proxy.
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) {
        await close();
    }
});
const TOKEN = 'fixture-supervisor-secret-24+';
const labels = (bot: string, namespace = 'company-brain') => ({
    'openbot.supervisor': 'true',
    'openbot.namespace': namespace,
    'openbot.bot-id': bot,
});
const volumes = (bot: string, sizes = [1000, 200, 30]) =>
    ['workspace', 'profile', 'private'].map((kind, index) => ({
        Name: `company-brain-${kind}-${bot}`,
        Labels: labels(bot),
        UsageData: { Size: sizes[index], RefCount: 1 },
    }));
const container = (bot: string, SizeRw = 4096) => ({
    Id: 'id-' + bot,
    Names: [`/company-brain-computer-${bot}`],
    Labels: labels(bot),
    State: 'running',
    SizeRw,
    Mounts: [],
});
function reader(answers: { df: unknown; containers: unknown }) {
    const paths: string[] = [];
    const read = vi.fn(async (path: string) => {
        paths.push(path);
        return path.includes('/system/df') ? answers.df : answers.containers;
    });
    return { read, paths };
}

it('measures in the background, sums the three volumes, and reads the last result without waiting', async () => {
    let now = 1_000_000;
    const { read, paths } = reader({
        df: {
            Volumes: [
                ...volumes('dot-a'),
                // A partial set is no total; an unknown size is unavailable.
                ...volumes('dot-b').slice(0, 2),
                ...volumes('dot-c', [1, -1, 1]),
                // Foreign labels or names are ignored even if the proxy sent them.
                ...volumes('dot-d').map((volume) => ({
                    ...volume,
                    Labels: labels('dot-d', 'other'),
                })),
                { ...volumes('dot-e')[0], Name: 'company-brain-workspace-dot-x' },
            ],
        },
        containers: [container('dot-a'), container('dot-b', 0), { ...container('dot-f'), Names: ['/somebody-else'] }],
    });
    const disk = new ComputerDiskUsage(read, 'company-brain', () => now);
    expect(disk.status()).toEqual({
        state: 'pending',
        measuredAt: null,
        everyMinutes: 15,
    });
    disk.refresh();
    // Still measuring: readings are empty rather than waited for.
    expect(disk.reading('dot-a')).toEqual({
        volumeBytes: null,
        containerBytes: null,
    });
    await disk.pending;
    expect(paths).toEqual(['/v1.44/system/df?type=volume', '/v1.44/containers/json?all=true&size=true']);
    expect(disk.reading('dot-a')).toEqual({
        volumeBytes: 1230,
        containerBytes: 4096,
    });
    expect(disk.reading('dot-b')).toEqual({
        volumeBytes: null,
        containerBytes: 0,
    });
    expect(disk.reading('dot-c').volumeBytes).toBeNull();
    for (const id of ['dot-d', 'dot-e', 'dot-f', 'dot-x']) {
        expect(disk.reading(id)).toEqual({
            volumeBytes: null,
            containerBytes: null,
        });
    }
    expect(disk.status()).toMatchObject({ state: 'ok', measuredAt: now });
    // At most one measurement per interval.
    now += DISK_USAGE_EVERY_MS - 1;
    disk.refresh();
    expect(disk.pending).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(2);
    now += 1;
    disk.refresh();
    await disk.pending;
    expect(read).toHaveBeenCalledTimes(4);
});

it('keeps a recent result through one failure, then says unavailable once it is stale', async () => {
    let now = 0;
    let fail = false;
    const read = vi.fn(async (path: string) => {
        if (fail) {
            throw Error('Docker disk usage unavailable');
        }
        return path.includes('/system/df') ? { Volumes: volumes('dot-a') } : [container('dot-a')];
    });
    const disk = new ComputerDiskUsage(read, 'company-brain', () => now);
    disk.refresh();
    await disk.pending;
    fail = true;
    now += DISK_USAGE_EVERY_MS;
    disk.refresh();
    await disk.pending;
    expect(disk.status().state).toBe('ok');
    expect(disk.reading('dot-a').volumeBytes).toBe(1230);
    now = DISK_USAGE_FRESH_MS;
    disk.refresh();
    await disk.pending;
    expect(disk.status()).toEqual({
        state: 'unavailable',
        measuredAt: 0,
        everyMinutes: 15,
    });
    expect(disk.reading('dot-a').volumeBytes).toBeNull();
    // Malformed answers fail the same way.
    const odd = new ComputerDiskUsage(
        async () => ({ Volumes: 'nope' }),
        'company-brain',
        () => 0,
    );
    odd.refresh();
    await odd.pending;
    expect(odd.status().state).toBe('unavailable');
    // No proxy: off, and nothing is ever requested.
    const off = new ComputerDiskUsage(null, 'company-brain');
    off.refresh();
    expect(off.pending).toBeUndefined();
    expect(off.status().state).toBe('off');
});

it('does not start a measurement after the sampler stopped', () => {
    const read = vi.fn(async () => ({}));
    const disk = new ComputerDiskUsage(read, 'company-brain');
    disk.refresh(AbortSignal.abort());
    expect(read).not.toHaveBeenCalled();
});

/** A fake Docker Engine on a unix socket, behind the real proxy. */
async function engineAndProxy(answer: { df: unknown; containers: unknown }) {
    const dir = mkdtempSync(join(tmpdir(), 'cb197-disk-'));
    const socketPath = join(dir, 'docker.sock');
    const engineRequests: string[] = [];
    const engine = createServer((req, res) => {
        engineRequests.push(`${req.method} ${req.url}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(req.url!.startsWith('/v1.44/system/df') ? answer.df : answer.containers));
    });
    await new Promise<void>((resolve) => engine.listen(socketPath, resolve));
    const proxy: Server = await startDiskUsageProxy({
        socketPath,
        host: '127.0.0.1',
        port: 0,
        namespace: 'company-brain',
        token: TOKEN,
    });
    cleanup.push(async () => {
        for (const server of [proxy, engine]) {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
        rmSync(dir, { recursive: true, force: true });
    });
    const address = proxy.address();
    if (!address || typeof address === 'string') {
        throw Error('No address');
    }
    return { url: `http://127.0.0.1:${address.port}`, engineRequests };
}

function service(
    diskUrl: string | undefined,
    volumeBytes: number | null,
    workspace = new WorkspaceStore(testDatabase()),
) {
    cleanup.push(() => workspace.close());
    const id = workspace.dots()[0].id;
    const supervisor: string[] = [];
    const proxied: Array<{ url: string; authorization: string | null }> = [];
    const computers = new ComputerService(
        workspace,
        {
            computerSupervisorUrl: 'http://supervisor.test',
            computerSupervisorToken: TOKEN,
            computerToken: 'fixture-child-master',
            computerDiskUsageUrl: diskUrl,
        },
        () => false,
        async (url, init) => {
            if (diskUrl && String(url).startsWith(diskUrl)) {
                proxied.push({
                    url: String(url),
                    authorization: new Headers(init?.headers).get('authorization'),
                });
                return fetch(url, init);
            }
            supervisor.push(String(url));
            if (String(url).endsWith('/stats')) {
                return Response.json({
                    botId: id,
                    container: 'company-brain-computer-' + id,
                    instance: 'instance-one',
                    running: true,
                    values: {
                        cpuPercent: 10,
                        memoryBytes: 100,
                        memoryLimitBytes: 1000,
                        volumeBytes,
                    },
                });
            }
            if (String(url).endsWith('/computers')) {
                return Response.json({
                    computers: [
                        {
                            botId: id,
                            container: 'company-brain-computer-' + id,
                            status: 'running',
                            url: `http://company-brain-computer-${id}:4100`,
                        },
                    ],
                });
            }
            throw Error('Unexpected endpoint ' + String(url));
        },
        1000,
    );
    return { computers, id, supervisor, proxied };
}

it('adds proxy-measured disk to running computers’ readings, end to end over a fake Docker API', async () => {
    const workspace = new WorkspaceStore(testDatabase());
    const id = workspace.dots()[0].id;
    const { url, engineRequests } = await engineAndProxy({
        df: { Volumes: [...volumes(id), ...volumes('someone-else')] },
        containers: [container(id, 2048)],
    });
    const { computers, proxied } = service(url, null, workspace);
    const first = await computers.resourceReadings();
    // The first sample does not wait for Docker's df.
    expect(first[0].stats.values).toMatchObject({
        cpuPercent: 10,
        volumeBytes: null,
        containerBytes: null,
    });
    await computers.disk.pending;
    expect(proxied.map((request) => request.url)).toEqual([
        url + '/v1.44/system/df?type=volume',
        url + '/v1.44/containers/json?all=true&size=true',
    ]);
    expect(proxied.every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(engineRequests[0]).toBe('GET /v1.44/system/df?type=volume');
    expect(engineRequests[1]).toMatch(/^GET \/v1\.44\/containers\/json\?all=true&size=true&filters=/);
    const second = await computers.resourceReadings();
    expect(second[0].dotId).toBe(id);
    expect(second[0].stats.values).toMatchObject({
        volumeBytes: 1230,
        containerBytes: 2048,
    });
    // Within the interval no further Docker read happens.
    expect(proxied).toHaveLength(2);
    expect(computers.diskStatus().state).toBe('ok');
});

it('says not set up without a proxy, and keeps an older supervisor’s own volume reading', async () => {
    const { computers, proxied } = service(undefined, 777);
    const [reading] = await computers.resourceReadings();
    expect(reading.stats.values).toMatchObject({
        volumeBytes: 777,
        containerBytes: null,
    });
    expect(proxied).toEqual([]);
    expect(computers.diskStatus()).toEqual({
        state: 'off',
        measuredAt: null,
        everyMinutes: 15,
    });
});

it('says unavailable when the proxy cannot be reached, without failing the CPU and memory sample', async () => {
    const { computers } = service('http://127.0.0.1:9', null);
    const [reading] = await computers.resourceReadings();
    expect(reading.stats.values.cpuPercent).toBe(10);
    await computers.disk.pending;
    expect(computers.diskStatus().state).toBe('unavailable');
    expect((await computers.resourceReadings())[0].stats.values.volumeBytes).toBeNull();
});
