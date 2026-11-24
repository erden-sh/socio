// CB-374: a signed-in page's Space access costs a fixed number of queries,
// not two or three per Space for every Dot. `SpaceAccess` reads a person's
// memberships and the members-only Spaces once, then applies the one rule
// (`spaceAccessLevel`) in memory; the workspace view asks for the person's
// readable Spaces once for all their Dots. The answers stay those of
// `level` and `reads` asked once per Space.
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it } from 'vitest';

import { sqliteData } from '@socio/data/open';
import type { Space, User } from '@socio/shared/types';

import { issuesModule } from '../src/server/issues/module.js';
import { SpaceAccess } from '../src/server/spaces/access.js';
import type { SpaceReader } from '../src/server/spaces/contract.js';
import { sqliteSpaceAccess } from '../src/server/spaces/infra/sqlite/repositories.js';

import { testWorkspaceViews } from './helpers/page-views.js';
import { LocalAgentRunner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testAuth } from './helpers/test-auth.js';
import { testDatabase } from './helpers/test-database.js';
import { startWithTestPlatform } from './helpers/test-platform.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const ADMIN: User = { id: 'alice', name: 'Alice', role: 'admin' };
const MEMBER: User = { id: 'bob', name: 'Bob', role: 'member' };

/** Counts the statements prepared against the Space-access tables. */
function countAccessQueries(db: DatabaseSync) {
    const prepare = db.prepare.bind(db);
    const counter = { queries: 0 };
    db.prepare = ((sql: string) => {
        if (/space_members|space_settings/.test(sql)) {
            counter.queries++;
        }
        return prepare(sql);
    }) as DatabaseSync['prepare'];
    cleanup.push(() => {
        db.prepare = prepare;
    });
    return counter;
}

/** A workspace with `spaces` Spaces (every other one private, bob in half of those) and `dots` Dots. */
async function workspace(spaces: number, dots: number) {
    const ws = new WorkspaceStore(testDatabase());
    cleanup.push(() => ws.close());
    const store = new Store(testDatabase());
    cleanup.push(() => store.close());
    const { runtime, platform } = await startWithTestPlatform({
        db: ws.db,
        store,
        workspace: ws,
        config: {
            baseUrl: '',
            apiKey: '',
            model: '',
            voiceName: 'marin',
            runtimeUrl: '',
            appOrigin: 'https://app.example.invalid',
        },
        runner: new LocalAgentRunner(testDatabase()),
        auth: testAuth(),
        modules: [issuesModule],
        log: () => {},
    });
    cleanup.push(() => platform.stop());
    cleanup.push(() => runtime.dispose());
    ws.recordUser(ADMIN);
    ws.recordUser(MEMBER);
    const ids: string[] = [];
    for (let i = 0; i < spaces; i++) {
        const space = ws.createSpace(`Space ${i}`, '');
        ids.push(space.id);
        if (i % 2) {
            await ws.spaceAccess.setMembersOnly(space.id, ADMIN.id, true);
            if (i % 4 === 1) {
                await ws.spaceAccess.setRole(space.id, ADMIN.id, MEMBER.id, 'member');
            }
        }
    }
    for (let i = 0; i < dots; i++) {
        ws.createDot(ids[i % ids.length]!, `Dot ${i}`, '', true, true);
    }
    return { ws, views: testWorkspaceViews(platform) };
}

it("the workspace view's Space-access queries don't grow with the Spaces or the Dots", async () => {
    const counts: number[] = [];
    for (const [spaces, dots] of [
        [2, 1],
        [40, 12],
    ] as const) {
        const { ws, views } = await workspace(spaces, dots);
        const counter = countAccessQueries(ws.db);
        for (const user of [MEMBER, ADMIN]) {
            counter.queries = 0;
            const view = await views.workspaceView(user);
            counts.push(counter.queries);
            // The view still lists what the person reads, as the per-Space rule says.
            const reads = ws.spaces().filter((space) => ws.spaceAccess.level(space.id, user.id) !== null);
            expect(view.spaces.map((space) => space.id)).toEqual(reads.map((space) => space.id));
            expect(reads.length).toBeGreaterThan(user === ADMIN ? spaces : spaces / 2);
        }
    }
    expect(new Set(counts).size).toBe(1);
    expect(counts[0]).toBeLessThanOrEqual(4);
});

