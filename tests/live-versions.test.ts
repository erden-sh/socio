import { afterEach, expect, it, vi } from 'vitest';

import { parseIfNoneMatch } from '@socio/foundation/http/conditional';
import type { User } from '@socio/shared/types';

import { MockAuthProvider } from '../src/server/auth/mock.js';
import { ChangeCounters, syncTriggers } from '../src/server/live/change-counters.js';
import type { TelegramChannel } from '../src/server/telegram/telegram-channel.js';

import { testWorkspaceViews } from './helpers/page-views.js';
import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

// Live updates step 1:
// each polled view answers 304 to the tag it gave while nothing it shows
// this user changed, and 200 as soon as something did. The audit mode is
// on in the suite (vitest.shared.ts), so every 304 a version decides is
// also checked against a rebuilt body: a missing dependency fails as a
// 500, never as a stale 304.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

const NAMES = ['alice', 'bob', 'carol'] as const;
type Name = (typeof NAMES)[number];

async function fixture() {
    const users: User[] = [
        { id: 'alice', name: 'Alice', role: 'admin' },
        { id: 'bob', name: 'Bob', role: 'member' },
        { id: 'carol', name: 'Carol', role: 'member' },
    ];
    const { app, store, workspace, platform, dispose } = await makeTestRuntime({
        config: {
            baseUrl: '',
            apiKey: '',
            model: '',
            voiceName: 'marin',
            runtimeUrl: '',
        },
        app: {
            auth: {
                provider: new MockAuthProvider(users, 'secret-0123456789abcdef-xyz'),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    for (const user of users) {
        workspace.recordUser(user);
    }
    const cookies = {} as Record<Name, string>;
    for (const name of NAMES) {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: name }),
        });
        cookies[name] = login.headers.get('set-cookie')!.split(';')[0]!;
    }
    const get = (name: Name, path: string, headers: Record<string, string> = {}) =>
        app.request(`/api${path}`, {
            headers: { cookie: cookies[name], ...headers },
        });
    /**
     * Polls `path` as each user, runs `write`, and polls again with each
     * user's tag: `changed` must get a 200, everyone else a 304.
     */
    const expectChange = async (path: string, changed: Name[], write: () => unknown, who: readonly Name[] = NAMES) => {
        const tags = new Map<Name, string>();
        for (const name of who) {
            const first = await get(name, path);
            expect(first.status, `${name} ${path}`).toBe(200);
            const tag = first.headers.get('etag')!;
            expect(tag, `${name} ${path}`).toMatch(/^"[\w-]+\.[\w-]+"$/);
            // Nothing changed yet: the tag answers 304.
            expect((await get(name, path, { 'If-None-Match': tag })).status, `${name} ${path} before`).toBe(304);
            tags.set(name, tag);
        }
        await write();
        for (const name of who) {
            const again = await get(name, path, {
                'If-None-Match': tags.get(name)!,
            });
            expect(again.status, `${name} ${path} after`).toBe(changed.includes(name) ? 200 : 304);
        }
    };
    return {
        users,
        store,
        workspace,
        platform,
        app,
        get,
        expectChange,
        space: workspace.spaces()[0]!.id,
        dot: workspace.dots()[0]!,
    };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const thread = (f: Fixture, id: string, owner: string) => f.workspace.bindThread(id, f.dot.id, `Talk ${id}`, owner);

it('installs a trigger per watched table and keeps them in step on open', () => {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    const names = () =>
        (
            workspace.db
                .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'change_%' ORDER BY name")
                .all() as Array<{ name: string }>
        ).map((row) => row.name);
    expect(names()).toContain('change_issues_update');
    expect(names()).toContain('change_pages_delete');
    // A rebuilt table loses its triggers; the next sync puts them back.
    const before = names();
    workspace.db.exec('DROP TRIGGER change_issues_update');
    workspace.db.exec('DROP TRIGGER change_pages_insert');
    workspace.db.exec('CREATE TRIGGER change_pages_insert AFTER INSERT ON pages BEGIN SELECT 1; END');
    // One created, one replaced (dropped and created).
    expect(workspace.counters.sync()).toBe(3);
    expect(names()).toEqual(before);
    expect(syncTriggers(workspace.db)).toBe(0);
    // A second store on the same connection adds nothing.
    new ChangeCounters(workspace.db);
    expect(names()).toEqual(before);
});

it('bumps one key per visible owner, and only for the columns that count', async () => {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    const read = (...keys: string[]) => workspace.counters.read(keys);
    workspace.recordUser({ id: 'u1', name: 'One', role: 'member' });
    const users = read('users');
    // Every request records its user: the same name and role bump nothing.
    workspace.recordUser({ id: 'u1', name: 'One', role: 'member' });
    expect(read('users')).toBe(users);
    workspace.recordUser({ id: 'u1', name: 'Uno', role: 'member' });
    expect(read('users')).not.toBe(users);
    // A conversation bumps its owner's key, not another user's.
    const dot = workspace.dots()[0]!;
    const other = read('threads:u2');
    workspace.bindThread('t1', dot.id, 'Hello', 'u1');
    expect(read('threads:u1')).toBe('threads:u1=1');
    expect(read('threads:u2')).toBe(other);
    // A move between owners bumps both.
    workspace.db.exec("UPDATE thread_bindings SET ownerId='u2' WHERE id='t1'");
    expect(read('threads:u1', 'threads:u2')).toBe('threads:u1=2,threads:u2=1');
    // A group message rewrites seenAt only: no bump.
    await workspace.telegram.recordMember('chat', 'u1', 1);
    const member = read('telegram-members:u1');
    await workspace.telegram.recordMember('chat', 'u1', 2);
    expect(read('telegram-members:u1')).toBe(member);
});

it('answers 304 to a matching tag without building the view', async () => {
    const f = await fixture();
    // Off for this test: the audit builds the body on purpose.
    vi.stubEnv('LIVE_VERSION_AUDIT', '');
    const first = await f.get('bob', '/workspace');
    const tag = first.headers.get('etag')!;
    expect(first.headers.get('vary')).toBe('Accept-Encoding');
    expect(first.headers.get('cache-control')).toBe('no-store');
    const conversations = vi.spyOn(f.workspace, 'conversations');
    const tasks = vi.spyOn(f.store, 'tasks');
    const issues = vi.spyOn(f.platform.board.issues, 'list');
    const stateTag = (await f.get('bob', '/state')).headers.get('etag')!;
    const issuesTag = (await f.get('bob', '/issues')).headers.get('etag')!;
    tasks.mockClear();
    issues.mockClear();
    for (const [path, sent] of [
        ['/workspace', tag],
        ['/state', stateTag],
        ['/issues', issuesTag],
    ] as const) {
        const again = await f.get('bob', path, { 'If-None-Match': sent });
        expect(again.status).toBe(304);
        expect(again.body).toBeNull();
        expect(again.headers.get('etag')).toBe(sent);
        expect(again.headers.get('content-type')).toBeNull();
        expect(again.headers.get('vary')).toBe('Accept-Encoding');
        expect(again.headers.get('cache-control')).toBe('no-store');
    }
    expect(conversations).not.toHaveBeenCalled();
    expect(tasks).not.toHaveBeenCalled();
    expect(issues).not.toHaveBeenCalled();
    // Another user's tag is never this user's version: built, and a 200.
    const other = await f.get('carol', '/workspace', { 'If-None-Match': tag });
    expect(other.status).toBe(200);
    expect(conversations).toHaveBeenCalledWith('carol');
    // A list of tags, weak or strong, matches any of them.
    expect(
        (
            await f.get('bob', '/workspace', {
                'If-None-Match': `"x.y", W/${tag}`,
            })
        ).status,
    ).toBe(304);
});

it('checks the session and the role before any 304', async () => {
    const f = await fixture();
    const tag = (await f.get('alice', '/runs')).headers.get('etag')!;
    expect(tag).toMatch(/^"0\./);
    // A member on an admin route: 403, whatever tag they send.
    expect((await f.get('bob', '/github', { 'If-None-Match': tag })).status).toBe(403);
    expect((await f.get('bob', '/learning/containers', { 'If-None-Match': tag })).status).toBe(403);
    // Signed out: 401.
    const workspaceTag = (await f.get('bob', '/workspace')).headers.get('etag')!;
    const signedOut = await f.app.request('/api/workspace', {
        headers: { 'If-None-Match': workspaceTag },
    });
    expect(signedOut.status).toBe(401);
    // An account that is gone (the provider no longer has it): 401, not 304.
    f.users.splice(
        f.users.findIndex((user) => user.id === 'bob'),
        1,
    );
    expect((await f.get('bob', '/workspace', { 'If-None-Match': workspaceTag })).status).toBe(401);
});

it('changes the shell state for its owner only: settings, tasks, memories', async () => {
    const f = await fixture();
    await f.expectChange('/state', ['bob'], () => f.store.createTask('Look into this', null, 'bob'));
    const task = (await f.store.tasks('bob'))[0]!;
    await f.expectChange('/state', ['bob'], () => f.store.action(task.id, 'pause'));
    await f.expectChange('/state', ['bob'], () => f.store.deleteTask(task.id, 'bob'));
    await f.expectChange('/state', ['carol'], () =>
        f.store.memoryItems.add({
            text: 'Likes tea',
            userId: 'carol',
            source: 'person',
        }),
    );
    const memory = (await f.store.memoryItems.active('carol'))[0]!;
    // Another user can't overwrite it: nothing changes for anyone.
    await f.expectChange('/state', [], () => f.store.memoryItems.update(memory.id, 'bob', { text: 'Mine now' }));
    await f.expectChange('/state', ['carol'], () => f.store.memoryItems.forget(memory.id, 'carol'));
    await f.expectChange('/state', [...NAMES], () => f.store.updateSettings({ name: 'Brain' }));
});

it('changes the shell for whoever sees the change: Spaces, Dots, conversations, calls', async () => {
    const f = await fixture();
    await f.expectChange('/workspace', [...NAMES], () => f.workspace.createSpace('Plans', 'Next quarter'));
    const plans = f.workspace.spaces().find((s) => s.name === 'Plans')!;
    await f.expectChange('/workspace', [...NAMES], () =>
        f.workspace.updateDot(f.dot.id, {
            name: f.dot.name,
            instructions: f.dot.instructions,
            researchAllowed: true,
            memoryAllowed: true,
            spaceIds: [f.space, plans.id],
        }),
    );
    // A soft-deleted Space is an update, and leaves everyone's shell.
    await f.expectChange('/workspace', [...NAMES], () =>
        f.workspace.db
            .prepare('UPDATE spaces SET deletedAt=?, deletedBy=? WHERE id=?')
            .run(Date.now(), 'alice', plans.id),
    );
    await f.expectChange('/workspace', ['bob'], () => thread(f, 't-bob', 'bob'));
    await f.expectChange('/workspace', ['bob'], () => f.workspace.setAutomaticTitle('t-bob', 'Renamed'));
    // CB-66: the owner's own title, from the chat menu.
    await f.expectChange('/workspace', ['bob'], () => f.workspace.renameThread('t-bob', 'Bob’s title'));
    // Archiving moves the chat out of the list, unarchiving
    // brings it back; both change the owner's shell only.
    await f.expectChange('/workspace', ['bob'], () => f.workspace.setArchived('t-bob', true, 'bob'));
    await f.expectChange('/workspace', ['bob'], () => f.workspace.setArchived('t-bob', false, 'bob'));
    const call = f.workspace.createCall('t-bob');
    await f.expectChange('/workspace', ['bob'], () => f.workspace.setCall(call.id, 'ended', 'Bye.'));
    await f.expectChange('/workspace', ['bob'], () => f.workspace.deleteThread('t-bob', 'bob'));
});

it('changes the shell for a Telegram team topic’s members only, joining and leaving included', async () => {
    const f = await fixture();
    await f.workspace.telegram.recordMember('chat-1', 'bob');
    await f.expectChange('/workspace', ['bob'], async () => {
        thread(f, 't-team', 'telegram-team:chat-1');
        await f.workspace.telegram.bindThread('chat-1:7', 't-team', 'topic', 'chat-1', '7');
    });
    await f.expectChange('/workspace', ['bob'], () => f.workspace.setAutomaticTitle('t-team', 'Team plans'));
    // Carol speaks in the group: the topic is hers to see too.
    await f.expectChange('/workspace', ['carol'], () => f.workspace.telegram.recordMember('chat-1', 'carol'));
    // Bob leaves: his own key, from the membership table's trigger.
    await f.expectChange('/workspace', ['bob'], () =>
        f.workspace.db.prepare('DELETE FROM telegram_members WHERE chatId=? AND userId=?').run('chat-1', 'bob'),
    );
});

it('changes the shell on a role or name from the session, for that user', async () => {
    const f = await fixture();
    await f.expectChange('/workspace', ['carol'], () => {
        f.users[2]!.role = 'admin';
    });
    await f.expectChange('/workspace', ['bob'], () => {
        f.users[1]!.name = 'Robert';
    });
});

it('changes setup’s version for the user whose connection changed, and the data key’s for admins', async () => {
    const f = await fixture();
    // Without a model, setup looks the same before and after these: the
    // versions are checked directly.
    const versions = async () =>
        Object.fromEntries(
            await Promise.all(
                f.users.map(async (user) => [user.id, await testWorkspaceViews(f.platform).workspaceVersion(user)]),
            ),
        );
    const changedBy = async (write: () => unknown) => {
        const before = await versions();
        await write();
        const after = await versions();
        return NAMES.filter((name) => before[name] !== after[name]);
    };
    expect(await changedBy(() => f.platform.inference.store.saveConnection('bob', 'fake', { t: 1 }))).toEqual([
        'alice',
        'bob',
    ]);
    expect(await changedBy(() => f.platform.inference.store.setAllowedByoKinds(['fake']))).toEqual([...NAMES]);
    // A file sealed in the data space counts for the admins' data key only.
    expect(
        await changedBy(() =>
            f.platform.data.putFile({ kind: 'user', userId: 'bob' }, 'notes.txt', Buffer.from('notes')),
        ),
    ).toEqual(['alice']);
    expect(await changedBy(() => undefined)).toEqual([]);
});

it('changes the shell when in-memory status changes (statusEpoch)', async () => {
    const f = await fixture();
    const channel = {
        status: 'connecting',
        start: async () => {},
        stop: async () => {},
        drain: async () => {},
        handling: 0,
    };
    f.platform.useTelegram(channel as unknown as TelegramChannel);
    const epoch = f.platform.statusEpoch();
    expect(f.platform.statusEpoch()).toBe(epoch);
    await f.expectChange('/workspace', [...NAMES], () => {
        channel.status = 'connected';
    });
    expect(f.platform.statusEpoch()).toBe(epoch + 1);
});

it('changes the shell when an admin’s transcription settings change dictation (CB-222)', async () => {
    const f = await fixture();
    // A lab server: server dictation works, with live text.
    await f.expectChange('/workspace', [...NAMES], () =>
        f.store.updateSettings({
            transcription: { url: 'https://stt.lab', model: 'whisper-1' },
        }),
    );
    await f.expectChange('/workspace', [...NAMES], () => f.store.updateSettings({ transcriptionStreaming: 'off' }));
    // Not a change to either flag.
    await f.expectChange('/workspace', [], () => f.store.updateSettings({ transcriptionStreaming: 'off' }));
});

it('changes the issue list for everyone on any issue change, soft deletes included', async () => {
    const f = await fixture();
    const all = [...NAMES];
    await f.expectChange('/issues', all, () => f.platform.board.issues.create({ title: 'Broken thing' }, 'bob'));
    const issue = (await f.platform.board.issues.list())[0]!;
    await f.expectChange('/issues', all, () =>
        f.platform.board.issues.update(issue.number, { labels: ['ux'] }, 'alice'),
    );
    // A comment moves the issue's updatedAt.
    await f.expectChange('/issues', all, () => f.platform.board.issues.addComment(issue.number, 'Seen it', 'carol'));
    // Every request records its user: the same name changes nothing.
    await f.expectChange('/issues', [], () => f.workspace.recordUser({ id: 'bob', name: 'Bob', role: 'member' }));
    // A renamed assignee is in the list's names.
    await f.expectChange('/issues', all, () =>
        f.platform.board.issues.update(issue.number, { assigneeId: 'bob' }, 'alice'),
    );
    await f.expectChange('/issues', all, () => f.workspace.recordUser({ id: 'bob', name: 'Robert', role: 'member' }));
    await f.expectChange('/issues', all, () => f.platform.board.issues.remove(issue.number, 'alice'));
    // A Dot's capability request carries its demand.
    await f.expectChange('/issues', all, () =>
        f.platform.board.requests.request(f.dot.id, 'bob', {
            capability: 'send email',
            why: 'To send the weekly report',
            example: 'Email the team the summary',
        }),
    );
    // Votes carry their count (CB-83), cast and withdrawn.
    const voted = await f.platform.board.issues.create({ title: 'Popular' }, 'bob');
    await f.expectChange('/issues', all, () => f.platform.board.votes.cast(voted.id, 'carol'));
    await f.expectChange('/issues', all, () => f.platform.board.votes.withdraw(voted.id, 'carol'));
    // A filtered list has its own version.
    await f.expectChange('/issues?status=triage', all, () =>
        f.platform.board.issues.create({ title: 'Another' }, 'carol'),
    );
});

it('changes a Space’s pages and tree on its own page changes only', async () => {
    const f = await fixture();
    const other = f.workspace.createSpace('Other', 'Elsewhere');
    const paths = [
        `/spaces/${f.space}/pages`,
        `/spaces/${f.space}/pages?bodies=false&limit=10`,
        `/spaces/${f.space}/page-tree`,
    ];
    for (const path of paths) {
        await f.expectChange(path, [...NAMES], () => f.workspace.pages.create(f.space, { title: `Notes ${path}` }));
        await f.expectChange(path, [], () => f.workspace.pages.create(other.id, { title: 'Not here' }));
    }
    const page = f.workspace.pages.list(f.space)[0]!;
    for (const path of paths) {
        await f.expectChange(path, [...NAMES], () =>
            f.workspace.pages.update(f.space, page.id, {
                title: `${page.title} ${path}`,
                expectedRevision: f.workspace.pages.get(f.space, page.id).revision,
            }),
        );
    }
    await f.expectChange(paths[2]!, [...NAMES], () => f.workspace.pages.delete(f.space, page.id, { by: 'alice' }));
});

it('answers 304 by the body alone on the views without a version', async () => {
    const f = await fixture();
    for (const [name, path] of [
        ['alice', '/runs'],
        ['alice', '/learning/containers'],
        ['bob', '/schedules'],
    ] as const) {
        const first = await f.get(name, path);
        const tag = first.headers.get('etag')!;
        expect(parseIfNoneMatch(tag)).toEqual([{ version: '0', body: expect.any(String) }]);
        expect((await f.get(name, path, { 'If-None-Match': tag })).status).toBe(304);
    }
    const tag = (await f.get('bob', '/schedules')).headers.get('etag')!;
    await f.store.createTask('Every morning', 86_400, 'bob');
    expect((await f.get('bob', '/schedules', { 'If-None-Match': tag })).status).toBe(200);
});

it('fails the audit when a version misses a write, instead of answering 304', async () => {
    const f = await fixture();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const tag = (await f.get('bob', '/issues')).headers.get('etag')!;
    // A table without its trigger: the write bumps nothing.
    f.workspace.db.exec('DROP TRIGGER change_issues_insert');
    await f.platform.board.issues.create({ title: 'Unseen' }, 'bob');
    const audited = await f.get('bob', '/issues', { 'If-None-Match': tag });
    expect(audited.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^Version audit: \/api\/issues matched/));
    // Without the audit, the same request would be a stale 304.
    vi.stubEnv('LIVE_VERSION_AUDIT', '');
    expect((await f.get('bob', '/issues', { 'If-None-Match': tag })).status).toBe(304);
});

it('keeps 304 working with gzip on and off: weak tags match, a 304 is never compressed', async () => {
    const f = await fixture();
    for (let index = 0; index < 20; index++) {
        await f.platform.board.issues.create({ title: `Issue ${index}`, body: 'Some words here. '.repeat(20) }, 'bob');
    }
    const gzip = { 'Accept-Encoding': 'gzip' };
    const zipped = await f.get('bob', '/issues', gzip);
    expect(zipped.headers.get('content-encoding')).toBe('gzip');
    expect(zipped.headers.get('vary')).toBe('Accept-Encoding');
    expect(zipped.headers.get('cache-control')).toBe('no-store');
    const weak = zipped.headers.get('etag')!;
    expect(weak).toMatch(/^W\/"/);
    const plain = await f.get('bob', '/issues');
    expect(plain.headers.get('content-encoding')).toBeNull();
    const strong = plain.headers.get('etag')!;
    // The same answer: the same tag, weak once compressed.
    expect(weak).toBe(`W/${strong}`);
    for (const [headers, sent] of [
        [gzip, weak],
        [gzip, strong],
        [{}, weak],
        [{}, strong],
    ] as const) {
        const again = await f.get('bob', '/issues', {
            ...headers,
            'If-None-Match': sent,
        });
        expect(again.status).toBe(304);
        expect(again.body).toBeNull();
        expect(again.headers.get('content-encoding')).toBeNull();
        expect(again.headers.get('content-length')).toBeNull();
        expect(again.headers.get('vary')).toBe('Accept-Encoding');
        expect(again.headers.get('cache-control')).toBe('no-store');
        expect(again.headers.get('etag')).toBe(strong);
    }
});
