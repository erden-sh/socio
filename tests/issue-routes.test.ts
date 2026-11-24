import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it } from 'vitest';

import { backupDatabase } from '@socio/data/backup';
import type {
    IssueAssignees,
    IssueAttachment,
    IssueCard,
    IssueComment,
    IssueDetail,
    IssueList,
} from '@socio/shared/issues/issue-types';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';

import { testDatabaseFile } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const auth = () => ({
    provider: new MockAuthProvider(DEFAULT_MOCK_USERS, 'secret-0123456789abcdef-xyz'),
    secureCookies: false,
});
/**
 * The app's runtime over a test database, or, given `database`, over that
 * file (the backup test reads it back).
 */
async function runtime(database?: string) {
    const built = await makeTestRuntime({
        ...(database === undefined ? {} : { database }),
        config: { baseUrl: '', apiKey: '', model: '', runtimeUrl: '' },
        app: { auth: auth() },
    });
    cleanup.push(built.dispose);
    return built;
}

async function fixture(database?: string) {
    const { workspace, platform, app } = await runtime(database);
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
    return {
        app,
        workspace,
        platform,
        alice: await as('alice'),
        bob: await as('bob'),
    };
}
const json = async <T>(response: Response | Promise<Response>) => (await (await response).json()) as T;

it('shows the socio and acting person on both linked issue histories without leaking the private source thread', async () => {
    const f = await fixture();
    const dot = f.workspace.dots()[0];
    const first = await f.platform.board.issues.create({ title: 'Foundation' }, 'alice');
    await f.platform.board.filings.file(
        {
            userId: 'alice',
            dotId: dot.id,
            trigger: 'chat',
            causeId: null,
            threadId: 'private-source-thread',
        },
        {
            title: 'Dependent fix',
            kind: 'bug',
            problem: 'Keep provenance',
            blockedBy: ['CB-1'],
            fileAnyway: true,
        },
    );
    for (const number of [first.number, 2]) {
        const detail = await json<IssueDetail>(f.bob(`/issues/${number}`));
        const event = detail.events.find((row) => row.kind === 'blocks' || row.kind === 'blocked_by');
        expect(event?.dot).toMatchObject({
            dotId: dot.id,
            userId: 'alice',
            trigger: 'chat',
        });
        expect(detail.users.alice).toBe('Alice');
        expect(detail.users[`dot:${dot.id}`]).toBe(dot.name);
        expect(JSON.stringify(detail)).not.toContain('private-source-thread');
        expect(detail.events.filter((row) => row.kind === 'created').every((row) => !row.dot)).toBe(true);
    }
});

it('lets everyone read every issue; members file into triage, admins anywhere', async () => {
    const { alice, bob } = await fixture();
    const filed = await bob('/issues', 'POST', {
        title: 'The board is slow',
        body: 'Takes 3 s.',
        kind: 'improvement',
        priority: 'high',
        area: 'client',
    });
    expect(filed.status).toBe(201);
    const bobs = await json<IssueDetail>(filed);
    expect(bobs.issue).toMatchObject({
        number: 1,
        status: 'triage',
        reporterId: 'bob',
        kind: 'improvement',
    });
    expect(bobs.users).toEqual({ bob: 'Bob' });
    // Members cannot pick a status, labels, assignee or resolution.
    for (const extra of [
        { status: 'open' },
        { labels: ['ux'] },
        { assigneeId: 'bob' },
        { resolution: 'done already' },
    ]) {
        const refused = await bob('/issues', 'POST', { title: 'Sneaky', ...extra });
        expect(refused.status).toBe(403);
    }
    expect((await bob('/issues', 'POST', { title: 'Explicit', status: 'triage' })).status).toBe(201);
    const admins = await json<IssueDetail>(
        alice('/issues', 'POST', {
            title: 'Ship the tracker',
            status: 'open',
            labels: ['owner:lead'],
            assigneeId: 'alice',
        }),
    );
    expect(admins.issue).toMatchObject({
        number: 3,
        status: 'open',
        labels: ['owner:lead'],
        assigneeId: 'alice',
    });
    // Everyone sees all issues, with their assignees' names.
    for (const viewer of [alice, bob]) {
        const list = await json<IssueList>(viewer('/issues'));
        expect(list.issues.map((issue) => issue.number).sort()).toEqual([1, 2, 3]);
        expect(list.users).toEqual({ alice: 'Alice' });
        expect((await viewer('/issues/CB-3')).status).toBe(200);
        expect((await viewer('/issues/1')).status).toBe(200);
    }
    expect((await bob('/issues/CB-99')).status).toBe(404);
    expect((await bob('/issues/nope')).status).toBe(404);
    expect((await json<IssueList>(bob('/issues?status=open'))).issues.map((issue) => issue.number)).toEqual([3]);
});

