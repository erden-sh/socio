import { DatabaseSync } from 'node:sqlite';

import { getTableName } from 'drizzle-orm';
import { afterEach, expect, it, vi } from 'vitest';

import { schemaDrift } from '@socio/data/drift';
import { migrate } from '@socio/data/migrate';
import { sqliteData } from '@socio/data/open';

import { domainsRepositories } from '../src/server/composition/domains.js';
import { computerStoreOn, telegramLinksOn, webStoreOn } from '../src/server/composition/integration-stores.js';
import { DomainsStore } from '../src/server/domains/store.js';
import { sqliteIntegrationRepositories } from '../src/server/integrations/infra/sqlite/index.js';
import { integrationTables } from '../src/server/integrations/infra/sqlite/schema.js';
import { computersSchema, domainsSchema, telegramSchema, webSchema } from '../src/server/integrations/migrations.js';
import { LINK_CODE_TTL_MS } from '../src/server/telegram/telegram-links.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

/*
 * The Integrations repository contract (CB-110): what any implementation
 * of `integrations/contract.ts` must keep, run against the
 * SQLite one, the services over it (Telegram link codes, web identity,
 * computer permissions, domain operations), and the drift check of its
 * Drizzle mirror.
 */

const cleanup: Array<() => void> = [];
afterEach(() => {
    vi.restoreAllMocks();
    cleanup
        .splice(0)
        .reverse()
        .forEach((fn) => fn());
});

const SETS = [telegramSchema, webSchema, computersSchema, domainsSchema];

function context() {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, SETS);
    const data = sqliteData(db);
    return { db, uow: data.uow, repos: sqliteIntegrationRepositories(data) };
}

const count = (db: DatabaseSync, table: string) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);

it('mirrors the migrated Integrations tables exactly, and only those', () => {
    const { db } = context();
    expect(schemaDrift(db, integrationTables)).toEqual([]);
    const created = db
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name",
        )
        .all()
        .map((row) => String(row.name));
    expect(created).toHaveLength(13);
    expect(integrationTables.map((table) => getTableName(table)).sort()).toEqual(created);
    // As the workspace migrates them, with every other set.
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    expect(schemaDrift(workspace.db, integrationTables)).toEqual([]);
});

it('reports a column the mirror does not know', () => {
    const { db } = context();
    db.exec('ALTER TABLE web_audit ADD COLUMN agent TEXT');
    expect(schemaDrift(db, integrationTables)).toEqual([expect.stringContaining('agent')]);
});

it('keeps one link code per person, used once, and one link per account and person', async () => {
    const { db, repos } = context();
    await repos.telegramLinks.issueCode('old', 'alice', 100, 0);
    await repos.telegramLinks.issueCode('stale', 'bob', 50, 0);
    // Alice's new code replaces her old one; codes expired by then go too.
    await repos.telegramLinks.issueCode('new', 'alice', 200, 60);
    expect(await repos.telegramLinks.code('old')).toBeUndefined();
    expect(await repos.telegramLinks.code('stale')).toBeUndefined();
    expect(await repos.telegramLinks.code('new')).toEqual({
        userId: 'alice',
        expiresAt: 200,
        usedAt: null,
    });
    expect(await repos.telegramLinks.claimCode('new', 150)).toBe(true);
    expect(await repos.telegramLinks.claimCode('new', 160)).toBe(false);
    expect((await repos.telegramLinks.code('new'))?.usedAt).toBe(150);

    await repos.telegramLinks.link('42', 'alice', 'al', 10);
    await repos.telegramLinks.link('43', 'bob', null, 11);
    // Alice links another account: her first link goes, Bob's stays.
    await repos.telegramLinks.link('44', 'alice', null, 12);
    expect(await repos.telegramLinks.userFor('42')).toBeUndefined();
    expect(await repos.telegramLinks.linkFor('alice')).toEqual({
        telegramUserId: '44',
        username: null,
        linkedAt: 12,
    });
    // Bob's account is relinked to Carol: Bob has none now.
    await repos.telegramLinks.link('43', 'carol', 'c', 13);
    expect(await repos.telegramLinks.linkFor('bob')).toBeUndefined();
    expect(
        (await repos.telegramLinks.linked()).sort((a, b) => a.telegramUserId.localeCompare(b.telegramUserId)),
    ).toEqual([
        { telegramUserId: '43', userId: 'carol' },
        { telegramUserId: '44', userId: 'alice' },
    ]);
    expect(await repos.telegramLinks.unlink('alice')).toBe(true);
    expect(await repos.telegramLinks.unlink('alice')).toBe(false);
    expect(count(db, 'telegram_links')).toBe(1);
});

