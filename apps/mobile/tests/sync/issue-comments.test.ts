import { afterEach, describe, expect, it } from 'vitest';

import type { IssueComment, IssueDetail } from '@socio/shared/issues/issue-types';

import type { AuthedFetch, AuthedRequestInit } from '../../src/net/authed-fetch';
import { NetworkError } from '../../src/net/errors';
import { unsentListRows } from '../../src/shell/unsent';
import { type Drafts, openDrafts } from '../../src/sync/chat-drafts';
import {
    COMMENT_EDIT_KIND,
    COMMENT_IDS,
    commentBody,
    CommentError,
    commentOnIssue,
    commentRoute,
    deleteComment,
    editComment,
    ISSUE_COMMENT_KIND,
    ISSUE_COMMENT_VIEWS,
    ISSUE_COMMENTS,
    issueCommentKinds,
    isLocalComment,
    seenComments,
} from '../../src/sync/issue-comments';
import {
    fileIssue,
    ISSUE_DRAFT,
    issueCommentsDraft,
    issueCreateKind,
    issueDraftText,
} from '../../src/sync/issue-create';
import { ISSUE_IDS } from '../../src/sync/local-ids';
import { type Outbox, type OutboxKind, openOutbox } from '../../src/sync/outbox';
import { overlaysOf } from '../../src/sync/outbox-overlay';

import { turns, userDb } from './outbox-fakes';

// Issue comments: add, edit and delete on a real outbox and drafts (user.db),
// against a fake server whose comment routes answer as src/server/issues's
// do: the body trimmed by `commentInput`, 403 for someone else's comment, a
// deleted comment gone (404) after.

const ME = 'user-me';

