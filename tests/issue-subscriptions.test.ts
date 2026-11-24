import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import type { DotTurn } from '@socio/foundation/turns/turn';

import { issueSubscriptionTools } from '../src/server/issues/subscription-tools.js';
import type { NotificationService } from '../src/server/notifications/service.js';

import { testDatabase, testDatabaseFile } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
});
const source = {
    sourceKind: 'person' as const,
    sourceId: 'alice',
    threadId: null,
    causeId: null,
};
const CONFIG = {
    baseUrl: '',
    apiKey: '',
    model: '',
    runtimeUrl: '',
    appOrigin: 'https://app.example.invalid',
};
/**
 * The app's runtime over a test database, or, given `path`, the workspace in
 * that file (a restart reads it again) beside a fresh store.
 */
async function runtime(path?: string) {
    if (path === undefined) {
        return makeTestRuntime({ config: CONFIG });
    }
    const store = testDatabase();
    const t = await makeTestRuntime({ database: { store, workspace: path }, config: CONFIG });
    return {
        ...t,
        dispose: async () => {
            try {
                await t.dispose();
            } finally {
                store.close();
            }
        },
    };
}
async function setup(path?: string) {
    const { workspace, platform, dispose } = await runtime(path);
    workspace.recordUser({ id: 'alice', name: 'Alice', role: 'member' });
    workspace.recordUser({ id: 'bob', name: 'Bob', role: 'member' });
    const send = vi.fn(async () => ({ outcome: 'sent' as const }));
    platform.notifications.register({
        id: 'fixture',
        label: 'Fixture',
        targets: (userId) => [{ id: 'target-' + userId, label: 'Fixture' }],
        send,
    });
    workspace.setPreferences('alice', {
        notifications: { fixture: { enabled: true, content: 'message' } },
    });
    let closed = false;
    const close = async () => {
        if (closed) {
            return;
        }
        closed = true;
        await dispose();
    };
    cleanup.push(close);
    const make = async (title = 'Watched issue', status: 'open' | 'done' = 'open') =>
        platform.board.issues.create({ title, status }, 'alice');
    const run = async () => {
        await platform.board.watches.replay();
        await platform.board.watches.flush(platform.notifications);
        expect(await platform.notifications.waitForAppDeliveries()).toBe(true);
    };
    const count = (table: string) =>
        Number(Object.values(workspace.db.prepare('SELECT COUNT(*) n FROM ' + table).get()!)[0]);
    return {
        workspace,
        platform,
        send,
        close,
        make,
        run,
        count,
        subscriptions: platform.board.watches,
    };
}

it('does not backfill already matched issues and deduplicates concurrent subscription retries', async () => {
    const f = await setup();
    const issue = await f.make('Private title stays in the board', 'done');
    const inputs = { issues: ['CB-1'], targetStatus: 'done' as const };
    const results = await Promise.all([
        f.subscriptions.create('alice', inputs, source),
        f.subscriptions.create('alice', inputs, source),
    ]);
    expect(new Set(results.map((r) => r.watch.id)).size).toBe(1);
    expect(results.every((r) => r.alreadyMatched)).toBe(true);
    await f.run();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.count('issue_watch_outbox')).toBe(0);
    await f.platform.board.issues.update(issue.number, { status: 'open' }, 'alice');
    await f.run();
    await f.platform.board.issues.update(issue.number, { status: 'done' }, 'alice');
    await f.run();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.send.mock.calls)).not.toContain('Private title');
});

it('notifies once only when every explicit member reaches the status; parallel flushes cannot duplicate it', async () => {
    const f = await setup();
    const a = await f.make('First prerequisite'),
        b = await f.make('Second prerequisite');
    const watch = await f.subscriptions.create('alice', { issues: ['CB-1', '2'] }, source);
    await f.platform.board.issues.update(a.number, { status: 'done' }, 'alice');
    await f.run();
    expect(f.send).not.toHaveBeenCalled();
    await f.platform.board.issues.update(b.number, { status: 'done' }, 'alice');
    await f.subscriptions.replay();
    await Promise.all([
        f.subscriptions.flush(f.platform.notifications),
        f.subscriptions.flush(f.platform.notifications),
    ]);
    expect(await f.platform.notifications.waitForAppDeliveries()).toBe(true);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.count('notifications')).toBe(1);
    expect(f.count('notification_in_app')).toBe(1);
    expect((await f.subscriptions.list('alice')).items).toMatchObject([{ id: watch.watch.id, state: 'triggered' }]);
    await f.platform.board.issues.update(a.number, { status: 'open' }, 'alice');
    await f.platform.board.issues.update(a.number, { status: 'done' }, 'alice');
    await f.run();
    expect(f.send).toHaveBeenCalledTimes(1);
});

