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
import { fileIssue, ISSUE_DRAFT, issueCreateKind, issueDraftText } from '../../src/sync/issue-create';
import { editIssue, issueEditKinds, voteOnIssue } from '../../src/sync/issue-edit';
import { ISSUE_IDS } from '../../src/sync/local-ids';
import { type OutboxKind, openOutbox } from '../../src/sync/outbox';
import { userDb } from '../sync/outbox-fakes';

// Editing issues' contract test: against a real local Socio server, the
// member files an issue offline, edits its title and description and votes,
// vote, unvote and vote folding to one request; an edit whose answer is lost
// goes again and lands once. It needs `pnpm run build` and `node
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
const newId = () => `ie-${Date.now().toString(36)}-${++ids}`;

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

describe.skipIf(!CREDENTIALS)('issue edits and votes against a local server', () => {
    it('edits and votes on an issue filed offline, each landing once', { timeout: 90_000 }, async () => {
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
            // The member: edits the title and description of their own issue in triage.
            json: { email: credentials.accounts[1]!.email, password: credentials.password },
        });
        const me = (await json<{ user: { id: string } }>(request, '/api/auth/session')).user.id;
        const writes: string[] = [];
        /** The next field edit is saved by the server and its answer lost. */
        let dropNext = false;
        const phoneFetch: AuthedFetch = async (input, init) => {
            const response = await request(input, init);
            if (init?.method && init.method !== 'GET') {
                writes.push(`${init.method} ${input.replace(/\d+/, 'N')}`);
            }
            if (dropNext && init?.method === 'PATCH') {
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
            kinds: [issueCreateKind() as OutboxKind<unknown>, ...issueEditKinds()],
            fetch: phoneFetch,
        });
        const drafts = await openDrafts({ db: file.db, state: file.state, outbox });
        cleanups.push(async () => {
            await drafts.close();
            await outbox.dispose();
            await file.db.close();
            rmSync(files.directory, { recursive: true, force: true });
        });
        const detail = (number: string) => json<IssueDetail>(request, `/api/issues/${number}`);

        // Offline: filed, edited and voted on before anything goes.
        const title = `IE ${newId()}`;
        drafts.write(ISSUE_DRAFT, issueDraftText({ title, body: 'Filed by the IE contract test.' }));
        const { localKey } = (await fileIssue({ drafts, newId, reporterId: me, after: null, serverAt: null }))!;
        const filed = { title, body: 'Filed by the IE contract test.' };
        await editIssue(outbox, { issue: localKey, changes: { title: `${title} (edited) ` }, base: filed, newId });
        await editIssue(outbox, { issue: localKey, changes: { body: 'Edited offline.' }, base: filed, newId });
        const base = { voted: false, votes: 0 };
        await voteOnIssue(outbox, { issue: localKey, vote: true, base, newId });
        await voteOnIssue(outbox, { issue: localKey, vote: false, base, newId });
        await voteOnIssue(outbox, { issue: localKey, vote: true, base, newId });
        outbox.start();
        await until(() => outbox.rows().length === 0);
        const number = outbox.resolve(ISSUE_IDS, localKey)!;
        let held = await detail(number);
        expect([held.issue.title, held.issue.body]).toEqual([`${title} (edited)`, 'Edited offline.']);
        expect([held.issue.voted, held.issue.votes]).toEqual([true, 1]);
        // The create first; then the edit and vote lanes, in either order.
        expect(writes[0]).toBe('POST /api/issues');
        expect([...writes.slice(1)].sort()).toEqual(['PATCH /api/issues/N', 'POST /api/issues/N/vote']);

        // A lost answer: the edit goes again, finds its change there and sends nothing more.
        dropNext = true;
        await editIssue(outbox, { issue: number, changes: { body: 'Edited again.' }, base: held.issue, newId });
        await until(() => outbox.rows().length === 0);
        held = await detail(number);
        expect(held.issue.body).toBe('Edited again.');
        expect(held.events.filter((event) => event.kind === 'body')).toHaveLength(2);
        expect(outbox.unsent()).toEqual([]);
    });
});
