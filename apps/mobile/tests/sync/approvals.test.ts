import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthedFetch, AuthedRequestInit } from '../../src/net/authed-fetch';
import { NetworkError } from '../../src/net/errors';
import {
    APPROVAL_CARRYING_POLL_MS,
    APPROVAL_POLL_MS,
    type ApprovalActionsOptions,
    approvalRule,
    createApprovalActions,
    RECONCILE_CONCURRENCY,
} from '../../src/sync/approval-actions';
import { APPROVALS, APPROVALS_SNAPSHOT } from '../../src/sync/approvals';
import { SnapshotShapeError } from '../../src/sync/errors';
import { APPROVALS_KIND } from '../../src/sync/kinds';
import type { WriteHold } from '../../src/sync/session';
import { createSnapshotSource } from '../../src/sync/snapshot-source';

import { fakeAppState, fakeNetwork, OFFLINE, WIFI } from './fakes';
import { approval, syncSetup } from './helpers';

// Approvals against the fake server (tests/sync/helpers.ts answers approvals as
// src/server/approvals does: a plain c.json list, and 409s and 404s with a
// sentence and no code): the approvals kind, and decisions online only.

type Setup = Awaited<ReturnType<typeof syncSetup>>;
const open: Setup[] = [];
const disposers: (() => void)[] = [];
afterEach(async () => {
    vi.useRealTimers();
    for (const dispose of disposers.splice(0)) {
        dispose();
    }
    for (const s of open.splice(0)) {
        await s.close().catch(() => {});
    }
});

interface Sent {
    path: string;
    method: string;
}

/** A signed-in setup with the approvals pulled, and the actions over a fetch that records every request. */
async function setup(options: Partial<ApprovalActionsOptions> & { pull?: boolean } = {}) {
    const s = await syncSetup();
    open.push(s);
    const source = createSnapshotSource({
        definition: APPROVALS_SNAPSHOT,
        cache: s.cache,
        fetch: s.authed,
        signal: s.scope.signal,
    });
    if (options.pull !== false) {
        await source.pull('', null);
    }
    const sent: Sent[] = [];
    /** Throws a NetworkError in place of the next POST, after the server took it when `landed`. */
    let breakNext: { landed: boolean } | null = null;
    const fetch: AuthedFetch = async (input: string, init?: AuthedRequestInit) => {
        const method = init?.method ?? 'GET';
        sent.push({ path: input, method });
        if (method === 'POST' && breakNext !== null) {
            const { landed } = breakNext;
            breakNext = null;
            if (landed) {
                await s.authed(input, init);
            }
            throw new NetworkError(input);
        }
        return s.authed(input, init);
    };
    const appState = fakeAppState();
    const network = fakeNetwork(WIFI);
    let away = false;
    let hold: WriteHold = null;
    const feedback: string[] = [];
    const actions = createApprovalActions({
        fetch,
        cache: s.cache,
        appState,
        network,
        away: () => away,
        hold: () => hold,
        feedback: (kind) => feedback.push(kind),
        ...options,
    });
    disposers.push(() => actions.dispose());
    // The network's first state (NetInfo.fetch) has settled.
    await Promise.resolve();
    return Object.assign(s, {
        source,
        actions,
        sent,
        appState,
        network,
        feedback,
        posts: () => sent.filter((request) => request.method === 'POST'),
        reads: (id: string) =>
            sent.filter((request) => request.method === 'GET' && request.path === `/api/approvals/${id}`),
        breakNext(landed = true) {
            breakNext = { landed };
        },
        setAway(value: boolean) {
            away = value;
        },
        setHold(value: WriteHold) {
            hold = value;
        },
        item: (id: string) => s.server.data.approvals.find((entry) => entry.id === id)!,
        row: (id: string) =>
            JSON.parse(s.cache.rows(APPROVALS).get(id)?.json ?? 'null') as Record<string, unknown> | null,
    });
}