const json = (status: number, body: unknown = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Script = 'ok' | 'drop' | { readonly status: number; readonly body?: unknown };

function server() {
    const details = new Map<number, IssueDetail>();
    const scripts: Script[] = [];
    const log: string[] = [];
    let offline = false;
    /** The detail can't be read (a check can't tell). */
    let readsDown = false;
    let clock = 10_000_000;
    let ids = 0;
    let last = 40;

    const issue = (number = ++last): IssueDetail => {
        const at = (clock += 1_000);
        const detail = {
            issue: {
                id: `issue-${number}`,
                number,
                title: 'Export fails',
                body: '',
                status: 'triage',
                priority: 'medium',
                kind: 'bug',
                area: null,
                labels: [],
                reporterId: ME,
                assigneeId: null,
                resolution: null,
                source: 'web',
                createdAt: at,
                updatedAt: at,
                closedAt: null,
            },
            comments: [],
            attachments: [],
            events: [],
            users: {},
        } as unknown as IssueDetail;
        details.set(number, detail);
        return detail;
    };

    const addComment = (number: number, body: string, authorId = ME): IssueComment => {
        const detail = details.get(number)!;
        const comment: IssueComment = {
            id: `comment-${++ids}`,
            issueId: detail.issue.id,
            authorKind: 'user',
            authorId,
            body: body.trim(),
            createdAt: (clock += 1_000),
            editedAt: null,
        };
        details.set(number, { ...detail, comments: [...detail.comments, comment] });
        return comment;
    };

    const fetch: AuthedFetch = async (input: string, init: AuthedRequestInit = {}) => {
        const method = init.method ?? 'GET';
        if (offline) {
            throw new NetworkError(input);
        }
        log.push(`${method} ${input}`);
        const body = (init.json ?? {}) as Record<string, unknown>;
        if (input === '/api/issues' && method === 'POST') {
            const detail = issue();
            return json(201, detail);
        }
        if (input === '/api/issues') {
            return json(200, {
                issues: [...details.values()].map(({ issue: i }) => ({
                    number: i.number,
                    title: i.title,
                    updatedAt: i.updatedAt,
                })),
                users: {},
            });
        }
        const match = /^\/api\/issues\/(\d+)(?:\/comments(?:\/([^/]+))?)?$/.exec(input);
        const detail = match ? details.get(Number(match[1])) : undefined;
        if (!match || detail === undefined) {
            return json(404, { error: 'Issue not found.' });
        }
        const number = Number(match[1]);
        if (method === 'GET' && readsDown) {
            return json(500, { error: 'Internal error.' });
        }
        const script = method === 'GET' ? 'ok' : (scripts.shift() ?? 'ok');
        if (typeof script === 'object') {
            return json(script.status, script.body ?? { error: 'Refused.' });
        }
        if (input.endsWith('/comments') && method === 'POST') {
            if (typeof body.body !== 'string' || body.body.trim() === '') {
                return json(400, { error: 'Invalid request.' });
            }
            const comment = addComment(number, body.body);
            if (script === 'drop') {
                throw new NetworkError(input);
            }
            return json(201, comment);
        }
        if (match[2] !== undefined) {
            const comment = detail.comments.find((item) => item.id === decodeURIComponent(match[2]!));
            if (comment === undefined) {
                return json(404, { error: 'Comment not found.' });
            }
            if (comment.authorId !== ME) {
                return json(403, { error: 'You can edit only your own comments.' });
            }
            if (method === 'PATCH') {
                const edited = { ...comment, body: String(body.body).trim(), editedAt: (clock += 1_000) };
                details.set(number, {
                    ...detail,
                    comments: detail.comments.map((item) => (item.id === comment.id ? edited : item)),
                });
                return script === 'drop' ? Promise.reject(new NetworkError(input)) : json(200, edited);
            }
            if (method === 'DELETE') {
                details.set(number, { ...detail, comments: detail.comments.filter((item) => item.id !== comment.id) });
                return script === 'drop' ? Promise.reject(new NetworkError(input)) : json(200, { ok: true });
            }
        }
        if (method === 'PATCH' && match[2] === undefined && !input.includes('/comments')) {
            // The issue field edit, stood in by a test kind below.
            return json(200, detail);
        }
        return method === 'GET' ? json(200, detail) : json(404, {});
    };

    return {
        fetch,
        details,
        scripts,
        log,
        issue,
        addComment,
        get clock() {
            return clock;
        },
        offline: (on: boolean) => void (offline = on),
        readsDown: (on: boolean) => void (readsDown = on),
        writes: () => log.filter((line) => !line.startsWith('GET')),
        comments: (number: number) => details.get(number)!.comments,
    };
}

type Server = ReturnType<typeof server>;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup();
    }
});

let ids = 0;
const newId = () => `id-${++ids}`;

/** The issue field edit, as a stand-in: `PATCH /api/issues/:n` in `issue:<n>`. */
const FIELD_EDIT: OutboxKind<{ issue: string }> = {
    kind: 'test-issue-update',
    payloadVersion: 1,
    repeatable: true,
    async send({ payload }, context) {
        const response = await context.fetch(`/api/issues/${payload.issue}`, { method: 'PATCH', json: {} });
        return response.ok ? { action: 'done' } : { action: 'unsent', reason: `http-${response.status}` };
    },
};

interface Phone {
    readonly outbox: Outbox;
    readonly drafts: Drafts;
    readonly held: Map<string, IssueDetail>;
    readonly wrote: string[];
    relaunch(options?: { start?: boolean }): Promise<Phone>;
    settle(): Promise<void>;
    until(done: () => boolean): Promise<void>;
}