it('redeems a link code once, before it expires, and never stores the code', async () => {
    const { db } = context();
    const links = telegramLinksOn(db);
    const now = 1_000_000;
    const { code, expiresAt } = await links.createCode('alice', now);
    expect(expiresAt).toBe(now + LINK_CODE_TTL_MS);
    expect(code).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(
        db
            .prepare('SELECT hash FROM telegram_link_codes')
            .all()
            .map((row) => String(row.hash)),
    ).not.toContain(code);
    expect(await links.redeem('not a code', '42', null, now)).toEqual({
        ok: false,
        reason: 'invalid',
    });
    expect(await links.redeem('unknown', '42', null, now)).toEqual({
        ok: false,
        reason: 'invalid',
    });
    expect(await links.redeem(code, '42', 'al', expiresAt)).toEqual({
        ok: false,
        reason: 'expired',
    });
    expect(await links.redeem(code, '42', 'al', now + 1)).toEqual({
        ok: true,
        userId: 'alice',
    });
    expect(await links.redeem(code, '43', null, now + 2)).toEqual({
        ok: false,
        reason: 'used',
    });
    expect(await links.userFor('42')).toBe('alice');
    // A new code stops the unused earlier one.
    const first = await links.createCode('bob', now);
    const second = await links.createCode('bob', now);
    expect(await links.redeem(first.code, '50', null, now)).toEqual({
        ok: false,
        reason: 'invalid',
    });
    expect(await links.redeem(second.code, '50', null, now)).toEqual({
        ok: true,
        userId: 'bob',
    });
});

it('redeems a code once when two redemptions race', async () => {
    const { db } = context();
    const links = telegramLinksOn(db);
    const { code } = await links.createCode('alice', 1_000);
    const results = await Promise.all([links.redeem(code, '42', null, 1_001), links.redeem(code, '43', null, 1_001)]);
    expect(results).toEqual([
        { ok: true, userId: 'alice' },
        { ok: false, reason: 'used' },
    ]);
    expect(await links.linkFor('alice')).toMatchObject({ telegramUserId: '42' });
});

