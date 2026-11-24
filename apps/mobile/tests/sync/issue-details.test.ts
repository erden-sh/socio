import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Store } from '../../src/data';
import {
    createIssueDetails,
    followIssueList,
    ISSUE_DETAILS_KIND,
    issueLanes,
    issueOfLane,
} from '../../src/sync/issue-details';
import { ISSUE_USERS, ISSUES, ISSUES_SNAPSHOT, USERS_KEY } from '../../src/sync/issues';
import { type OutboxKind, type SendOutcome, UNSENT_GONE } from '../../src/sync/outbox';
import { COALESCE_MS } from '../../src/sync/scheduler';
import { openWorkspaceScope, type WorkspaceScope } from '../../src/sync/scope';
import { createSnapshotSource } from '../../src/sync/snapshot-source';
import { launch, phone, type Phone } from '../helpers/store';
import { clocks, ORIGIN, T0 } from '../net/helpers';

import { fakeAppState, fakeNetwork, WIFI } from './fakes';
import { fakeWorkspaceServer, issue, syncSetup } from './helpers';
import { turns } from './outbox-fakes';
import { signedIn, wire } from './wire';

// Issue details, a
// bounded kind of `GET /api/issues/:number`, against the fake server and a
// real cache.db: read on open; read again only when the list's poll brings a
// newer `updatedAt` or drops the row, never while it is unchanged; a detail
// refreshes its list row; a local key sends nothing; and through the scope, a
// 404 moves a queued comment to the Unsent list.

type Setup = Awaited<ReturnType<typeof syncSetup>>;
const open: Setup[] = [];
afterEach(async () => {
    for (const s of open.splice(0)) {
        await s.close().catch(() => {});
    }
});

async function setup() {
    const s = await syncSetup();
    open.push(s);
    const list = createSnapshotSource({
        definition: ISSUES_SNAPSHOT,
        cache: s.cache,
        fetch: s.authed,
        signal: s.scope.signal,
    });
    const refused: string[][] = [];
    const errors: unknown[] = [];
    const lanes: string[] = [];
    const details = createIssueDetails({
        db: s.db,
        fetch: s.authed,
        signal: s.scope.signal,
        cache: s.cache,
        outbox: () => ({
            rows: () => lanes.map((lane, index) => ({ lane, id: `r${index}` }) as never),
            unsent: () => [],
        }),
        onGone: (gone) => refused.push([...gone]),
        onError: (error) => errors.push(error),
        now: s.clock.device,
    });
    const unfollow = followIssueList(s.cache, details);
    const close = s.close.bind(s);
    s.close = async (options) => {
        unfollow();
        await details.close();
        await close(options);
    };
    const detailRequests = () => s.server.requests.filter((request) => /^\/api\/issues\/\d+$/.test(request.path));
    const pullList = () => list.pull('', list.cursor());
    return Object.assign(s, { list, details, refused, errors, lanes, detailRequests, pullList });
}

