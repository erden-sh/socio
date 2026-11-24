import { afterEach, describe, expect, it } from 'vitest';

import { SnapshotShapeError } from '../../src/sync/errors';
import { firstFrameSnapshots, MODULE_KINDS } from '../../src/sync/kinds';
import { MEMORIES, MEMORIES_SNAPSHOT, MEMORY_PROFILE, PROFILE_KEY } from '../../src/sync/memories';
import { RUNS, RUNS_SNAPSHOT } from '../../src/sync/runs';
import { GOALS, JOBS, LIMITS_KEY, SCHEDULE_LIMITS, SCHEDULES, SCHEDULES_SNAPSHOT } from '../../src/sync/schedules';
import { SKILLS, SKILLS_SNAPSHOT } from '../../src/sync/skills';
import type { SnapshotDefinition } from '../../src/sync/snapshot-cache';
import { bodyTag, createSnapshotSource } from '../../src/sync/snapshot-source';

import { memory, metaOnDisk, rowsOnDisk, run, syncSetup } from './helpers';

// The small kinds against
// the fake server: memories, schedules and runs with their ETags (a 200 that
// fills them, a 304, removed rows), and skills, whose path sends no ETag, by
// the hash of its body.

type Setup = Awaited<ReturnType<typeof syncSetup>>;
const open: Setup[] = [];
afterEach(async () => {
    for (const s of open.splice(0)) {
        await s.close().catch(() => {});
    }
});

async function setup(definition: SnapshotDefinition) {
    const s = await syncSetup();
    open.push(s);
    const source = createSnapshotSource({ definition, cache: s.cache, fetch: s.authed, signal: s.scope.signal });
    return Object.assign(s, { source });
}

const keys = (s: Setup, collection: string) => [...s.cache.rows(collection).keys()].sort();
const value = (s: Setup, collection: string, key: string) =>
    JSON.parse(s.cache.rows(collection).get(key)?.json ?? 'null') as Record<string, unknown> | null;

describe('the memories kind', () => {
    it('fills memories and proposals by id and the profile as one row, answers 304, and removes what a 200 drops', async () => {
        const s = await setup(MEMORIES_SNAPSHOT);
        const first = await s.source.pull('', null);
        expect(first.outcome).toBe('changed');
        expect(keys(s, MEMORIES)).toEqual(['m1', 'm2']);
        expect(value(s, MEMORIES, 'm2')).toMatchObject({ status: 'proposed' });
        expect(s.cache.rows(MEMORIES).get('m1')?.version).toBe(5);
        expect(value(s, MEMORY_PROFILE, PROFILE_KEY)).toEqual({
            profile: { name: 'Ada', timezone: 'Europe/Lisbon' },
            timeZoneMoved: null,
        });

        const again = await s.source.pull('', s.source.cursor());
        expect(again.outcome).toBe('not-modified');
        expect(s.server.requests.at(-1)).toMatchObject({
            path: '/api/memories',
            ifNoneMatch: first.cursor,
            status: 304,
        });

        // Approving the proposal changes its row; the other is deleted; the zone moved.
        s.server.change('memories', (data) => {
            data.memories = [memory('m2', 'Works in Lisbon', 9)];
            data.proposals = [];
            data.timeZoneMoved = 'America/New_York';
        });
        const changed = await s.source.pull('', s.source.cursor());
        expect(changed.removes.map(({ key }) => key)).toEqual(['m1']);
        expect(keys(s, MEMORIES)).toEqual(['m2']);
        expect(value(s, MEMORIES, 'm2')).toMatchObject({ status: 'active' });
        expect(value(s, MEMORY_PROFILE, PROFILE_KEY)).toMatchObject({ timeZoneMoved: 'America/New_York' });

        await s.cache.flush();
        expect(Object.keys(await rowsOnDisk(s.db, MEMORIES))).toEqual(['m2']);
        expect((await metaOnDisk(s.db, 'memories'))?.etag).toBe(changed.cursor);
    });

    it('refuses a body that isn’t the page, applying nothing', () => {
        const page = { profile: null, memories: [], proposals: [] };
        expect(() => MEMORIES_SNAPSHOT.split(page)).not.toThrow();
        expect(() => MEMORIES_SNAPSHOT.split({ ...page, memories: [{ text: 'no id', updatedAt: 1 }] })).toThrow(
            SnapshotShapeError,
        );
        expect(() => MEMORIES_SNAPSHOT.split({ ...page, proposals: [{ id: 'm', updatedAt: 'x' }] })).toThrow(
            SnapshotShapeError,
        );
        expect(() => MEMORIES_SNAPSHOT.split({ memories: [], proposals: [] })).toThrow(SnapshotShapeError);
        expect(() => MEMORIES_SNAPSHOT.split({ ...page, timeZoneMoved: 3 })).toThrow(SnapshotShapeError);
    });
});

