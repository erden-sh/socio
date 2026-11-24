import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';

import type { AppEnv } from '@socio/foundation/http/app-env';
import type { CodingSandboxList, CodingSandboxView } from '@socio/shared/coding/coding-sessions';

import { filterVolumes } from '../deployment/computers/disk-usage-proxy.mjs';
import { ComputerDiskUsage } from '../src/server/computers/computer-disk-usage.js';

import { REPO, codingWorld, eventually } from './support/coding-fixture.js';

// CB-239: the Computer panel lists a person's own coding
// sandboxes and sessions on a socio (status, repository, branch, age,
// disk) with Stop, which ends a session the way coding_stop does. Admins
// see everyone's; nobody else sees anyone else's. Negative cases first.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const USERS: Record<string, 'member' | 'admin'> = {
    alice: 'member',
    bob: 'member',
    olga: 'admin',
};

async function setup(flags?: Record<string, boolean>) {
    const world = await codingWorld(flags ? { flags } : {});
    cleanup.push(() => world.close());
    vi.spyOn(world.turns, 'turnOutcome').mockResolvedValue({
        text: '',
    } as never);
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
        const id = c.req.header('x-test-user') ?? 'alice';
        c.set('user', { id, name: id, role: USERS[id] ?? 'member' } as never);
        await next();
    });
    app.route('/gateway', world.routes());
    const list = async (user: string, socio = world.socio.id) => {
        const response = await app.request(`/gateway/sandboxes?socio=${encodeURIComponent(socio)}`, {
            headers: { 'x-test-user': user },
        });
        return {
            status: response.status,
            body: (await response.json()) as CodingSandboxList & { error?: string },
        };
    };
    const stop = async (user: string, id: string) => {
        const response = await app.request(`/gateway/sandboxes/${id}/stop`, {
            method: 'POST',
            headers: { 'x-test-user': user, 'content-type': 'application/json' },
            body: '{}',
        });
        return {
            status: response.status,
            body: (await response.json()) as CodingSandboxView & { error?: string },
        };
    };
    const ready = async (person = 'alice') => {
        const { session } = await world.started({}, world.turnOf(person));
        await eventually(() => world.service.sessions.get(session!.id)!.state === 'ready');
        return session!;
    };
    return { ...world, list, stop, ready };
}

it('shows nothing while the flag is off for the viewer, and needs a socio', async () => {
    const world = await setup({ 'socio-actor-access': true });
    expect((await world.list('alice')).status).toBe(404);
    expect((await world.stop('alice', 'whatever')).status).toBe(404);
    const on = await setup();
    expect((await on.list('alice', '')).status).toBe(400);
});

it('lists only the viewer’s own sessions; another member sees none of them', async () => {
    const world = await setup();
    const session = await world.ready('alice');
    const bob = await world.list('bob');
    expect(bob.status).toBe(200);
    expect(bob.body.sandboxes).toEqual([]);
    const alice = await world.list('alice');
    expect(alice.body.sandboxes).toHaveLength(1);
    expect(alice.body.sandboxes[0]).toMatchObject({
        id: session.id,
        mine: true,
        personName: 'Alice',
        repository: REPO,
        branch: session.branch,
        base: 'main',
        state: 'ready',
        sandbox: true,
        canStop: true,
    });
    expect(alice.body.sandboxes[0]!.createdAt).toBeLessThanOrEqual(Date.now());
    // Another socio's panel lists none of it.
    expect((await world.list('alice', 'some-other-socio')).body.sandboxes).toEqual([]);
    // Nothing the agent wrote, ever: no run, summary or progress fields.
    const keys = Object.keys(alice.body.sandboxes[0]!);
    for (const key of ['run', 'summary', 'progress', 'changedFiles', 'tokens']) {
        expect(keys).not.toContain(key);
    }
});

it('lets an admin see everyone’s sessions on the socio, by name', async () => {
    const world = await setup();
    const mine = await world.ready('alice');
    const bobs = await world.ready('bob');
    const olga = await world.list('olga');
    expect(olga.body.sandboxes.map((row) => row.id).sort()).toEqual([mine.id, bobs.id].sort());
    for (const row of olga.body.sandboxes) {
        expect(row.mine).toBe(false);
        expect(row.canStop).toBe(true);
    }
    expect(olga.body.sandboxes.map((row) => row.personName).sort()).toEqual(['Alice', 'Bob']);
    // Bob still sees only his own.
    expect((await world.list('bob')).body.sandboxes.map((row) => row.id)).toEqual([bobs.id]);
});

it('refuses another person’s Stop with the 404 of a missing session; nothing ends', async () => {
    const world = await setup();
    const session = await world.ready('alice');
    const bob = await world.stop('bob', session.id);
    const missing = await world.stop('bob', 'nothing-here');
    for (const answer of [bob, missing]) {
        expect(answer.status).toBe(404);
        expect(answer.body).toEqual({ error: 'No such session.' });
    }
    expect(world.service.sessions.get(session.id)!.state).toBe('ready');
    expect(world.supervisor.removed).not.toContain(session.id);
});