it('recovers only post-subscription events across restart, including a transient group match', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'issue-watch-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = testDatabaseFile(join(dir, 'workspace.sqlite'));
    const first = await setup(path);
    const issue = await first.make();
    await first.subscriptions.create('alice', { issues: ['1'] }, source);
    await first.platform.board.issues.update(issue.number, { status: 'done' }, 'alice');
    await first.platform.board.issues.update(issue.number, { status: 'open' }, 'alice');
    await first.close();
    const restarted = await setup(path);
    await restarted.run();
    expect(restarted.send).toHaveBeenCalledTimes(1);
    expect(restarted.count('notification_in_app')).toBe(1);
    await restarted.close();
    const again = await setup(path);
    await again.run();
    expect(again.send).not.toHaveBeenCalled();
    expect(again.count('notifications')).toBe(1);
});

it('retries an unclaimed durable outbox after restart without repeating a claimed external attempt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'issue-watch-outbox-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = testDatabaseFile(join(dir, 'workspace.sqlite'));
    const first = await setup(path);
    const issue = await first.make();
    await first.subscriptions.create('alice', { issues: ['1'] }, source);
    await first.platform.board.issues.update(issue.number, { status: 'done' }, 'alice');
    await first.subscriptions.replay();
    expect(first.count('issue_watch_outbox')).toBe(1);
    expect(first.count('notifications')).toBe(0);
    await first.close();
    const restarted = await setup(path);
    await restarted.run();
    expect(restarted.send).toHaveBeenCalledTimes(1);
    await restarted.close();
    const again = await setup(path);
    await again.run();
    expect(again.send).not.toHaveBeenCalled();
    expect(again.count('notification_in_app')).toBe(1);
});

it('rolls back the claim, notification and notice together if recording fails before commit', async () => {
    const f = await setup();
    const issue = await f.make();
    await f.subscriptions.create('alice', { issues: ['1'] }, source);
    await f.platform.board.issues.update(issue.number, { status: 'done' }, 'alice');
    await f.subscriptions.replay();
    const failing = {
        queueFromApp: async (input: Parameters<NotificationService['queueFromApp']>[0]) => {
            await f.platform.notifications.queueFromApp(input);
            throw Error('interrupted before claim commit');
        },
    };
    await expect(f.subscriptions.flush(failing)).rejects.toThrow('interrupted before claim commit');
    expect(f.count('notifications')).toBe(0);
    expect(f.count('notification_in_app')).toBe(0);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.workspace.db.prepare('SELECT claimedAt FROM issue_watch_outbox').get()).toMatchObject({ claimedAt: null });
    await f.run();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.count('notifications')).toBe(1);
});

it('does not notify for rolled-back issue changes and never sends before the claim commits', async () => {
    const f = await setup();
    const issue = await f.make();
    await f.subscriptions.create('alice', { issues: ['1'] }, source);
    await expect(
        f.workspace.data.uow.run(async () => {
            await f.platform.board.issues.update(issue.number, { status: 'done' }, 'alice');
            throw Error('rollback status');
        }),
    ).rejects.toThrow('rollback status');
    await f.run();
    expect(f.send).not.toHaveBeenCalled();
    await f.platform.board.issues.update(issue.number, { status: 'done' }, 'alice');
    await f.subscriptions.replay();
    const original = f.platform.notifications.queueFromApp.bind(f.platform.notifications);
    await f.subscriptions.flush({
        queueFromApp: async (input) => {
            await original(input);
            expect(f.send).not.toHaveBeenCalled();
        },
    });
    expect(await f.platform.notifications.waitForAppDeliveries()).toBe(true);
    expect(f.send).toHaveBeenCalledTimes(1);
});