describe('the schedules kind', () => {
    it('fills schedules, goals with their comments and jobs by id, and the limits as one row, then answers 304', async () => {
        const s = await setup(SCHEDULES_SNAPSHOT);
        const first = await s.source.pull('', null);
        expect(keys(s, SCHEDULES)).toEqual(['s1']);
        expect(value(s, GOALS, 'G-0000000a')).toMatchObject({ comments: [{ id: 'gc1', text: 'Started' }] });
        expect(s.cache.rows(GOALS).get('G-0000000a')?.version).toBe(3);
        expect(s.cache.rows(SCHEDULES).get('s1')?.version).toBeNull();
        expect(keys(s, JOBS)).toEqual(['j1']);
        expect(value(s, SCHEDULE_LIMITS, LIMITS_KEY)).toMatchObject({
            limits: { maxActiveSchedules: 20 },
            usage: { activeSchedules: 1, jobs: 1 },
        });
        expect(value(s, SCHEDULE_LIMITS, LIMITS_KEY)).not.toHaveProperty('counts');

        expect((await s.source.pull('', first.cursor)).outcome).toBe('not-modified');

        s.server.change('schedules', (data) => {
            data.schedules = [];
            data.jobs = [];
            data.goals = [{ ...data.goals[0], comments: [], updatedAt: 8 }];
        });
        const changed = await s.source.pull('', s.source.cursor());
        expect(changed.removes.map(({ collection, key }) => `${collection}/${key}`).sort()).toEqual([
            'jobs/j1',
            'schedules/s1',
        ]);
        expect(value(s, GOALS, 'G-0000000a')).toMatchObject({ comments: [] });
        expect(value(s, SCHEDULE_LIMITS, LIMITS_KEY)).toMatchObject({ usage: { activeSchedules: 0, jobs: 0 } });
    });

    it('refuses a body with no limits or a job with no id', () => {
        const page = { schedules: [], goals: [], jobs: [], limits: {}, usage: {} };
        expect(() => SCHEDULES_SNAPSHOT.split(page)).not.toThrow();
        expect(() => SCHEDULES_SNAPSHOT.split({ ...page, limits: undefined })).toThrow(SnapshotShapeError);
        expect(() => SCHEDULES_SNAPSHOT.split({ ...page, jobs: [{ name: 'x', updatedAt: 1 }] })).toThrow(
            SnapshotShapeError,
        );
    });
});

describe('the runs kind', () => {
    it('fills the runs by id, answers 304, and sets a changed status and removes a dropped run', async () => {
        const s = await setup(RUNS_SNAPSHOT);
        const first = await s.source.pull('', null);
        expect(keys(s, RUNS)).toEqual(['r1', 'r2']);
        expect(s.server.requests.at(-1)).toMatchObject({ path: '/api/runs', status: 200 });
        expect((await s.source.pull('', first.cursor)).outcome).toBe('not-modified');

        s.server.change('runs', (data) => {
            data.runs = [run('r3', 'running', 30), run('r2', 'done', 20)];
        });
        const changed = await s.source.pull('', s.source.cursor());
        expect(changed.removes.map(({ key }) => key)).toEqual(['r1']);
        expect(keys(s, RUNS)).toEqual(['r2', 'r3']);
        expect(value(s, RUNS, 'r2')).toMatchObject({ status: 'done' });
    });
});

