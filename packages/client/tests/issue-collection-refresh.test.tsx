// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { issueSummary, type Issue, type IssueDetail } from '@socio/shared/issues/issue-types';

import { closeChangeChannel } from '../src/lib/change-channel';
import { useIssues } from '../src/modules/issues/use-issues';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined, host: HTMLElement | undefined;
afterEach(async () => {
    await act(async () => root?.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
    closeChangeChannel();
    vi.unstubAllGlobals();
});
const issue = (number: number, change: Partial<Issue> = {}): Issue => ({
    id: 'i' + number,
    number,
    title: 'Issue ' + number,
    body: 'Initial body',
    status: 'open',
    priority: 'medium',
    kind: 'bug',
    area: null,
    labels: [],
    assigneeId: 'bob',
    reporterId: 'alice',
    resolution: null,
    source: 'web',
    createdAt: 1,
    updatedAt: 1,
    closedAt: null,
    ...change,
});
const detail = (row: Issue, users: Record<string, string> = {}): IssueDetail => ({
    issue: row,
    users,
    comments: [],
    events: [],
    attachments: [],
    blockedBy: [],
    blocks: [],
    components: {},
});
const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
async function fixture(initial: Issue[]) {
    let rows = initial,
        users: Record<string, string> = { bob: 'Bob' },
        unchanged = false;
    let completePatch!: (response: Response) => void;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/api/issues') {
            return unchanged
                ? new Response(null, { status: 304 })
                : json({ issues: rows.map((row) => issueSummary(row)), users });
        }
        if (init?.method === 'PATCH') {
            return new Promise<Response>((resolve) => {
                completePatch = resolve;
            });
        }
        throw Error('Unexpected fixture request ' + input);
    });
    vi.stubGlobal('fetch', fetch);
    let data!: ReturnType<typeof useIssues>;
    function Harness() {
        const current = useIssues();
        useEffect(() => {
            data = current;
        });
        return null;
    }
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<Harness />));
    return {
        get data() {
            return data;
        },
        set rows(next: Issue[]) {
            rows = next;
        },
        set users(next: Record<string, string>) {
            users = next;
        },
        set unchanged(next: boolean) {
            unchanged = next;
        },
        fetch,
        finish: (response: Response) => completePatch(response),
        reload: async () => {
            await act(async () => {
                await data.reload();
            });
        },
    };
}

it('shares actual200 snapshots but reflects same-timestamp row fields, order/additions/deletions and authoritative user removals', async () => {
    const first = issue(1),
        second = issue(2);
    const f = await fixture([first, second]);
    const before = f.data.issues!,
        names = f.data.users,
        version = f.data.version;
    await f.reload();
    expect(f.data.issues).toBe(before);
    expect(f.data.users).toBe(names);
    expect(f.data.version).toBe(version + 1);
    f.rows = [
        first,
        {
            ...second,
            title: 'New title',
            body: 'Changed description',
            priority: 'high',
            area: 'client',
            labels: ['ux'],
            openBlockers: [1],
            demand: 2,
            votes: 3,
            voted: true,
        },
    ];
    await f.reload();
    const changed = f.data.issues!;
    expect(changed[0]).toBe(before[0]);
    expect(changed[1]).not.toBe(before[1]);
    expect(changed[1]).toMatchObject({
        title: 'New title',
        excerpt: 'Changed description',
        priority: 'high',
        area: 'client',
        labels: ['ux'],
        openBlockers: [1],
        demand: 2,
        votes: 3,
        voted: true,
        updatedAt: 1,
    });
    // A reorder preserves individual identities, whereas new/removed rows reflect the complete list.
    f.rows = [
        {
            ...second,
            title: 'New title',
            body: 'Changed description',
            priority: 'high',
            area: 'client',
            labels: ['ux'],
            openBlockers: [1],
            demand: 2,
            votes: 3,
            voted: true,
        },
        first,
    ];
    await f.reload();
    expect(f.data.issues).toEqual([changed[1], changed[0]]);
    expect(f.data.issues![0]).toBe(changed[1]);
    f.rows = [issue(3), first];
    f.users = { bob: 'Robert', carol: 'Carol' };
    await f.reload();
    expect(f.data.issues!.map((r) => r.number)).toEqual([3, 1]);
    expect(f.data.issues![1]).toBe(changed[0]);
    expect(f.data.users).toEqual({ bob: 'Robert', carol: 'Carol' });
    f.users = { carol: 'Carol' };
    await f.reload();
    expect(f.data.users).toEqual({ carol: 'Carol' });
    expect('bob' in f.data.users).toBe(false);
});

it('keeps a pending move through fresh votes/text and detail responses, then rolls back to the latest server row', async () => {
    const initial = issue(1, { status: 'triage' });
    const f = await fixture([initial, issue(2)]);
    let failure: unknown;
    let finished!: Promise<unknown>;
    await act(async () => {
        finished = f.data.update(1, { status: 'done' }).catch((error) => {
            failure = error;
        });
    });
    expect(f.data.issues![0].status).toBe('done');
    const untouched = f.data.issues![1];
    const fresh = {
        ...initial,
        title: 'Updated elsewhere',
        body: 'Fresh body',
        votes: 1,
        voted: true,
        updatedAt: 2,
    };
    f.rows = [fresh, issue(2)];
    await f.reload();
    expect(f.data.issues![0]).toMatchObject({
        status: 'done',
        title: 'Updated elsewhere',
        votes: 1,
        voted: true,
    });
    expect(f.data.issues![1]).toBe(untouched);
    await act(async () => f.data.replace(detail(fresh, { carol: 'Carol' })));
    expect(f.data.issues![0].status).toBe('done');
    expect(f.data.users).toEqual({ bob: 'Bob', carol: 'Carol' });
    await act(async () => {
        f.finish(json({ error: 'Move refused' }, 403));
        await finished;
    });
    expect((failure as Error).message).toBe('Move refused');
    expect(f.data.issues![0]).toMatchObject({
        status: 'triage',
        title: 'Updated elsewhere',
        excerpt: 'Fresh body',
        votes: 1,
        voted: true,
        updatedAt: 2,
    });
    f.unchanged = true;
    let snapshot;
    await act(async () => {
        snapshot = await f.data.reread();
    });
    expect(snapshot).toMatchObject([{ number: 1, status: 'triage', votes: 1 }, { number: 2 }]);
});

it('does not resurrect a row deleted during a pending move, and304rereads keep acknowledged replacements/removals', async () => {
    const f = await fixture([issue(1), issue(2)]);
    let finished!: Promise<unknown>;
    await act(async () => {
        finished = f.data.update(1, { status: 'done' }).catch(() => {});
    });
    f.rows = [issue(2)];
    await f.reload();
    expect(f.data.issues!.map((r) => r.number)).toEqual([2]);
    await act(async () => {
        f.finish(json({ error: 'Gone' }, 404));
        await finished;
    });
    expect(f.data.issues!.map((r) => r.number)).toEqual([2]);
    const replacement = issue(2, {
        title: 'Acknowledged detail',
        status: 'done',
        votes: 4,
        voted: true,
    });
    await act(async () => f.data.replace(detail(replacement)));
    f.unchanged = true;
    let snapshot;
    await act(async () => {
        snapshot = await f.data.reread();
    });
    expect(snapshot).toMatchObject([{ number: 2, title: 'Acknowledged detail', status: 'done', votes: 4 }]);
    await act(async () => f.data.remove(2));
    await act(async () => {
        snapshot = await f.data.reread();
    });
    expect(snapshot).toEqual([]);
    expect(f.data.issues).toEqual([]);
});