it('stops the viewer’s own session the way coding_stop does: sandbox removed, grant ended, audited', async () => {
    const world = await setup();
    const session = await world.ready('alice');
    const stopped = await world.stop('alice', session.id);
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({
        id: session.id,
        state: 'ended',
        endReason: 'stopped',
        canStop: false,
    });
    await eventually(() => world.supervisor.removed.includes(session.id));
    const grant = world.platform.actors.grants.get(session.grantId!)!;
    expect(grant.revokedAt).not.toBeNull();
    const audit = world.platform.actors.audit.list({ personId: 'alice' }, 200);
    expect(
        audit.find((row) => row.phase === 'context' && row.status === 'closed' && row.resourceId === session.id),
    ).toMatchObject({ actorBy: 'alice', reason: 'stopped' });
    expect(audit.find((row) => row.phase === 'revoke' && row.grantId === grant.id)).toMatchObject({
        reason: 'task_ended',
    });
    // Stopping again changes nothing; the workspace stays listed as kept.
    expect((await world.stop('alice', session.id)).body.state).toBe('ended');
    const listed = (await world.list('alice')).body.sandboxes;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ state: 'ended', canStop: false });
});

it('lets an admin stop someone else’s session, recorded as theirs with admin_revoked', async () => {
    const world = await setup();
    const session = await world.ready('bob');
    const stopped = await world.stop('olga', session.id);
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({
        state: 'ended',
        endReason: 'admin_stopped',
        mine: false,
    });
    const audit = world.platform.actors.audit.list({ personId: 'bob' }, 200);
    expect(audit.find((row) => row.phase === 'context' && row.resourceId === session.id)).toMatchObject({
        actorBy: 'olga',
        reason: 'admin_stopped',
    });
    expect(audit.find((row) => row.phase === 'revoke' && row.grantId === session.grantId)).toMatchObject({
        reason: 'admin_revoked',
    });
});

it('shows a revoked session as ended, without Stop, and drops one whose workspace is gone', async () => {
    const world = await setup();
    const session = await world.ready('alice');
    await world.platform.actors.revoke({ grantId: session.grantId! }, 'alice', 'person_revoked');
    await eventually(() => world.service.sessions.get(session.id)!.state === 'ended');
    const row = (await world.list('alice')).body.sandboxes[0]!;
    expect(row).toMatchObject({ state: 'ended', canStop: false });
    world.connection.prepare('UPDATE coding_sessions SET volumeGoneAt=? WHERE id=?').run(Date.now(), session.id);
    expect((await world.list('alice')).body.sandboxes).toEqual([]);
});

it('shows each workspace’s disk from the read-only disk usage measurement', async () => {
    const world = await setup();
    const session = await world.ready('alice');
    vi.spyOn(world.platform.computers.disk, 'workspace').mockImplementation((key) =>
        key === session.volumeKey ? 12_345_678 : null,
    );
    expect((await world.list('alice')).body.sandboxes[0]!.diskBytes).toBe(12_345_678);
});

const KEY = 'a'.repeat(64);
const codingVolume = (over: Record<string, unknown> = {}) => ({
    Name: `company-brain-code-work-${KEY}`,
    Labels: {
        'socio.coding.supervisor': 'true',
        'socio.coding.namespace': 'company-brain',
        'socio.coding.volume': KEY,
        extra: 'dropped',
    },
    Mountpoint: '/var/lib/docker/volumes/x',
    UsageData: { Size: 4096, RefCount: 1 },
    ...over,
});

it('passes only this deployment’s coding workspace volumes through the disk usage proxy, with their labels and size', () => {
    const filtered = filterVolumes(
        {
            Volumes: [
                codingVolume(),
                codingVolume({
                    Labels: { ...codingVolume().Labels, 'socio.coding.namespace': 'x' },
                }),
                codingVolume({ Name: 'company-brain-code-work-other' }),
                codingVolume({
                    Labels: { ...codingVolume().Labels, 'socio.coding.volume': '../x' },
                }),
                { Name: 'someone-else', Labels: {}, UsageData: { Size: 1 } },
            ],
        },
        'company-brain',
    ) as { Volumes: Array<Record<string, unknown>> };
    expect(filtered.Volumes).toEqual([
        {
            Name: `company-brain-code-work-${KEY}`,
            Labels: {
                'socio.coding.supervisor': 'true',
                'socio.coding.namespace': 'company-brain',
                'socio.coding.volume': KEY,
            },
            UsageData: { Size: 4096, RefCount: 1 },
        },
    ]);
});

it('reads coding workspaces’ sizes beside the computers’, only while fresh', async () => {
    let now = 1_000_000;
    const read = vi.fn(async (path: string) =>
        path.includes('system/df')
            ? filterVolumes(
                  {
                      Volumes: [
                          codingVolume(),
                          codingVolume({
                              Name: `company-brain-code-work-${'b'.repeat(64)}`,
                              Labels: {
                                  ...codingVolume().Labels,
                                  'socio.coding.volume': 'b'.repeat(64),
                              },
                              UsageData: { Size: -1, RefCount: 0 },
                          }),
                      ],
                  },
                  'company-brain',
              )
            : [],
    );
    const disk = new ComputerDiskUsage(read, 'company-brain', () => now);
    expect(disk.workspace(KEY)).toBeNull();
    disk.refresh();
    await disk.pending;
    expect(disk.workspace(KEY)).toBe(4096);
    // Docker's "not measured" is unknown, not zero.
    expect(disk.workspace('b'.repeat(64))).toBeNull();
    // A coding volume is never counted as a computer's.
    expect(disk.reading(KEY).volumeBytes).toBeNull();
    now += 4 * 15 * 60_000;
    expect(disk.workspace(KEY)).toBeNull();
});