it('lets members edit only their own issue’s title and body while in triage', async () => {
    const { alice, bob } = await fixture();
    await bob('/issues', 'POST', { title: 'Bob’s issue' });
    await alice('/issues', 'POST', { title: 'Alice’s issue' });
    const edit = await bob('/issues/1', 'PATCH', {
        title: 'Bob’s issue, clearer',
        body: 'Steps to reproduce.',
    });
    expect(edit.status).toBe(200);
    expect((await json<IssueDetail>(edit)).issue.title).toBe('Bob’s issue, clearer');
    // Someone else’s issue, even in triage.
    expect((await bob('/issues/2', 'PATCH', { title: 'Not mine' })).status).toBe(403);
    // Triage fields stay with admins.
    for (const change of [
        { status: 'open' },
        { priority: 'critical' },
        { labels: ['ux'] },
        { assigneeId: 'bob' },
        { area: 'client' },
        { kind: 'feature' },
        { resolution: 'Fixed' },
    ]) {
        expect((await bob('/issues/1', 'PATCH', change)).status).toBe(403);
    }
    // Once triaged, the member’s own issue is read-only to them.
    expect((await alice('/issues/1', 'PATCH', { status: 'open' })).status).toBe(200);
    expect((await bob('/issues/1', 'PATCH', { body: 'More detail.' })).status).toBe(403);
    // Admins edit any field of any issue.
    const triaged = await json<IssueDetail>(
        alice('/issues/1', 'PATCH', {
            title: 'Board is slow with 200 issues',
            body: 'Edited by an admin.',
            priority: 'high',
            labels: ['performance'],
            assigneeId: 'bob',
            area: 'client',
            kind: 'improvement',
        }),
    );
    expect(triaged.issue).toMatchObject({
        status: 'open',
        priority: 'high',
        labels: ['performance'],
        assigneeId: 'bob',
    });
    // Every change is in the history, with who made it.
    expect(triaged.events.map((event) => [event.kind, event.actorId, event.toValue])).toEqual([
        ['created', 'bob', 'triage'],
        ['title', 'bob', 'Bob’s issue, clearer'],
        ['body', 'bob', 'Steps to reproduce.'],
        ['status', 'alice', 'open'],
        ['title', 'alice', 'Board is slow with 200 issues'],
        ['body', 'alice', 'Edited by an admin.'],
        ['priority', 'alice', 'high'],
        ['kind', 'alice', 'improvement'],
        ['area', 'alice', 'client'],
        ['assignee', 'alice', 'bob'],
        ['labels', 'alice', 'performance'],
    ]);
});

it('rejects unknown statuses, priorities, kinds, areas, labels and fields', async () => {
    const { alice, bob } = await fixture();
    await alice('/issues', 'POST', { title: 'Valid issue' });
    for (const [change, error] of [
        [{ status: 'closed' }, 'Unknown status.'],
        [{ priority: 'urgent' }, 'Unknown priority.'],
        [{ kind: 'epic' }, 'Unknown kind.'],
        [{ area: 'kitchen' }, 'Unknown area.'],
        [{ labels: ['wat'] }, 'Unknown labels.'],
        [{ owner: 'alice' }, 'Unknown field: owner.'],
        [{ title: 'x' }, 'Enter a title of 3 to 200 characters.'],
    ] as const) {
        const response = await alice('/issues/1', 'PATCH', change);
        expect(response.status).toBe(400);
        expect(await json(response)).toEqual({ error: error });
    }
    expect((await bob('/issues', 'POST', { title: 'no', kind: 'epic' })).status).toBe(400);
    expect((await bob('/issues?status=closed')).status).toBe(400);
    expect((await bob('/issues?label=wat')).status).toBe(400);
});

