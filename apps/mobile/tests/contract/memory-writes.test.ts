import { readFileSync, rmSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import type { MemoriesState } from '@socio/shared/memory';

import { createAuthedFetch, type AuthedFetch } from '../../src/net/authed-fetch';
import { memoryJarStore, openCookieJar } from '../../src/net/cookie-jar';
import type { FetchFunction } from '../../src/net/fetch-function';
import { readJson } from '../../src/net/read-body';
import { SIGN_IN_PATH } from '../../src/net/sign-in';
import { addMemory, MEMORY_IDS, memoryWriteKinds, newestMemory, saveProfile } from '../../src/sync/memory-writes';
import { openOutbox } from '../../src/sync/outbox';
import { userDb } from '../sync/outbox-fakes';

// The memory writes' contract test: add a memory and save one profile field
// through the outbox against a real local Socio server, as the chat
// management one (chat-manage.test.ts): it needs `pnpm run build` and `node
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
const newId = () => `mw1-${Date.now().toString(36)}-${++ids}`;

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
        json: { email: credentials.accounts[0]!.email, password: credentials.password },
    });
    const files = await userDb();
    const file = await files.open();
    const outbox = await openOutbox({ db: file.db, state: file.state, kinds: memoryWriteKinds(), fetch: request });
    outbox.start();
    cleanups.push(async () => {
        await outbox.dispose();
        await file.db.close();
        rmSync(files.directory, { recursive: true, force: true });
    });
    return { request, outbox };
}

const until = async (check: () => boolean, ms = 30_000) => {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) {
            throw new Error('Timed out.');
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
};

describe.skipIf(!CREDENTIALS)('memories and profile writes against a local server', () => {
    it('adds a memory exactly once and saves one profile field, keeping the rest', { timeout: 60_000 }, async () => {
        const { request, outbox } = await setup();
        const before = await json<MemoriesState>(request, '/api/memories');
        const text = `MW1 contract ${newId()}`;
        const localId = await addMemory(outbox, {
            text: `  ${text}  `,
            newId,
            after: newestMemory(before.memories),
            serverAt: null,
        });
        await saveProfile(outbox, { fields: { pronouns: 'they/them' }, base: before.profile, newId });
        await until(() => outbox.rows().length === 0);
        expect(outbox.unsent()).toHaveLength(0);
        const after = await json<MemoriesState>(request, '/api/memories');
        const added = after.memories.filter((item) => item.text === text);
        expect(added).toHaveLength(1);
        expect(outbox.resolve(MEMORY_IDS, localId)).toBe(added[0]!.id);
        expect(after.profile?.fields).toEqual({ ...before.profile?.fields, pronouns: 'they/them' });
    });
});
