import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';

import { destroyComputer } from '../deployment/computers/computer-destroy.mjs';
import { hardenSupervisorRoutes } from '../deployment/computers/harden-supervisor.mjs';

const names = {
    botId: 'dot-a',
    container: 'ns-computer-dot-a',
    profileVolume: 'ns-profile-dot-a',
    workspaceVolume: 'ns-workspace-dot-a',
    privateVolume: 'ns-private-dot-a',
};
const ours = (labels) => labels?.owner === 'true' && labels?.namespace === 'ns';
const mine = { owner: 'true', namespace: 'ns', bot: 'dot-a' };
const notFound = () => Object.assign(new Error('no such object'), { statusCode: 404 });

/** A Docker with the given containers and volumes (name -> labels); records removals. */
function fakeDocker(containers, volumes) {
    const removed = [];
    return {
        removed,
        getContainer: (name) => ({
            inspect: async () => {
                if (!(name in containers)) {
                    throw notFound();
                }
                return { Config: { Labels: containers[name] } };
            },
            remove: vi.fn(async (options) => {
                if (!(name in containers)) {
                    throw notFound();
                }
                expect(options).toEqual({ force: true, v: false });
                delete containers[name];
                removed.push(name);
            }),
        }),
        getVolume: (name) => ({
            inspect: async () => {
                if (!(name in volumes)) {
                    throw notFound();
                }
                return { Labels: volumes[name] };
            },
            remove: async () => {
                if (!(name in volumes)) {
                    throw notFound();
                }
                delete volumes[name];
                removed.push(name);
            },
        }),
    };
}

it('removes the computer’s container and all three volumes, container first', async () => {
    const docker = fakeDocker(
        { [names.container]: mine },
        { [names.profileVolume]: mine, [names.workspaceVolume]: mine, [names.privateVolume]: mine },
    );
    expect(await destroyComputer(docker, names, ours, 'bot')).toEqual({
        botId: 'dot-a',
        container: true,
        volumes: [names.profileVolume, names.workspaceVolume, names.privateVolume],
    });
    expect(docker.removed).toEqual([names.container, names.profileVolume, names.workspaceVolume, names.privateVolume]);
});

it('finishes what an earlier run left: volumes without a container, and nothing at all', async () => {
    const docker = fakeDocker({}, { [names.workspaceVolume]: mine });
    expect(await destroyComputer(docker, names, ours, 'bot')).toEqual({
        botId: 'dot-a',
        container: false,
        volumes: [names.workspaceVolume],
    });
    expect(await destroyComputer(docker, names, ours, 'bot')).toEqual({
        botId: 'dot-a',
        container: false,
        volumes: [],
    });
});

it('leaves anyone else’s container and volumes alone', async () => {
    const other = { owner: 'true', namespace: 'ns', bot: 'dot-b' };
    const foreignNamespace = { owner: 'true', namespace: 'other', bot: 'dot-a' };
    const volumes = {
        [names.profileVolume]: other,
        [names.workspaceVolume]: foreignNamespace,
        [names.privateVolume]: {},
    };
    const docker = fakeDocker({}, volumes);
    expect((await destroyComputer(docker, names, ours, 'bot')).volumes).toEqual([]);
    expect(Object.keys(volumes)).toHaveLength(3);
    const taken = fakeDocker({ [names.container]: other }, { [names.profileVolume]: mine });
    await expect(destroyComputer(taken, names, ours, 'bot')).rejects.toMatchObject({ refused: true });
    expect(taken.removed).toEqual([]);
});

it('passes on a Docker failure other than “not found”', async () => {
    const docker = fakeDocker({ [names.container]: mine }, {});
    docker.getContainer = () => ({
        inspect: async () => Promise.reject(Object.assign(new Error('down'), { statusCode: 500 })),
    });
    await expect(destroyComputer(docker, names, ours, 'bot')).rejects.toThrow('down');
});

it('adds the destroy route under the existing token guard and validated Bot vocabulary', async () => {
    const upstream = `import {\n  listOwned,\n} from "./docker";\nconst app = new Hono();\napp.use('*',async(c,next)=>c.req.header('authorization')==='Bearer fixture'?next():c.json({error:'Unauthorized'},401));\napp.get("/computers", async (context) => {return context.json({computers:await listOwned()})});`;
    const patched = hardenSupervisorRoutes(upstream).replace(/import \{[\s\S]*?\} from "\.\/docker";/, '');
    const destroy = vi.fn(async (n) => ({ botId: n.botId, container: true, volumes: [n.profileVolume] }));
    const resolve = (raw) =>
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(raw)
            ? { ok: true, names: { ...names, botId: raw } }
            : { ok: false, reason: 'Invalid id' };
    const app = new Function(
        'Hono',
        'listOwned',
        'computerStats',
        'computerDestroy',
        'resolve',
        patched + '\nreturn app;',
    )(
        Hono,
        async () => [],
        async () => null,
        destroy,
        resolve,
    );
    const post = (path, authorized = true) =>
        app.request(path, { method: 'POST', headers: authorized ? { authorization: 'Bearer fixture' } : {} });
    expect((await post('/computers/dot-a/destroy', false)).status).toBe(401);
    // The purge's probe: the route exists, so a bad id is a 400, not a 404.
    expect((await post('/computers/-/destroy')).status).toBe(400);
    expect(destroy).not.toHaveBeenCalled();
    const ok = await post('/computers/dot-a/destroy');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ botId: 'dot-a', container: true, volumes: [names.profileVolume] });
    destroy.mockRejectedValueOnce(Object.assign(new Error('taken'), { refused: true }));
    expect((await post('/computers/dot-a/destroy')).status).toBe(409);
    destroy.mockRejectedValueOnce(new Error('docker down'));
    expect((await post('/computers/dot-a/destroy')).status).toBe(503);
});