it('binds Telegram conversations and knows who is in which group', async () => {
    const { repos } = context();
    const chats = repos.telegramConversations;
    await chats.bind('dm:1', 't-dm', { kind: 'dm', chatId: '1', topicId: null }, 5);
    await chats.bind('tg:-100:topic:7', 't-topic', { kind: 'topic', chatId: '-100', topicId: '7' }, 6);
    await chats.bind('tg:-200:group#bob', 't-group', { kind: 'group', chatId: '-200', topicId: null }, 7);
    expect(await chats.threadFor('dm:1')).toBe('t-dm');
    expect(await chats.threadFor('nothing')).toBeUndefined();
    await chats.rebind('dm:1', 't-dm-2');
    expect(await chats.threadFor('dm:1')).toBe('t-dm-2');
    expect(await chats.info('t-dm')).toBeUndefined();
    expect(await chats.info('t-topic')).toEqual({
        kind: 'topic',
        chatId: '-100',
        topicId: '7',
    });
    const infos = await chats.infos(['t-dm-2', 't-group', 'web']);
    expect([...infos.keys()].sort()).toEqual(['t-dm-2', 't-group']);
    expect(infos.get('t-group')).toEqual({
        kind: 'group',
        chatId: '-200',
        topicId: null,
    });
    expect((await chats.infos([])).size).toBe(0);

    await chats.recordMember('-200', 'alice', 1);
    await chats.recordMember('-100', 'alice', 2);
    await chats.recordMember('-100', 'alice', 3);
    expect(await chats.isMember('-100', 'alice')).toBe(true);
    expect(await chats.isMember('-100', 'bob')).toBe(false);
    expect(await chats.memberChats('alice')).toEqual(['-100', '-200']);
    // Only forum topics are team threads.
    expect(await chats.teamThreads('alice')).toEqual(['t-topic']);
    expect(await chats.teamThreads('bob')).toEqual([]);
    // A group's linked people, first seen first (CB-214).
    await chats.recordMember('-100', 'bob', 4);
    expect(await chats.chatMembers('-100')).toEqual(['alice', 'bob']);
    expect(await chats.chatMembers('-300')).toEqual([]);
});

it('keeps one usable room code per person and target, used once, and tells an unanswered sender once (CB-214)', async () => {
    const { db, repos } = context();
    const codes = repos.telegramRoomCodes;
    const code = (target: string, expiresAt: number) => ({
        userId: 'ada',
        purpose: 'bind' as const,
        target,
        expiresAt,
        createdAt: 1,
    });
    await codes.issue('h1', code('room-1', 100), 0);
    await codes.issue('h2', code('room-2', 100), 0);
    await codes.issue('stale', { ...code('room-3', 5), userId: 'mo' }, 0);
    // A new code for the same room replaces Ada's earlier one; expired go.
    await codes.issue('h3', code('room-1', 200), 10);
    expect(await codes.get('h1')).toBeUndefined();
    expect(await codes.get('stale')).toBeUndefined();
    expect(await codes.get('h2')).toMatchObject({ target: 'room-2' });
    expect(await codes.get('h3')).toEqual({
        userId: 'ada',
        purpose: 'bind',
        target: 'room-1',
        expiresAt: 200,
        usedAt: null,
    });
    expect(await codes.claim('h3', 50)).toBe(true);
    expect(await codes.claim('h3', 60)).toBe(false);
    expect((await codes.get('h3'))?.usedAt).toBe(50);
    expect(() => db.exec("INSERT INTO telegram_room_codes VALUES ('x','ada','other','r',1,NULL,1)")).toThrow();

    const senders = repos.telegramTopicSenders;
    const sender = {
        sourceKey: 'tg:-100:topic:7',
        roomId: 'room-1',
        telegramUserId: '57',
        reason: 'not_member' as const,
        username: null,
    };
    expect(await senders.record(sender, 10)).toBe(true);
    expect(await senders.record({ ...sender, username: 'nina' }, 20)).toBe(false);
    // Another reason, or another room, is told once again.
    expect(await senders.record({ ...sender, reason: 'closed' }, 30)).toBe(true);
    expect(await senders.record({ ...sender, roomId: 'room-2' }, 40)).toBe(true);
    expect(await senders.forRoom('room-1', 10)).toEqual([
        expect.objectContaining({ reason: 'closed', seen: 1, lastSeenAt: 30 }),
        expect.objectContaining({
            reason: 'not_member',
            username: 'nina',
            seen: 2,
            firstSeenAt: 10,
            lastSeenAt: 20,
            noticedAt: 10,
        }),
    ]);
});

