import { afterEach, expect, it, vi } from 'vitest';

import { capabilityKey, guessArea, stem } from '@socio/foundation/issues/capability-key';
import { DEFAULT_DOT_REQUEST_LIMITS, dotRequestLimitsFromEnv } from '@socio/foundation/issues/settings';
import { withoutEmails } from '@socio/foundation/issues/without-emails';
import type { DotRequestNotices, IssueDetail, IssueList } from '@socio/shared/issues/issue-types';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { requestTools, resolvedRequestNews } from '../src/server/issues/request-tools.js';
import { noticeMessage } from '../src/server/issues/requests.js';
import type { TelegramChannel } from '../src/server/telegram/telegram-channel.js';

import { boardOf } from './helpers/board.js';
import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

function workspaceFixture() {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    for (const user of DEFAULT_MOCK_USERS) {
        workspace.recordUser(user);
    }
    const space = workspace.spaces()[0]!;
    const dot = workspace.dots()[0]!;
    const other = workspace.createDot(space.id, 'Ledger', 'Count.', false, false);
    return { workspace, dot, other };
}
const ask = (capability: string, why = 'The user asked.') => ({
    capability,
    why,
    example: 'For example, every Monday.',
});

// --- The capability key -----------------------------------------------------

it('normalises capability names to a key: case, punctuation, stopwords, stems, synonyms, order', () => {
    expect(capabilityKey('Send email')).toBe('email send');
    expect(capabilityKey('sending e-mails')).toBe(capabilityKey('Send email'));
    expect(capabilityKey('The ability to send an email!')).toBe('email send');
    expect(capabilityKey('Email sending')).toBe('email send');
    expect(capabilityKey('persistent key-value store')).toBe(capabilityKey('Persistent KV storage'));
    expect(capabilityKey('durable key value stores')).toBe(capabilityKey('persistent key-value store'));
    expect(capabilityKey('Café calendar')).toBe(capabilityKey('cafe calendars'));
    expect(capabilityKey('scheduled jobs')).toBe(capabilityKey('schedule job'));
    // Different needs stay different.
    expect(capabilityKey('send email')).not.toBe(capabilityKey('read email'));
    // All stopwords: the plain words stand in.
    expect(capabilityKey('a new tool')).toBe('a new tool');
    expect(stem('queries')).toBe('query');
    expect(stem('running')).toBe('run');
    expect(stem('class')).toBe('class');
});

it('guesses an area from the capability, or none', () => {
    expect(guessArea('Telegram voice notes')).toBe('telegram');
    expect(guessArea('a shell in my computer')).toBe('computers');
    expect(guessArea('The web chat loses my draft')).toBe('chat');
    // Before spaces, which "page" would match.
    expect(guessArea('a widget on the home page')).toBe('homepage');
    expect(guessArea('recurring reports on a cron')).toBe('schedules');
    expect(guessArea('see what my scheduled turns did')).toBe('schedules');
    expect(guessArea('send email')).toBeNull();
});

it('reads the limits from the environment, refusing nonsense', () => {
    expect(dotRequestLimitsFromEnv({})).toEqual(DEFAULT_DOT_REQUEST_LIMITS);
    expect(
        dotRequestLimitsFromEnv({
            DOT_REQUESTS_PER_DOT_DAILY: '2',
            DOT_REQUESTS_PER_USER_DAILY: '0',
        }),
    ).toMatchObject({ perDot: 2, perUser: 0 });
    expect(() => dotRequestLimitsFromEnv({ DOT_REQUESTS_PER_DOT_DAILY: 'lots' })).toThrow(/DOT_REQUESTS_PER_DOT_DAILY/);
});

// --- Intake -----------------------------------------------------------------

