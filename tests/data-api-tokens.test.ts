import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { backupUserData } from '@socio/data/backup';
import { WORKSPACE_OWNER_ID } from '@socio/shared/data-types';
import type { CreatedDataApiToken, DataApiTokenList } from '@socio/shared/dataspace/api-tokens';
import type { User } from '@socio/shared/types';

import { DATA_API_USE_SUMMARY_MS } from '../src/server/dataspace/api-tokens.js';
import { API_SCOPE_OF } from '../src/server/dataspace/routes.js';

import { cleanup, world } from './helpers/plugin-world.js';

// Admins' data API tokens: made in Settings by a workspace admin, for a
// script of theirs (a Notion import) on the company's datasets. Scopes
// data:read, data:write, data:admin; an expiry; a budget of its own; the
// workspace audit has its making, its use and its revoke.

afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

type World = Awaited<ReturnType<typeof world>>;
type Api = ReturnType<World['withToken']>;

async function setup(limits: Record<string, number> = {}) {
    const f = await world(limits);
    const alice = await f.as('alice');
    const bob = await f.as('bob');
    const make = async (body: Record<string, unknown>) => {
        const made = await alice('/data/api-tokens', 'POST', { name: 'Notion import', ...body });
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        const created = made.body as unknown as CreatedDataApiToken;
        return { ...created, api: f.withToken(created.token) };
    };
    const lines = () =>
        f.workspace.db
            .prepare(
                "SELECT actor, action, targetId, detail FROM workspace_audit WHERE targetKind='data_api_token' ORDER BY id",
            )
            .all() as Array<{ actor: string; action: string; targetId: string; detail: string }>;
    return { f, alice, bob, make, lines };
}
const ALL = ['data:read', 'data:write', 'data:admin'];
const TABLE = {
    table: 'pages',
    columns: [
        { name: 'id', type: 'TEXT', primaryKey: true },
        { name: 'title', type: 'TEXT' },
        { name: 'status', type: 'TEXT' },
    ],
};

/** A company dataset with a table and a row, made by a token with every scope. */
async function companyDataset(api: Api, name = 'Roadmap') {
    const created = await api('/data/datasets', 'POST', { name });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = String(created.body.id);
    expect((await api(`/data/datasets/${id}/tables`, 'POST', TABLE)).status).toBe(200);
    expect(
        (await api(`/data/datasets/${id}/tables/pages/rows`, 'POST', { rows: [{ id: 'p1', title: 'One' }] })).status,
    ).toBe(200);
    return id;
}