async function open(
    srv: Server,
    kept?: Awaited<ReturnType<typeof userDb>>,
    { start = true }: { start?: boolean } = {},
): Promise<Phone> {
    const user = kept ?? (await userDb());
    const file = await user.open();
    // The scope's issue details, as far as the hand-off reads them: the details a screen holds.
    const held = new Map<string, IssueDetail>();
    const wrote: string[] = [];
    const issueDetails = {
        peek: (key: string) => (held.has(key) ? ({ state: { value: held.get(key)! } } as never) : undefined),
        put: async (key: string, detail: IssueDetail) => void held.set(key, detail),
    };
    const outbox = await openOutbox({
        db: file.db,
        state: file.state,
        kinds: [
            issueCreateKind() as OutboxKind<unknown>,
            ...issueCommentKinds({ issueDetails, afterWrite: (path) => wrote.push(path) }),
            FIELD_EDIT as OutboxKind<unknown>,
        ],
        fetch: srv.fetch,
        random: () => 0,
    });
    const drafts = await openDrafts({ db: file.db, state: file.state, outbox });
    let closed = false;
    const close = async () => {
        if (closed) {
            return;
        }
        closed = true;
        await drafts.close();
        await outbox.dispose();
        await file.db.close().catch(() => {});
    };
    cleanups.push(close);
    if (!kept) {
        cleanups.unshift(async () => {
            const { rmSync } = await import('node:fs');
            rmSync(user.directory, { recursive: true, force: true });
        });
    }
    if (start) {
        outbox.start();
    }
    const phone: Phone = {
        outbox,
        drafts,
        held,
        wrote,
        async relaunch(options = {}) {
            await drafts.flush();
            await close();
            return open(srv, user, options);
        },
        async settle() {
            for (let i = 0; i < 3; i += 1) {
                await turns(10);
                await outbox.idle();
            }
            await turns(10);
        },
        async until(done) {
            const end = Date.now() + 15_000;
            await phone.settle();
            while (!done()) {
                if (Date.now() > end) {
                    throw new Error('Timed out waiting for the outbox.');
                }
                await new Promise((resolve) => setTimeout(resolve, 50));
                await phone.settle();
            }
        },
    };
    return phone;
}

/** The person types `text` in issue `issue`'s comment box and sends it. */
async function comment(phone: Phone, srv: Server, issue: string, text: string) {
    phone.drafts.write(issueCommentsDraft(issue), text);
    const sent = await commentOnIssue({
        outbox: phone.outbox,
        drafts: phone.drafts,
        newId,
        issue,
        authorId: ME,
        serverAt: srv.clock,
    });
    expect(sent).not.toBeNull();
    return sent!;
}