describe('issue details', () => {
    it('reads a detail as it opens, then asks nothing while the list’s updatedAt is unchanged', async () => {
        const s = await setup();
        await s.pullList();
        const detail = s.details.item('2');
        const release = detail.use();
        await vi.waitFor(() => expect(detail.state.settled).toBe(true));
        expect(detail.state.value?.issue).toMatchObject({ number: 2, title: 'Search is slow', updatedAt: 20 });
        expect(s.detailRequests()).toHaveLength(1);

        // A 304, then a 200 that changes another issue: no detail request.
        await s.pullList();
        s.server.change('issues', (data) => {
            data.issues = [issue(2, 'Search is slow', 20, { assigneeId: 'u-ada' }), issue(1, 'Login fixed', 11)];
        });
        expect((await s.pullList()).outcome).toBe('changed');
        await turns();
        expect(s.detailRequests()).toHaveLength(1);
        release();
    });

    it('reads a held detail again when the list brings a newer updatedAt', async () => {
        const s = await setup();
        await s.pullList();
        const detail = s.details.item('2');
        const release = detail.use();
        await vi.waitFor(() => expect(detail.state.settled).toBe(true));
        s.server.change('issues', (data) => {
            data.issues = [issue(2, 'Search is fast', 30, { assigneeId: 'u-ada' }), issue(1, 'Login fails', 10)];
        });
        await s.pullList();
        await vi.waitFor(() => expect(detail.state.value?.issue.title).toBe('Search is fast'));
        expect(s.detailRequests()).toHaveLength(2);
        release();
    });

    it('refreshes the issue’s list row and the assignee’s name from a detail (the web’s replace)', async () => {
        const s = await setup();
        await s.pullList();
        // The server moved on; the list hasn't polled since.
        s.server.change('issues', (data) => {
            data.issues = [issue(2, 'Renamed', 40, { assigneeId: 'u-bo' }), issue(1, 'Login fails', 10)];
            data.users = { 'u-ada': 'Ada', 'u-bo': 'Bo' };
        });
        await s.details.item('2').refresh();
        await turns();
        const row = s.cache.rows(ISSUES).get('2');
        expect(row?.version).toBe(40);
        expect(JSON.parse(row?.json ?? 'null')).toMatchObject({ title: 'Renamed', assigneeId: 'u-bo' });
        expect(JSON.parse(s.cache.rows(ISSUE_USERS).get(USERS_KEY)?.json ?? 'null')).toEqual({
            'u-ada': 'Ada',
            'u-bo': 'Bo',
        });
        // The list's next pull is full, and agrees.
        expect(s.list.cursor()).toBeNull();

        // An older detail never sets an older row.
        await s.details.put('2', {
            ...s.details.peek('2')!.state.value!,
            issue: { ...s.details.peek('2')!.state.value!.issue, title: 'Old', updatedAt: 5 },
        });
        expect(JSON.parse(s.cache.rows(ISSUES).get('2')?.json ?? 'null')).toMatchObject({ title: 'Renamed' });
    });

    it('reads again a detail the phone keeps whose row left the list, and a 404 drops it as gone', async () => {
        const s = await setup();
        await s.pullList();
        await s.details.item('1').refresh();
        await s.details.flush();
        s.lanes.push('issue-comments:1', 'chat:c-1');
        s.server.change('issues', (data) => {
            data.issues = data.issues.filter((item) => item.number !== 1);
        });
        s.server.refuseDetail(1, 404);
        await s.pullList();
        await vi.waitFor(() => expect(s.refused).toEqual([issueLanes('1')]));
        expect(s.details.peek('1')?.state.gone).toBe(true);
        await s.details.flush();
        expect(await s.details.stored('1')).toBe(false);
        // An issue the phone never held asks nothing.
        expect(s.detailRequests().filter((request) => request.path === '/api/issues/2')).toEqual([]);
    });

    it('drops every stored detail of a bulk delete past the memory bound, and refuses each one’s lanes', async () => {
        const s = await setup();
        const numbers = Array.from({ length: 10 }, (_, index) => index + 10);
        s.server.change('issues', (data) => {
            data.issues = [...data.issues, ...numbers.map((number) => issue(number, `Issue ${number}`, 5))];
        });
        await s.pullList();
        for (const number of numbers) {
            await s.details.item(String(number)).refresh();
        }
        await s.details.flush();
        for (const number of numbers) {
            expect(await s.details.stored(String(number))).toBe(true);
        }
        // All ten deleted at once: they leave the list, and each detail answers 404.
        s.server.change('issues', (data) => {
            data.issues = data.issues.filter((item) => !numbers.includes(item.number as number));
        });
        await s.pullList();
        await vi.waitFor(() => expect(s.refused).toHaveLength(numbers.length));
        expect(s.refused.map(([lane]) => lane).sort()).toEqual(numbers.map((number) => `issue:${number}`).sort());
        await s.details.flush();
        for (const number of numbers) {
            expect(await s.details.stored(String(number))).toBe(false);
        }
    });

    it('a local key (an issue filed offline) sends no request', async () => {
        const s = await setup();
        const detail = s.details.item('pending-issue-0b1c');
        const release = detail.use();
        expect(await detail.refresh()).toEqual({ outcome: 'local' });
        release();
        expect(s.detailRequests()).toEqual([]);
        expect(s.server.requests.some((request) => request.path.includes('pending-issue'))).toBe(false);
    });

    it('names the issue each of its lanes is for', () => {
        expect(issueLanes('7').map(issueOfLane)).toEqual(['7', '7', '7']);
        expect(issueOfLane('chat:7')).toBeNull();
    });
});