it('keeps ownership private and cancels deleted/deactivated recipients before delivery', async () => {
    const f = await setup();
    const issue = await f.make();
    const created = await f.subscriptions.create('alice', { issues: ['1'] }, source);
    expect((await f.subscriptions.list('bob')).items).toEqual([]);
    await expect(f.subscriptions.cancel('bob', created.watch.id)).rejects.toMatchObject({ status: 404 });
    await f.platform.board.issues.update(issue.number, { status: 'done' }, 'alice');
    await f.subscriptions.replay();
    f.workspace.useDeactivated(() => ['alice']);
    await f.subscriptions.flush(f.platform.notifications);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.workspace.db.prepare('SELECT state,cancelReason FROM issue_watches').get()).toMatchObject({
        state: 'cancelled',
        cancelReason: 'person_unavailable',
    });
    await expect(f.subscriptions.list('alice')).rejects.toMatchObject({
        status: 403,
    });
});

it('respects disabled/private channels and retains an in-app fallback on failed external delivery', async () => {
    const f = await setup();
    const issue = await f.make();
    await f.subscriptions.create('alice', { issues: ['1'] }, source);
    f.workspace.setPreferences('alice', {
        notifications: { fixture: { enabled: true, content: 'private' } },
    });
    await f.platform.board.issues.update(issue.number, { status: 'done' }, 'alice');
    await f.run();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.send.mock.calls)).not.toContain('CB-1');
    const next = await f.make('Next watched issue');
    await f.subscriptions.create('alice', { issues: ['2'] }, source);
    f.workspace.setPreferences('alice', {
        notifications: { fixture: { enabled: false, content: 'message' } },
    });
    await f.platform.board.issues.update(next.number, { status: 'done' }, 'alice');
    await f.run();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.count('notification_in_app')).toBe(2);
    const third = await f.make('Failed delivery');
    await f.subscriptions.create('alice', { issues: ['3'] }, source);
    f.workspace.setPreferences('alice', {
        notifications: { fixture: { enabled: true, content: 'message' } },
    });
    f.send.mockRejectedValueOnce(Error('simulated delivery interruption'));
    await f.platform.board.issues.update(third.number, { status: 'done' }, 'alice');
    await f.run();
    expect(f.count('notification_in_app')).toBe(3);
    expect(f.send).toHaveBeenCalledTimes(2);
    await f.run();
    expect(f.send).toHaveBeenCalledTimes(2);
});

it('preserves later events when a watch has more than one bounded replay batch', async () => {
    const f = await setup();
    const a = await f.make(),
        b = await f.make();
    await f.subscriptions.create('alice', { issues: ['1', '2'] }, source);
    for (let i = 0; i < 201; i++) {
        await f.platform.board.issues.update(a.number, { status: i % 2 === 0 ? 'ready' : 'open' }, 'alice');
    }
    await f.platform.board.issues.update(a.number, { status: 'done' }, 'alice');
    await f.platform.board.issues.update(b.number, { status: 'done' }, 'alice');
    await f.run();
    expect(f.send).not.toHaveBeenCalled();
    await f.run();
    expect(f.send).toHaveBeenCalledTimes(1);
});

it('internal tools bind the current person, preserve board permissions and reject recipient spoofing', async () => {
    const f = await setup();
    await f.make();
    const dot = f.workspace.dots()[0]!;
    const turn = {
        dot,
        userId: 'alice',
        threadId: 'private-thread',
        purpose: 'chat',
        check: () => {},
        signal: new AbortController().signal,
    } as unknown as DotTurn;
    expect(issueSubscriptionTools(f.subscriptions, turn)).toEqual([]);
    const tools = issueSubscriptionTools(f.subscriptions, {
        ...turn,
        dot: { ...dot, issuesAllowed: true },
    });
    const subscribe = tools.find((t) => t.name === 'subscribe_to_issues')! as unknown as {
        execute: (input: unknown) => Promise<unknown>;
    };
    expect(await subscribe.execute({ issues: ['1'] })).toMatchObject({
        outcome: 'subscribed',
    });
    await expect(subscribe.execute({ issues: ['1'], userId: 'bob' })).rejects.toThrow();
    const ownOnly = issueSubscriptionTools(f.subscriptions, {
        ...turn,
        dot: { ...dot, issuesAllowed: true, ownerId: 'bob' },
    });
    await expect(
        (ownOnly[0] as unknown as { execute: (input: unknown) => Promise<unknown> }).execute({ issues: ['1'] }),
    ).rejects.toMatchObject({ status: 403 });
});