describe('adding a comment', () => {
    it('sends it trimmed, records its id and hands it into the held detail', async () => {
        const srv = server();
        srv.issue();
        const phone = await open(srv);
        phone.held.set('41', srv.details.get(41)!);
        const { commentId, row } = await comment(phone, srv, '41', '  Same here.\n');
        expect(isLocalComment(commentId)).toBe(true);
        expect(row.lane).toBe('issue-comments:41');
        expect(phone.drafts.read(issueCommentsDraft('41')).text).toBe('');
        await phone.settle();
        expect(srv.comments(41).map((item) => item.body)).toEqual(['Same here.']);
        const serverId = srv.comments(41)[0]!.id;
        expect(phone.outbox.resolve(COMMENT_IDS, commentId)).toBe(serverId);
        expect(phone.held.get('41')!.comments.map((item) => item.id)).toEqual([serverId]);
        expect(phone.wrote).toEqual(['/api/issues/41/comments']);
        expect(phone.outbox.rows()).toEqual([]);
    });

    it('refuses blank text and text over the limit, and keeps the box', async () => {
        expect(() => commentBody('   ')).toThrow(CommentError);
        expect(() => commentBody('x'.repeat(10_001))).toThrow(CommentError);
        expect(commentBody(` ${'x'.repeat(10_000)} `)).toHaveLength(10_000);
        const srv = server();
        srv.issue();
        const phone = await open(srv);
        phone.drafts.write(issueCommentsDraft('41'), 'x'.repeat(10_001));
        await expect(
            commentOnIssue({ outbox: phone.outbox, drafts: phone.drafts, newId, issue: '41', authorId: ME }),
        ).rejects.toBeInstanceOf(CommentError);
        expect(phone.drafts.read(issueCommentsDraft('41')).text).toHaveLength(10_001);
        expect(phone.outbox.rows()).toEqual([]);
    });

    it('a comment on a CB-? issue goes after its create, under its number', async () => {
        const srv = server();
        srv.offline(true);
        const phone = await open(srv);
        phone.drafts.write(ISSUE_DRAFT, issueDraftText({ title: 'Export fails', body: '' }));
        const filed = (await fileIssue({ drafts: phone.drafts, newId, reporterId: ME, after: null }))!;
        const first = await comment(phone, srv, filed.localKey, 'First');
        expect(first.row.lane).toBe(`issue-comments:${filed.localKey}`);
        expect(first.row.dependsOn).toBe(filed.localKey);
        await phone.settle();
        srv.offline(false);
        phone.outbox.poke();
        await phone.until(() => phone.outbox.rows().length === 0);
        expect(srv.writes()).toEqual(['POST /api/issues', 'POST /api/issues/41/comments']);
        expect(phone.outbox.resolve(ISSUE_IDS, filed.localKey)).toBe('41');
        expect(srv.comments(41).map((item) => item.body)).toEqual(['First']);
    });

    it('a comment written under the number joins the local lane while it still holds a write', async () => {
        const srv = server();
        srv.issue();
        const phone = await open(srv);
        // The create resolved to 41; one comment under the local key still waits (offline).
        srv.offline(true);
        await phone.outbox.enqueue({
            id: 'pending-issue-x',
            lane: 'issue:pending-issue-x',
            kind: 'test-issue-update',
            payload: JSON.stringify({ issue: '41' }),
            payloadVersion: 1,
            idempotencyKey: 'k',
        });
        expect(commentRoute(phone.outbox, '41')).toEqual({ lane: 'issue-comments:41', dependsOn: null });
        const stub = {
            rows: () => [{ lane: 'issue-comments:pending-issue-x' }],
            unsent: () => [],
            resolve: (kind: string, id: string) => (kind === ISSUE_IDS && id === 'pending-issue-x' ? '41' : null),
        } as unknown as Outbox;
        expect(commentRoute(stub, '41')).toEqual({ lane: 'issue-comments:pending-issue-x', dependsOn: null });
        expect(commentRoute(stub, 'pending-issue-x')).toEqual({
            lane: 'issue-comments:pending-issue-x',
            dependsOn: null,
        });
        expect(commentRoute(phone.outbox, 'pending-issue-y')).toEqual({
            lane: 'issue-comments:pending-issue-y',
            dependsOn: 'pending-issue-y',
        });
    });

    it('two identical “+1” comments, a kill during the first: each settles on its own comment', async () => {
        const srv = server();
        srv.issue();
        let phone = await open(srv);
        srv.scripts.push('drop');
        const one = await comment(phone, srv, '41', '+1');
        const two = await comment(phone, srv, '41', '+1');
        // The first is stored, its answer lost, and the app dies before anything else.
        await phone.settle();
        srv.offline(true);
        phone = await phone.relaunch();
        srv.offline(false);
        phone.outbox.poke();
        await phone.until(() => phone.outbox.rows().length === 0);
        const stored = srv.comments(41).map((item) => item.id);
        expect(stored).toHaveLength(2);
        expect(srv.writes().filter((line) => line === 'POST /api/issues/41/comments')).toHaveLength(2);
        expect([
            phone.outbox.resolve(COMMENT_IDS, one.commentId),
            phone.outbox.resolve(COMMENT_IDS, two.commentId),
        ]).toEqual(stored);
    });

    it('a second “+1” whose answer is lost is not taken for the first, which another write claims', async () => {
        const srv = server();
        srv.issue();
        const phone = await open(srv);
        const one = await comment(phone, srv, '41', '+1');
        await phone.settle();
        srv.scripts.push('drop');
        const two = await comment(phone, srv, '41', '+1');
        await phone.until(() => phone.outbox.rows().length === 0);
        const [first, second] = srv.comments(41).map((item) => item.id);
        expect(srv.comments(41)).toHaveLength(2);
        expect(phone.outbox.resolve(COMMENT_IDS, one.commentId)).toBe(first);
        expect(phone.outbox.resolve(COMMENT_IDS, two.commentId)).toBe(second);
    });

    it('a request that never arrived goes again after the check finds nothing', async () => {
        const srv = server();
        srv.issue();
        let phone = await open(srv);
        await comment(phone, srv, '41', 'Lost');
        // Killed in flight before the server saw it.
        srv.offline(true);
        await phone.settle();
        phone = await phone.relaunch();
        srv.offline(false);
        phone.outbox.poke();
        await phone.until(() => phone.outbox.rows().length === 0);
        expect(srv.comments(41).map((item) => item.body)).toEqual(['Lost']);
    });

    it('with no Date seen, an older identical comment the screen showed is not taken for a lost one', async () => {
        const srv = server();
        srv.issue();
        srv.addComment(41, '+1');
        let phone = await open(srv);
        // Opened offline: no Date, so only what the screen shows bounds the check.
        srv.offline(true);
        phone.drafts.write(issueCommentsDraft('41'), '+1');
        const seen = seenComments(srv.details.get(41));
        await commentOnIssue({
            outbox: phone.outbox,
            drafts: phone.drafts,
            newId,
            issue: '41',
            authorId: ME,
            seen,
        });
        await phone.settle();
        phone = await phone.relaunch();
        srv.offline(false);
        phone.outbox.poke();
        await phone.until(() => phone.outbox.rows().length === 0);
        expect(srv.comments(41).map((item) => item.body)).toEqual(['+1', '+1']);
        expect(srv.writes()).toEqual(['POST /api/issues/41/comments']);
    });

    it('with neither a Date nor a held detail, one identical comment waits for the person', async () => {
        const srv = server();
        srv.issue();
        const old = srv.addComment(41, '+1');
        let phone = await open(srv);
        srv.offline(true);
        phone.drafts.write(issueCommentsDraft('41'), '+1');
        const sent = await commentOnIssue({
            outbox: phone.outbox,
            drafts: phone.drafts,
            newId,
            issue: '41',
            authorId: ME,
        });
        await phone.settle();
        phone = await phone.relaunch();
        srv.offline(false);
        phone.outbox.poke();
        await phone.until(() => phone.outbox.holds().length > 0);
        const row = phone.outbox.rows().find((item) => item.id === sent!.commentId)!;
        expect(row.lastError).toBe('unconfirmed');
        expect(phone.outbox.resolve(COMMENT_IDS, sent!.commentId)).toBeNull();
        expect(srv.comments(41).map((item) => item.id)).toEqual([old.id]);
        // The person sends it again: it goes once.
        await phone.outbox.sendNow(sent!.commentId);
        await phone.until(() => phone.outbox.rows().length === 0);
        expect(srv.comments(41).map((item) => item.body)).toEqual(['+1', '+1']);
    });

    it('a refused comment holds no field edit, and a field edit no comment', async () => {
        const srv = server();
        srv.issue();
        const phone = await open(srv);
        srv.scripts.push({ status: 403 });
        await comment(phone, srv, '41', 'Not allowed');
        await phone.settle();
        await phone.outbox.enqueue({
            id: 'edit-1',
            lane: 'issue:41',
            kind: 'test-issue-update',
            payload: JSON.stringify({ issue: '41' }),
            payloadVersion: 1,
            idempotencyKey: 'k1',
        });
        await phone.settle();
        expect(srv.writes()).toEqual(['POST /api/issues/41/comments', 'PATCH /api/issues/41']);
        expect(phone.outbox.unsent().map((write) => [write.kind, write.reason])).toEqual([
            [ISSUE_COMMENT_KIND, 'refused'],
        ]);
        expect(phone.outbox.rows()).toEqual([]);
    });

    it('400 and a gone issue go to Unsent in 10.2’s words, on the issue they were for', async () => {
        const srv = server();
        srv.issue();
        const phone = await open(srv);
        srv.scripts.push({
            status: 400,
            body: { error: 'Descriptions can be at most 20,000 characters; comments 10,000.' },
        });
        await comment(phone, srv, '41', 'Too long');
        await comment(phone, srv, '99', 'On a gone issue');
        await phone.settle();
        const rows = unsentListRows(phone.outbox.unsent(), phone.outbox.holds(), {
            chatTitle: () => null,
            resolve: () => null,
        });
        expect(rows.map((row) => [row.what, row.where, row.why, row.text])).toEqual([
            ['Comment', 'CB-41', 'It couldn’t be sent as written', 'Too long'],
            ['Comment', 'CB-99', 'You no longer have access', 'On a gone issue'],
        ]);
    });
});