it('files a request as a triage issue of kind request, labelled dot-request, with its requester', async () => {
    const { workspace, dot } = workspaceFixture();
    const result = await boardOf(workspace).requests.request(
        dot.id,
        'bob',
        { ...ask('Telegram voice replies'), kind: 'integration' },
        undefined,
        1000,
    );
    expect(result).toMatchObject({
        outcome: 'filed',
        issue: 'CB-1',
        key: 'reply telegram voic',
        demand: 1,
    });
    // The message relays an issue link, not plain text, so the inline card
    // renders in chat/rooms (CB-306): `[CB-1](/issues/CB-1)`.
    expect(result.message).toContain('[CB-1](/issues/CB-1)');
    const issue = (await boardOf(workspace).issues.get(1))!;
    expect(issue).toMatchObject({
        title: 'Socio request: Telegram voice replies',
        kind: 'request',
        labels: ['dot-request'],
        status: 'triage',
        priority: 'medium',
        area: 'telegram',
        reporterId: `dot:${dot.id}`,
    });
    expect(issue.body).toContain(`${dot.name} asked for a capability`);
    expect(issue.body).toContain('> The user asked.');
    expect(issue.body).toContain('> For example, every Monday.');
    expect(issue.body).toContain('**Kind:** integration');
    // The requester is in the table, not in the text (issue text goes to
    // socios and connected agents).
    expect(issue.body).not.toMatch(/bob/i);
    expect(await boardOf(workspace).requests.requesters(issue.id)).toEqual([
        { dotId: dot.id, userId: 'bob', createdAt: 1000 },
    ]);
    const row = workspace.db.prepare('SELECT * FROM dot_request_requesters').get() as Record<string, unknown>;
    expect(row).toMatchObject({
        issueId: issue.id,
        dotId: dot.id,
        userId: 'bob',
        why: 'The user asked.',
        example: 'For example, every Monday.',
        announcedAt: null,
    });
});

it('merges a request with the same key into the open issue: demand, an agent comment, no new issue', async () => {
    const { workspace, dot, other } = workspaceFixture();
    await boardOf(workspace).requests.request(dot.id, 'bob', ask('Send email'));
    const merged = await boardOf(workspace).requests.request(
        other.id,
        'alice',
        ask('email sending', 'Invoices go out by mail.'),
    );
    expect(merged).toMatchObject({ outcome: 'merged', issue: 'CB-1', demand: 2 });
    expect(merged.message).toContain('[CB-1](/issues/CB-1)'); // CB-306
    // The same pair again: nothing new, no comment.
    const again = await boardOf(workspace).requests.request(dot.id, 'bob', ask('SEND EMAILS'));
    expect(again).toMatchObject({
        outcome: 'already_requested',
        issue: 'CB-1',
        demand: 2,
    });
    expect(again.message).toContain('[CB-1](/issues/CB-1)'); // CB-306
    // The same Dot for another user counts.
    expect(await boardOf(workspace).requests.request(dot.id, 'alice', ask('send e-mail'))).toMatchObject({
        outcome: 'merged',
        demand: 3,
    });
    expect(await boardOf(workspace).issues.list()).toHaveLength(1);
    const issue = (await boardOf(workspace).issues.get(1))!;
    const comments = await boardOf(workspace).issues.comments(issue.id);
    expect(comments.map((c) => [c.authorKind, c.authorId])).toEqual([
        ['agent', `dot:${other.id}`],
        ['agent', `dot:${dot.id}`],
    ]);
    expect(comments[0]!.body).toContain('Ledger asked for this too (demand 2)');
    expect(comments[0]!.body).toContain('> Invoices go out by mail.');
    expect((await boardOf(workspace).requests.demand()).get(issue.id)).toBe(3);
    // Once closed, the same need files a new request.
    await boardOf(workspace).issues.update(1, { status: 'done' }, 'alice');
    expect(await boardOf(workspace).requests.request(other.id, 'bob', ask('send email'))).toMatchObject({
        outcome: 'filed',
        issue: 'CB-2',
        demand: 1,
    });
});

it('rate limits per socio and per user over a day', async () => {
    const { workspace, dot, other } = workspaceFixture();
    const limits = { perDot: 2, perUser: 3, windowMs: 1000 };
    const r = async (dotId: string, userId: string, name: string, now: number) =>
        (await boardOf(workspace).requests.request(dotId, userId, ask(name), limits, now)).outcome;
    expect(await r(dot.id, 'bob', 'alpha thing', 100)).toBe('filed');
    expect(await r(dot.id, 'alice', 'beta thing', 200)).toBe('filed');
    // The Dot is at its limit, for every user.
    expect(await r(dot.id, 'bob', 'gamma thing', 300)).toBe('rate_limited');
    // Another Dot for bob is fine, until bob is at his.
    expect(await r(other.id, 'bob', 'gamma thing', 300)).toBe('filed');
    expect(await r(other.id, 'bob', 'delta thing', 400)).toBe('filed');
    const limited = await boardOf(workspace).requests.request(
        other.id,
        'bob',
        ask('epsilon thing'),
        { ...limits, perDot: 10 },
        500,
    );
    expect(limited.outcome).toBe('rate_limited');
    expect(limited.message).toMatch(/for this user/);
    expect(limited.issue).toBeUndefined();
    // A day later the window has moved on.
    expect(await r(dot.id, 'bob', 'gamma thing', 1150)).toBe('merged');
    expect(await boardOf(workspace).issues.list()).toHaveLength(4);
});