describe('making, listing and revoking', () => {
    it('lets admins alone make, list and revoke tokens, shown once and kept as a hash', async () => {
        const { f, alice, bob, make, lines } = await setup();
        expect((await bob('/data/api-tokens')).status).toBe(403);
        expect((await bob('/data/api-tokens', 'POST', { name: 'x', scopes: ['data:read'] })).status).toBe(403);
        const made = await make({ scopes: ['data:read'] });
        expect(made.token).toMatch(/^cbdt_api_[A-Za-z0-9_-]{40,}$/);
        expect(made.apiToken).toMatchObject({
            name: 'Notion import',
            scopes: ['data:read'],
            statementsPerMinute: 600,
            createdBy: 'alice',
            createdByName: 'Alice',
            revokedAt: null,
        });
        // 7 days unless chosen; at most 30.
        expect(made.apiToken.expiresAt - made.apiToken.createdAt).toBe(7 * 86_400_000);
        expect((await alice('/data/api-tokens', 'POST', { name: 'x', scopes: ['data:read'], days: 31 })).status).toBe(
            400,
        );
        expect((await alice('/data/api-tokens', 'POST', { name: 'x', scopes: [] })).status).toBe(400);
        expect((await alice('/data/api-tokens', 'POST', { name: 'x', scopes: ['issues:read'] })).status).toBe(400);
        expect(
            (
                await alice('/data/api-tokens', 'POST', {
                    name: 'x',
                    scopes: ['data:read'],
                    statementsPerMinute: 100_001,
                })
            ).status,
        ).toBe(400);
        // Never stored, never listed.
        const stored = JSON.stringify(f.workspace.db.prepare('SELECT * FROM data_api_tokens').all());
        expect(stored).not.toContain(made.token);
        expect(stored).not.toContain(made.token.slice('cbdt_api_'.length));
        const list = (await alice('/data/api-tokens')).body as unknown as DataApiTokenList;
        expect(list.tokens.map((token) => token.id)).toEqual([made.apiToken.id]);
        expect(JSON.stringify(list)).not.toContain(made.token);
        expect(list).toMatchObject({ daysDefault: 7, daysMax: 30, statementsPerMinuteDefault: 600 });

        expect((await made.api('/data/datasets')).status).toBe(200);
        expect((await bob(`/data/api-tokens/${made.apiToken.id}`, 'DELETE')).status).toBe(403);
        const revoked = await alice(`/data/api-tokens/${made.apiToken.id}`, 'DELETE');
        expect(revoked.body).toMatchObject({ revokedBy: 'alice' });
        expect(revoked.body.revokedAt).toEqual(expect.any(Number));
        expect((await made.api('/data/datasets')).status).toBe(401);
        expect(lines().map((line) => [line.actor, line.action])).toEqual([
            ['alice', 'create'],
            [`token:${made.apiToken.id}`, 'use'],
            ['alice', 'revoke'],
        ]);
        expect(lines()[0]!.detail).toContain('data:read; 7 day(s); 600 operations a minute');
        expect(lines()[1]!.detail).toContain('made by alice: 1 request(s)');
        expect(JSON.stringify(lines())).not.toContain(made.token);
    });

    it('refuses a token once it expires', async () => {
        const { f, make } = await setup();
        const made = await make({ scopes: ['data:read'], days: 1 });
        expect((await made.api('/data/datasets')).status).toBe(200);
        f.workspace.db
            .prepare('UPDATE data_api_tokens SET expiresAt=? WHERE id=?')
            .run(Date.now() - 1, made.apiToken.id);
        expect((await made.api('/data/datasets')).status).toBe(401);
    });

    it('revokes a token for good once its maker is no longer an active admin', async () => {
        const { f, make, lines } = await setup();
        const demoted = await make({ scopes: ['data:read'] });
        // The sign-in provider's effective role decides, not the workspace's last record of it.
        const people: { list: User[] } = {
            list: [
                { id: 'alice', name: 'Alice', role: 'member' },
                { id: 'bob', name: 'Bob', role: 'member' },
            ],
        };
        f.platform.data.useActiveUsers(() => people.list);
        expect((await demoted.api('/data/datasets')).status).toBe(401);
        people.list = [{ id: 'alice', name: 'Alice', role: 'admin' }, people.list[1]!];
        expect((await demoted.api('/data/datasets')).status).toBe(401);
        expect(
            f.workspace.db.prepare('SELECT revokedBy FROM data_api_tokens WHERE id=?').get(demoted.apiToken.id),
        ).toEqual({ revokedBy: 'system' });
        // Deactivated, out of the people who may sign in: refused.
        const second = await make({ scopes: ['data:read'], name: 'Second' });
        people.list = [people.list[1]!];
        expect((await second.api('/data/datasets')).status).toBe(401);
        expect(
            lines()
                .filter((line) => line.action === 'revoke')
                .map((line) => line.actor),
        ).toEqual(['system', 'system']);
    });

    it('stays dead after its maker is deactivated and reactivated without it being used', async () => {
        const { f, make, lines } = await setup();
        // The server's deactivation revokes them at once (accounts.ts).
        const dormant = await make({ scopes: ['data:read'] });
        expect(f.platform.data.revokeApiTokensMadeBy('alice', 'bob')).toEqual(['Notion import']);
        expect((await dormant.api('/data/datasets')).status).toBe(401);
        expect(lines().at(-1)).toMatchObject({ actor: 'bob', action: 'revoke' });
        // The auth CLI's deactivation has no data space: its audit line ends the token on its next use.
        const viaCli = await make({ scopes: ['data:read'], name: 'Second' });
        f.workspace.audit({
            actor: 'cli',
            action: 'deactivate',
            targetKind: 'user',
            targetId: 'alice',
            detail: 'Alice',
        });
        f.workspace.audit({
            actor: 'cli',
            action: 'reactivate',
            targetKind: 'user',
            targetId: 'alice',
            detail: 'Alice',
        });
        expect((await viaCli.api('/data/datasets')).status).toBe(401);
        // A token made after the reactivation works. Deactivation counts lines at or after a token's
        // millisecond, so let the clock pass the audit's millisecond first (a same-instant token is revoked).
        const audited = Date.now();
        while (Date.now() <= audited) {
            await new Promise((resolve) => setTimeout(resolve, 1));
        }
        const fresh = await make({ scopes: ['data:read'], name: 'Third' });
        expect((await fresh.api('/data/datasets')).status).toBe(200);
    });

    it('reaches the data API only, never another route a data token reaches', async () => {
        const { make } = await setup();
        const { api } = await make({ scopes: ALL });
        for (const path of ['/workload/secrets', '/apps/actor/continuations', '/issues', '/data/job']) {
            expect((await api(path)).status, path).toBeGreaterThanOrEqual(401);
            expect((await api(path)).status, path).toBeLessThan(500);
        }
        // Not the token routes either: a token never makes or revokes one.
        expect((await api('/data/api-tokens')).status).toBe(403);
        expect((await api('/data/api-tokens', 'POST', { name: 'x', scopes: ['data:read'] })).status).toBe(403);
    });
});