it('retires a direct message’s key for a new thread, keeping the old thread Telegram’s, and maps bot messages to replies (CB-145)', async () => {
    const { repos } = context();
    const chats = repos.telegramConversations;
    const info = { kind: 'dm' as const, chatId: '42', topicId: null };
    await chats.bind('tg:42:dm#alice', 'first', info, 1);
    await chats.retire('tg:42:dm#alice');
    expect(await chats.threadFor('tg:42:dm#alice')).toBeUndefined();
    expect(await chats.threadFor('tg:42:dm#alice~first')).toBe('first');
    await chats.bind('tg:42:dm#alice', 'second', info, 2);
    expect(await chats.threadFor('tg:42:dm#alice')).toBe('second');
    expect(await chats.info('first')).toEqual(info);
    // Retiring a key nobody has is nothing.
    await chats.retire('tg:7:dm#bob');

    const replies = repos.telegramReplies;
    await replies.record('42', ['1001', '1002'], { threadId: 'first', replyId: 'a' }, 5);
    await replies.record('42', [], { threadId: 'first', replyId: 'b' }, 6);
    expect(await replies.reply('42', '1002')).toEqual({
        threadId: 'first',
        replyId: 'a',
    });
    // The same message id in another chat is another message.
    expect(await replies.reply('43', '1002')).toBeUndefined();
    // Recorded again (an edit that showed a later reply): the latest wins.
    await replies.record('42', ['1002'], { threadId: 'second', replyId: 'c' }, 7);
    expect(await replies.reply('42', '1002')).toEqual({
        threadId: 'second',
        replyId: 'c',
    });
});

it('tells whether a person’s Telegram account still reaches a conversation', async () => {
    const { db } = context();
    const links = telegramLinksOn(db);
    const dm = { kind: 'dm' as const, chatId: '42' };
    const group = { kind: 'group' as const, chatId: '-100' };
    expect(await links.reaches(dm, 'alice')).toBe(false);
    await sqliteIntegrationRepositories(sqliteData(db)).telegramLinks.link('42', 'alice', null, 1);
    expect(await links.reaches(dm, 'alice')).toBe(true);
    expect(await links.reaches({ kind: 'dm', chatId: '43' }, 'alice')).toBe(false);
    expect(await links.reaches(group, 'alice')).toBe(false);
    await links.recordMember('-100', 'alice');
    expect(await links.reaches(group, 'alice')).toBe(true);
});

it('keeps a socio’s web identity and its audit, newest first', async () => {
    const { db, repos } = context();
    expect(await repos.webIdentities.get('dot-1')).toBeUndefined();
    await repos.webIdentities.set('dot-1', 'browser', 1);
    await repos.webIdentities.set('dot-1', 'agent', 2);
    expect(await repos.webIdentities.get('dot-1')).toBe('agent');
    await repos.webIdentities.set('dot-1', null, 3);
    expect(await repos.webIdentities.get('dot-1')).toBeUndefined();

    const line = (id: string, createdAt: number, dotId = 'dot-1') => ({
        id,
        dotId,
        userId: id === 'a' ? null : 'alice',
        method: 'GET',
        host: 'example.com',
        path: `/${id}`,
        status: id === 'a' ? null : 200,
        bytes: 10,
        outcome: 'fetched',
        createdAt,
    });
    repos.webAudit.append(line('a', 10));
    repos.webAudit.append(line('b', 20));
    // Same millisecond: the later one first.
    repos.webAudit.append(line('c', 20));
    repos.webAudit.append(line('d', 30, 'dot-2'));
    expect((await repos.webAudit.latest('dot-1', 10)).map((entry) => entry.id)).toEqual(['c', 'b', 'a']);
    expect((await repos.webAudit.latest('dot-1', 1))[0]).toEqual({
        id: 'c',
        userId: 'alice',
        method: 'GET',
        host: 'example.com',
        path: '/c',
        status: 200,
        bytes: 10,
        outcome: 'fetched',
        createdAt: 20,
    });
    expect((await repos.webAudit.latest('dot-1', 10)).at(-1)).toMatchObject({
        userId: null,
        status: null,
    });
    expect((await repos.webAudit.activity('dot-1', 15, 10)).map((row) => row.path)).toEqual(['/a']);
    expect(count(db, 'web_audit')).toBe(4);
});

