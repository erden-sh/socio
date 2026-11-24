import { readFileSync, rmSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import type { IssueList } from '@socio/shared/issues/issue-types';

import { createAuthedFetch, type AuthedFetch } from '../../src/net/authed-fetch';
import { memoryJarStore, openCookieJar } from '../../src/net/cookie-jar';
import { NetworkError } from '../../src/net/errors';
import type { FetchFunction } from '../../src/net/fetch-function';
import { readJson } from '../../src/net/read-body';
import { SIGN_IN_PATH } from '../../src/net/sign-in';
import { openDrafts } from '../../src/sync/chat-drafts';
import { fileIssue, highestIssue, ISSUE_DRAFT, issueCreateKind, issueDraftText } from '../../src/sync/issue-create';
import { ISSUE_IDS } from '../../src/sync/local-ids';
import { type OutboxKind, openOutbox } from '../../src/sync/outbox';
import { userDb } from '../sync/outbox-fakes';

// Filing an issue's contract test: file an issue offline, go online, and
// the local server lists exactly one; then one whose answer is lost after the
// server filed it, which the check finds. Against a real local Socio server:
// it needs `pnpm run build` and `node apps/mobile/e2e/servers.mjs`, and runs
// only when SOCIO_CONTRACT_CREDENTIALS names the credentials file servers.mjs
// wrote; CI skips it.

const CREDENTIALS = process.env.SOCIO_CONTRACT_CREDENTIALS;

interface Credentials {
    password: string;
    accounts: { email: string }[];
    servers: { origin: string }[];
}

const nodeFetch: FetchFunction = (url, init) => fetch(url, init as RequestInit);

let ids = 0;
const newId = () => `ic-${Date.now().toString(36)}-${++ids}`;

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
        // The member: a filing as the people the app is for.
        json: { email: credentials.accounts[1]!.email, password: credentials.password },
    });
    const me = (await json<{ user: { id: string } }>(request, '/api/auth/session')).user.id;
    let offline = false;
    /** The next create is filed by the server and its answer lost. */
    let dropNext = false;
    const phoneFetch: AuthedFetch = async (input, init) => {
        if (offline) {
            throw new NetworkError(input);
        }
        const response = await request(input, init);
        if (dropNext && init?.method === 'POST') {
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
        kinds: [issueCreateKind() as OutboxKind<unknown>],
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
    const list = () => json<IssueList>(request, '/api/issues');
    const file1 = async (title: string) => {
        drafts.write(ISSUE_DRAFT, issueDraftText({ title, body: 'Filed by the IC contract test.' }));
        const held = await list();
        return (await fileIssue({
            drafts,
            newId,
            reporterId: me,
            after: highestIssue(held.issues),
            serverAt: null,
        }))!;
    };
    return {
        outbox,
        list,
        file: file1,
        offline: (on: boolean) => void (offline = on),
        dropNext: () => void (dropNext = true),
    };
}

describe.skipIf(!CREDENTIALS)('filing an issue against a local server', () => {
    it('files offline, goes online, and the server lists exactly one', { timeout: 60_000 }, async () => {
        const session = await setup();
        const title = `IC offline ${newId()}`;
        session.offline(true);
        const { localKey } = await session.file(`  ${title} `);
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        session.offline(false);
        session.outbox.poke();
        await until(() => session.outbox.rows().length === 0);
        const found = (await session.list()).issues.filter((issue) => issue.title === title);
        expect(found).toHaveLength(1);
        expect(session.outbox.resolve(ISSUE_IDS, localKey)).toBe(String(found[0]!.number));
        expect(session.outbox.unsent()).toEqual([]);
    });

    it(
        'finds the issue the server filed when the answer was lost, and files it no second time',
        { timeout: 60_000 },
        async () => {
            const session = await setup();
            const title = `IC lost answer ${newId()}`;
            session.dropNext();
            const { localKey } = await session.file(title);
            await until(() => session.outbox.rows().length === 0);
            const found = (await session.list()).issues.filter((issue) => issue.title === title);
            expect(found).toHaveLength(1);
            expect(session.outbox.resolve(ISSUE_IDS, localKey)).toBe(String(found[0]!.number));
        },
    );
});