describe('scopes on every data route', () => {
    it('maps every data operation to a scope, or to none for deletes and files', () => {
        expect(
            Object.entries(API_SCOPE_OF)
                .filter(([, scope]) => scope === null)
                .map(([op]) => op),
        ).toEqual(['deleteRows', 'dropTable', 'deleteDataset', 'files.read', 'files.write', 'files.delete']);
    });

    it('lets each scope do its routes and nothing more', async () => {
        const { make } = await setup();
        const admin = (await make({ scopes: ALL, name: 'All' })).api;
        const id = await companyDataset(admin);
        const read = (await make({ scopes: ['data:read'], name: 'Read' })).api;
        const write = (await make({ scopes: ['data:write'], name: 'Write' })).api;
        const schema = (await make({ scopes: ['data:admin'], name: 'Admin' })).api;
        const field = {
            schema: 1,
            baseVersion: 0,
            kind: 'select',
            settings: { options: [{ id: 'a', label: 'A', color: 'green' }] },
        };
        // [method, path, body, the scope it needs]
        const routes: Array<[string, string, unknown, string]> = [
            ['GET', '/data/usage', undefined, 'data:read'],
            ['GET', '/data/datasets', undefined, 'data:read'],
            ['GET', `/data/datasets/${id}`, undefined, 'data:read'],
            ['POST', `/data/datasets/${id}/query`, { sql: 'SELECT count(*) FROM pages' }, 'data:read'],
            ['POST', `/data/datasets/${id}/read-batch`, { statements: [{ sql: 'SELECT 1' }] }, 'data:read'],

            ['POST', `/data/datasets/${id}/tables/pages/rows`, { rows: [{ id: 'w', title: 'W' }] }, 'data:write'],
            [
                'POST',
                `/data/datasets/${id}/batch`,
                { statements: [{ sql: "UPDATE pages SET title='B' WHERE id='p1'" }] },
                'data:write',
            ],
            ['POST', `/data/datasets/${id}/analyze`, undefined, 'data:write'],
            ['POST', '/data/datasets', { name: 'Another' }, 'data:admin'],
            ['PATCH', `/data/datasets/${id}`, { description: 'From Notion' }, 'data:admin'],
            ['POST', `/data/datasets/${id}/tables`, { ...TABLE, table: 'more' }, 'data:admin'],
            [
                'POST',
                `/data/datasets/${id}/tables/pages/columns`,
                { column: { name: 'owner', type: 'TEXT' } },
                'data:admin',
            ],
            ['PUT', `/data/datasets/${id}/tables/pages/fields/status`, field, 'data:admin'],
            [
                'POST',
                `/data/datasets/${id}/tables/pages/indexes`,
                { name: 'by_title', columns: ['title'] },
                'data:admin',
            ],
        ];
        // Field settings: read with data:read or data:admin, never data:write alone.
        for (const [scope, api, status] of [
            ['data:read', read, 200],
            ['data:admin', schema, 200],
            ['data:write', write, 403],
        ] as const) {
            expect((await api(`/data/datasets/${id}/tables/pages/fields`)).status, scope).toBe(status);
        }
        for (const [method, path, body, needs] of routes) {
            for (const [scope, api] of [
                ['data:read', read],
                ['data:write', write],
                ['data:admin', schema],
            ] as const) {
                const answer = await api(path, method, body ?? (method === 'POST' ? {} : undefined));
                if (scope === needs) {
                    expect(answer.status, `${scope} ${method} ${path}: ${JSON.stringify(answer.body)}`).toBeLessThan(
                        300,
                    );
                } else {
                    expect(answer.status, `${scope} ${method} ${path}`).toBe(403);
                    expect(String(answer.body.error), path).toContain(needs);
                }
            }
        }
    });

    it('never reaches the user-only routes, deletes, exports, grants or files, whatever its scopes', async () => {
        const { make } = await setup();
        const { api } = await make({ scopes: ALL });
        const id = await companyDataset(api);
        const routes: Array<[string, string, unknown?]> = [
            ['GET', '/data'],
            ['GET', '/data/shared'],
            ['GET', '/data/private-items'],
            ['DELETE', `/data/datasets/${id}`],
            ['GET', `/data/datasets/${id}/export.csv?table=pages`],
            ['GET', `/data/datasets/${id}/export.sqlite`],
            ['GET', `/data/datasets/${id}/tables/pages/rows`],
            ['GET', `/data/datasets/${id}/tables/pages/changes?since=0.0`],
            ['PUT', `/data/datasets/${id}/tables/pages/retention`, { days: 3 }],
            ['POST', `/data/datasets/${id}/compact`, {}],
            ['PATCH', `/data/datasets/${id}/tables/pages`, { history: false }],
            ['GET', '/data/grants'],
            ['PUT', '/data/grants', { dotId: 'x', datasetId: id, access: 'read' }],
            ['GET', '/data/audit'],
            ['GET', '/data/plugins/datasync/budget'],
            ['GET', '/data/files'],
            ['PUT', '/data/files', { path: 'a.txt', content: 'a' }],
            ['DELETE', '/data/files?path=a.txt'],
            ['POST', '/data/views/query', {}],
            ['POST', '/data/specs/run', {}],
        ];
        for (const [method, path, body] of routes) {
            expect((await api(path, method, body)).status, `${method} ${path}`).toBe(403);
        }
    });
});