/** Eight Spaces, the odd ones private; people with every kind of row. */
function direct() {
    const db = testDatabase();
    cleanup.push(() => db.close());
    const spaces: Space[] = Array.from({ length: 8 }, (_, n) => ({
        id: `s${n}`,
        name: `Space ${n}`,
        description: '',
        createdAt: n,
    }));
    const settings = db.prepare(
        'INSERT INTO space_settings (spaceId, membersOnly, updatedBy, updatedAt) VALUES (?, ?, ?, ?)',
    );
    for (const space of spaces) {
        // s6 has a row that says open, as one made private and opened again.
        if (space.id === 's6' || Number(space.id.slice(1)) % 2) {
            settings.run(space.id, space.id === 's6' ? 0 : 1, 'alice', 1);
        }
    }
    const member = db.prepare(
        'INSERT INTO space_members (spaceId, userId, role, addedBy, addedAt, updatedAt) VALUES (?, ?, ?, ?, ?, 1)',
    );
    member.run('s1', 'bob', 'member', 'alice', 1);
    member.run('s3', 'bob', 'editor', 'alice', 1);
    member.run('s2', 'bob', 'editor', 'alice', 1);
    member.run('s5', 'ada', 'member', 'alice', 1);
    member.run('s3', 'eve', 'editor', 'alice', 1);
    // A row for a Space that is no longer live.
    member.run('gone', 'bob', 'editor', 'alice', 1);
    const users: User[] = [
        ADMIN,
        MEMBER,
        { id: 'ada', name: 'Ada', role: 'member' },
        { id: 'eve', name: 'Eve', role: 'member' },
    ];
    let deactivatedChecks = 0;
    const access = new SpaceAccess({
        repository: sqliteSpaceAccess(sqliteData(db)),
        users: () => users,
        spaces: () => spaces,
        isDeactivated: (id) => {
            deactivatedChecks++;
            return id === 'eve';
        },
        socioHas: (dotId, spaceId) => dotId === 'all' || spaceId !== 's0',
    });
    return { db, access, spaces, checks: () => deactivatedChecks };
}

it('the batched answers are the per-Space rule’s, for people and socios', () => {
    const { access, spaces } = direct();
    const people = ['alice', 'bob', 'ada', 'eve', 'nobody'];
    for (const userId of people) {
        const one = spaces.flatMap((space) => {
            const level = access.level(space.id, userId);
            return level ? [{ id: space.id, level, private: access.membersOnly(space.id) }] : [];
        });
        expect(access.readable({ userId }).map((space) => space.id)).toEqual(one.map((space) => space.id));
        expect(
            access.spacesFor(userId).map(({ id, access, private: closed }) => ({ id, level: access, private: closed })),
        ).toEqual(one);
    }
    const readers: SpaceReader[] = [
        { dotId: 'all', people: null },
        { dotId: 'some', people: null },
        { dotId: 'all', people: [] },
        { dotId: 'all', people: ['bob'] },
        { dotId: 'some', people: ['bob', 'ada'] },
        { dotId: 'all', people: ['alice', 'eve'] },
    ];
    for (const reader of readers) {
        expect(access.readable(reader).map((space) => space.id)).toEqual(
            spaces.filter((space) => access.reads(space.id, reader)).map((space) => space.id),
        );
    }
    const ids = [...spaces.map((space) => space.id), 'gone'];
    for (const group of [[], ['bob'], ['bob', 'ada'], ['alice', 'bob'], ['eve']]) {
        expect(access.readableByAll(ids, group)).toEqual(
            ids.filter((id) => group.length > 0 && group.every((userId) => access.reads(id, { userId }))),
        );
    }
});

it('a list of Spaces is two queries and one deactivation check per person, whatever the Spaces', () => {
    const { db, access, checks } = direct();
    const counter = countAccessQueries(db);
    const before = checks();
    access.spacesFor('bob');
    expect(counter.queries).toBe(2);
    counter.queries = 0;
    access.readable({ dotId: 'all', people: ['bob', 'ada', 'alice'] });
    // The members-only Spaces once, then each person's rows once.
    expect(counter.queries).toBe(4);
    expect(checks() - before).toBe(4);
});