describe('the approvals kind', () => {
    it('fills the requests waiting and the recent decisions by id, pulled with the shell and every 60 s in view', async () => {
        const s = await setup({ pull: false });
        const first = await s.source.pull('', null);
        expect(first.outcome).toBe('changed');
        expect([...s.cache.rows(APPROVALS).keys()].sort()).toEqual(['a1', 'a2']);
        expect(s.row('a2')).toMatchObject({ status: 'pending' });
        expect(s.server.requests.at(-1)).toMatchObject({ path: '/api/approvals', ifNoneMatch: undefined });
        // No ETag: the hash of an unchanged body applies nothing.
        expect((await s.source.pull('', s.source.cursor())).outcome).toBe('not-modified');

        s.server.data.approvals = [approval('a2', 'denied')];
        const changed = await s.source.pull('', s.source.cursor());
        expect(changed.removes.map(({ key }) => key)).toEqual(['a1']);
        expect(s.row('a2')).toMatchObject({ status: 'denied' });

        expect(APPROVALS_KIND).toMatchObject({ visiblePoll: 60_000, collections: [APPROVALS] });
        expect(APPROVALS_KIND.inView).toBeUndefined();
    });

    it('refuses a body that isn’t the page', () => {
        const page = { capabilities: [], pending: [], recent: [], policies: [], audit: [] };
        expect(() => APPROVALS_SNAPSHOT.split(page)).not.toThrow();
        expect(() => APPROVALS_SNAPSHOT.split({ ...page, pending: undefined })).toThrow(SnapshotShapeError);
        expect(() => APPROVALS_SNAPSHOT.split({ ...page, recent: [{ status: 'approved' }] })).toThrow(
            SnapshotShapeError,
        );
    });
});