it('cancels an unreadable deleted member even after the outbox is ready and lets owners cancel queued notices', async () => {
    const f = await setup();
    const first = await f.make();
    await f.subscriptions.create('alice', { issues: ['1'] }, source);
    await f.platform.board.issues.update(first.number, { status: 'done' }, 'alice');
    await f.subscriptions.replay();
    await f.platform.board.issues.remove(first.number, 'alice');
    await f.subscriptions.flush(f.platform.notifications);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.count('notifications')).toBe(0);
    expect((await f.subscriptions.list('alice')).items).toMatchObject([
        { state: 'cancelled', cancelReason: 'issue_unavailable' },
    ]);
    const second = await f.make();
    const pending = await f.subscriptions.create('alice', { issues: [String(second.number)] }, source);
    await f.platform.board.issues.update(second.number, { status: 'done' }, 'alice');
    await f.subscriptions.replay();
    await f.subscriptions.cancel('alice', pending.watch.id);
    await f.subscriptions.flush(f.platform.notifications);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.count('notifications')).toBe(0);
});

it('bounds explicit groups and active watches and leaves no partial rows for unavailable members', async () => {
    const f = await setup();
    await f.make();
    await expect(f.subscriptions.create('alice', { issues: ['1', '99999'] }, source)).rejects.toMatchObject({
        status: 404,
    });
    expect(f.count('issue_watches')).toBe(0);
    expect(f.count('issue_watch_members')).toBe(0);
    await expect(
        f.subscriptions.create('alice', { issues: Array.from({ length: 21 }, () => '1') }, source),
    ).rejects.toThrow();
    for (let i = 0; i < 50; i++) {
        if (i) {
            await f.make();
        }
        await f.subscriptions.create('alice', { issues: [String(i + 1)] }, source);
    }
    await f.make();
    await expect(f.subscriptions.create('alice', { issues: ['51'] }, source)).rejects.toMatchObject({ status: 409 });
    expect(f.count('issue_watches')).toBe(50);
});

it('uses the real after-commit module subscription without a polling reminder or replaying rolled-back changes', async () => {
    const { issuesModule } = await import('../src/server/issues/module.js');
    const f = await setup();
    const issue = await f.make();
    await f.subscriptions.create('alice', { issues: ['1'] }, source);
    const context = {
        db: f.workspace.db,
        data: f.workspace.data,
        platform: f.platform,
        store: f.platform.store,
        workspace: f.workspace,
        config: f.platform.config,
        services: f.platform.context.services,
        log: () => {},
    };
    await issuesModule.start!(context);
    cleanup.push(() => issuesModule.stop!(context));
    await expect(
        f.workspace.data.uow.run(async () => {
            await f.platform.board.issues.update(issue.number, { status: 'done' }, 'alice');
            throw Error('rolled back');
        }),
    ).rejects.toThrow();
    expect(f.send).not.toHaveBeenCalled();
    await f.platform.board.issues.update(issue.number, { status: 'done' }, 'alice');
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    await issuesModule.stop!(context);
    await f.platform.board.issues.update(issue.number, { status: 'open' }, 'alice');
    await f.platform.board.issues.update(issue.number, { status: 'done' }, 'alice');
    expect(f.send).toHaveBeenCalledTimes(1);
});

