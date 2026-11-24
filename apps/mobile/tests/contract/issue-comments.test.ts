import { readFileSync, rmSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import type { IssueDetail } from '@socio/shared/issues/issue-types';

import { createAuthedFetch, type AuthedFetch } from '../../src/net/authed-fetch';
import { memoryJarStore, openCookieJar } from '../../src/net/cookie-jar';
import { NetworkError } from '../../src/net/errors';
import type { FetchFunction } from '../../src/net/fetch-function';
import { readJson } from '../../src/net/read-body';
import { SIGN_IN_PATH } from '../../src/net/sign-in';
import { openDrafts } from '../../src/sync/chat-drafts';
import {
    COMMENT_IDS,
    commentOnIssue,
    deleteComment,
    editComment,
    issueCommentKinds,
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
import { type OutboxKind, openOutbox } from '../../src/sync/outbox';
import { userDb } from '../sync/outbox-fakes';

// The issue comments' contract test: against a real local Socio server, a
// comment on an issue filed offline goes after its create; one whose answer
// is lost after the server saved it is found by the check, never saved twice;
// then an edit and a delete. It needs `pnpm run build` and `node
// apps/mobile/e2e/servers.mjs`, and runs only when SOCIO_CONTRACT_CREDENTIALS
// names the credentials file servers.mjs wrote; CI skips it.

const CREDENTIALS = process.env.SOCIO_CONTRACT_CREDENTIALS;

interface Credentials {
    password: string;
    accounts: { email: string }[];
    servers: { origin: string }[];
}

const nodeFetch: FetchFunction = (url, init) => fetch(url, init as RequestInit);

let ids = 0;
const newId = () => `ik-${Date.now().toString(36)}-${++ids}`;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup();
    }
});

async function json<T>(request: AuthedFetch, path: string, init?: Parameters<AuthedFetch>[1]): Promise<T> {
    const response = await request(path, init);
    if (!response.ok) {
        throw new Error(`${init?.method ?? 'GET'} ${path}: ${response.status}`);
    }
    return (await readJson(response)) as T;
}

const until = async (check: () => Promise<boolean> | boolean, ms = 45_000) => {
    const end = Date.now() + ms;
    while (!(await check())) {
        if (Date.now() > end) {
            throw new Error('Timed out.');
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
};

async function setup() {
    const credentials = JSON.parse(readFileSync(CREDENTIALS!, 'utf8')) as Credentials;
    const origin = credentials.servers[0]!.origin;
    const jar = await openCookieJar({ origin, store: memoryJarStore() });
    const request = createAuthedFetch({
        origin,
        jar,
        fetch: nodeFetch,
        userAgent: 'Socio/0.1.0 (contract test)',
        signal: new AbortController().signal,
    });
    await json(request, SIGN_IN_PATH, {
        method: 'POST',
        // The member: comments as the people the app is for.
        json: { email: credentials.accounts[1]!.email, password: credentials.password },
    });
    const me = (await json<{ user: { id: string } }>(request, '/api/auth/session')).user.id;
    let offline = false;
    /** The next comment is saved by the server and its answer lost. */
    let dropNext = false;
    const phoneFetch: AuthedFetch = async (input, init) => {
        if (offline) {
            throw new NetworkError(input);
        }
        const response = await request(input, init);
        if (dropNext && init?.method === 'POST' && input.endsWith('/comments')) {
            dropNext = false;
            throw new NetworkError(input);
        }
        return response;
    };
    const files = await userDb();
    const file = await files.open();
    const outbox = await openOutbox({
        db: file.db,
        state: file.state,
        kinds: [issueCreateKind() as OutboxKind<unknown>, ...issueCommentKinds()],
        fetch: phoneFetch,
    });
    const drafts = await openDrafts({ db: file.db, state: file.state, outbox });
    outbox.start();
    cleanups.push(async () => {
        await drafts.close();
        await outbox.dispose();
        await file.db.close();
        rmSync(files.directory, { recursive: true, force: true });
    });
    const detail = (number: string) => json<IssueDetail>(request, `/api/issues/${number}`);
    /** No Date seen (`serverAt: null`): what the screen shows (`seen`) bounds the check. */
    const comment = async (issue: string, text: string, seen?: readonly string[] | null) => {
        drafts.write(issueCommentsDraft(issue), text);
        return (await commentOnIssue({ outbox, drafts, newId, issue, authorId: me, serverAt: null, seen }))!;
    };
    const file1 = async (title: string) => {
        drafts.write(ISSUE_DRAFT, issueDraftText({ title, body: 'Filed by the IK contract test.' }));
        return (await fileIssue({ drafts, newId, reporterId: me, after: null, serverAt: null }))!;
    };
    return {
        outbox,
        detail,
        comment,
        file: file1,
        offline: (on: boolean) => void (offline = on),
        dropNext: () => void (dropNext = true),
    };
}

describe.skipIf(!CREDENTIALS)('issue comments against a local server', () => {
    it(
        'comments on an issue filed offline, finds a lost answer, then edits and deletes',
        { timeout: 90_000 },
        async () => {
            const session = await setup();
            session.offline(true);
            const { localKey } = await session.file(`IK ${newId()}`);
            const first = await session.comment(localKey, '  First, from offline. ');
            await new Promise((resolve) => setTimeout(resolve, 1_500));
            session.offline(false);
            session.outbox.poke();
            await until(() => session.outbox.rows().length === 0);
            const number = session.outbox.resolve(ISSUE_IDS, localKey)!;
            expect(number).toMatch(/^\d+$/);

            session.dropNext();
            const second = await session.comment(number, '+1', seenComments(await session.detail(number)));
            await until(() => session.outbox.rows().length === 0);
            let held = await session.detail(number);
            expect(held.comments.map((item) => item.body)).toEqual(['First, from offline.', '+1']);
            const [firstId, secondId] = held.comments.map((item) => item.id);
            expect(session.outbox.resolve(COMMENT_IDS, first.commentId)).toBe(firstId);
            expect(session.outbox.resolve(COMMENT_IDS, second.commentId)).toBe(secondId);

            // Edited and deleted by the local ids they were written under.
            const outbox = session.outbox;
            await editComment(outbox, { issue: number, commentId: first.commentId, text: 'First, edited', newId });
            await deleteComment(outbox, { issue: number, commentId: second.commentId, newId });
            await until(() => session.outbox.rows().length === 0);
            held = await session.detail(number);
            expect(held.comments.map((item) => item.body)).toEqual(['First, edited']);
            expect(session.outbox.unsent()).toEqual([]);
        },
    );
});