describe('the skills kind (no ETag: the body’s hash)', () => {
    it('sends no If-None-Match, keeps the hash as its tag, and applies an unchanged body as a 304', async () => {
        const s = await setup(SKILLS_SNAPSHOT);
        const first = await s.source.pull('', null);
        expect(first.outcome).toBe('changed');
        expect(keys(s, SKILLS)).toEqual(['everyone']);
        expect(first.cursor).toBe(bodyTag(JSON.stringify(s.server.data.skills)));

        const told: string[] = [];
        s.cache.subscribe((change) => told.push(...change.upserts.map(({ key }) => key)));
        const again = await s.source.pull('', s.source.cursor());
        expect(again.outcome).toBe('not-modified');
        expect(again.cursor).toBe(first.cursor);
        expect(told).toEqual([]);
        // Asked plainly both times: the path ignores tags.
        expect(s.server.requests.filter(({ path }) => path === '/api/learning/skills')).toMatchObject([
            { ifNoneMatch: undefined, status: 200 },
            { ifNoneMatch: undefined, status: 200 },
        ]);
        // A full poll (no cursor) of the same body applies nothing either.
        expect((await s.source.pull('', null)).outcome).toBe('not-modified');

        s.server.data.skills = [
            { containerId: 'eng', skills: [{ name: 'review', description: 'Reviews', revision: 2, revisionId: 'k2' }] },
        ];
        const changed = await s.source.pull('', s.source.cursor());
        expect(changed.outcome).toBe('changed');
        expect(changed.removes.map(({ key }) => key)).toEqual(['everyone']);
        expect(keys(s, SKILLS)).toEqual(['eng']);
        expect(changed.cursor).not.toBe(first.cursor);

        await s.cache.flush();
        expect((await metaOnDisk(s.db, 'skills'))?.etag).toBe(changed.cursor);
    });

    it('applies the body whole once a confirmed write dropped the hash', async () => {
        const s = await setup(SKILLS_SNAPSHOT);
        await s.source.pull('', null);
        await s.cache.confirm({
            collection: SKILLS,
            scope: '',
            key: 'everyone',
            value: { containerId: 'everyone', skills: [] },
        });
        expect(s.source.cursor()).toBeNull();
        const after = await s.source.pull('', s.source.cursor());
        expect(after.outcome).toBe('changed');
        expect(value(s, SKILLS, 'everyone')).toMatchObject({ skills: [{ name: 'triage' }] });
    });

    it('tells bodies apart by length and content', () => {
        expect(bodyTag('[]')).toBe(bodyTag('[]'));
        expect(bodyTag('[1]')).not.toBe(bodyTag('[2]'));
        expect(bodyTag('[1]')).not.toBe(bodyTag('[11]'));
        expect(bodyTag('')).toMatch(/^"body\.0\.[0-9a-z]+"$/);
    });
});

describe('the module kinds', () => {
    it('pull only in view, except issues and approvals, at the web’s intervals, and none is read before the first frame unless kept', () => {
        expect(
            MODULE_KINDS.map(({ definition, visiblePoll, inView }) => [definition.id, visiblePoll ?? null, !!inView]),
        ).toEqual([
            ['issues', 15_000, false],
            ['approvals', 60_000, false],
            ['room-invites', 60_000, true],
            ['memories', 15_000, true],
            ['schedules', 10_000, true],
            ['runs', 10_000, true],
            ['skills', null, true],
        ]);
        const kept = (screen: string | null) =>
            firstFrameSnapshots({ get: () => screen }).map((definition) => definition.id);
        expect(kept('Board')).toEqual(['issues']);
        expect(kept('Memories')).toEqual(['memories']);
        expect(kept('More')).toEqual([]);
        expect(kept(null)).toEqual([]);
    });
});