describe('a gone issue with a queued comment (the scope)', () => {
    let device: Phone;
    const scopes: WorkspaceScope[] = [];
    const stores: Store[] = [];

    beforeEach(() => {
        device = phone(mkdtempSync(join(tmpdir(), 'socio-issue-details-')));
        vi.useFakeTimers({ now: T0, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    });
    afterEach(async () => {
        for (const scope of scopes.splice(0)) {
            await scope.dispose();
        }
        for (const store of stores.splice(0)) {
            await store.registry.close().catch(() => {});
        }
        vi.useRealTimers();
        rmSync(device.root, { recursive: true, force: true });
    });

    /** A comment kind that waits on the person, so the row stays queued until the detail says gone. */
    const HELD: OutboxKind<{ number: number; body: string }> = {
        kind: 'issue-comment',
        payloadVersion: 1,
        repeatable: false,
        send: async (): Promise<SendOutcome> => ({ action: 'hold', reason: 'ask' }),
    };

    it('a 404 moves the issue’s comment to unsent ("You no longer have access") and leaves other lanes', async () => {
        const { store } = await launch(device);
        stores.push(store);
        const clock = clocks();
        const server = fakeWorkspaceServer(clock);
        const net = wire(new Map([[ORIGIN, server]]));
        const id = await signedIn(store, ORIGIN, server, clock);
        const errors: unknown[] = [];
        const scope = await openWorkspaceScope({
            store,
            workspaceId: id,
            fetch: net.fetch,
            userAgent: 'Socio/0.1.0 (Pixel 4; Android 13)',
            variant: 'production',
            appState: fakeAppState('active'),
            network: fakeNetwork(WIFI),
            outboxKinds: [HELD] as OutboxKind<unknown>[],
            onError: (error) => errors.push(error),
            random: () => 0.5,
        });
        scopes.push(scope);
        scope.start();
        await vi.advanceTimersByTimeAsync(COALESCE_MS);
        const comment = (rowId: string, number: number) => ({
            id: rowId,
            lane: `issue-comments:${number}`,
            kind: 'issue-comment',
            payload: JSON.stringify({ number, body: 'Still broken here' }),
            payloadVersion: 1,
            idempotencyKey: `key-${rowId}`,
        });
        await scope.outbox.enqueue(comment('c-1', 1));
        await scope.outbox.enqueue(comment('c-2', 2));
        await turns();
        await scope.outbox.idle();

        server.refuseDetail(1, 404);
        expect(await scope.issueDetails.item('1').refresh()).toEqual({ outcome: 'gone', status: 404 });
        await turns();
        await scope.outbox.idle();

        expect(scope.outbox.unsent().map((write) => [write.id, write.reason])).toEqual([['c-1', UNSENT_GONE]]);
        expect(scope.outbox.rows().map((row) => row.id)).toEqual(['c-2']);
        expect(errors).toEqual([]);

        // Its rows live in cache.db, which Clear cache and every wipe take whole.
        await scope.issueDetails.item('2').refresh();
        await scope.issueDetails.flush();
        expect(await scope.issueDetails.stored('2')).toBe(true);
        expect(ISSUE_DETAILS_KIND).toBe('issue-detail');
    });
});