describe('ownership', () => {
    it('reaches company datasets only: never a person’s, a socio’s or a plugin’s', async () => {
        const { f, alice, bob, make } = await setup();
        const { api } = await make({ scopes: ALL });
        const company = await companyDataset(api);
        // A person's dataset, the admin's own included.
        const own = String((await alice('/data/datasets', 'POST', { name: 'Mine' })).body.id);
        const bobs = String((await bob('/data/datasets', 'POST', { name: 'Bob’s' })).body.id);
        // A socio's scratch and a company socio's shared area.
        const dot = f.workspace.dots()[0]!;
        const scratch = f.platform.data.scratch('alice', dot.id)!.id;
        const shared = f.platform.data.scratch(`socio:${dot.id}`, dot.id)!.id;
        // A plugin's bound workspace dataset.
        const plugin = await f.datasync();
        const bound = plugin.datasets[0]!.id;
        const listed = (await api('/data/datasets')).body as unknown as Array<{ id: string }>;
        expect(listed.map((item) => item.id)).toEqual([company]);
        for (const id of [own, bobs, scratch, shared, bound, 'scratch']) {
            for (const [method, path, body] of [
                ['GET', `/data/datasets/${id}`, undefined],
                ['POST', `/data/datasets/${id}/query`, { sql: 'SELECT 1' }],
                ['POST', `/data/datasets/${id}/tables`, TABLE],
                ['POST', `/data/datasets/${id}/tables/pages/rows`, { rows: [{ id: 'x' }] }],
                ['POST', `/data/datasets/${id}/batch`, { statements: [{ sql: 'DELETE FROM pages' }] }],
                ['PATCH', `/data/datasets/${id}`, { name: 'Taken' }],
                ['GET', `/data/datasets/${id}/tables/pages/fields`, undefined],
                ['PUT', `/data/datasets/${id}/tables/pages/fields/title`, { schema: 1, baseVersion: 0, kind: 'text' }],
            ] as const) {
                expect((await api(path, method, body)).status, `${method} ${path}`).toBe(404);
            }
        }
        expect((await api(`/data/datasets/${company}`)).status).toBe(200);
        expect(f.workspace.db.prepare('SELECT ownerUserId FROM data_datasets WHERE id=?').get(bound)).toEqual({
            ownerUserId: WORKSPACE_OWNER_ID,
        });
    });

    it('loses a company dataset at once when a plugin is bound to it', async () => {
        const { f, make } = await setup();
        const { api } = await make({ scopes: ALL });
        const company = await companyDataset(api);
        expect((await api(`/data/datasets/${company}`)).status).toBe(200);
        await f.platform.plugins.install('reports', {}, { bindings: { reports: { datasetId: company } } });
        expect(
            f.workspace.db
                .prepare('SELECT count(*) AS n FROM data_plugin_bindings WHERE datasetId=? AND unboundAt IS NULL')
                .get(company),
        ).toEqual({ n: 1 });
        expect(((await api('/data/datasets')).body as unknown as unknown[]).length).toBe(0);
        expect((await api(`/data/datasets/${company}`)).status).toBe(404);
        expect((await api(`/data/datasets/${company}/query`, 'POST', { sql: 'SELECT 1' })).status).toBe(404);
        expect((await api(`/data/datasets/${company}/tables/pages/rows`, 'POST', { rows: [{ id: 'x' }] })).status).toBe(
            404,
        );
        expect((await api(`/data/datasets/${company}`, 'PATCH', { name: 'Taken' })).status).toBe(404);
    });

    it('ends the tokens of makers an admin-list change demoted, even unused', async () => {
        const { f, make, lines } = await setup();
        const dormant = await make({ scopes: ['data:read'] });
        const people: { list: User[] } = { list: [{ id: 'alice', name: 'Alice', role: 'member' }] };
        f.platform.data.useActiveUsers(() => people.list);
        // The access policy's save (or the boot) sweeps, before the token is used again.
        expect(f.platform.data.revokeApiTokensOfFormerAdmins()).toEqual(['Notion import']);
        people.list = [{ id: 'alice', name: 'Alice', role: 'admin' }];
        expect((await dormant.api('/data/datasets')).status).toBe(401);
        expect(lines().at(-1)).toMatchObject({ actor: 'system', action: 'revoke' });
    });

    it('makes company datasets, in a Space its maker edits, and writes as the token for its maker', async () => {
        const { f, alice, make } = await setup();
        const { api, apiToken } = await make({ scopes: ALL });
        const space = f.workspace.spaces()[0]!;
        const made = await api('/data/datasets', 'POST', { name: 'Wiki', sharedSpaceId: space.id });
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        const id = String(made.body.id);
        expect(
            f.workspace.db.prepare('SELECT ownerUserId, sharedSpaceId FROM data_datasets WHERE id=?').get(id),
        ).toEqual({ ownerUserId: WORKSPACE_OWNER_ID, sharedSpaceId: space.id });
        expect((await api('/data/datasets', 'POST', { name: 'Lost', sharedSpaceId: 'no-such-space' })).status).toBe(
            404,
        );
        expect((await api('/data/datasets', 'POST', { name: 'Lost', spaceParentId: 'page' })).status).toBe(400);
        // A Space-shared company dataset needs no person's approval for the token's writes.
        expect((await api(`/data/datasets/${id}/tables`, 'POST', TABLE)).status).toBe(200);
        expect((await api(`/data/datasets/${id}/tables/pages/rows`, 'POST', { rows: [{ id: 'p1' }] })).status).toBe(
            200,
        );
        const placed = await api(`/data/datasets/${id}`, 'PATCH', { spacePosition: 'a0' });
        expect(placed.status, JSON.stringify(placed.body)).toBe(200);
        const field = await api(`/data/datasets/${id}/tables/pages/fields/status`, 'PUT', {
            schema: 1,
            baseVersion: 0,
            kind: 'select',
            settings: { options: [{ id: 'todo', label: 'To do', color: 'green' }] },
        });
        expect(field.status, JSON.stringify(field.body)).toBe(200);
        const writer = `token:${apiToken.id}`;
        expect(f.workspace.db.prepare('SELECT updatedBy FROM data_field_settings WHERE datasetId=?').get(id)).toEqual({
            updatedBy: writer,
        });
        const audit = f.workspace.db
            .prepare(
                'SELECT actorKind, actorId, byUserId, action, dotId FROM data_audit WHERE datasetId=? ORDER BY rowid',
            )
            .all(id);
        expect(audit.length).toBeGreaterThan(3);
        for (const line of audit) {
            expect(line).toMatchObject({ actorKind: 'token', actorId: writer, byUserId: 'alice', dotId: null });
        }
        // The admin sees it, with the token's lines, in the app.
        expect((await alice(`/data/datasets/${id}`)).status).toBe(200);
        const seen = (await alice(`/data/audit?dataset=${id}`)).body as unknown as Array<{ actorId: string }>;
        expect(seen.some((line) => line.actorId === writer)).toBe(true);
        // Row history names the token.
        await api(`/data/datasets/${id}/tables/pages/rows`, 'POST', {
            rows: [{ id: 'p1', title: 'Two' }],
            key: ['id'],
        });
        const history = f.platform.data.withHistoryRows(id, 'pages') as unknown as Array<Record<string, unknown>>;
        expect(JSON.stringify(history)).toContain(writer);
        // DELETE in a batch, on a company dataset it writes; the answer is under `result`.
        const deleted = await api(`/data/datasets/${id}/batch`, 'POST', {
            statements: [{ sql: "DELETE FROM pages WHERE id = 'p1'" }],
        });
        expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
        expect(deleted.body).toMatchObject({ status: 'done', result: { totalChanges: 1 } });
    });

    it('counts against no person’s quota, caps the workspace’s own datasets, and backs them up', async () => {
        const { f, make } = await setup({ maxDatasets: 2 });
        const { api } = await make({ scopes: ALL });
        const before = f.platform.data.usage('alice');
        const id = await companyDataset(api, 'One');
        expect(f.platform.data.usage('alice')).toEqual(before);
        expect(f.platform.data.usage(WORKSPACE_OWNER_ID).datasets).toBe(1);
        expect((await api('/data/datasets', 'POST', { name: 'Two' })).status).toBe(201);
        expect((await api('/data/datasets', 'POST', { name: 'Three' })).status).toBe(413);
        // In the backup like every dataset file.
        const row = f.platform.data.withDeletedDataset(id)!;
        const path = f.platform.data.datasetPath(row);
        expect(existsSync(path)).toBe(true);
        const backups = mkdtempSync(join(tmpdir(), 'socio-api-token-backup-'));
        cleanup.push(() => rmSync(backups, { recursive: true, force: true }));
        const copy = await backupUserData(f.platform.data.dir, backups, 2, new Date(), { prune: false });
        expect(existsSync(join(copy.path, relative(f.platform.data.dir, path)))).toBe(true);
    });
});

