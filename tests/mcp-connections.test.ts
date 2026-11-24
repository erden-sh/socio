import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it } from 'vitest';

import { SecretBox } from '@socio/foundation/keys/secret-box';

import { McpConnections } from '../src/server/mcp/connections.js';
import { McpConnectionRepository } from '../src/server/mcp/infra/sqlite/repository.js';

import { testDatabase } from './helpers/test-database.js';

const opened: DatabaseSync[] = [];
afterEach(() => {
    for (const db of opened.splice(0)) {
        db.close();
    }
});
function setup() {
    const db = testDatabase();
    opened.push(db);
    db.exec("CREATE TABLE original(id TEXT PRIMARY KEY,value TEXT);INSERT INTO original VALUES('old','Preserve');");
    const repository = new McpConnectionRepository(db);
    const active = new Set(['alice', 'bob']);
    const keys = { legacy: 'test-session', current: randomBytes(32) };
    const service = new McpConnections(repository, keys, {
        active: (id) => active.has(id),
        socio: () => true,
    });
    return { db, repository, service, active, keys };
}
const input = { name: 'My custom server', url: 'https://mcp.example.test/mcp' };
it('creates owner-only views without secrets and preserves old data while migrating', async () => {
    const f = setup();
    const row = await f.service.create('alice', input);
    expect(row).toMatchObject({
        generation: 1,
        authentication: 'oauth',
        state: 'draft',
    });
    expect(f.db.prepare('SELECT value FROM original').get()?.value).toBe('Preserve');
    expect(f.service.list('bob')).toEqual([]);
    expect(() => f.service.get('bob', row.id)).toThrow('not found');
    await f.service.saveCredentials('alice', row.id, 1, {
        access_token: 'fixture-secret',
    });
    const stored = f.repository.owned('alice', row.id)!;
    expect(stored.secret).not.toContain('fixture-secret');
    expect(JSON.stringify(f.service.list('alice'))).not.toMatch(/fixture-secret|secret|userId/);
    expect(f.service.credentials('alice', row.id, 1)).toEqual({
        access_token: 'fixture-secret',
    });
});
it('enforces per-owner capacity atomically under parallel creates', async () => {
    const f = setup();
    const attempts = await Promise.allSettled(Array.from({ length: 21 }, () => f.service.create('alice', input)));
    expect(attempts.filter((x) => x.status === 'fulfilled')).toHaveLength(20);
    expect(f.service.list('alice')).toHaveLength(20);
    expect(f.service.list('bob')).toEqual([]);
});
it('fences revoked credentials and aborts in-flight work without granting other users access', async () => {
    const f = setup(),
        row = await f.service.create('alice', input);
    await f.service.saveCredentials('alice', row.id, 1, { token: 'old' });
    await f.repository.saveGrant(
        'alice',
        row.id,
        {
            dotId: 'd',
            tools: ['tool'],
            catalogRevision: 'review',
            revision: 'grant',
        },
        1,
    );
    const scoped = f.service.scoped('alice', row.id, 1);
    await f.service.disconnect('alice', row.id);
    expect(scoped.signal.aborted).toBe(true);
    scoped.release();
    expect(f.repository.grants('alice', row.id)).toEqual([]);
    expect(f.repository.owned('alice', row.id)?.secret).toBeNull();
    await expect(f.service.saveCredentials('alice', row.id, 1, { token: 'late' })).rejects.toThrow('changed');
    expect(() => f.service.credentials('alice', row.id, 1)).toThrow('changed');
    await expect(f.service.disconnect('bob', row.id)).rejects.toThrow('not found');
});
it('binds seals to exact owner/connection/generation and rotates without changing provenance', async () => {
    const f = setup(),
        a = await f.service.create('alice', input),
        b = await f.service.create('bob', input);
    await f.service.saveCredentials('alice', a.id, 1, { token: 'secret' });
    const sealed = f.repository.owned('alice', a.id)!.secret!;
    await f.repository.replaceSecret('bob', b.id, 1, null, sealed);
    expect(() => f.service.credentials('bob', b.id, 1)).toThrow('identity mismatch');
    const next = {
        legacy: 'test-session',
        previous: f.keys.current,
        current: randomBytes(32),
    };
    const rotated = new McpConnections(f.repository, next, {
        active: () => true,
        socio: () => true,
    });
    expect(await rotated.reseal()).toEqual({ resealed: 1, unreadable: 1 });
    const newSeal = f.repository.owned('alice', a.id)!.secret!;
    expect(new SecretBox(next, 'mcp-credentials').valueKey(newSeal)).toBe(
        new SecretBox(next, 'mcp-credentials').currentKey,
    );
    expect(rotated.credentials('alice', a.id, 1)).toEqual({ token: 'secret' });
    expect(() => rotated.credentials('bob', b.id, 1)).toThrow('identity mismatch');
});
it('rechecks account state inside the writer queue', async () => {
    const f = setup(),
        a = await f.service.create('alice', input);
    f.active.delete('alice');
    await expect(f.service.saveCredentials('alice', a.id, 1, { token: 'late' })).rejects.toThrow('active account');
    expect(f.repository.owned('alice', a.id)?.secret).toBeNull();
});
it('claims actor/cookie-bound unexpired OAuth state once and preserves ambiguity through restart', async () => {
    const f = setup();
    await f.repository.createOAuth({
        stateHash: 'state',
        connectionId: 'c',
        userId: 'alice',
        generation: 1,
        cookieHash: 'cookie',
        secret: 'sealed',
        state: 'pending',
        expiresAt: 100,
        createdAt: 1,
    });
    expect(f.repository.oauth('bob', 'state')).toBeUndefined();
    expect(await f.repository.claimOAuth('bob', 'state', 'cookie', 2)).toBeUndefined();
    expect(await f.repository.claimOAuth('alice', 'state', 'other', 2)).toBeUndefined();
    const claims = await Promise.all([
        f.repository.claimOAuth('alice', 'state', 'cookie', 2),
        f.repository.claimOAuth('alice', 'state', 'cookie', 2),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(f.repository.oauth('alice', 'state')?.state).toBe('exchanging');
    expect(await f.repository.claimOAuth('alice', 'state', 'cookie', 3)).toBeUndefined();
    await f.repository.endOAuth('alice', 'state');
    expect(f.repository.oauth('alice', 'state')?.secret).toBe('');
});
it('never reclaims an external call with an uncertain outcome after restart', async () => {
    const f = setup();
    await f.repository.createCall({
        id: 'call',
        approvalId: 'approval',
        userId: 'alice',
        dotId: 'd',
        connectionId: 'c',
        generation: 1,
        catalogRevision: 'r',
        tool: 'external',
        toolFingerprint: 'f',
        grantRevision: 'g',
        argumentsHash: 'h',
        state: 'planned',
        result: null,
        createdAt: 1,
        updatedAt: 1,
    });
    expect(await f.repository.claimCall('bob', 'call', 2)).toBe(false);
    const claims = await Promise.all([
        f.repository.claimCall('alice', 'call', 2),
        f.repository.claimCall('alice', 'call', 2),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await f.repository.recoverCalls(3);
    expect(f.repository.call('alice', 'call')?.state).toBe('unknown');
    expect(await f.repository.claimCall('alice', 'call', 4)).toBe(false);
});

it('bounds active external operations per owner and keeps cancellation separate from releasing capacity', async () => {
    const f = setup(),
        row = await f.service.create('alice', input),
        scopes = Array.from({ length: 4 }, () => f.service.scoped('alice', row.id, 1));
    expect(() => f.service.scoped('alice', row.id, 1)).toThrow('Too many');
    f.service.abort('alice', row.id);
    expect(scopes.every((s) => s.signal.aborted)).toBe(true);
    expect(() => f.service.scoped('alice', row.id, 1)).toThrow('Too many');
    scopes[0]!.release();
    scopes[0]!.release();
    const next = f.service.scoped('alice', row.id, 1);
    next.release();
    for (const scope of scopes) {
        scope.release();
    }
});
it('rotates pending PKCE secrets and clears all personal credentials and grants on account deactivation', async () => {
    const f = setup(),
        row = await f.service.create('alice', input);
    const legacy = new McpConnections(
        f.repository,
        { legacy: f.keys.legacy },
        { active: () => true, socio: () => true },
    );
    await f.repository.createOAuth({
        stateHash: 'state',
        connectionId: row.id,
        userId: 'alice',
        generation: 1,
        cookieHash: 'cookie',
        secret: legacy.encrypt('alice', row.id, 1, {
            codeVerifier: 'never exposed',
        }),
        state: 'pending',
        expiresAt: Date.now() + 10000,
        createdAt: Date.now(),
    });
    expect(f.service.sealStates().legacy).toBe(1);
    expect(await f.service.reseal()).toEqual({ resealed: 1, unreadable: 0 });
    expect(f.service.sealStates().current).toBe(1);
    expect(f.service.decrypt('alice', row.id, 1, f.repository.oauth('alice', 'state')!.secret)).toEqual({
        codeVerifier: 'never exposed',
    });
    await f.service.saveCredentials('alice', row.id, 1, { tokens: 'sealed' });
    const scoped = f.service.scoped('alice', row.id, 1);
    f.active.delete('alice');
    await f.service.forgetUser('alice');
    expect(scoped.signal.aborted).toBe(true);
    expect(f.repository.oauth('alice', 'state')).toBeUndefined();
    expect(f.repository.owned('alice', row.id)).toMatchObject({
        generation: 2,
        state: 'disconnected',
        secret: null,
        catalog: '[]',
    });
    scoped.release();
});