it('audits who set a web identity, with it, in one unit of work', async () => {
    const { db } = context();
    const store = webStoreOn(db);
    await store.setIdentity('dot-1', 'browser', 'admin-1');
    expect(await store.identity('dot-1')).toBe('browser');
    await store.setIdentity('dot-1', null, 'admin-2');
    expect(await store.identity('dot-1')).toBeUndefined();
    expect((await store.audit('dot-1')).map((entry) => [entry.outcome, entry.userId])).toEqual([
        ['identity:default', 'admin-2'],
        ['identity:browser', 'admin-1'],
    ]);
});

it('keeps each socio’s computer permissions and an outcome for every action', async () => {
    const { db, repos } = context();
    const store = computerStoreOn(db);
    expect(await store.permissions('dot-1')).toEqual({
        enabled: false,
        browser: false,
        files: false,
        shell: false,
    });
    expect(await store.patch('dot-1', { enabled: true, shell: true })).toEqual({
        enabled: true,
        browser: false,
        files: false,
        shell: true,
    });
    await store.patch('dot-1', { shell: false, files: true });
    expect(await repos.computerPermissions.get('dot-1')).toEqual({
        enabled: true,
        browser: false,
        files: true,
        shell: false,
    });
    expect(await repos.computerPermissions.get('dot-2')).toBeUndefined();

    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(100);
    const first = store.begin('dot-1', 'exec', 'agent', 'alice');
    now.mockReturnValue(200);
    const second = store.begin('dot-1', 'start', 'owner');
    store.finish(first, 'succeeded');
    expect(await store.audit('dot-1')).toEqual([
        {
            id: second,
            action: 'start',
            actor: 'owner',
            userId: null,
            outcome: 'pending',
            createdAt: 200,
        },
        {
            id: first,
            action: 'exec',
            actor: 'agent',
            userId: 'alice',
            outcome: 'succeeded',
            createdAt: 100,
        },
    ]);
    expect(await store.activity('dot-1', 150, 10)).toEqual([
        {
            action: 'exec',
            actor: 'agent',
            outcome: 'succeeded',
            userId: 'alice',
            createdAt: 100,
        },
    ]);
});

it('keeps the domains’ hosts and every operation, the newest first', async () => {
    const { db, repos } = context();
    let now = 1_000;
    const store = new DomainsStore(domainsRepositories(db), () => now++);
    await store.saveHost('b.example.com', 'custom', 'olga', {
        dnsRecordId: 'r1',
    });
    await store.saveHost('a.example.com', 'base', 'olga', {});
    // Only the given fields change; who made it and when stay.
    const saved = await store.saveHost('b.example.com', 'custom', 'ivan', {
        proxyHostId: 7,
        proxyHostCreated: 1,
    });
    expect(saved).toEqual({
        hostname: 'b.example.com',
        kind: 'custom',
        dnsRecordId: 'r1',
        dnsContent: null,
        dnsCreated: 0,
        certificateId: null,
        certificateCreated: 0,
        proxyHostId: 7,
        proxyHostCreated: 1,
        createdBy: 'olga',
        createdAt: 1_000,
        updatedAt: 1_002,
    });
    expect(await store.host('b.example.com')).toEqual(saved);
    expect((await store.hosts()).map((host) => host.hostname)).toEqual(['a.example.com', 'b.example.com']);
    expect((await store.hosts('custom')).map((host) => host.hostname)).toEqual(['b.example.com']);
    await store.deleteHost('b.example.com');
    expect(await store.host('b.example.com')).toBeUndefined();

    const first = await store.startOp('provision', 'b.example.com', 'olga');
    await store.saveSteps(first.id, [{ item: 'dns', name: 'b.example.com', action: 'created' }]);
    expect((await store.op(first.id))?.steps).toHaveLength(1);
    expect(await store.finishOp(first.id, [], 'NPM refused it.')).toMatchObject({
        status: 'failed',
        steps: [],
        error: 'NPM refused it.',
    });
    const second = await store.startOp('remove', 'b.example.com', 'olga');
    const third = await store.startOp('ensure_base', 'example.com', 'olga');
    const done = await store.finishOp(second.id, [{ item: 'proxy_host', name: 'b.example.com', action: 'deleted' }]);
    expect(done).toEqual({
        id: second.id,
        kind: 'remove',
        hostname: 'b.example.com',
        actor: 'olga',
        status: 'ok',
        steps: [{ item: 'proxy_host', name: 'b.example.com', action: 'deleted' }],
        startedAt: second.startedAt,
        finishedAt: expect.any(Number),
    });
    expect((await store.ops()).map((op) => op.id)).toEqual([third.id, second.id, first.id]);
    expect((await store.lastOp('b.example.com'))?.id).toBe(second.id);
    expect(await store.lastOp('example.com')).toBeUndefined();
    expect(await store.interruptRunning()).toBe(1);
    expect(await repos.domainOps.byId(third.id)).toMatchObject({
        status: 'failed',
        error: 'Interrupted by a restart.',
    });
    expect(await store.interruptRunning()).toBe(0);
});