it('hides a request’s key, requesters and notices with its issue, and keeps them (CB-64)', async () => {
    const { workspace, dot } = workspaceFixture();
    await boardOf(workspace).requests.request(dot.id, 'bob', ask('send email'));
    await boardOf(workspace).requests.request(dot.id, 'bob', ask('a calendar'));
    await boardOf(workspace).issues.update(1, { status: 'done' }, 'alice');
    expect(await boardOf(workspace).requests.notices('bob')).toHaveLength(1);
    await boardOf(workspace).issues.remove(1, 'alice');
    await boardOf(workspace).issues.remove(2, 'alice');
    expect(await boardOf(workspace).requests.notices('bob')).toEqual([]);
    expect(await boardOf(workspace).requests.pendingRequestsFor(dot.id, 'bob')).toEqual([]);
    expect(await boardOf(workspace).requests.resolvedRequestsFor(dot.id, 'bob')).toEqual([]);
    expect((await boardOf(workspace).requests.demand()).size).toBe(0);
    // The same capability again opens a new issue, under a new number.
    const again = await boardOf(workspace).requests.request(dot.id, 'bob', ask('a calendar'));
    expect(again).toMatchObject({ outcome: 'filed', issue: 'CB-3' });
    expect(await boardOf(workspace).requests.pendingRequestsFor(dot.id, 'bob')).toHaveLength(1);
    for (const [table, n] of [
        ['dot_requests', 3],
        ['dot_request_requesters', 3],
        ['dot_request_notices', 1],
    ] as const) {
        expect(workspace.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n });
    }
});

// --- Done and won't fix -------------------------------------------------------

it('notifies each user who asked once the request is done or won’t be built, and tells the socio', async () => {
    const { workspace, dot, other } = workspaceFixture();
    await boardOf(workspace).requests.request(dot.id, 'bob', ask('send email'));
    await boardOf(workspace).requests.request(other.id, 'bob', ask('email sending'));
    await boardOf(workspace).requests.request(dot.id, 'alice', ask('Send emails'));
    await boardOf(workspace).requests.request(dot.id, 'bob', ask('a calendar'));
    expect(await boardOf(workspace).requests.pendingRequestsFor(dot.id, 'bob')).toHaveLength(2);
    expect(await boardOf(workspace).requests.resolvedRequestsFor(dot.id, 'bob')).toEqual([]);
    // Moving between open statuses tells nobody.
    await boardOf(workspace).issues.update(1, { status: 'in_progress' }, 'alice');
    expect(await boardOf(workspace).requests.notices('bob')).toEqual([]);
    await boardOf(workspace).issues.update(1, { status: 'done', resolution: 'Shipped as send_email.' }, 'alice');
    const bobs = await boardOf(workspace).requests.notices('bob');
    expect(bobs).toEqual([
        expect.objectContaining({
            number: 1,
            capability: 'send email',
            status: 'done',
            resolution: 'Shipped as send_email.',
            dots: [dot.name, 'Ledger'],
        }),
    ]);
    expect(await boardOf(workspace).requests.notices('alice')).toHaveLength(1);
    // Seen by its user only.
    expect(await boardOf(workspace).requests.markSeen('alice', [bobs[0]!.id])).toBe(0);
    expect(await boardOf(workspace).requests.markSeen('bob', [bobs[0]!.id])).toBe(1);
    expect(await boardOf(workspace).requests.notices('bob')).toEqual([]);
    expect(await boardOf(workspace).requests.pendingRequestsFor(dot.id, 'bob')).toEqual([
        expect.objectContaining({ issue: 'CB-2', status: 'triage', demand: 1 }),
    ]);
    expect(await boardOf(workspace).requests.resolvedRequestsFor(dot.id, 'bob')).toEqual([
        expect.objectContaining({
            issue: 'CB-1',
            status: 'done',
            resolution: 'Shipped as send_email.',
            demand: 3,
        }),
    ]);
    // The Dot is told on its next turn for bob, once.
    const news = await resolvedRequestNews(boardOf(workspace).requests, dot.id, 'bob');
    expect(news).toContain('"issue":"CB-1"');
    expect(news).toContain('Shipped as send_email.');
    expect(await resolvedRequestNews(boardOf(workspace).requests, dot.id, 'bob')).toBe('');
    expect(await resolvedRequestNews(boardOf(workspace).requests, other.id, 'bob')).toContain('CB-1');
    // Won't fix notifies too, with the resolution; closed to closed doesn't.
    await boardOf(workspace).issues.update(2, { status: 'wont_fix', resolution: 'Out of scope.' }, 'alice');
    expect(await boardOf(workspace).requests.notices('bob')).toEqual([
        expect.objectContaining({
            number: 2,
            status: 'wont_fix',
            resolution: 'Out of scope.',
        }),
    ]);
    await boardOf(workspace).issues.update(2, { status: 'done' }, 'alice');
    expect(await boardOf(workspace).requests.notices('bob')).toHaveLength(1);
    // Ordinary issues never make notices.
    await boardOf(workspace).issues.create({ title: 'A bug' }, 'bob');
    await boardOf(workspace).issues.update(3, { status: 'done' }, 'alice');
    expect(await boardOf(workspace).requests.notices('bob')).toHaveLength(1);
});

