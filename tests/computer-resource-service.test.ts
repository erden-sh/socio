import { afterEach, expect, it } from 'vitest';

import { ComputerService } from '../src/server/computers/computer-service.js';
import { DataTokens } from '../src/server/dataspace/tokens.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));
function fixture(hooks: { stopped?: (id: string) => void } = {}) {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    const id = workspace.dots()[0].id;
    let running = true;
    const state = () => ({
        botId: id,
        container: 'company-brain-computer-' + id,
        status: running ? 'running' : 'exited',
        url: `http://company-brain-computer-${id}:4100`,
    });
    const stats = () => ({
        botId: id,
        container: state().container,
        instance: 'instance-one',
        running: true,
        values: {
            cpuPercent: 10,
            memoryBytes: 100,
            memoryLimitBytes: 1000,
            volumeBytes: 300,
        },
    });
    const requests: string[] = [];
    let read = async () => Response.json(stats());
    let list = async () => Response.json({ computers: [state()] });
    const service = new ComputerService(
        workspace,
        {
            computerSupervisorUrl: 'http://supervisor.test',
            computerSupervisorToken: 'fixture-supervisor-secret',
            computerToken: 'fixture-child-master',
        },
        () => false,
        async (url, init) => {
            requests.push(`${init?.method} ${url}`);
            if (String(url).endsWith('/stats')) {
                return read();
            }
            if (String(url).endsWith('/ensure')) {
                return Response.json(state());
            }
            if (String(url).endsWith('/stop')) {
                running = false;
                return Response.json({ stopped: true });
            }
            if (String(url).endsWith('/computers')) {
                return list();
            }
            throw Error('Unexpected telemetry endpoint');
        },
        1000,
        hooks,
    );
    return {
        workspace,
        id,
        service,
        requests,
        stats,
        setList: (next: typeof list) => {
            list = next;
        },
        setRead: (next: typeof read) => {
            read = next;
        },
        setRunning: (next: boolean) => {
            running = next;
        },
    };
}
it('samples only running computers with read-only requests and bounded values', async () => {
    const { service, requests, id, setRunning } = fixture();
    const readings = await service.resourceReadings();
    expect(readings).toHaveLength(1);
    expect(readings[0].dotId).toBe(id);
    expect(readings[0].current()).toBe(true);
    expect(requests.every((request) => request.startsWith('GET '))).toBe(true);
    expect(requests.some((request) => request.includes('ensure'))).toBe(false);
    setRunning(false);
    requests.length = 0;
    expect(await service.resourceReadings()).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(service.resourceState(id)).toBe(false);
});
it('discards stats returned after an acknowledged stop and invalidates held writer callbacks', async () => {
    const { service, workspace, id, setRead, stats } = fixture();
    await workspace.computers.patch(id, { enabled: true });
    const first = (await service.resourceReadings())[0];
    let release: () => void = () => {};
    let pending = false;
    setRead(
        () =>
            new Promise<Response>((resolve) => {
                pending = true;
                release = () => resolve(Response.json(stats()));
            }),
    );
    const inFlight = service.resourceReadings();
    while (!pending) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await service.stop(id);
    release();
    expect(await inFlight).toEqual([]);
    expect(first.current()).toBe(false);
    expect(service.resourceState(id)).toBe(false);
});
it('treats unsupported or foreign stats as missing and never adopts another identity', async () => {
    const { service, setRead, stats } = fixture();
    setRead(async () => new Response('Old supervisor', { status: 404 }));
    expect(await service.resourceReadings()).toEqual([]);
    setRead(async () => Response.json({ ...stats(), botId: 'foreign' }));
    expect(await service.resourceReadings()).toEqual([]);
    setRead(async () =>
        Response.json({
            ...stats(),
            values: { ...stats().values, memoryBytes: -1 },
        }),
    );
    expect(await service.resourceReadings()).toEqual([]);
});

it('clears stale running status on listing failure while preserving a concurrent stop', async () => {
    const { service, workspace, id, setList } = fixture();
    await workspace.computers.patch(id, { enabled: true });
    await service.resourceReadings();
    expect(service.resourceState(id)).toBe(true);
    setList(async () => {
        throw Error('supervisor unavailable');
    });
    expect(await service.resourceReadings()).toEqual([]);
    expect(service.resourceState(id)).toBeNull();
    setList(async () => {
        setList(async () => Response.json({ computers: [] }));
        await service.stop(id);
        throw Error('supervisor unavailable');
    });
    expect(await service.resourceReadings()).toEqual([]);
    expect(service.resourceState(id)).toBe(false);
});

it('ignores a stopped stats response from before a fresh start without revoking its tokens', async () => {
    const tokens = new DataTokens();
    let calls = 0;
    const { service, workspace, id, setRead, stats } = fixture({
        stopped: (dotId) => {
            calls++;
            tokens.revokeDot(dotId);
        },
    });
    await workspace.computers.patch(id, { enabled: true });
    let answer: (response: Response) => void = () => {};
    let pending = false;
    setRead(
        () =>
            new Promise((resolve) => {
                pending = true;
                answer = resolve;
            }),
    );
    const reading = service.resourceReadings();
    while (!pending) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await service.start(id);
    const fresh = tokens.issue({
        userId: 'fixture-person',
        dotId: id,
        purpose: 'job',
        session: 'after-start',
    });
    const before = calls;
    answer(Response.json({ ...stats(), running: false }));
    expect(await reading).toEqual([]);
    expect(calls).toBe(before);
    expect(tokens.resolve(fresh)).toBeDefined();
    expect(service.resourceState(id)).toBe(true);
});
