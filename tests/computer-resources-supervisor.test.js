import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';

import { hardenSupervisorDocker, hardenSupervisorRoutes } from '../deployment/computers/harden-supervisor.mjs';
import { readComputerStats, resourceValues } from '../deployment/computers/resource-stats.mjs';

const names = {
    botId: 'dot-a',
    container: 'company-computer-dot-a',
    workspaceVolume: 'company-workspace-dot-a',
    profileVolume: 'company-profile-dot-a',
    privateVolume: 'company-private-dot-a',
};
const labels = { owner: 'true', namespace: 'company', bot: 'dot-a' };
const ours = (labels) => labels?.owner === 'true' && labels?.namespace === 'company';
function fixture(change = {}) {
    const info = {
        Id: 'container-a',
        Name: '/' + names.container,
        Config: { Labels: labels },
        State: { Running: true, StartedAt: '2026-10-25T00:00:00Z' },
        HostConfig: { Memory: 1000 },
        Mounts: [names.workspaceVolume, names.profileVolume, names.privateVolume].map((Name) => ({
            Type: 'volume',
            Name,
        })),
        ...change,
    };
    const inspect = vi.fn(async () => globalThis.structuredClone(info));
    const stats = vi.fn(async () => ({
        cpu_stats: {
            cpu_usage: { total_usage: 200 },
            system_cpu_usage: 1000,
            online_cpus: 2,
        },
        precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 500 },
        memory_stats: { usage: 600, stats: { inactive_file: 100 } },
    }));
    const df = vi.fn(async () => ({
        Volumes: [names.workspaceVolume, names.profileVolume, names.privateVolume].map((Name) => ({
            Name,
            Labels: labels,
            UsageData: { Size: 10 },
        })),
    }));
    const docker = { getContainer: vi.fn(() => ({ inspect, stats })), df };
    return { docker, inspect, stats, df, info };
}

it('reads only the derived owned running container and never sizes its volumes', async () => {
    const { docker, stats, df } = fixture();
    const first = await readComputerStats(docker, names, ours, 'bot');
    expect(first).toMatchObject({
        botId: 'dot-a',
        container: names.container,
        running: true,
        values: {
            cpuPercent: 40,
            memoryBytes: 500,
            memoryLimitBytes: 1000,
            // The disk usage proxy measures volumes (CB-197); df takes minutes.
            volumeBytes: null,
        },
    });
    expect(docker.getContainer).toHaveBeenCalledWith(names.container);
    expect(stats).toHaveBeenCalledWith(
        expect.objectContaining({
            stream: false,
            'one-shot': true,
            abortSignal: expect.any(globalThis.AbortSignal),
        }),
    );
    await readComputerStats(docker, names, ours, 'bot');
    expect(df).not.toHaveBeenCalled();
    expect(JSON.stringify(first)).not.toMatch(/Mountpoint|\/private|Labels|Env/);
});

it.each([
    { Config: { Labels: { ...labels, owner: 'false' } } },
    { Config: { Labels: { ...labels, namespace: 'other' } } },
    { Config: { Labels: { ...labels, bot: 'other' } } },
    { Name: '/somebody-else' },
])('refuses foreign identity before requesting Docker stats or disk: %j', async (change) => {
    const { docker, stats, df } = fixture(change);
    expect(await readComputerStats(docker, names, ours, 'bot')).toBeNull();
    expect(stats).not.toHaveBeenCalled();
    expect(df).not.toHaveBeenCalled();
});

it('does not sample a stopped computer or create/ensure anything', async () => {
    const { docker, stats, df } = fixture({
        State: { Running: false, StartedAt: 'old' },
    });
    expect(await readComputerStats(docker, names, ours, 'bot')).toMatchObject({
        running: false,
        values: { cpuPercent: null, memoryBytes: null, volumeBytes: null },
    });
    expect(stats).not.toHaveBeenCalled();
    expect(df).not.toHaveBeenCalled();
});

it('discards a reading that races a stop or a new container instance', async () => {
    for (const state of [
        { State: { Running: false } },
        { Id: 'replacement' },
        { State: { Running: true, StartedAt: 'new' } },
    ]) {
        const { docker, inspect, info } = fixture();
        inspect.mockResolvedValueOnce(info).mockResolvedValueOnce({ ...info, ...state });
        expect(await readComputerStats(docker, names, ours, 'bot')).toBeNull();
    }
});