it('words the Telegram message without emails', () => {
    expect(withoutEmails('mail me at someone@example.com please')).toBe('mail me at [email removed] please');
    const text = noticeMessage({
        number: 4,
        capability: 'send email',
        status: 'wont_fix',
        resolution: 'Ask ops@example.com instead.',
        dots: ['Socio'],
    });
    expect(text).toContain('won’t be built: “send email”, CB-4 (asked by Socio)');
    expect(text).toContain('Resolution: Ask [email removed] instead.');
    expect(text).not.toContain('@');
});

// --- The tool -----------------------------------------------------------------

it('offers request_capability, filing for the acting user and listing the socio’s requests', async () => {
    const { workspace, dot } = workspaceFixture();
    const check = vi.fn();
    const [tool] = requestTools(boardOf(workspace).requests, dot.id, 'bob', check, {
        perDot: 1,
        perUser: 5,
        windowMs: 60_000,
    });
    expect(tool!.name).toBe('request_capability');
    const run = (input: unknown) =>
        (tool as unknown as { execute: (input: unknown) => Promise<unknown> }).execute(input) as Promise<
            Record<string, unknown>
        >;
    const first = await run(ask('send email'));
    expect(first).toMatchObject({
        outcome: 'filed',
        issue: 'CB-1',
        pending: [expect.objectContaining({ issue: 'CB-1' })],
        resolved: [],
    });
    expect(check).toHaveBeenCalled();
    expect(await boardOf(workspace).requests.requesters((await boardOf(workspace).issues.get(1))!.id)).toEqual([
        expect.objectContaining({ userId: 'bob', dotId: dot.id }),
    ]);
    expect(await run(ask('read pdf files'))).toMatchObject({
        outcome: 'rate_limited',
    });
    await expect(run({ ...ask('x'), why: '' })).rejects.toThrow();
});

// --- Routes: members and admins see the same -----------------------------------