it('lets only admins delete issues', async () => {
    const { alice, bob, platform } = await fixture();
    const { issue } = await json<IssueDetail>(bob('/issues', 'POST', { title: 'Delete me' }));
    await bob('/issues/1/comments', 'POST', { body: 'A comment.' });
    expect((await bob('/issues/1', 'DELETE')).status).toBe(403);
    expect((await alice('/issues/1', 'DELETE')).status).toBe(200);
    expect((await alice('/issues/1')).status).toBe(404);
    expect(await platform.board.issues.comments(issue.id)).toEqual([]);
    expect((await alice('/issues/1', 'DELETE')).status).toBe(404);
});

it('gives chat’s issue cards in one call, live issues only', async () => {
    const { alice, bob } = await fixture();
    await bob('/issues', 'POST', {
        title: 'The board is slow',
        body: '**Cards** take too long to appear after changing filters.',
        kind: 'improvement',
        priority: 'high',
        area: 'client',
    });
    await bob('/issues', 'POST', { title: 'Deleted soon' });
    await alice('/issues', 'POST', { title: 'Ship cards', status: 'open' });
    await alice('/issues/2', 'DELETE');
    // Missing (99) and deleted (2) issues are left out; repeats count once.
    expect(await json<IssueCard[]>(bob('/issues/cards?numbers=3,1,2,99,1'))).toEqual([
        {
            number: 1,
            title: 'The board is slow',
            excerpt: 'Cards take too long to appear after changing filters.',
            status: 'triage',
            kind: 'improvement',
            priority: 'high',
            area: 'client',
        },
        {
            number: 3,
            title: 'Ship cards',
            excerpt: '',
            status: 'open',
            kind: 'bug',
            priority: 'medium',
            area: null,
        },
    ]);
    const many = Array.from({ length: 51 }, (_, index) => index + 1).join(',');
    for (const query of ['', '?numbers=', '?numbers=CB-1', '?numbers=0', `?numbers=${many}`, '?numbers=1&q=x']) {
        expect([query, (await bob(`/issues/cards${query}`)).status]).toEqual([query, 400]);
    }
});

it('lists the users an issue can be assigned to, for admins only', async () => {
    const { alice, bob } = await fixture();
    expect((await bob('/issues/assignees')).status).toBe(403);
    const { users, deactivated } = await json<IssueAssignees>(alice('/issues/assignees'));
    expect(users.map((user) => user.id)).toEqual(DEFAULT_MOCK_USERS.map((user) => user.id));
    // Mock auth deactivates no one (Better Auth: better-auth.test.ts).
    expect(deactivated).toEqual([]);
    expect(Object.keys(users[0]!).sort()).toEqual(['id', 'name']);
});

it('lets everyone comment; authors edit their own; admins delete any', async () => {
    const { alice, bob } = await fixture();
    await alice('/issues', 'POST', { title: 'Discuss this', status: 'open' });
    const bobs = await json<IssueComment>(bob('/issues/CB-1/comments', 'POST', { body: 'I see this too.' }));
    const alices = await json<IssueComment>(alice('/issues/1/comments', 'POST', { body: 'Thanks, looking.' }));
    expect((await bob(`/issues/1/comments/${bobs.id}`, 'PATCH', { body: 'Me too.' })).status).toBe(200);
    expect((await bob(`/issues/1/comments/${alices.id}`, 'PATCH', { body: 'Edit' })).status).toBe(403);
    // Admins delete any comment but edit only their own.
    expect((await alice(`/issues/1/comments/${bobs.id}`, 'PATCH', { body: 'Edit' })).status).toBe(403);
    expect((await bob(`/issues/1/comments/${alices.id}`, 'DELETE')).status).toBe(403);
    expect((await bob('/issues/1/comments', 'POST', { body: ' ' })).status).toBe(400);
    const before = await json<IssueDetail>(bob('/issues/1'));
    expect(before.comments.map((comment) => comment.body)).toEqual(['Me too.', 'Thanks, looking.']);
    expect((await alice(`/issues/1/comments/${bobs.id}`, 'DELETE')).status).toBe(200);
    expect((await bob(`/issues/1/comments/${alices.id}`, 'PATCH', {})).status).toBe(400);
    const after = await json<IssueDetail>(bob('/issues/1'));
    expect(after.comments.map((comment) => comment.authorId)).toEqual(['alice']);
    expect(after.events.map((event) => event.kind)).toEqual([
        'created',
        'comment_added',
        'comment_added',
        'comment_edited',
        'comment_deleted',
    ]);
    expect((await bob('/issues/1/comments/nope', 'DELETE')).status).toBe(404);
});