describe('editing and deleting comments', () => {
    it('edits a queued comment in place, and deletes one with no request', async () => {
        const srv = server();
        srv.issue();
        // Nothing has gone yet: the outbox hasn't started (as before the scope's start).
        const phone = await open(srv, undefined, { start: false });
        const one = await comment(phone, srv, '41', 'Tpyo');
        const two = await comment(phone, srv, '41', 'Never mind');
        expect(await editComment(phone.outbox, { issue: '41', commentId: one.commentId, text: ' Typo ', newId })).toBe(
            'in-place',
        );
        expect(await deleteComment(phone.outbox, { issue: '41', commentId: two.commentId, newId })).toBe('in-place');
        expect(phone.outbox.rows().map((row) => [row.kind, JSON.parse(row.payload).body])).toEqual([
            [ISSUE_COMMENT_KIND, 'Typo'],
        ]);
        phone.outbox.start();
        await phone.until(() => phone.outbox.rows().length === 0);
        expect(srv.writes()).toEqual(['POST /api/issues/41/comments']);
        expect(srv.comments(41).map((item) => item.body)).toEqual(['Typo']);
    });

    it('edits a refused comment in Unsent in place, and discards one there', async () => {
        const srv = server();
        srv.issue();
        const phone = await open(srv);
        srv.scripts.push({ status: 400 }, { status: 400 });
        const one = await comment(phone, srv, '41', 'First');
        await phone.settle();
        expect(await editComment(phone.outbox, { issue: '41', commentId: one.commentId, text: 'Edited', newId })).toBe(
            'in-place',
        );
        expect(JSON.parse(phone.outbox.unsent()[0]!.payload).body).toBe('Edited');
        expect(await deleteComment(phone.outbox, { issue: '41', commentId: one.commentId, newId })).toBe('in-place');
        expect(phone.outbox.unsent()).toEqual([]);
    });

    it('edits a sent comment over the network, folding a second edit, and a delete drops the edits queued', async () => {
        const srv = server();
        srv.issue();
        const stored = srv.addComment(41, 'Old');
        let phone = await open(srv);
        phone.held.set('41', srv.details.get(41)!);
        expect(await editComment(phone.outbox, { issue: '41', commentId: stored.id, text: 'New', newId })).toBe(
            'queued',
        );
        await phone.settle();
        expect(srv.comments(41)[0]!.body).toBe('New');
        expect(phone.held.get('41')!.comments[0]!.body).toBe('New');

        // Written before the outbox sends again (a queued row, not yet tried).
        phone = await phone.relaunch({ start: false });
        phone.held.set('41', srv.details.get(41)!);
        await editComment(phone.outbox, { issue: '41', commentId: stored.id, text: 'Newer', newId });
        await editComment(phone.outbox, { issue: '41', commentId: stored.id, text: 'Newest', newId });
        expect(phone.outbox.rows().map((row) => [row.kind, JSON.parse(row.payload).body])).toEqual([
            [COMMENT_EDIT_KIND, 'Newest'],
        ]);
        expect(await deleteComment(phone.outbox, { issue: '41', commentId: stored.id, newId })).toBe('queued');
        expect(await deleteComment(phone.outbox, { issue: '41', commentId: stored.id, newId })).toBe('queued');
        expect(phone.outbox.rows().map((row) => row.kind)).toEqual(['comment-delete']);
        phone.outbox.start();
        await phone.until(() => phone.outbox.rows().length === 0);
        expect(srv.writes()).toEqual([
            `PATCH /api/issues/41/comments/${stored.id}`,
            `DELETE /api/issues/41/comments/${stored.id}`,
        ]);
        expect(srv.comments(41)).toEqual([]);
        expect(phone.held.get('41')!.comments).toEqual([]);
    });

    it('a delete whose answer is lost goes again and takes the 404 as done; someone else’s comment is refused', async () => {
        const srv = server();
        srv.issue();
        const mine = srv.addComment(41, 'Mine');
        const theirs = srv.addComment(41, 'Theirs', 'someone-else');
        const phone = await open(srv);
        srv.scripts.push('drop');
        await deleteComment(phone.outbox, { issue: '41', commentId: mine.id, newId });
        await editComment(phone.outbox, { issue: '41', commentId: theirs.id, text: 'Hijack', newId });
        await phone.until(() => phone.outbox.rows().length === 0);
        expect(srv.comments(41).map((item) => item.id)).toEqual([theirs.id]);
        const rows = unsentListRows(phone.outbox.unsent(), phone.outbox.holds(), {
            chatTitle: () => null,
            resolve: () => null,
        });
        expect(rows.map((row) => [row.what, row.why, row.text])).toEqual([
            ['Edited comment', 'You can change only your own comments', 'Hijack'],
        ]);
    });

    it('an edit of a comment still going waits for it, then goes under the server’s id', async () => {
        const srv = server();
        srv.issue();
        const phone = await open(srv);
        srv.scripts.push('drop');
        // Its request goes and breaks off, and its check can't read the detail yet: unknown, not editable in place.
        srv.readsDown(true);
        const one = await comment(phone, srv, '41', 'Draft');
        const sent = phone.outbox.rows()[0]!;
        await phone.settle();
        expect(phone.outbox.rows()[0]!.id).toBe(sent.id);
        expect(phone.outbox.rows()[0]!.state).toBe('unknown');
        expect(await editComment(phone.outbox, { issue: '41', commentId: one.commentId, text: 'Final', newId })).toBe(
            'queued',
        );
        expect(phone.outbox.rows()[1]!.dependsOn).toBe(one.commentId);
        srv.readsDown(false);
        phone.outbox.wake();
        await phone.until(() => phone.outbox.rows().length === 0);
        const serverId = srv.comments(41)[0]!.id;
        expect(srv.comments(41).map((item) => item.body)).toEqual(['Final']);
        expect(srv.writes()).toEqual(['POST /api/issues/41/comments', `PATCH /api/issues/41/comments/${serverId}`]);
    });

    it('lays its writes over the detail’s comments', async () => {
        const srv = server();
        srv.issue();
        const stored = srv.addComment(41, 'Old');
        const phone = await open(srv, undefined, { start: false });
        const added = await comment(phone, srv, '41', 'Pending');
        await editComment(phone.outbox, { issue: '41', commentId: stored.id, text: 'Changed', newId });
        const items = overlaysOf({
            rows: phone.outbox.rows(),
            kinds: ISSUE_COMMENT_VIEWS,
            scope: { resolve: () => null },
        });
        expect(items.map((item) => [item.collection, item.key, item.mode, item.value])).toEqual([
            [ISSUE_COMMENTS, added.commentId, 'insert', { issue: '41', body: 'Pending', authorId: ME }],
            [ISSUE_COMMENTS, stored.id, 'patch', { issue: '41', body: 'Changed' }],
        ]);
    });
});
