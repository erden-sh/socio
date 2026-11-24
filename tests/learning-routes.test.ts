import { afterEach, expect, it, vi } from 'vitest';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

/** `featureFlags`: `FEATURE_FLAGS` as the entry reads it, e.g. `{ 'learning-analyze-now': true }`. */
async function fixture(featureFlags?: Record<string, boolean>) {
    const { workspace, platform, app, dispose } = await makeTestRuntime({
        config: {
            baseUrl: 'http://model.test/v1',
            apiKey: 'k',
            model: 'qwen',
            runtimeUrl: '',
            ...(featureFlags ? { featureFlags } : {}),
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
    const as = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0];
        return (path: string, method = 'GET', body?: unknown) =>
            app.request(`/api${path}`, {
                method,
                headers: {
                    cookie,
                    ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
    };
    const dot = workspace.dots()[0];
    workspace.updateDot(dot.id, {
        ...dot,
        learningContainerId: 'research',
        skillDeliveryEnabled: true,
    });
    // Bob's private conversation is evidence; a proposal cites it.
    workspace.bindThread('bob-thread', dot.id, 'Bob’s report', 'bob');
    workspace.evidence.record('bob-thread', 'finished', 10);
    const analysis = platform.learning as unknown as {
        db: { prepare(sql: string): { run(...args: unknown[]): unknown } };
    };
    analysis.db
        .prepare(
            "INSERT INTO learning_proposals VALUES ('p1', 'research', 'run', 'weekly-report', 'Weekly report', '1. Collect.\n2. Summarize.', 'Repeated', '[\"bob-thread\"]', 'pending', 1, NULL, NULL, NULL)",
        )
        .run();
    return { app, as, workspace, platform };
}

it('keeps proposals, evidence and controls for admins; members see only published skills', async () => {
    const f = await fixture();
    const bob = await f.as('bob');
    for (const [method, path, body] of [
        ['GET', '/learning/containers'],
        ['GET', '/learning/settings'],
        ['PATCH', '/learning/settings/any', { learningContainerId: 'x', skillDeliveryEnabled: false }],
        ['GET', '/learning/containers/research'],
        ['POST', '/learning/containers/research/analyze', {}],
        ['POST', '/learning/containers/research/cancel', {}],
        ['PUT', '/learning/containers/research/pin', { revision: null }],
        ['POST', '/learning/containers/research/skills/weekly-report/revoke', {}],
        ['GET', '/learning/proposals/p1'],
        ['PATCH', '/learning/proposals/p1', { name: 'x' }],
        ['POST', '/learning/proposals/p1/publish', {}],
        ['POST', '/learning/proposals/p1/reject', {}],
    ] as Array<[string, string, unknown?]>) {
        expect((await bob(path, method, body)).status, `${method} ${path}`).toBe(403);
    }
    expect(await (await bob('/learning/skills')).json()).toEqual([{ containerId: 'research', skills: [] }]);
    const alice = await f.as('alice');
    const [listed] = await (await alice('/learning/containers')).json();
    expect(listed).toMatchObject({
        id: 'research',
        newEvidence: 1,
        pendingProposals: 1,
        published: 0,
        running: false,
    });
    const detail = await (await alice('/learning/proposals/p1')).json();
    expect(detail.evidence).toEqual([expect.objectContaining({ threadId: 'bob-thread', ownerId: 'bob' })]);
    expect(detail.current).toBeNull();
});

it('creates and edits scope assignments without moving old evidence or changing unrelated socio settings', async () => {
    const f = await fixture();
    const alice = await f.as('alice');
    const dot = f.workspace.dots()[0];
    const before = f.workspace.dot(dot.id)!;
    const listed = await (await alice('/learning/settings')).json();
    expect(listed).toContainEqual({
        id: dot.id,
        name: dot.name,
        learningContainerId: 'research',
        skillDeliveryEnabled: true,
    });
    const path = `/learning/settings/${dot.id}`;
    expect(
        (
            await alice(path, 'PATCH', {
                learningContainerId: 'New Scope',
                skillDeliveryEnabled: true,
            })
        ).status,
    ).toBe(400);
    expect(
        (
            await alice(path, 'PATCH', {
                learningContainerId: null,
                skillDeliveryEnabled: true,
            })
        ).status,
    ).toBe(400);
    expect(
        (
            await alice(path, 'PATCH', {
                learningContainerId: 'new-scope',
                skillDeliveryEnabled: false,
                instructions: 'overwrite',
            })
        ).status,
    ).toBe(400);
    expect(
        (
            await alice(path, 'PATCH', {
                learningContainerId: 'new-scope',
                skillDeliveryEnabled: false,
            })
        ).status,
    ).toBe(200);
    expect(f.workspace.dot(dot.id)).toEqual({
        ...before,
        learningContainerId: 'new-scope',
        skillDeliveryEnabled: false,
    });
    expect(f.workspace.thread('bob-thread')?.learningContainerId).toBe('research');
    expect(f.workspace.evidence.count('research')).toBe(1);
    f.workspace.bindThread('new-thread', dot.id, 'New report', 'alice');
    expect(f.workspace.thread('new-thread')?.learningContainerId).toBe('new-scope');
    const scopes = await (await alice('/learning/containers')).json();
    expect(scopes.map((scope: { id: string }) => scope.id)).toEqual(['new-scope', 'research']);
    expect(
        (
            await alice(path, 'PATCH', {
                learningContainerId: null,
                skillDeliveryEnabled: false,
            })
        ).status,
    ).toBe(200);
    expect(f.workspace.dot(dot.id)?.learningContainerId).toBeNull();
});

it('shows a deleted conversation’s evidence as deleted, without its messages (CB-64)', async () => {
    const f = await fixture();
    vi.spyOn(f.platform.runner, 'messages').mockResolvedValue([
        { id: 'm1', role: 'user', content: 'Draft the heron report.' },
    ]);
    const alice = await f.as('alice');
    const before = await (await alice('/learning/proposals/p1')).json();
    expect(before.evidence[0].messages).toEqual([{ role: 'user', content: 'Draft the heron report.' }]);
    await f.platform.deleteConversation('bob-thread', 'bob');
    const after = await (await alice('/learning/proposals/p1')).json();
    expect(after.evidence).toEqual([
        {
            threadId: 'bob-thread',
            title: 'Deleted conversation',
            ownerId: null,
            triage: null,
            messages: [],
        },
    ]);
});

it('lets an admin edit, publish, revoke, pin and reject', async () => {
    const f = await fixture();
    const alice = await f.as('alice');
    const edited = await (
        await alice('/learning/proposals/p1', 'PATCH', {
            description: 'Use for the weekly status report.',
            skillMd: '1. Collect wins and risks.\n2. Summarize in 200 words.',
        })
    ).json();
    expect(edited).toMatchObject({ status: 'pending', reviewedBy: 'alice' });
    expect((await alice('/learning/proposals/p1', 'PATCH', { name: 'Bad Name' })).status).toBe(400);
    const published = await (await alice('/learning/proposals/p1/publish', 'POST', {})).json();
    expect(published).toMatchObject({ status: 'published' });
    expect((await alice('/learning/proposals/p1/publish', 'POST', {})).status).toBe(409);
    const snapshot = f.workspace.skills.snapshot('research');
    expect(snapshot.revision).toBe('research@1');
    const bob = await f.as('bob');
    expect((await (await bob('/learning/skills')).json())[0].skills).toEqual([
        expect.objectContaining({
            name: 'weekly-report',
            description: 'Use for the weekly status report.',
            revision: 1,
        }),
    ]);
    const revision = f.workspace.skills.published('research')[0];
    expect(revision.files[0].content).toContain('name: weekly-report');
    expect(revision.files[0].content).toContain('Summarize in 200 words.');
    expect((await alice('/learning/containers/research/skills/weekly-report/revoke', 'POST', {})).status).toBe(200);
    expect(f.workspace.skills.published('research')).toEqual([]);
    expect(await (await alice('/learning/containers/research/pin', 'PUT', { revision: 1 })).json()).toEqual({
        pinned: 1,
    });
    expect(f.workspace.skills.current('research')?.revision).toBe(1);
    expect((await alice('/learning/containers/research/pin', 'PUT', { revision: 9 })).status).toBe(404);
    const detail = await (await alice('/learning/containers/research')).json();
    expect(detail).toMatchObject({ revision: 2, pinned: 1, delivered: 1 });
    expect((await alice('/learning/proposals/p1/reject', 'POST', {})).status).toBe(409);
});

it('refuses Analyze now with a 404 while learning-analyze-now is off (the default), without analyzing', async () => {
    const f = await fixture();
    const alice = await f.as('alice');
    const analyze = vi.spyOn(f.platform.learning, 'analyze');
    expect(f.platform.flags.enabled('learning-analyze-now', 'alice')).toBe(false);
    const refused = await alice('/learning/containers/research/analyze', 'POST', {});
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: 'This feature isn’t available to you.' });
    expect(analyze).not.toHaveBeenCalled();
    // The rest of Learning still answers, and members still get the admin guard's 403.
    expect((await alice('/learning/containers/research')).status).toBe(200);
    expect((await (await f.as('bob'))('/learning/containers/research/analyze', 'POST', {})).status).toBe(403);
});

it('runs Analyze now once an admin turns learning-analyze-now on in Settings → Features', async () => {
    const f = await fixture();
    const alice = await f.as('alice');
    const analyze = vi.spyOn(f.platform.learning, 'analyze').mockImplementationOnce(async () => ({
        run: { id: 'r', status: 'running' } as never,
        done: Promise.resolve() as never,
    }));
    const on = await alice('/flags/learning-analyze-now/workspace', 'PUT', { enabled: true, roles: [], people: [] });
    expect(on.status).toBe(200);
    expect((await alice('/learning/containers/research/analyze', 'POST', {})).status).toBe(202);
    expect(analyze).toHaveBeenCalledWith('research', 'manual', 'alice');
    // Off again: refused again.
    expect((await alice('/flags/learning-analyze-now/workspace', 'DELETE')).status).toBe(200);
    expect((await alice('/learning/containers/research/analyze', 'POST', {})).status).toBe(404);
});

it('starts one analysis at a time from the review screen', async () => {
    const f = await fixture({ 'learning-analyze-now': true });
    const alice = await f.as('alice');
    vi.spyOn(f.platform.learning, 'analyze').mockImplementationOnce(async () => ({
        run: { id: 'r', status: 'running' } as never,
        done: Promise.resolve() as never,
    }));
    expect((await alice('/learning/containers/research/analyze', 'POST', {})).status).toBe(202);
    vi.spyOn(f.platform.learning, 'analyze').mockImplementationOnce(() => {
        throw new Error('An analysis is already running for this container.');
    });
    const busy = await alice('/learning/containers/research/analyze', 'POST', {});
    expect(busy.status).toBe(409);
    expect((await busy.json()).error).toMatch(/already running/);
});

it('lists a container’s proposals without their bodies when asked (?bodies=false)', async () => {
    const f = await fixture();
    const alice = await f.as('alice');
    const full = await (await alice('/learning/containers/research')).json();
    expect(full.proposals[0]).toMatchObject({
        id: 'p1',
        skillMd: '1. Collect.\n2. Summarize.',
        rationale: 'Repeated',
    });
    const light = await (await alice('/learning/containers/research?bodies=false')).json();
    expect(light.proposals[0]).toMatchObject({
        id: 'p1',
        name: 'weekly-report',
        description: 'Weekly report',
        evidenceThreadIds: ['bob-thread'],
    });
    expect(light.proposals[0]).not.toHaveProperty('skillMd');
    expect(light.proposals[0]).not.toHaveProperty('rationale');
    const bob = await f.as('bob');
    expect((await bob('/learning/containers/research?bodies=false', 'GET')).status).toBe(403);
});

it('pages a container’s proposals newest first with a cursor (?limit=&cursor=)', async () => {
    const f = await fixture();
    const insert = (
        f.platform.learning as unknown as {
            db: { prepare(sql: string): { run(...args: unknown[]): unknown } };
        }
    ).db.prepare(
        "INSERT INTO learning_proposals VALUES (?, ?, 'run', ?, 'A skill.', 'BODY', 'Why', '[]', ?, ?, NULL, NULL, NULL)",
    );
    // 59 more in research (p1 is the oldest, at 1), some created in the
    // same millisecond, which the id orders; and one in another container.
    for (let index = 0; index < 59; index++) {
        insert.run(
            `q${String(index).padStart(2, '0')}`,
            'research',
            `skill-${index}`,
            index % 3 ? 'pending' : 'rejected',
            100 + Math.floor(index / 4),
        );
    }
    insert.run('other', 'support', 'other-skill', 'pending', 10_000);
    const alice = await f.as('alice');
    const expected = f.platform.learning.proposals('research').map((proposal) => proposal.id);
    expect(expected).toHaveLength(60);
    expect(expected.slice(0, 4)).toEqual(['q58', 'q57', 'q56', 'q55']);
    expect(expected.at(-1)).toBe('p1');

    // The detail carries the first page and the cursor to the next.
    const detail = await (await alice('/learning/containers/research?bodies=false')).json();
    expect(detail.proposals.map((p: { id: string }) => p.id)).toEqual(expected.slice(0, 25));
    expect(detail.proposalsCursor).toEqual(expect.any(String));

    // Walking the pages gives every proposal once, in order, and the last
    // page has no cursor.
    const seen: string[] = [];
    let cursor: string | undefined = detail.proposalsCursor;
    let pages = 0;
    while (cursor) {
        const response = await alice(
            `/learning/containers/research/proposals?bodies=false&limit=20&cursor=${encodeURIComponent(cursor)}`,
        );
        expect(response.status).toBe(200);
        const page = await response.json();
        for (const item of page.items) {
            expect(item).not.toHaveProperty('skillMd');
            seen.push(item.id);
        }
        cursor = page.nextCursor;
        pages++;
    }
    expect(pages).toBe(2);
    expect([...expected.slice(0, 25), ...seen]).toEqual(expected);

    // Without a cursor, the first page; bodies unless asked not to.
    const top = await (await alice('/learning/containers/research/proposals?limit=60')).json();
    expect(top.items.map((p: { id: string }) => p.id)).toEqual(expected);
    expect(top.items[0]).toMatchObject({ skillMd: 'BODY', rationale: 'Why' });
    expect(top).not.toHaveProperty('nextCursor');

    // A container with nothing yet; bad limits and cursors.
    expect(await (await alice('/learning/containers/empty/proposals')).json()).toEqual({ items: [] });
    for (const query of [
        'limit=0',
        'limit=101',
        'limit=2.5',
        'cursor=nope',
        `cursor=${Buffer.from('["x","y"]').toString('base64url')}`,
    ]) {
        expect((await alice(`/learning/containers/research/proposals?${query}`)).status, query).toBe(400);
    }

    // Members see no proposals at all, paged or not.
    const bob = await f.as('bob');
    for (const path of [
        '/learning/containers/research/proposals',
        `/learning/containers/research/proposals?cursor=${encodeURIComponent(detail.proposalsCursor)}`,
    ]) {
        expect((await bob(path)).status, path).toBe(403);
    }

    // The count on the container list doesn't read the proposals.
    const [listed] = await (await alice('/learning/containers')).json();
    expect(listed.pendingProposals).toBe(f.platform.learning.proposals('research', 'pending').length);
});

it('lets an admin label a conversation’s triage, and shows it in the container and the review (CB-200)', async () => {
    const f = await fixture();
    vi.spyOn(f.platform.runner, 'messages').mockResolvedValue([
        { id: 'm1', role: 'user', content: 'Draft the heron report for a@b.co.' },
        { id: 'm2', role: 'assistant', content: 'REPLY-CANARY' },
    ]);
    const alice = await f.as('alice');
    const bob = await f.as('bob');
    // Off by default: the container says so, and lists nothing triaged.
    const before = await (await alice('/learning/containers/research')).json();
    expect(before.triage).toMatchObject({
        enabled: false,
        passed: false,
        golden: 0,
        callsToday: 0,
    });
    const path = '/learning/threads/bob-thread/triage';
    expect((await bob(path, 'PUT', { label: 'one-off' })).status).toBe(403);
    expect((await alice(path, 'PUT', { label: 'maybe' })).status).toBe(400);
    expect((await alice('/learning/threads/nope/triage', 'PUT', { label: 'one-off' })).status).toBe(404);
    const labelled = await alice(path, 'PUT', { label: 'one-off' });
    expect(labelled.status).toBe(200);
    expect(await labelled.json()).toMatchObject({
        threadId: 'bob-thread',
        title: 'Bob’s report',
        pending: true,
        label: { value: 'one-off', source: 'admin' },
        score: null,
    });
    const after = await (await alice('/learning/containers/research')).json();
    expect(after.triage.golden).toBe(1);
    expect(after.triage.threads).toEqual([
        expect.objectContaining({
            threadId: 'bob-thread',
            label: expect.objectContaining({ value: 'one-off', source: 'admin' }),
        }),
    ]);
    const review = await (await alice('/learning/proposals/p1')).json();
    expect(review.evidence[0].triage).toEqual({
        label: 'one-off',
        source: 'admin',
        score: null,
        intent: null,
    });
    // The stored input is scrubbed and holds what people asked, not replies.
    const [row] = f.workspace.db.prepare("SELECT input FROM classify_labels WHERE use='learning'").all() as Array<{
        input: string;
    }>;
    expect(row!.input).toContain('<email>');
    expect(row!.input).not.toContain('REPLY-CANARY');
    // The seam's own settings API knows the use; it stays off.
    const use = await (await alice('/classify/uses/learning')).json();
    expect(use).toMatchObject({ use: 'learning', enabled: false, golden: 1 });
});