describe('decisions, online only', () => {
    it('never calls the fetch offline, while the server is away, or while writes wait for a sign-in or an update', async () => {
        const s = await setup();
        const before = s.sent.length;
        const tryAll = async () => [
            await s.actions.decide('a2', 'approve'),
            await s.actions.decide('a2', 'deny'),
            await s.actions.openDetails('a2'),
            await s.actions.undo('a1'),
        ];

        s.network.set(OFFLINE);
        expect(s.actions.blocked()).toBe('offline');
        expect(await tryAll()).toEqual(Array(4).fill({ kind: 'blocked', reason: 'offline' }));
        s.network.set(WIFI);

        s.setAway(true);
        expect(await tryAll()).toEqual(Array(4).fill({ kind: 'blocked', reason: 'away' }));
        s.setAway(false);

        for (const hold of ['sign-in', 'update'] as const) {
            s.setHold(hold);
            expect(await tryAll()).toEqual(Array(4).fill({ kind: 'blocked', reason: hold }));
        }
        s.setHold(null);

        expect(s.sent.length).toBe(before);
        expect(s.feedback).toEqual([]);
        expect(s.item('a2').status).toBe('pending');
    });

    it('tells its listeners when the connection changes, so the card and the bar say "Needs a connection"', async () => {
        const s = await setup();
        const told = vi.fn();
        disposers.push(s.actions.subscribe(told));
        s.network.set(OFFLINE);
        expect(told).toHaveBeenCalledTimes(1);
        s.network.set(OFFLINE);
        expect(told).toHaveBeenCalledTimes(1);
        s.network.set(WIFI);
        expect(told).toHaveBeenCalledTimes(2);
        expect(s.actions.blocked()).toBeNull();
    });

    it('approves online: the row is the answer, with a success haptic', async () => {
        const s = await setup();
        const outcome = await s.actions.decide('a2', 'approve');
        expect(outcome).toMatchObject({ kind: 'done', view: { id: 'a2', status: 'approved' } });
        expect(s.posts()).toEqual([{ path: '/api/approvals/a2/decision', method: 'POST' }]);
        expect(s.server.requests.at(-1)).toMatchObject({ body: { decision: 'approve' } });
        expect(s.row('a2')).toMatchObject({ status: 'approved', decidedVia: 'user' });
        expect(s.actions.state('a2')).toEqual({ busy: null, unconfirmed: false });
        expect(s.feedback).toEqual(['success']);
    });

    it('sends one request at a time per request', async () => {
        const s = await setup();
        const first = s.actions.decide('a2', 'approve');
        expect(s.actions.state('a2').busy).toBe('approve');
        expect(await s.actions.decide('a2', 'deny')).toEqual({ kind: 'busy' });
        await first;
        expect(s.posts()).toHaveLength(1);
    });

    it('a request cut off by airplane mode is read once on return, never sent again', async () => {
        const s = await setup();
        s.breakNext(true);
        const outcome = s.actions.decide('a2', 'approve');
        s.network.set(OFFLINE);
        expect(await outcome).toEqual({ kind: 'unconfirmed' });
        expect(s.actions.state('a2')).toEqual({ busy: null, unconfirmed: true });
        expect(s.feedback).toEqual(['error']);

        // Still offline: nothing goes; back online but before the read, Approve sends nothing either.
        expect(await s.actions.decide('a2', 'approve')).toEqual({ kind: 'blocked', reason: 'offline' });
        expect(s.reads('a2')).toHaveLength(0);

        s.network.set(WIFI);
        await vi.waitFor(() => expect(s.actions.state('a2').unconfirmed).toBe(false));
        expect(s.reads('a2')).toHaveLength(1);
        expect(s.posts()).toHaveLength(1);
        // The server had taken it: the read says so.
        expect(s.row('a2')).toMatchObject({ status: 'approved' });
    });

    it('reads a request cut off before the server took it at once when online, then a new decision may go', async () => {
        const s = await setup();
        s.breakNext(false);
        expect(await s.actions.decide('a2', 'deny')).toEqual({ kind: 'unconfirmed' });
        await vi.waitFor(() => expect(s.actions.state('a2').unconfirmed).toBe(false));
        expect(s.reads('a2')).toHaveLength(1);
        // The server never had it: still waiting, and a new decision may go.
        expect(s.row('a2')).toMatchObject({ status: 'pending' });
        expect(await s.actions.decide('a2', 'deny')).toMatchObject({ kind: 'done', view: { status: 'denied' } });
        expect(s.posts()).toHaveLength(2);
    });

    it('reads a request decided elsewhere again after the 409, by its status alone', async () => {
        const s = await setup();
        // Decided on the web since the pull: the row still says pending.
        Object.assign(s.item('a2'), { status: 'approved', decidedVia: 'user' });
        const outcome = await s.actions.decide('a2', 'deny');
        expect(outcome).toMatchObject({ kind: 'refused', view: { status: 'approved' } });
        expect(s.reads('a2')).toHaveLength(1);
        expect(s.row('a2')).toMatchObject({ status: 'approved' });
        expect(s.feedback).toEqual(['error']);
        // Now the row says decided: nothing more is sent.
        expect(await s.actions.decide('a2', 'deny')).toEqual({ kind: 'not-allowed', reason: 'decided' });
        expect(s.posts()).toHaveLength(1);
    });

    it('a 404 drops the request', async () => {
        const s = await setup();
        s.server.data.approvals = s.server.data.approvals.filter((item) => item.id !== 'a2');
        expect(await s.actions.decide('a2', 'approve')).toEqual({ kind: 'refused', view: null });
        expect(s.cache.rows(APPROVALS).has('a2')).toBe(false);
        expect(s.actions.view('a2')).toBeUndefined();
        expect(s.actions.gone('a2')).toBe(true);
    });

    it('blocks Approve until the details are opened; Deny needs no opening', async () => {
        const s = await setup({ pull: false });
        s.server.data.approvals = [
            approval('long', 'pending', { review: { mustOpen: true, opened: false } }),
            approval('other', 'pending', { review: { mustOpen: true, opened: false } }),
        ];
        await s.source.pull('', null);
        expect(await s.actions.decide('long', 'approve')).toEqual({ kind: 'not-allowed', reason: 'open-first' });
        expect(s.posts()).toHaveLength(0);

        expect(await s.actions.openDetails('long')).toEqual({
            kind: 'opened',
            full: 'The full details of long.',
            view: expect.objectContaining({ id: 'long', review: { mustOpen: true, opened: true } }),
        });
        expect(s.actions.view('long')?.review).toEqual({ mustOpen: true, opened: true });
        expect(await s.actions.decide('long', 'approve')).toMatchObject({ kind: 'done', view: { status: 'approved' } });
        expect(await s.actions.decide('other', 'deny')).toMatchObject({ kind: 'done', view: { status: 'denied' } });
        expect(s.posts().map((post) => post.path)).toEqual([
            '/api/approvals/long/open',
            '/api/approvals/long/decision',
            '/api/approvals/other/decision',
        ]);
    });

    it('undoes only an automatic approval that can be', async () => {
        const auto = { verdict: 'approved', undoable: true, undoneAt: null, reason: 'Routine', cause: 'model' };
        const s = await setup({ pull: false });
        s.server.data.approvals = [
            approval('by-hand', 'approved'),
            approval('auto', 'approved', { decidedVia: 'auto', auto }),
            approval('fixed', 'approved', { decidedVia: 'auto', auto: { ...auto, undoable: false } }),
        ];
        await s.source.pull('', null);
        expect(await s.actions.undo('by-hand')).toEqual({ kind: 'not-allowed', reason: 'not-undoable' });
        expect(await s.actions.undo('fixed')).toEqual({ kind: 'not-allowed', reason: 'not-undoable' });
        expect(await s.actions.undo('unknown')).toEqual({ kind: 'not-allowed', reason: 'not-undoable' });
        expect(s.posts()).toHaveLength(0);

        expect(await s.actions.undo('auto')).toMatchObject({ kind: 'done', view: { auto: { undoable: false } } });
        expect(await s.actions.undo('auto')).toEqual({ kind: 'not-allowed', reason: 'not-undoable' });
        expect(s.posts()).toEqual([{ path: '/api/approvals/auto/undo', method: 'POST' }]);
        // Undo is no decision: no haptic.
        expect(s.feedback).toEqual([]);
    });

    it('keeps the card’s rules', () => {
        const view = approval('x') as unknown as Parameters<typeof approvalRule>[0];
        expect(approvalRule(view, 'approve')).toBeNull();
        expect(approvalRule(undefined, 'approve')).toBeNull();
        expect(approvalRule({ ...view!, status: 'expired' }, 'deny')).toBe('decided');
        // Details open on any request with a review, decided or not; none without one.
        expect(approvalRule({ ...view!, status: 'expired' }, 'open')).toBe('no-details');
        const reviewed = { ...view!, review: { mustOpen: true, opened: false } };
        expect(approvalRule({ ...reviewed, status: 'expired' }, 'open')).toBeNull();
        expect(approvalRule(reviewed, 'open')).toBeNull();
    });

    it('opens details it doesn’t hold: the server’s `{ full }`, then the request read again', async () => {
        const s = await setup({ pull: false });
        s.server.data.approvals = [
            approval('far', 'approved', { review: { mustOpen: true, opened: false } }),
            approval('plain', 'pending'),
        ];
        expect(await s.actions.openDetails('far')).toEqual({
            kind: 'opened',
            full: 'The full details of far.',
            view: expect.objectContaining({ id: 'far', review: { mustOpen: true, opened: true } }),
        });
        // Not held, and decided: kept in memory, not in the collection.
        expect(s.actions.view('far')?.review?.opened).toBe(true);
        // A request with no review: the server's 404, read again, still there.
        expect(await s.actions.openDetails('plain')).toMatchObject({ kind: 'refused', view: { id: 'plain' } });
        expect(s.posts().map((post) => post.path)).toEqual(['/api/approvals/far/open', '/api/approvals/plain/open']);
        // Once held, the rule refuses it with no request.
        expect(await s.actions.openDetails('plain')).toEqual({ kind: 'not-allowed', reason: 'no-details' });
        expect(s.posts()).toHaveLength(2);
    });
});

