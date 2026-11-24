import { afterEach, expect, it, vi } from 'vitest';

import { compareBoardOrder } from '@socio/shared/issues/issue-board';
import type { IssueList, IssuePriority } from '@socio/shared/issues/issue-types';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// The contract behind shared's compareBoardOrder: a client that
// keeps the board's rows by key (the app's snapshot cache) sorts them back
// into the order GET /api/issues answers in, which is the server's SQL
// `boardOrder`. Priority, updatedAt and number ties all come up here.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

it('answers /api/issues in compareBoardOrder’s order', async () => {
    const built = await makeTestRuntime({
        config: { baseUrl: '', apiKey: '', model: '', runtimeUrl: '' },
        app: {
            auth: {
                provider: new MockAuthProvider(DEFAULT_MOCK_USERS, 'secret-0123456789abcdef-xyz'),
                secureCookies: false,
            },
        },
    });
    cleanup.push(built.dispose);
    for (const user of DEFAULT_MOCK_USERS) {
        built.workspace.recordUser(user);
    }
    const login = await built.app.request('/api/auth/mock/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'alice' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const alice = (path: string, method = 'GET', body?: unknown) =>
        built.app.request(`/api${path}`, {
            method,
            headers: { cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

    // The clock moves only when told, so several issues share an updatedAt.
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const priorities: IssuePriority[] = ['low', 'medium', 'medium', 'critical', 'high', 'high', 'medium', 'low'];
    for (const [index, priority] of priorities.entries()) {
        expect((await alice('/issues', 'POST', { title: `Issue ${index + 1}`, priority })).status).toBe(201);
        if (index % 3 === 2) {
            now += 1000;
        }
    }
    // Later changes move some issues up within their priority, or to another one.
    now += 1000;
    expect((await alice('/issues/1', 'PATCH', { priority: 'medium' })).status).toBe(200);
    expect((await alice('/issues/4', 'PATCH', { title: 'Issue 4, renamed' })).status).toBe(200);
    now += 1000;
    expect((await alice('/issues/7', 'PATCH', { status: 'in_progress' })).status).toBe(200);

    const { issues } = (await (await alice('/issues')).json()) as IssueList;
    expect(issues).toHaveLength(priorities.length);
    const sorted = [...issues].reverse().sort(compareBoardOrder);
    expect(sorted.map((issue) => issue.number)).toEqual(issues.map((issue) => issue.number));
    // The case is meaningful: some rows tie on priority and updatedAt, so the number decides.
    const ties = issues.filter((issue, index) => {
        const before = issues[index - 1];
        return before && before.priority === issue.priority && before.updatedAt === issue.updatedAt;
    });
    expect(ties.length).toBeGreaterThan(0);
});