async function appFixture() {
    const { app, workspace, platform, dispose } = await makeTestRuntime({
        config: {
            baseUrl: '',
            apiKey: '',
            model: '',
            runtimeUrl: '',
        },
        app: {
            config: { mode: 'live', baseUrl: '' },
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
        const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
        return async <T>(path: string, method = 'GET', body?: unknown) => {
            const response = await app.request(`/api${path}`, {
                method,
                headers: {
                    cookie,
                    ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            return { status: response.status, body: (await response.json()) as T };
        };
    };
    return {
        platform,
        workspace,
        dot: workspace.dots()[0]!,
        alice: await as('alice'),
        bob: await as('bob'),
    };
}

it('lists demand and requesters to members and admins alike; notices are each user’s own', async () => {
    const f = await appFixture();
    await f.platform.board.requests.request(f.dot.id, 'bob', ask('send email'));
    await f.platform.board.requests.request(f.dot.id, 'alice', ask('email sending'));
    await f.platform.board.issues.create({ title: 'A plain bug' }, 'bob');
    for (const as of [f.alice, f.bob]) {
        const list = await as<IssueList>('/issues');
        expect(list.status).toBe(200);
        const [request, bug] = [1, 2].map((n) => list.body.issues.find((issue) => issue.number === n)!);
        expect(request!.demand).toBe(2);
        expect(bug).not.toHaveProperty('demand');
        expect((await as<IssueList>('/issues?label=dot-request')).body.issues.map((issue) => issue.number)).toEqual([
            1,
        ]);
        expect((await as<IssueList>('/issues?kind=request')).body.issues).toHaveLength(1);
        const detail = (await as<IssueDetail>('/issues/CB-1')).body;
        expect(detail.issue.demand).toBe(2);
        expect(detail.requesters!.map((row) => row.userId)).toEqual(['bob', 'alice']);
        expect(detail.users[`dot:${f.dot.id}`]).toBe(f.dot.name);
        expect(detail.users).toMatchObject({ alice: 'Alice', bob: 'Bob' });
        expect((await as<IssueDetail>('/issues/CB-2')).body).not.toHaveProperty('requesters');
    }
    // Only an admin closes it; then each asker has their own notice.
    expect((await f.bob('/issues/CB-1', 'PATCH', { status: 'done' })).status).toBe(403);
    expect(
        (
            await f.alice('/issues/CB-1', 'PATCH', {
                status: 'done',
                resolution: 'Shipped.',
            })
        ).status,
    ).toBe(200);
    const bobs = (await f.bob<DotRequestNotices>('/dot-requests/notices')).body;
    expect(bobs.notices).toEqual([expect.objectContaining({ number: 1, status: 'done', dots: [f.dot.name] })]);
    const alices = (await f.alice<DotRequestNotices>('/dot-requests/notices')).body;
    expect(alices.notices).toHaveLength(1);
    // Alice can't mark Bob's seen.
    expect(
        (
            await f.alice<{ seen: number }>('/dot-requests/notices/seen', 'POST', {
                ids: [bobs.notices[0]!.id],
            })
        ).body.seen,
    ).toBe(0);
    expect(
        (
            await f.bob<{ seen: number }>('/dot-requests/notices/seen', 'POST', {
                ids: [bobs.notices[0]!.id],
            })
        ).body.seen,
    ).toBe(1);
    expect((await f.bob<DotRequestNotices>('/dot-requests/notices')).body.notices).toEqual([]);
    expect((await f.bob('/dot-requests/notices/seen', 'POST', { ids: 'x' })).status).toBe(400);
});

it('sends a Telegram direct message to linked users while the bot is online', async () => {
    const f = await appFixture();
    const sent: Array<[string, string]> = [];
    const channel = {
        status: 'online',
        start: async () => {},
        stop: async () => {},
        sendDirect: async (to: string, text: string) => {
            sent.push([to, text]);
        },
    };
    f.platform.useTelegram(channel as unknown as TelegramChannel);
    await f.platform.start();
    // Bob is linked; Alice isn't.
    await f.workspace.telegram.redeem((await f.workspace.telegram.createCode('bob')).code, '4242');
    await f.platform.board.requests.request(f.dot.id, 'bob', ask('send email'));
    await f.platform.board.requests.request(f.dot.id, 'alice', ask('email sending'));
    await f.platform.board.issues.update(1, { status: 'wont_fix', resolution: 'Mail bob@example.com.' }, 'alice');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]![0]).toBe('4242');
    expect(sent[0]![1]).toContain('won’t be built: “send email”, CB-1');
    expect(sent[0]![1]).not.toMatch(/@|Bob|Alice/);
    // Offline: the in-app notice only.
    channel.status = 'failed';
    await f.platform.board.requests.request(f.dot.id, 'bob', ask('read pdf'));
    await f.platform.board.issues.update(2, { status: 'done' }, 'alice');
    expect(await f.platform.board.requests.notices('bob')).toHaveLength(2);
    expect(sent).toHaveLength(1);
    // Stopped: no more messages.
    channel.status = 'online';
    await f.platform.stop();
    await f.platform.board.requests.request(f.dot.id, 'bob', ask('make charts'));
    await f.platform.board.issues.update(3, { status: 'done' }, 'alice');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent).toHaveLength(1);
});