it('never makes an issue status write wait for a slow notification channel', async () => {
    const { issuesModule } = await import('../src/server/issues/module.js');
    const f = await setup();
    const issue = await f.make();
    await f.subscriptions.create('alice', { issues: ['1'] }, source);
    const context = {
        db: f.workspace.db,
        data: f.workspace.data,
        platform: f.platform,
        store: f.platform.store,
        workspace: f.workspace,
        config: f.platform.config,
        services: f.platform.context.services,
        log: () => {},
    };
    let release: ((value: { outcome: 'sent' }) => void) | undefined;
    f.send.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                release = resolve;
            }),
    );
    await issuesModule.start!(context);
    let writeFinished = false;
    const write = f.platform.board.issues.update(issue.number, { status: 'done' }, 'alice').then(() => {
        writeFinished = true;
    });
    try {
        await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
        expect(writeFinished).toBe(true);
    } finally {
        release?.({ outcome: 'sent' });
        await write;
        await issuesModule.stop!(context);
    }
});

it.each(['send', 'targets', 'note'] as const)(
    'keeps durable watches and shutdown independent of stalled %s, including late completion after DB close',
    async (stage) => {
        const { issuesModule } = await import('../src/server/issues/module.js');
        const f = await setup();
        const a = await f.make(),
            b = await f.make();
        await f.subscriptions.create('alice', { issues: ['1'] }, source);
        await f.subscriptions.create('alice', { issues: ['2'] }, source);
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let entered = false;
        if (stage === 'send') {
            f.send.mockImplementationOnce(async () => {
                entered = true;
                await held;
                return { outcome: 'sent' };
            });
        } else {
            let first = true;
            f.platform.notifications.register({
                id: 'stall',
                label: 'Stalled discovery',
                targets: async () => {
                    if (stage === 'targets' && first) {
                        first = false;
                        entered = true;
                        await held;
                    }
                    return [];
                },
                note: async () => {
                    if (stage === 'note' && first) {
                        first = false;
                        entered = true;
                        await held;
                    }
                    return 'No target';
                },
                send: async () => ({ outcome: 'sent' }),
            });
        }
        const context = {
            db: f.workspace.db,
            data: f.workspace.data,
            platform: f.platform,
            store: f.platform.store,
            workspace: f.workspace,
            config: f.platform.config,
            services: f.platform.context.services,
            log: () => {},
        };
        await issuesModule.start!(context);
        await f.platform.board.issues.update(a.number, { status: 'done' }, 'alice');
        await vi.waitFor(() => expect(entered).toBe(true));
        await f.platform.board.issues.update(b.number, { status: 'done' }, 'alice');
        await vi.waitFor(() => {
            expect(f.count('notification_in_app')).toBe(2);
            expect(
                f.workspace.db.prepare('SELECT COUNT(*) n FROM issue_watch_outbox WHERE claimedAt IS NOT NULL').get(),
            ).toMatchObject({ n: 2 });
        });
        const notifications = f.platform.notifications;
        const addDelivery = vi.spyOn(
            (
                notifications as unknown as {
                    repos: {
                        notifications: { addDelivery: (...args: unknown[]) => unknown };
                    };
                }
            ).repos.notifications,
            'addDelivery',
        );
        await issuesModule.stop!(context);
        expect(notifications.appDeliveryStatus()).toMatchObject({
            accepting: false,
            running: 1,
            abortRequested: 1,
        });
        await f.close();
        addDelivery.mockClear();
        release();
        expect(await notifications.waitForAppDeliveries()).toBe(true);
        expect(addDelivery).not.toHaveBeenCalled();
    },
);

it('uses the current privacy choice after delayed discovery, before any send', async () => {
    const f = await setup();
    const issue = await f.make();
    await f.subscriptions.create('alice', { issues: ['1'] }, source);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    let entered = false;
    f.platform.notifications.register({
        id: 'fixture',
        label: 'Fixture',
        targets: async () => {
            entered = true;
            await held;
            return [{ id: 'target-alice', label: 'Fixture' }];
        },
        send: f.send,
    });
    await f.platform.board.issues.update(issue.number, { status: 'done' }, 'alice');
    await f.subscriptions.replay();
    await f.subscriptions.flush(f.platform.notifications);
    await vi.waitFor(() => expect(entered).toBe(true));
    f.workspace.setPreferences('alice', {
        notifications: { fixture: { enabled: true, content: 'private' } },
    });
    release();
    expect(await f.platform.notifications.waitForAppDeliveries()).toBe(true);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.send.mock.calls)).not.toContain('CB-1');
});