describe('budget and use', () => {
    it('has its own per-minute budget', async () => {
        const { make } = await setup();
        const slow = await make({ scopes: ['data:read'], statementsPerMinute: 3 });
        const other = await make({ scopes: ['data:read'], name: 'Other' });
        for (let i = 0; i < 3; i++) {
            expect((await slow.api('/data/datasets')).status).toBe(200);
        }
        const over = await slow.api('/data/datasets');
        expect(over.status).toBe(429);
        expect(String(over.body.error)).toContain('this data API token may make 3 a minute');
        // Every route counts, the usage read too.
        const usage = await make({ scopes: ['data:read'], name: 'Usage', statementsPerMinute: 1 });
        expect((await usage.api('/data/usage')).status).toBe(200);
        expect((await usage.api('/data/usage')).status).toBe(429);
        // Another token's budget is its own.
        expect((await other.api('/data/datasets')).status).toBe(200);
    });

    it('sums up its use in the workspace audit at most every 15 minutes, and counts it on its row', async () => {
        const { f, make, lines } = await setup();
        const made = await make({ scopes: ['data:read'] });
        for (let i = 0; i < 3; i++) {
            await made.api('/data/datasets');
        }
        await made.api('/data/files');
        expect(lines().filter((line) => line.action === 'use')).toHaveLength(1);
        const tokens = f.platform.data.apiTokens;
        tokens.flush();
        const uses = lines().filter((line) => line.action === 'use');
        expect(uses).toHaveLength(2);
        expect(uses[1]!.detail).toContain('3 request(s)');
        expect(uses[1]!.detail).toContain('1 refused');
        tokens.used(made.apiToken.id, { write: true, status: 200 }, Date.now() + DATA_API_USE_SUMMARY_MS + 1);
        expect(lines().filter((line) => line.action === 'use')).toHaveLength(3);
        expect(f.workspace.db.prepare('SELECT uses FROM data_api_tokens WHERE id=?').get(made.apiToken.id)).toEqual({
            uses: 5,
        });
    });
});
