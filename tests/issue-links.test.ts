import { afterEach, expect, it } from 'vitest';

import type { IssueDetail, IssueList } from '@socio/shared/issues/issue-types';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function fixture() {
    const { workspace, platform, app, dispose } = await makeTestRuntime({
        config: { baseUrl: '', apiKey: '', model: '', runtimeUrl: '' },
        app: {
            auth: {
                provider: new MockAuthProvider(DEFAULT_MOCK_USERS, 'secret-0123456789abcdef-xyz'),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    for (const user of DEFAULT_MOCK_USERS) {
        workspace.recordUser(user);
    }
    const as = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0];
        return async <T = unknown>(path: string, method = 'GET', body?: unknown) => {
            const response = await app.request(`/api${path}`, {
                method,
                headers: {
                    cookie,
                    ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            return {
                status: response.status,
                body: (await response.json()) as T,
            };
        };
    };
    const make = async (title: string) => (await platform.board.issues.create({ title, status: 'open' }, 'bob')).number;
    return { workspace, platform, alice: await as('alice'), bob: await as('bob'), make };
}

it('links an issue to its blockers and shows both ends on the detail', async () => {
    const f = await fixture();
    const one = await f.make('Ship it');
    const two = await f.make('Build it');
    const three = await f.make('Plan it');
    const added = await f.alice<IssueDetail>(`/issues/${one}/blocked-by`, 'POST', { blocker: 'CB-2' });
    expect(added.status).toBe(200);
    expect(added.body.blockedBy).toEqual([{ number: two, title: 'Build it', status: 'open' }]);
    expect(added.body.blocks).toEqual([]);
    await f.alice(`/issues/${one}/blocked-by`, 'POST', { blocker: '3' });
    // Adding the same link again changes nothing.
    await f.alice(`/issues/${one}/blocked-by`, 'POST', { blocker: three });
    const blocker = await f.bob<IssueDetail>(`/issues/${two}`);
    expect(blocker.body.blocks).toEqual([{ number: one, title: 'Ship it', status: 'open' }]);
    expect((await f.bob<IssueDetail>(`/issues/${one}`)).body.blockedBy!.map((ref) => ref.number)).toEqual([two, three]);

    // History rows on both issues, by the admin.
    const events = async (number: number) =>
        (await f.platform.board.issues.events((await f.platform.board.issues.require(number)).id))
            .filter((event) => event.kind === 'blocked_by' || event.kind === 'blocks')
            .map((event) => [event.kind, event.actorId, event.fromValue, event.toValue]);
    expect(await events(one)).toEqual([
        ['blocked_by', 'alice', null, 'CB-2'],
        ['blocked_by', 'alice', null, 'CB-3'],
    ]);
    expect(await events(two)).toEqual([['blocks', 'alice', null, 'CB-1']]);

    const removed = await f.alice<IssueDetail>(`/issues/${one}/blocked-by/CB-2`, 'DELETE');
    expect(removed.body.blockedBy!.map((ref) => ref.number)).toEqual([three]);
    expect(await events(two)).toEqual([
        ['blocks', 'alice', null, 'CB-1'],
        ['blocks', 'alice', 'CB-1', null],
    ]);
    // Removing what is not there is harmless; the link can come back.
    expect((await f.alice(`/issues/${one}/blocked-by/CB-2`, 'DELETE')).status).toBe(200);
    await f.alice(`/issues/${one}/blocked-by`, 'POST', { blocker: two });
    expect((await f.alice<IssueDetail>(`/issues/${one}`)).body.blockedBy).toHaveLength(2);
});

it('is for admins only, like the other triage fields', async () => {
    const f = await fixture();
    const one = await f.make('One');
    const two = await f.make('Two');
    expect((await f.bob(`/issues/${one}/blocked-by`, 'POST', { blocker: two })).status).toBe(403);
    await f.alice(`/issues/${one}/blocked-by`, 'POST', { blocker: two });
    expect((await f.bob(`/issues/${one}/blocked-by/${two}`, 'DELETE')).status).toBe(403);
    // Members still read the links.
    expect((await f.bob<IssueDetail>(`/issues/${one}`)).body.blockedBy).toHaveLength(1);
});

it('refuses self-links, cycles, unknown issues and bad input', async () => {
    const f = await fixture();
    const one = await f.make('One');
    const two = await f.make('Two');
    const three = await f.make('Three');
    const link = (issue: number, blocker: unknown) =>
        f.alice<{ error: string }>(`/issues/${issue}/blocked-by`, 'POST', {
            blocker,
        });
    expect(await link(one, 'CB-1')).toMatchObject({
        status: 400,
        body: { error: 'An issue can’t be blocked by itself.' },
    });
    expect((await link(one, 'CB-2')).status).toBe(200);
    expect((await link(two, 'CB-3')).status).toBe(200);
    // Three waiting for One would close the loop One > Two > Three > One.
    expect(await link(three, 'CB-1')).toMatchObject({
        status: 409,
        body: {
            error: 'CB-1 already waits for CB-3, directly or through other issues, so CB-3 can’t wait for it too.',
        },
    });
    expect(await link(two, 'CB-1')).toMatchObject({ status: 409 });
    expect(await link(one, 'CB-99')).toMatchObject({
        status: 404,
        body: { error: 'There is no CB-99.' },
    });
    expect((await link(one, 'nope')).status).toBe(400);
    expect((await f.alice(`/issues/CB-99/blocked-by`, 'POST', { blocker: 'CB-1' })).status).toBe(404);
    // Lifting a link frees the other direction.
    await f.alice(`/issues/${two}/blocked-by/${three}`, 'DELETE');
    expect((await link(three, 'CB-1')).status).toBe(200);
});

it('counts a blocker as done once it is closed, and keeps links to deleted issues dormant', async () => {
    const f = await fixture();
    const target = await f.make('Target');
    const a = await f.make('Done one');
    const b = await f.make('Dropped one');
    const c = await f.make('Open one');
    for (const blocker of [a, b, c]) {
        await f.alice(`/issues/${target}/blocked-by`, 'POST', { blocker });
    }
    const open = async () =>
        (await f.bob<IssueList>('/issues')).body.issues.find((issue) => issue.number === target)!.openBlockers;
    expect(await open()).toEqual([a, b, c]);
    // Closing a blocker, as done or as won't fix, satisfies it.
    await f.alice(`/issues/${a}`, 'PATCH', { status: 'done' });
    await f.alice(`/issues/${b}`, 'PATCH', { status: 'wont_fix' });
    expect(await open()).toEqual([c]);
    // The list leaves `openBlockers` out when there are none.
    await f.alice(`/issues/${c}`, 'PATCH', { status: 'done' });
    expect(await open()).toBeUndefined();
    // Reopened, it blocks again.
    await f.alice(`/issues/${c}`, 'PATCH', { status: 'open' });
    expect(await open()).toEqual([c]);
    // A deleted blocker is no longer listed or counted; the link returns with it.
    await f.alice(`/issues/${c}`, 'DELETE');
    expect(await open()).toBeUndefined();
    const detail = await f.alice<IssueDetail>(`/issues/${target}`);
    expect(detail.body.blockedBy!.map((ref) => ref.number)).toEqual([a, b]);
    expect(detail.body.blockedBy!.map((ref) => ref.status)).toEqual(['done', 'wont_fix']);
});

it('limits how many blockers one issue has', async () => {
    const f = await fixture();
    const target = await f.make('Target');
    for (let n = 0; n < 20; n++) {
        await f.platform.board.issues.addBlocker(target, await f.make(`Blocker ${n}`), 'alice');
    }
    const extra = await f.make('One too many');
    await expect(f.platform.board.issues.addBlocker(target, extra, 'alice')).rejects.toThrow(/at most 20/);
});

it('moves the issue list for everyone when a link changes', async () => {
    const f = await fixture();
    const one = await f.make('One');
    const two = await f.make('Two');
    const tag = async () =>
        (await f.bob<IssueList>('/issues')).body.issues
            .map((issue) => `${issue.number}:${issue.openBlockers?.length ?? 0}`)
            .join(',');
    expect(await tag()).toBe('2:0,1:0');
    await f.platform.board.issues.addBlocker(one, two, 'alice');
    expect(await tag()).toBe('2:0,1:1');
    await f.platform.board.issues.removeBlocker(one, two, 'alice');
    expect(await tag()).toBe('2:0,1:0');
});

it('gives Dots and connected agents the links where they read an item', async () => {
    const f = await fixture();
    const one = await f.make('Ship it');
    const two = await f.make('Build it, mail ada@example.com');
    await f.platform.board.issues.addBlocker(one, two, 'alice');
    const read = async (number: number) => {
        const found = await f.platform.board.filings.item(`CB-${number}`, {
            userId: 'bob',
        });
        if (found.outcome !== 'found') {
            throw new Error('missing');
        }
        return found;
    };
    expect((await read(one)).blockedBy).toEqual([
        { issue: 'CB-2', title: 'Build it, mail [email removed]', status: 'open' },
    ]);
    expect((await read(one)).blocks).toEqual([]);
    expect((await read(two)).blocks).toEqual([{ issue: 'CB-1', title: 'Ship it', status: 'open' }]);
});

// --- Related links and the link editor (CB-274) -----------------------------

const relatedEvents = async (f: Awaited<ReturnType<typeof fixture>>, number: number) =>
    (await f.platform.board.issues.events((await f.platform.board.issues.require(number)).id))
        .filter((event) => ['related', 'blocked_by', 'blocks'].includes(event.kind))
        .map((event) => [event.kind, event.fromValue, event.toValue]);

it('relates two issues with no direction, listed and recorded on both', async () => {
    const f = await fixture();
    const one = await f.make('Login fails');
    const two = await f.make('Signup fails');
    const put = (issue: number, other: unknown, relation: unknown) =>
        f.alice<IssueDetail>(`/issues/${issue}/links/${other}`, 'PUT', {
            relation,
        });
    const added = await put(one, 'CB-2', 'related');
    expect(added.status).toBe(200);
    expect(added.body.related).toEqual([{ number: two, title: 'Signup fails', status: 'open' }]);
    expect(added.body.blockedBy).toEqual([]);
    expect(added.body.blocks).toEqual([]);
    // The other end lists it too, for members as well.
    expect((await f.bob<IssueDetail>(`/issues/${two}`)).body.related).toEqual([
        { number: one, title: 'Login fails', status: 'open' },
    ]);
    // From either side, again: nothing changes.
    await put(two, one, 'related');
    expect(await relatedEvents(f, one)).toEqual([['related', null, 'CB-2']]);
    expect(await relatedEvents(f, two)).toEqual([['related', null, 'CB-1']]);
    // Removed from the other side.
    const removed = await f.alice<IssueDetail>(`/issues/${two}/links/CB-1`, 'DELETE');
    expect(removed.body.related).toEqual([]);
    expect((await f.bob<IssueDetail>(`/issues/${one}`)).body.related).toEqual([]);
    expect(await relatedEvents(f, one)).toEqual([
        ['related', null, 'CB-2'],
        ['related', 'CB-2', null],
    ]);
    // Removing what is not there is harmless.
    expect((await f.alice(`/issues/${one}/links/${two}`, 'DELETE')).status).toBe(200);
});

it('changes a pair’s link in place: one link per pair, related or blocking', async () => {
    const f = await fixture();
    const one = await f.make('One');
    const two = await f.make('Two');
    const put = (relation: string) => f.alice<IssueDetail>(`/issues/${one}/links/${two}`, 'PUT', { relation });
    const ends = async () => {
        const a = (await f.alice<IssueDetail>(`/issues/${one}`)).body;
        const b = (await f.alice<IssueDetail>(`/issues/${two}`)).body;
        const numbers = (refs?: { number: number }[]) => (refs ?? []).map((ref) => ref.number);
        return {
            one: [numbers(a.blockedBy), numbers(a.blocks), numbers(a.related)],
            two: [numbers(b.blockedBy), numbers(b.blocks), numbers(b.related)],
        };
    };
    await put('related');
    expect(await ends()).toEqual({
        one: [[], [], [two]],
        two: [[], [], [one]],
    });
    // One blocks two: two now waits for one.
    await put('blocks');
    expect(await ends()).toEqual({
        one: [[], [two], []],
        two: [[one], [], []],
    });
    // Turned round: one waits for two.
    await put('blocked_by');
    expect(await ends()).toEqual({
        one: [[two], [], []],
        two: [[], [one], []],
    });
    expect(await f.platform.board.issues.relation(one, two)).toBe('blocked_by');
    expect(await f.platform.board.issues.relation(two, one)).toBe('blocks');
    expect(await relatedEvents(f, one)).toEqual([
        ['related', null, 'CB-2'],
        ['related', 'CB-2', null],
        ['blocks', null, 'CB-2'],
        ['blocks', 'CB-2', null],
        ['blocked_by', null, 'CB-2'],
    ]);
    // Relating a blocking pair directly is refused: change the link instead.
    await expect(f.platform.board.issues.addRelated(one, two, 'alice')).rejects.toThrow(
        'CB-1 already waits for CB-2. Change that link instead.',
    );
    // Adding a blocker to a related pair makes it the blocking link.
    await f.alice(`/issues/${one}/links/${two}`, 'DELETE');
    expect(await ends()).toEqual({ one: [[], [], []], two: [[], [], []] });
    await put('related');
    await f.alice(`/issues/${two}/blocked-by`, 'POST', { blocker: one });
    expect(await ends()).toEqual({
        one: [[], [two], []],
        two: [[one], [], []],
    });
    // The editor's removal lifts a blocking link too.
    await f.alice(`/issues/${two}/links/${one}`, 'DELETE');
    expect(await ends()).toEqual({ one: [[], [], []], two: [[], [], []] });
});

it('keeps the old link when the new one is refused, and checks its input', async () => {
    const f = await fixture();
    const one = await f.make('One');
    const two = await f.make('Two');
    const three = await f.make('Three');
    const put = (issue: number, other: unknown, relation: unknown) =>
        f.alice<{ error: string }>(`/issues/${issue}/links/${other}`, 'PUT', {
            relation,
        });
    // One > Two > Three; Three related to One.
    expect((await put(one, two, 'blocked_by')).status).toBe(200);
    expect((await put(two, three, 'blocked_by')).status).toBe(200);
    expect((await put(three, one, 'related')).status).toBe(200);
    // Three waiting for One would close the loop: refused, still related.
    expect(await put(three, one, 'blocked_by')).toMatchObject({
        status: 409,
        body: {
            error: 'CB-1 already waits for CB-3, directly or through other issues, so CB-3 can’t wait for it too.',
        },
    });
    expect(await f.platform.board.issues.relation(three, one)).toBe('related');
    expect(await put(one, one, 'related')).toMatchObject({
        status: 400,
        body: { error: 'An issue can’t be linked to itself.' },
    });
    expect(await put(one, 'CB-99', 'related')).toMatchObject({
        status: 404,
        body: { error: 'There is no CB-99.' },
    });
    expect((await put(99, one, 'related')).status).toBe(404);
    expect((await put(one, 'nope', 'related')).status).toBe(404);
    for (const relation of ['depends', undefined, 1]) {
        expect((await put(one, three, relation)).status).toBe(400);
    }
    expect(
        (
            await f.alice(`/issues/${one}/links/${three}`, 'PUT', {
                relation: 'related',
                extra: true,
            })
        ).status,
    ).toBe(400);
});

it('lets members relate issues and lift related links, recorded as theirs', async () => {
    const f = await fixture();
    const one = await f.make('One');
    const two = await f.make('Two');
    const added = await f.bob<IssueDetail>(`/issues/${one}/links/CB-${two}`, 'PUT', {
        relation: 'related',
    });
    expect(added.status).toBe(200);
    expect(added.body.related!.map((ref) => ref.number)).toEqual([two]);
    expect(
        (await f.platform.board.issues.events((await f.platform.board.issues.require(two)).id))
            .filter((event) => event.kind === 'related')
            .map((event) => [event.actorId, event.toValue]),
    ).toEqual([['bob', 'CB-1']]);
    // Again, from the other side: nothing changes.
    expect((await f.bob(`/issues/${two}/links/${one}`, 'PUT', { relation: 'related' })).status).toBe(200);
    // A related link an admin made is the member's to lift too.
    const removed = await f.bob<IssueDetail>(`/issues/${two}/links/${one}`, 'DELETE');
    expect(removed.status).toBe(200);
    expect(removed.body.related).toEqual([]);
    await f.alice(`/issues/${one}/links/${two}`, 'PUT', { relation: 'related' });
    expect((await f.bob(`/issues/${one}/links/${two}`, 'DELETE')).status).toBe(200);
    expect(await f.platform.board.issues.relation(one, two)).toBeNull();
    // Lifting nothing is harmless for members too.
    expect((await f.bob(`/issues/${one}/links/${two}`, 'DELETE')).status).toBe(200);
});

it('keeps blocking links admins’ own: members can’t make, change, replace or lift them', async () => {
    const f = await fixture();
    const one = await f.make('One');
    const two = await f.make('Two');
    const three = await f.make('Three');
    const refused = {
        status: 403,
        body: {
            error: 'Only an admin can make, change or remove a blocking link. Anyone can link related issues.',
        },
    };
    // Making a blocking link, either way.
    for (const relation of ['blocks', 'blocked_by']) {
        expect(await f.bob(`/issues/${one}/links/${two}`, 'PUT', { relation })).toMatchObject(refused);
    }
    expect((await f.bob(`/issues/${one}/blocked-by`, 'POST', { blocker: two })).status).toBe(403);
    expect(await f.platform.board.issues.relation(one, two)).toBeNull();
    // Turning a related link into a blocking one.
    await f.bob(`/issues/${one}/links/${two}`, 'PUT', { relation: 'related' });
    expect(await f.bob(`/issues/${one}/links/${two}`, 'PUT', { relation: 'blocks' })).toMatchObject(refused);
    expect(await f.platform.board.issues.relation(one, two)).toBe('related');
    // Replacing an admin's blocking link with a related one, from either side,
    // or lifting it.
    await f.alice(`/issues/${one}/links/${three}`, 'PUT', {
        relation: 'blocked_by',
    });
    for (const [from, to] of [
        [one, three],
        [three, one],
    ]) {
        expect(
            await f.bob(`/issues/${from}/links/${to}`, 'PUT', {
                relation: 'related',
            }),
        ).toMatchObject(refused);
        expect(await f.bob(`/issues/${from}/links/${to}`, 'DELETE')).toMatchObject(refused);
    }
    expect((await f.bob(`/issues/${one}/blocked-by/${three}`, 'DELETE')).status).toBe(403);
    expect(await f.platform.board.issues.relation(one, three)).toBe('blocked_by');
    // Admins still do all of it.
    expect(
        (
            await f.alice(`/issues/${one}/links/${three}`, 'PUT', {
                relation: 'related',
            })
        ).status,
    ).toBe(200);
    expect(
        (
            await f.alice(`/issues/${one}/links/${two}`, 'PUT', {
                relation: 'blocks',
            })
        ).status,
    ).toBe(200);
});

it('answers a member about an issue they can’t see as about a missing one', async () => {
    const f = await fixture();
    const one = await f.make('One');
    const gone = await f.make('Deleted');
    await f.alice(`/issues/${gone}`, 'DELETE');
    const missing = 99;
    // The other end: the same 404 and words, whatever the relation asked,
    // so nothing tells a deleted issue from one that never was.
    for (const relation of ['related', 'blocks', 'blocked_by']) {
        const asked = await f.bob<{ error: string }>(`/issues/${one}/links/${gone}`, 'PUT', { relation });
        const never = await f.bob<{ error: string }>(`/issues/${one}/links/${missing}`, 'PUT', { relation });
        expect([asked.status, never.status]).toEqual([404, 404]);
        expect(asked.body.error.replace(`CB-${gone}`, 'CB-n')).toBe(never.body.error.replace(`CB-${missing}`, 'CB-n'));
    }
    expect((await f.bob<{ error: string }>(`/issues/${one}/links/${gone}`, 'DELETE')).body).toEqual({
        error: `There is no CB-${gone}.`,
    });
    // The issue itself.
    for (const number of [gone, missing]) {
        expect(
            await f.bob(`/issues/${number}/links/${one}`, 'PUT', {
                relation: 'related',
            }),
        ).toMatchObject({ status: 404, body: { error: 'Issue not found.' } });
    }
    // A related link to an issue that was deleted is dormant: not listed,
    // and not the member's to see or lift.
    const later = await f.make('Later deleted');
    await f.bob(`/issues/${one}/links/${later}`, 'PUT', { relation: 'related' });
    await f.alice(`/issues/${later}`, 'DELETE');
    expect((await f.bob<IssueDetail>(`/issues/${one}`)).body.related).toEqual([]);
    expect((await f.bob(`/issues/${one}/links/${later}`, 'DELETE')).status).toBe(404);
});

it('keeps related links to a deleted issue dormant, and limits them', async () => {
    const f = await fixture();
    const one = await f.make('One');
    const two = await f.make('Two');
    await f.platform.board.issues.addRelated(one, two, 'alice');
    await f.alice(`/issues/${two}`, 'DELETE');
    expect((await f.bob<IssueDetail>(`/issues/${one}`)).body.related).toEqual([]);
    const target = await f.make('Target');
    for (let n = 0; n < 50; n++) {
        await f.platform.board.issues.addRelated(target, await f.make(`Related ${n}`), 'alice');
    }
    await expect(f.platform.board.issues.addRelated(target, await f.make('One more'), 'alice')).rejects.toThrow(
        /at most 50/,
    );
});

it('gives Dots and connected agents the related links where they read an item', async () => {
    const f = await fixture();
    const one = await f.make('Ship it');
    const two = await f.make('Similar, mail ada@example.com');
    await f.platform.board.issues.addRelated(one, two, 'alice');
    const read = async (number: number) => {
        const found = await f.platform.board.filings.item(`CB-${number}`, {
            userId: 'bob',
        });
        if (found.outcome !== 'found') {
            throw new Error('missing');
        }
        return found;
    };
    expect((await read(one)).related).toEqual([
        { issue: 'CB-2', title: 'Similar, mail [email removed]', status: 'open' },
    ]);
    expect((await read(two)).related).toEqual([{ issue: 'CB-1', title: 'Ship it', status: 'open' }]);
});