describe('a shown request', () => {
    it('is read every 5 s while it waits, every 2 s while its socio carries on, then no more', async () => {
        vi.useFakeTimers();
        const s = await setup();
        const leave = s.actions.watch('a2');
        expect(s.reads('a2')).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(APPROVAL_POLL_MS);
        expect(s.reads('a2')).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(APPROVAL_POLL_MS);
        expect(s.reads('a2')).toHaveLength(2);

        // Approved: the socio carries on with nothing else to wait for.
        await s.actions.decide('a2', 'approve');
        await vi.advanceTimersByTimeAsync(APPROVAL_CARRYING_POLL_MS);
        expect(s.reads('a2')).toHaveLength(3);

        // Waiting for two other requests of the turn: every 5 s again.
        Object.assign(s.item('a2'), { continuation: { status: 'waiting', id: null, detail: null, waitingFor: 2 } });
        await vi.advanceTimersByTimeAsync(APPROVAL_CARRYING_POLL_MS);
        expect(s.reads('a2')).toHaveLength(4);
        await vi.advanceTimersByTimeAsync(APPROVAL_CARRYING_POLL_MS);
        expect(s.reads('a2')).toHaveLength(4);
        await vi.advanceTimersByTimeAsync(APPROVAL_POLL_MS - APPROVAL_CARRYING_POLL_MS);
        expect(s.reads('a2')).toHaveLength(5);

        // Carried on: done, so the polling stops.
        Object.assign(s.item('a2'), { continuation: { status: 'done', id: 'n1', detail: null, waitingFor: 0 } });
        await vi.advanceTimersByTimeAsync(APPROVAL_POLL_MS);
        expect(s.reads('a2')).toHaveLength(6);
        await vi.advanceTimersByTimeAsync(APPROVAL_POLL_MS * 3);
        expect(s.reads('a2')).toHaveLength(6);
        leave();
    });

    it('isn’t read in the background, offline, or once no screen shows it', async () => {
        vi.useFakeTimers();
        const s = await setup();
        const leave = s.actions.watch('a2');
        // Under 10 s, so coming back isn't a return (which asks about every request waiting).
        s.appState.set('background');
        await vi.advanceTimersByTimeAsync(APPROVAL_POLL_MS + 1_000);
        s.appState.set('active');
        s.network.set(OFFLINE);
        await vi.advanceTimersByTimeAsync(APPROVAL_POLL_MS * 2);
        expect(s.reads('a2')).toHaveLength(0);
        s.network.set(WIFI);
        await vi.advanceTimersByTimeAsync(APPROVAL_POLL_MS);
        expect(s.reads('a2')).toHaveLength(1);
        leave();
        leave();
        await vi.advanceTimersByTimeAsync(APPROVAL_POLL_MS * 3);
        expect(s.reads('a2')).toHaveLength(1);
    });

    it('is read at once when the device knows nothing of it', async () => {
        const s = await setup();
        s.server.data.approvals.push(approval('old', 'approved'));
        const leave = s.actions.watch('old');
        await vi.waitFor(() => expect(s.actions.view('old')).toMatchObject({ status: 'approved' }));
        // A decided request the list doesn't hold stays out of the collection.
        expect(s.cache.rows(APPROVALS).has('old')).toBe(false);
        leave();
    });

    it('says a request the server doesn’t have is gone, and stops reading it until it is shown anew', async () => {
        vi.useFakeTimers();
        const s = await setup();
        expect(s.actions.gone('nope')).toBe(false);
        const leave = s.actions.watch('nope');
        await vi.advanceTimersByTimeAsync(0);
        expect(s.reads('nope')).toHaveLength(1);
        expect(s.actions.gone('nope')).toBe(true);
        expect(s.actions.view('nope')).toBeUndefined();
        await vi.advanceTimersByTimeAsync(APPROVAL_POLL_MS * 3);
        expect(s.reads('nope')).toHaveLength(1);
        leave();

        // It turns up: shown again, it is read again and no longer gone.
        s.server.data.approvals.push(approval('nope', 'pending'));
        const again = s.actions.watch('nope');
        await vi.advanceTimersByTimeAsync(0);
        expect(s.reads('nope')).toHaveLength(2);
        expect(s.actions.gone('nope')).toBe(false);
        expect(s.actions.view('nope')).toMatchObject({ status: 'pending' });
        again();
    });
});

