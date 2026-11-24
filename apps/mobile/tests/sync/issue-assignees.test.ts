import { afterEach, describe, expect, it } from 'vitest';

import type { IssueAssignees } from '@socio/shared/issues/issue-types';

import type { AuthedFetch } from '../../src/net/authed-fetch';
import { NetworkError } from '../../src/net/errors';
import { assigneePicker, NEEDS_CONNECTION } from '../../src/shell/issue-detail';
import { ASSIGNEES_KEY, createIssueAssignees, type IssueAssigneeList } from '../../src/sync/issue-assignees';

import { syncSetup } from './helpers';

// The assignee list, a bounded kind of `GET /api/issues/assignees`
// against a real cache.db: read only when the picker uses it; kept on disk, so
// offline the picker shows the last list with its age and "Needs a
// connection"; a refusal keeps it, never drops it.

type Setup = Awaited<ReturnType<typeof syncSetup>>;
const open: Array<{ s: Setup; list: IssueAssigneeList }> = [];
afterEach(async () => {
    for (const { s, list } of open.splice(0)) {
        await list.close().catch(() => {});
        await s.close().catch(() => {});
    }
});

const PEOPLE: IssueAssignees = {
    users: [
        { id: 'u-ada', name: 'Ada' },
        { id: 'u-ben', name: 'Ben' },
    ],
    deactivated: [{ id: 'u-cy', name: 'Cy' }],
};

async function setup(directory?: string) {
    const s = await syncSetup(directory === undefined ? {} : { directory });
    const server = { mode: 'ok' as 'ok' | 'offline' | 'refuse', requests: [] as string[], body: PEOPLE };
    const fetch: AuthedFetch = async (path) => {
        server.requests.push(path);
        if (server.mode === 'offline') {
            throw new NetworkError(path);
        }
        return server.mode === 'refuse'
            ? new Response(JSON.stringify({ error: 'Admins only.' }), { status: 403 })
            : new Response(JSON.stringify(server.body), {
                  status: 200,
                  headers: { 'content-type': 'application/json' },
              });
    };
    const list = createIssueAssignees({ db: s.db, fetch, now: s.clock.device });
    open.push({ s, list });
    return { s, list, server };
}

const settle = async (list: IssueAssigneeList) => {
    const item = list.item(ASSIGNEES_KEY);
    await item.loaded;
    await item.refresh();
    return item;
};

describe('the assignee list', () => {
    it('reads nothing until the picker uses it, then keeps the list on disk', async () => {
        const { s, list, server } = await setup();
        expect(server.requests).toEqual([]);
        const item = list.item(ASSIGNEES_KEY);
        const release = item.use();
        await item.refresh();
        expect(server.requests[0]).toBe('/api/issues/assignees');
        expect(item.state.value).toEqual(PEOPLE);
        release();
        await list.flush();
        expect(await list.stored(ASSIGNEES_KEY)).toBe(true);
        expect(s.server.requests.some((request) => request.path === '/api/issues/assignees')).toBe(false);
    });

    it('offline, shows the last list with its age and "Needs a connection"', async () => {
        const first = await setup();
        await settle(first.list);
        await first.list.flush();
        const fetchedAt = first.list.item(ASSIGNEES_KEY).state.fetchedAt;
        await first.list.close();
        await first.s.close({ remove: false });
        open.splice(0);

        const again = await setup(first.s.directory);
        again.server.mode = 'offline';
        const item = await settle(again.list);
        expect(item.state).toMatchObject({ value: PEOPLE, failed: true, fetchedAt });
        const view = assigneePicker({ list: item.state, current: 'u-ben', users: {}, timeZone: 'UTC' });
        expect(view.choices.map((choice) => [choice.label, choice.selected])).toEqual([
            ['Unassigned', false],
            ['Ada', false],
            ['Ben', true],
        ]);
        expect(view.line).toBe(NEEDS_CONNECTION);
        expect(view.age).toMatch(/^Saved /);
    });

    it('with no list kept, offline offers Unassigned and the current assignee only', async () => {
        const { list, server } = await setup();
        server.mode = 'offline';
        const item = await settle(list);
        const view = assigneePicker({ list: item.state, current: 'u-ada', users: { 'u-ada': 'Ada' } });
        expect(view.choices.map((choice) => choice.label)).toEqual(['Unassigned', 'Ada']);
        expect(view.line).toBe(NEEDS_CONNECTION);
        expect(view.age).toBeNull();
    });

    it('a refusal keeps the last list', async () => {
        const { list, server } = await setup();
        await settle(list);
        server.mode = 'refuse';
        const item = await settle(list);
        expect(item.state).toMatchObject({ value: PEOPLE, failed: true, gone: false });
    });

    it('marks a deactivated current assignee, and offers no other', () => {
        const view = assigneePicker({
            list: { value: PEOPLE, fetchedAt: 1, settled: true, failed: false },
            current: 'u-cy',
            users: { 'u-cy': 'Cy' },
        });
        expect(view.choices.map((choice) => choice.label)).toEqual(['Unassigned', 'Ada', 'Ben', 'Cy (Deactivated)']);
        expect(view.line).toBeNull();
        expect(
            assigneePicker({
                list: { value: null, fetchedAt: null, settled: false, failed: false },
                current: null,
                users: {},
            }).line,
        ).toBe('Loading people…');
    });
});
