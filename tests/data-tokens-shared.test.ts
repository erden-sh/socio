import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { migrate } from '@socio/data/migrate';
import { openDatabase, sqliteData } from '@socio/data/open';
import { RuntimeSession } from '@socio/data/runtime-ownership';

import { SqliteLaunchCodes } from '../src/server/apps/infra/launch-codes.js';
import { appsSchema } from '../src/server/apps/migrations.js';
import { DataTokens } from '../src/server/dataspace/tokens.js';

import { testDatabaseFile } from './helpers/test-database.js';

/*
 * Two runtimes on one database (CB-108 blue/green): a data token or a
 * launch code made on one is accepted on the other.
 */

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) {
        await close();
    }
    vi.restoreAllMocks();
});

function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'data-tokens-shared-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = testDatabaseFile(join(dir, 'app.sqlite'));
    let now = 1000;
    // Tokens expire on the wall clock, runtimes on their own: one fake time.
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const a = openDatabase(path),
        b = openDatabase(path);
    cleanup.push(() => {
        if (a.isOpen) {
            a.close();
        }
        if (b.isOpen) {
            b.close();
        }
    });
    const ar = new RuntimeSession({
            heartbeat: false,
            leaseMs: 100,
            now: () => now,
        }),
        br = new RuntimeSession({ heartbeat: false, leaseMs: 100, now: () => now });
    const ao = ar.attach(a),
        bo = br.attach(b);
    cleanup.push(() => {
        if (a.isOpen) {
            ar.detachSync(a);
        }
        if (b.isOpen) {
            br.detachSync(b);
        }
    });
    return {
        a,
        b,
        ar,
        ao,
        bo,
        onA: new DataTokens(60_000, { ownership: ao }),
        onB: new DataTokens(60_000, { ownership: bo }),
        advance: (ms: number) => {
            now += ms;
        },
    };
}

const scope = {
    userId: 'u1',
    dotId: 'dot-1',
    purpose: 'job' as const,
    session: 'run:1',
};

it('accepts a token on every runtime while its issuer lives', () => {
    const f = fixture();
    const token = f.onA.issue(scope);
    expect(f.onA.resolve(token)).toMatchObject(scope);
    expect(f.onB.resolve(token)).toMatchObject({ ...scope, expiresAt: 61_000 });
    expect(f.onB.resolve(`${token}x`)).toBeUndefined();
    expect(f.onA.count()).toBe(1);
    expect(f.onB.count()).toBe(1);
    // The issuer renews its lease meanwhile (its heartbeat).
    f.advance(50);
    void f.ao.heartbeat();
    f.advance(50);
    expect(f.onB.resolve(token)).toBeDefined();
});

it('keeps only the hash, never the token', () => {
    const f = fixture();
    const token = f.onA.issue({ ...scope, datasetIds: ['scratch'] });
    const { token: command } = f.onA.forCommand('u1', 'dot-1', 5000, 'person');
    const rows = f.b.prepare('SELECT * FROM runtime_data_tokens').all();
    expect(rows).toHaveLength(2);
    const dump = JSON.stringify(rows);
    for (const raw of [token, command]) {
        expect(dump).not.toContain(raw);
        expect(dump).not.toContain(raw.slice(5));
    }
    expect(rows.map((row) => row.issuer)).toEqual([f.ao.session.id, f.ao.session.id]);
});

it('revokes on every runtime: one token, a session, a socio', () => {
    const f = fixture();
    const one = f.onA.issue(scope);
    const run = f.onA.issue({ ...scope, session: 'run:2' });
    const app = f.onA.issue({ ...scope, purpose: 'app', session: 'app:x' });
    const other = f.onA.issue({ ...scope, dotId: 'dot-2', session: 'run:3' });
    f.onB.revoke(one);
    expect(f.onA.resolve(one)).toBeUndefined();
    f.onB.revokeSession('run:2');
    expect(f.onA.resolve(run)).toBeUndefined();
    expect(f.onA.resolve(app)).toBeDefined();
    // Only some purposes, as when a computer stops.
    f.onB.revokeDot('dot-1', ['computer', 'job']);
    expect(f.onA.resolve(app)).toBeDefined();
    f.onB.revokeDot('dot-1');
    expect(f.onA.resolve(app)).toBeUndefined();
    expect(f.onA.resolve(other)).toBeDefined();
    expect(f.onA.count()).toBe(1);
});

