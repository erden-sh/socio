// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { IssueList } from '@socio/shared/issues/issue-types';

import { ApiError, apiIfChanged, FULL_POLL_MS, PollTags, UNCHANGED } from '../src/lib/api';
import { ISSUES_POLL_MS, useIssues } from '../src/modules/issues/use-issues';

// Live updates step 1 in the browser: polls send the tag of the copy
// they hold, keep it on a 304 without rendering, and ask without it
// after the tab comes back into view and every five minutes.

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | undefined;
let host: HTMLElement;
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
});
afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

const showTab = () => {
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
};

it('keeps a tag per path until it is forgotten, the tab is shown again, or five minutes pass', () => {
    const tags = new PollTags();
    tags.set('/a', '"v.b"', 1000);
    expect(tags.get('/a', 1000)).toBe('"v.b"');
    expect(tags.get('/b', 1000)).toBeUndefined();
    expect(tags.get('/a', 1000 + FULL_POLL_MS - 1)).toBe('"v.b"');
    expect(tags.get('/a', 1000 + FULL_POLL_MS)).toBeUndefined();
    tags.set('/a', '"v.c"', 2000);
    showTab();
    expect(tags.get('/a', 2000)).toBeUndefined();
    tags.set('/a', '"v.d"', 3000);
    expect(tags.get('/a', 3000)).toBe('"v.d"');
    tags.set('/a', null, 3000);
    expect(tags.get('/a', 3000)).toBeUndefined();
    tags.set('/a', '"v.e"', 3000);
    tags.forget();
    expect(tags.get('/a', 3000)).toBeUndefined();
});

it('sends the tag and answers UNCHANGED on a 304, the data and its tag on a 200', async () => {
    const sent: Array<string | null> = [];
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
        const tag = new Headers(init?.headers).get('If-None-Match');
        sent.push(tag);
        if (tag === '"v.1"') {
            return new Response(null, { status: 304 });
        }
        if (tag === '"bad"') {
            return Response.json({ error: 'Sign in to continue.' }, { status: 401 });
        }
        return Response.json({ n: 1 }, { headers: { ETag: 'W/"v.1"' } });
    });
    expect(await apiIfChanged('/x', undefined)).toEqual({
        data: { n: 1 },
        tag: 'W/"v.1"',
    });
    expect(await apiIfChanged('/x', '"v.1"')).toBe(UNCHANGED);
    await expect(apiIfChanged('/x', '"bad"')).rejects.toEqual(new ApiError('Sign in to continue.', 401));
    expect(sent).toEqual([null, '"v.1"', '"bad"']);
});

it("sends a caller's extra headers with the tag (the shell's presence, CB-114)", async () => {
    const sent: Headers[] = [];
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
        sent.push(new Headers(init?.headers));
        return Response.json({ n: 1 });
    });
    await apiIfChanged('/state', '"v.1"', undefined, {
        'X-CB-Presence': 'tab12345 -',
    });
    await apiIfChanged('/state', undefined, undefined, {
        'X-CB-Presence': 'tab12345 /chats/c1',
    });
    expect(sent.map((headers) => [headers.get('X-CB-Presence'), headers.get('If-None-Match')])).toEqual([
        ['tab12345 -', '"v.1"'],
        ['tab12345 /chats/c1', null],
    ]);
});

it('keeps the board as it is on a 304, without rendering it again', async () => {
    vi.useFakeTimers();
    const list: IssueList = {
        issues: [
            {
                number: 1,
                title: 'One',
                excerpt: '',
                status: 'open',
                priority: 'medium',
                kind: 'bug',
                area: null,
                labels: [],
                assigneeId: 'bob',
                updatedAt: 1,
                components: [],
            },
        ],
        users: { bob: 'Bob' },
        components: {},
    };
    let version = 1;
    const sent: Array<string | null> = [];
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
        const tag = new Headers(init?.headers).get('If-None-Match');
        sent.push(tag);
        if (tag === `"v.${version}"`) {
            return new Response(null, { status: 304 });
        }
        return Response.json(
            {
                ...list,
                issues: list.issues.map((i) => ({ ...i, updatedAt: version })),
            },
            { headers: { ETag: `"v.${version}"` } },
        );
    });
    // The board's content: rendered again only when the hook's data is new.
    let renders = 0;
    function List({ issues }: { issues: IssueList['issues'] | undefined }) {
        renders++;
        return <p>{issues ? issues[0]!.updatedAt : 'loading'}</p>;
    }
    function Board() {
        const { issues } = useIssues();
        return <List issues={issues} />;
    }
    root = createRoot(host);
    await act(async () => root!.render(<Board />));
    await act(async () => {});
    expect(host.textContent).toBe('1');
    const settled = renders;
    // Nothing changed: a 304, and no render.
    await act(async () => vi.advanceTimersByTimeAsync(ISSUES_POLL_MS));
    expect(sent).toEqual([null, '"v.1"']);
    expect(renders).toBe(settled);
    // A change: a 200 with the new list.
    version = 2;
    await act(async () => vi.advanceTimersByTimeAsync(ISSUES_POLL_MS));
    expect(sent.at(-1)).toBe('"v.1"');
    expect(host.textContent).toBe('2');
    await act(async () => vi.advanceTimersByTimeAsync(ISSUES_POLL_MS));
    expect(sent.at(-1)).toBe('"v.2"');
    // Back in view: the next poll asks without its tag.
    showTab();
    await act(async () => vi.advanceTimersByTimeAsync(ISSUES_POLL_MS));
    expect(sent.at(-1)).toBeNull();
});