it('rolls back every awaited write in a failed unit of work', async () => {
    const { uow, repos } = context();
    await expect(
        uow.run(async () => {
            await repos.telegramLinks.link('42', 'alice', null, 1);
            await repos.webIdentities.set('dot-1', 'browser', 1);
            await repos.computerPermissions.save('dot-1', {
                enabled: true,
                browser: true,
                files: true,
                shell: true,
            });
            throw new Error('nope');
        }),
    ).rejects.toThrow('nope');
    expect(await repos.telegramLinks.linkFor('alice')).toBeUndefined();
    expect(await repos.webIdentities.get('dot-1')).toBeUndefined();
    expect(await repos.computerPermissions.get('dot-1')).toBeUndefined();
});

it('queues writes and audit rows behind another chain’s open unit of work, and keeps the rows when it fails', async () => {
    const { db, uow, repos } = context();
    const computers = computerStoreOn(db);
    const web = webStoreOn(db);
    const order: string[] = [];
    let release!: () => void;
    const held = uow.run(
        async () => {
            order.push('unit open');
            await new Promise<void>((resolve) => (release = resolve));
            order.push('unit failed');
            throw new Error('another chain failed');
        },
        { label: 'another chain' },
    );
    for (let i = 0; i < 5; i++) {
        await Promise.resolve();
    }
    // Started while the other unit is open: each waits for it.
    const writes = Promise.all([
        repos.telegramConversations.recordMember('-100', 'alice', 1).then(() => order.push('member')),
        computers.patch('dot-1', { enabled: true }).then(() => order.push('permissions')),
    ]);
    // Audit rows don't make their callers wait.
    const receipt = computers.begin('dot-1', 'exec', 'agent', 'alice');
    computers.finish(receipt, 'failed');
    web.record({
        dotId: 'dot-1',
        method: 'GET',
        host: 'example.com',
        path: '/',
        bytes: 0,
        outcome: 'blocked',
    });
    for (let i = 0; i < 20; i++) {
        await Promise.resolve();
    }
    expect(order).toEqual(['unit open']);
    expect(count(db, 'computer_audit')).toBe(0);
    release();
    await expect(held).rejects.toThrow('another chain failed');
    await writes;
    // Queued in order: a unit started now runs after them.
    await uow.run(async () => {}, { label: 'after the queue' });
    expect(order).toEqual(['unit open', 'unit failed', 'member', 'permissions']);
    expect(await computers.audit('dot-1')).toEqual([expect.objectContaining({ id: receipt, outcome: 'failed' })]);
    expect(await web.audit('dot-1')).toHaveLength(1);
    expect(await repos.telegramConversations.isMember('-100', 'alice')).toBe(true);
});