it('ends tokens at expiry', () => {
    const f = fixture();
    const short = f.onA.issue(scope, 30);
    const long = f.onA.issue(scope, 60);
    f.advance(30);
    expect(f.onB.resolve(short)).toBeUndefined();
    expect(f.onA.resolve(short)).toBeUndefined();
    expect(f.onB.resolve(long)).toBeDefined();
    expect(f.onB.count()).toBe(1);
});

it('ends a released issuer’s tokens everywhere', () => {
    const f = fixture();
    const token = f.onA.issue(scope);
    const { token: command } = f.onA.forCommand('u1', 'dot-1', 5000, 'person');
    expect(f.onA.commandTokens('dot-1')).toEqual([command]);
    f.ar.detachSync(f.a);
    expect(f.onB.resolve(token)).toBeUndefined();
    expect(f.onB.resolve(command)).toBeUndefined();
    expect(f.onB.count()).toBe(0);
    // The new runtime's own tokens are unaffected.
    expect(f.onB.resolve(f.onB.issue(scope))).toBeDefined();
});

it('ends tokens when the issuer’s lease lapses', () => {
    const f = fixture();
    const token = f.onA.issue(scope);
    void f.bo.heartbeat();
    f.advance(60);
    void f.bo.heartbeat();
    f.advance(41);
    // A missed its heartbeats; B renewed.
    expect(f.onB.resolve(token)).toBeUndefined();
    expect(f.onA.resolve(token)).toBeUndefined();
    expect(f.onB.resolve(f.onB.issue(scope))).toBeDefined();
});

it('queues an issue behind an open unit of work, and a revocation drops it', async () => {
    const f = fixture();
    let token = '';
    let revoked = '';
    let inside: unknown;
    let queued: unknown;
    await Promise.all([
        sqliteData(f.a).uow.run(
            async () => {
                await Promise.resolve();
                await Promise.resolve();
            },
            { label: 'another unit' },
        ),
        (async () => {
            await Promise.resolve();
            // A unit of work holds the connection: the row waits for it.
            token = f.onA.issue(scope);
            revoked = f.onA.issue({ ...scope, session: 'run:9' });
            inside = f.onA.resolve(token);
            queued = f.a.prepare('SELECT COUNT(*) AS n FROM runtime_data_tokens').get()?.n;
            f.onA.revokeSession('run:9');
        })(),
    ]);
    expect(queued).toBe(0);
    expect(inside).toBeDefined();
    expect(f.onB.resolve(token)).toBeDefined();
    expect(f.onB.resolve(revoked)).toBeUndefined();
    expect(f.b.prepare('SELECT COUNT(*) AS n FROM runtime_data_tokens').get()?.n).toBe(1);
});

it('redeems a launch code made on one runtime once, on another', () => {
    // The repository on two connections, as AppsService.launch and redeem
    // use it; tests/apps.test.ts covers the routes on one.
    const f = fixture();
    migrate(f.a, [appsSchema]);
    migrate(f.b, [appsSchema]);
    const main = new SqliteLaunchCodes(f.a),
        app = new SqliteLaunchCodes(f.b);
    const code = { appId: 'board', userId: 'u1', next: '/', expiresAt: 61_000 };
    main.add('h1', code, 1000);
    main.add('h2', { ...code, userId: 'u2' }, 1000);
    main.add('h3', { ...code, appId: 'other' }, 1000);
    expect(app.take('h1')).toEqual(code);
    expect(app.take('h1')).toBeUndefined();
    expect(main.take('h1')).toBeUndefined();
    // Ended on one runtime, gone on the other.
    main.forgetUser('u2');
    expect(app.take('h2')).toBeUndefined();
    main.forgetApp('other');
    expect(app.take('h3')).toBeUndefined();
    // Expired codes go when a new one is made.
    main.add('old', { ...code, expiresAt: 1500 }, 1000);
    app.add('new', code, 2000);
    expect(f.a.prepare('SELECT hash FROM app_launch_codes ORDER BY hash').all()).toEqual([{ hash: 'new' }]);
});