it('keeps valid zero memory and unlimited limit, and refuses invented CPU deltas', () => {
    expect(resourceValues({ memory_stats: { usage: 0 } }, 0)).toEqual({
        cpuPercent: null,
        memoryBytes: 0,
        memoryLimitBytes: 0,
        volumeBytes: null,
    });
    expect(
        resourceValues(
            {
                cpu_stats: {
                    cpu_usage: { total_usage: 100 },
                    system_cpu_usage: 10,
                    online_cpus: 2,
                },
                precpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 20 },
            },
            null,
        ).cpuPercent,
    ).toBeNull();
    expect(
        resourceValues(
            {
                cpu_stats: {
                    cpu_usage: { total_usage: 200, percpu_usage: [1, 2] },
                    system_cpu_usage: 1000,
                },
                precpu_stats: {
                    cpu_usage: { total_usage: 100 },
                    system_cpu_usage: 500,
                },
                memory_stats: { usage: 600, stats: { total_inactive_file: 80 } },
            },
            1024,
        ),
    ).toMatchObject({ cpuPercent: 40, memoryBytes: 520, memoryLimitBytes: 1024 });
});

it('matches cgroupv1 total-inactive and cgroupv2 inactive working sets without false zeroes', () => {
    expect(
        resourceValues(
            {
                memory_stats: {
                    usage: 1000,
                    stats: { inactive_file: 100, total_inactive_file: 400 },
                },
            },
            2000,
        ).memoryBytes,
    ).toBe(600);
    expect(resourceValues({ memory_stats: { usage: 1000, stats: { inactive_file: 100 } } }, 2000).memoryBytes).toBe(
        900,
    );
    expect(resourceValues({ memory_stats: { usage: 1000, stats: { cache: 250 } } }, 2000).memoryBytes).toBe(750);
    expect(resourceValues({ memory_stats: { usage: 100, stats: { inactive_file: 400 } } }, 2000).memoryBytes).toBe(100);
    expect(
        resourceValues({ memory_stats: { usage: 100, stats: { total_inactive_file: 100 } } }, 2000).memoryBytes,
    ).toBe(100);
    expect(resourceValues({ memory_stats: { usage: 0, stats: { inactive_file: 400 } } }, 2000).memoryBytes).toBe(0);
});

it('cancels a Docker request at its deadline rather than leaving the socket request running', async () => {
    vi.useFakeTimers();
    try {
        const { docker, stats } = fixture();
        let signal;
        stats.mockImplementation((options) => {
            signal = options.abortSignal;
            return new Promise((_, reject) =>
                options.abortSignal.addEventListener('abort', () => reject(Error('aborted')), { once: true }),
            );
        });
        const expected = expect(readComputerStats(docker, names, ours, 'bot')).rejects.toThrow(/abort|timed out/i);
        await vi.advanceTimersByTimeAsync(4001);
        await expected;
        expect(signal.aborted).toBe(true);
    } finally {
        vi.useRealTimers();
    }
});

it('adds stats under the existing token guard and validated Bot vocabulary', async () => {
    const upstream = `import {\n  listOwned,\n} from "./docker";\nconst app = new Hono();\napp.use('*',async(c,next)=>c.req.header('authorization')==='Bearer fixture'?next():c.json({error:'Unauthorized'},401));\napp.get("/computers", async (context) => {return context.json({computers:await listOwned()})});`;
    const patched = hardenSupervisorRoutes(upstream).replace(/import \{[\s\S]*?\} from "\.\/docker";/, '');
    const stats = vi.fn(async (n) => ({ botId: n.botId, running: true }));
    const resolve = (raw) =>
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(raw)
            ? { ok: true, names: { ...names, botId: raw } }
            : { ok: false, reason: 'Invalid id' };
    const app = new Function('Hono', 'listOwned', 'computerStats', 'resolve', patched + '\nreturn app;')(
        Hono,
        async () => [],
        stats,
        resolve,
    );
    expect((await app.request('/computers/dot-a/stats')).status).toBe(401);
    expect(stats).not.toHaveBeenCalled();
    expect(
        (
            await app.request('/computers/dot.a/stats', {
                headers: { authorization: 'Bearer fixture' },
            })
        ).status,
    ).toBe(400);
    expect(stats).not.toHaveBeenCalled();
    expect(
        (
            await app.request('/computers/dot-a/stats', {
                headers: { authorization: 'Bearer fixture' },
            })
        ).status,
    ).toBe(200);
    expect(stats).toHaveBeenCalledWith(names);
    stats.mockResolvedValue(null);
    expect(
        (
            await app.request('/computers/dot-b/stats', {
                headers: { authorization: 'Bearer fixture' },
            })
        ).status,
    ).toBe(404);
    expect(() => hardenSupervisorRoutes(upstream + upstream)).toThrow(/contract changed/);
});

it('leaves volume sizing to the disk usage proxy: the patched supervisor never calls df (CB-197)', () => {
    const docker = hardenSupervisorDocker(
        readFileSync(new URL('./fixtures/openbot-b6932d3/docker.ts.txt', import.meta.url), 'utf8'),
    );
    expect(docker).toContain('readComputerStats(resourceDocker');
    expect(docker).not.toMatch(/system\/df|\.df\(/);
});