describe('on resume', () => {
    it('asks about each request still waiting, four at a time, after 10 s or more in the background', async () => {
        vi.useFakeTimers();
        const s = await setup({ pull: false });
        s.server.data.approvals = Array.from({ length: 6 }, (_, index) => approval(`p${index}`));
        s.server.data.approvals.push(approval('done', 'approved'));
        await s.source.pull('', null);

        // A picker's 5 s isn't a return.
        s.appState.set('background');
        await vi.advanceTimersByTimeAsync(5_000);
        s.appState.set('active');
        await vi.advanceTimersByTimeAsync(0);
        expect(s.sent.filter((request) => request.path.startsWith('/api/approvals/'))).toHaveLength(0);

        let inFlight = 0;
        let most = 0;
        const fetch: AuthedFetch = async (input, init) => {
            inFlight += 1;
            most = Math.max(most, inFlight);
            try {
                await new Promise((resolve) => setTimeout(resolve, 100));
                return await s.authed(input, init);
            } finally {
                inFlight -= 1;
            }
        };
        const counted = createApprovalActions({
            fetch,
            cache: s.cache,
            appState: s.appState,
            network: s.network,
            away: () => false,
            hold: () => null,
        });
        disposers.push(() => counted.dispose());
        s.server.data.approvals[0]!.status = 'denied';
        s.appState.set('background');
        await vi.advanceTimersByTimeAsync(11_000);
        s.appState.set('active');
        await vi.advanceTimersByTimeAsync(1_000);
        expect(most).toBe(RECONCILE_CONCURRENCY);
        const asked = new Set(
            s.server.requests.filter((request) => /^\/api\/approvals\/p\d$/.test(request.path)).map((r) => r.path),
        );
        expect([...asked].sort()).toEqual(Array.from({ length: 6 }, (_, index) => `/api/approvals/p${index}`));
        expect(s.row('p0')).toMatchObject({ status: 'denied' });
    });

    it('gives up a read after 10 s, leaving the row as it was', async () => {
        vi.useFakeTimers();
        const s = await setup();
        const stuck: AuthedFetch = (input, init) =>
            new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
        const actions = createApprovalActions({
            fetch: stuck,
            cache: s.cache,
            appState: s.appState,
            network: s.network,
            away: () => false,
            hold: () => null,
        });
        disposers.push(() => actions.dispose());
        let settled = false;
        void actions.reconcile().then(() => {
            settled = true;
        });
        await vi.advanceTimersByTimeAsync(9_999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toBe(true);
        expect(s.row('a2')).toMatchObject({ status: 'pending' });
    });
});