// Minimal valid files, identified by their first bytes.
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
);
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');
const b64 = (data: Buffer | string) => Buffer.from(data).toString('base64');

it('stores allowlisted attachments and serves them with a server-set type', async () => {
    const { alice, bob } = await fixture();
    await bob('/issues', 'POST', { title: 'With a screenshot' });
    const image = await bob('/issues/1/attachments', 'POST', {
        name: 'screen.png',
        mediaType: 'image/png',
        data: b64(PNG),
    });
    expect(image.status).toBe(201);
    const png = await json<IssueAttachment>(image);
    expect(png).toMatchObject({
        mediaType: 'image/png',
        size: PNG.length,
        uploaderId: 'bob',
    });
    // The type comes from the content when the client sends none.
    const pdf = await json<IssueAttachment>(
        bob('/issues/1/attachments', 'POST', {
            name: 'report.pdf',
            data: b64(PDF),
        }),
    );
    expect(pdf.mediaType).toBe('application/pdf');
    const note = await json<IssueAttachment>(
        alice('/issues/1/attachments', 'POST', {
            name: 'notes.md',
            mediaType: 'text/markdown',
            data: b64('# Steps\n\n1. Open the board.\n'),
        }),
    );
    expect(note.mediaType).toBe('text/plain');

    const served = await bob(`/issue-attachments/${png.id}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(Buffer.from(await served.arrayBuffer())).toEqual(PNG);
    for (const file of [pdf, note]) {
        const download = await alice(`/issue-attachments/${file.id}`);
        expect(download.headers.get('content-type')).toBe(file.mediaType);
        expect(download.headers.get('x-content-type-options')).toBe('nosniff');
        expect(download.headers.get('content-disposition')).toMatch(new RegExp(`^attachment; filename="${file.name}"`));
    }
    const detail = await json<IssueDetail>(bob('/issues/1'));
    expect(detail.attachments.map((file) => file.name)).toEqual(['screen.png', 'report.pdf', 'notes.md']);
    expect(detail.events.filter((e) => e.kind === 'attachment_added')).toHaveLength(3);
    // Uploaders and admins delete; other members cannot.
    expect((await bob(`/issue-attachments/${note.id}`, 'DELETE')).status).toBe(403);
    expect((await alice(`/issue-attachments/${png.id}`, 'DELETE')).status).toBe(200);
    expect((await bob(`/issue-attachments/${pdf.id}`, 'DELETE')).status).toBe(200);
    expect((await bob(`/issue-attachments/${pdf.id}`)).status).toBe(404);
});

it('refuses HTML, SVG and mislabelled uploads (415)', async () => {
    const { bob } = await fixture();
    await bob('/issues', 'POST', { title: 'Upload tests' });
    const html = '<!doctype html><script>alert(document.cookie)</script>';
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>';
    for (const file of [
        { name: 'page.html', mediaType: 'text/html', data: b64(html) },
        { name: 'page.html', mediaType: 'text/plain', data: b64(html) },
        { name: 'page.txt', data: b64(html) },
        { name: 'notes.html', data: b64('just words') },
        { name: 'logo.svg', mediaType: 'image/svg+xml', data: b64(svg) },
        { name: 'logo.png', mediaType: 'image/png', data: b64(svg) },
        // A PNG claiming to be a JPEG, and a PNG with the wrong extension.
        { name: 'photo.jpg', mediaType: 'image/jpeg', data: b64(PNG) },
        { name: 'photo.jpg', data: b64(PNG) },
        { name: 'blob.bin', data: b64(Buffer.from([0, 1, 2, 3, 0xff])) },
    ]) {
        const response = await bob('/issues/1/attachments', 'POST', file);
        expect(response.status, file.name).toBe(415);
    }
    expect((await json<IssueDetail>(bob('/issues/1'))).attachments).toEqual([]);
});

it('caps attachment size (413) and count per issue', async () => {
    const { bob, alice } = await fixture();
    await bob('/issues', 'POST', { title: 'Big files' });
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 0x61);
    const tooBig = await bob('/issues/1/attachments', 'POST', {
        name: 'big.txt',
        data: b64(big),
    });
    expect(tooBig.status).toBe(413);
    // Beyond the route's own body limit, the request is refused unread.
    const huge = await bob('/issues/1/attachments', 'POST', {
        name: 'huge.txt',
        data: b64(Buffer.alloc(8 * 1024 * 1024, 0x61)),
    });
    expect(huge.status).toBe(413);
    // Other routes keep the 1 MB limit.
    expect((await bob('/issues/1/comments', 'POST', { body: 'x'.repeat(1_100_000) })).status).toBe(413);
    // A 2 MB file is fine on the upload route.
    expect(
        (
            await bob('/issues/1/attachments', 'POST', {
                name: 'medium.txt',
                data: b64(Buffer.alloc(2 * 1024 * 1024, 0x61)),
            })
        ).status,
    ).toBe(201);
    for (let n = 2; n <= 10; n++) {
        expect(
            (
                await alice('/issues/1/attachments', 'POST', {
                    name: `${n}.png`,
                    data: b64(PNG),
                })
            ).status,
        ).toBe(201);
    }
    const eleventh = await bob('/issues/1/attachments', 'POST', {
        name: '11.png',
        data: b64(PNG),
    });
    expect(eleventh.status).toBe(413);
});

it('attaches files to comments for their authors, and deletes them with the comment', async () => {
    const { alice, bob, platform } = await fixture();
    await alice('/issues', 'POST', { title: 'Comment files', status: 'open' });
    const comment = await json<IssueComment>(alice('/issues/1/comments', 'POST', { body: 'See screenshot.' }));
    expect(
        (
            await bob('/issues/1/attachments', 'POST', {
                name: 'a.png',
                data: b64(PNG),
                commentId: comment.id,
            })
        ).status,
    ).toBe(403);
    const file = await json<IssueAttachment>(
        alice('/issues/1/attachments', 'POST', {
            name: 'a.png',
            data: b64(PNG),
            commentId: comment.id,
        }),
    );
    expect(file.commentId).toBe(comment.id);
    await alice(`/issues/1/comments/${comment.id}`, 'DELETE');
    expect(await platform.board.issues.attachment(file.id)).toBeUndefined();
});

it('includes attachments in database backups', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'brain-issues-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const live = testDatabaseFile(join(dir, 'live.sqlite'));
    const { bob } = await fixture(live);
    await bob('/issues', 'POST', { title: 'Backed up' });
    const file = await json<IssueAttachment>(bob('/issues/1/attachments', 'POST', { name: 's.png', data: b64(PNG) }));
    const { path } = backupDatabase(live, join(dir, 'backups'));
    const copy = new DatabaseSync(path, { readOnly: true });
    cleanup.push(() => copy.close());
    const row = copy.prepare('SELECT data, sha256 FROM issue_attachments WHERE id=?').get(file.id) as {
        data: Uint8Array;
        sha256: string;
    };
    expect(Buffer.from(row.data)).toEqual(PNG);
    expect(row.sha256).toBe(file.sha256);
});

it('manages only the signed-in person’s one-shot issue subscriptions and rejects recipient spoofing', async () => {
    const f = await fixture();
    await f.platform.board.issues.create({ title: 'Future member issue', status: 'open' }, 'alice');
    const created = await f.bob('/issues/subscriptions', 'POST', {
        issues: ['CB-1'],
    });
    expect(created.status).toBe(201);
    const result = (await created.json()) as {
        watch: { id: string };
        alreadyMatched: boolean;
    };
    expect(result.alreadyMatched).toBe(false);
    expect(await json(f.bob('/issues/subscriptions'))).toMatchObject({
        items: [{ id: result.watch.id, issues: ['CB-1'], state: 'watching' }],
        next: null,
    });
    expect(await json(f.alice('/issues/subscriptions'))).toMatchObject({
        items: [],
    });
    expect((await f.alice('/issues/subscriptions/' + result.watch.id, 'DELETE')).status).toBe(404);
    expect(
        (
            await f.bob('/issues/subscriptions', 'POST', {
                issues: ['CB-1'],
                userId: 'alice',
            })
        ).status,
    ).toBe(400);
    expect((await f.bob('/issues/subscriptions', 'POST', { issues: ['CB-99999'] })).status).toBe(404);
    expect(await json(f.bob('/issues/subscriptions/' + result.watch.id, 'DELETE'))).toMatchObject({
        outcome: 'cancelled',
        watch: { state: 'cancelled' },
    });
});
