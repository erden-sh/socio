// @vitest-environment jsdom
import { act, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
    areaLabel,
    BOARD_STATUSES,
    canDeleteComment,
    dotRequestsOnly,
    filterIssues,
    NO_FILTERS,
    toggleDotRequests,
    type IssueFilters,
} from '@socio/shared/issues/issue-board';
import {
    ISSUE_AREAS,
    ISSUE_ATTACHMENT_MAX_BYTES,
    ISSUE_ATTACHMENTS_PER_ISSUE,
    issueSummary,
    type Issue,
    type IssueComment,
    type IssueDetail,
    type IssueStatus,
} from '@socio/shared/issues/issue-types';
import type { AgentRunSummary, State, User, WorkspaceState } from '@socio/shared/types';

import { CHANGES_CHANNEL, closeChangeChannel } from '../src/lib/change-channel';
import { ChatTranscript } from '../src/modules/chat/ChatTranscript';
import { acceptFiles } from '../src/modules/issues/attachments';
import { DotRequestNotices, noticeText } from '../src/modules/issues/DotRequestNotices';
import { FileIssueFromRun, runIssueDraft } from '../src/modules/issues/FileIssueFromRun';
import { excerpt, issueCloseTarget, OPENED_FROM_CHAT, readView, writeView } from '../src/modules/issues/issue-meta';
import { IssueBoard } from '../src/modules/issues/IssueBoard';
import { IssueHistory } from '../src/modules/issues/IssueComments';
import { ISSUE_DELETED, IssueDetailDialog } from '../src/modules/issues/IssueDetail';
import { IssueList } from '../src/modules/issues/IssueList';
import { IssuesPage } from '../src/modules/issues/IssuesPage';
import { IssueToolbar } from '../src/modules/issues/IssueToolbar';
import { issuesModule } from '../src/modules/issues/module';
import { closeReport, openReport } from '../src/modules/issues/report';
import { areaOf, ReportIssue } from '../src/modules/issues/ReportIssue';
import { useIssues } from '../src/modules/issues/use-issues';
import { setAppNavigator } from '../src/modules/pages/page-navigation';
import { ShellContext, type Shell } from '../src/shell/shell-context';

import { FakeBroadcastChannel } from './helpers/fake-broadcast-channel';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const alice: User = { id: 'alice', name: 'Alice', role: 'admin' };
const bob: User = { id: 'bob', name: 'Bob', role: 'member' };

let next = 1;
function issue(fields: Partial<Issue> = {}): Issue {
    const number = fields.number ?? next++;
    return {
        id: `i${number}`,
        number,
        title: `Issue ${number}`,
        body: '',
        status: 'open',
        priority: 'medium',
        kind: 'bug',
        area: null,
        labels: [],
        reporterId: 'bob',
        assigneeId: null,
        resolution: null,
        source: 'web',
        createdAt: 1,
        updatedAt: 1,
        closedAt: null,
        ...fields,
    };
}

/** The issue as the board's list has it (CB-71). */
const row = (fields: Partial<Issue> = {}) => issueSummary(issue(fields));

// --- Pure helpers ------------------------------------------------------------

it('shortens markdown to one plain line', () => {
    expect(excerpt('## Problem\n\nThe `cron` and [the docs](/x) **fail**.\n- one')).toBe(
        'Problem The cron and the docs fail. one',
    );
    expect(excerpt('word '.repeat(100), 20)).toHaveLength(20);
});

it('remembers the board or list choice per browser', () => {
    localStorage.clear();
    expect(readView()).toBe('board');
    writeView('list');
    expect(readView()).toBe('list');
    writeView('board');
    expect(readView()).toBe('board');
});

it('names every area, Web chat, Homepage and Schedules among them (CB-76, CB-88)', () => {
    expect(ISSUE_AREAS.map(areaLabel)).toEqual([
        'Server',
        'Client',
        'Web chat',
        'Homepage',
        'Schedules',
        'Telegram',
        'Model',
        'Runs',
        'Spaces',
        'Learning',
        'Computers',
        'Auth',
        'Deploy',
        'Docs',
        'Tests',
    ]);
    // Reporting from a chat page defaults to Web chat; pages with no area to none.
    expect(areaOf('chat')).toBe('chat');
    expect(areaOf('memories')).toBeUndefined();
    // Home has no module of its own: its reports are about the Homepage.
    expect(areaOf(undefined, '/')).toBe('homepage');
    expect(areaOf('chat', '/chats/c1')).toBe('chat');
    // The schedules pages, and Scheduled & activity's tasks, are Schedules (CB-88).
    expect(areaOf('schedules', '/schedules/s1')).toBe('schedules');
    expect(areaOf('activity', '/activity')).toBe('schedules');
    expect(areaLabel('schedules')).toBe('Schedules');
});

it('checks files against the server’s types, size and count caps', () => {
    const file = (name: string, size: number, type = '') => new File([new Uint8Array(size)], name, { type });
    const { accepted, refused } = acceptFiles(
        [
            file('shot.png', 10, 'image/png'),
            file('notes.md', 10),
            file('page.html', 10, 'text/html'),
            file('huge.pdf', ISSUE_ATTACHMENT_MAX_BYTES + 1),
            file('empty.txt', 0),
            // A pasted screenshot has no useful name.
            file('', 10, 'image/png'),
        ],
        0,
    );
    expect(accepted.map((f) => f.name.split('.').pop())).toEqual(['png', 'md', 'png']);
    expect(accepted[2]!.name).toMatch(/^pasted-.+\.png$/);
    expect(refused).toHaveLength(3);
    expect(refused.join('\n')).toMatch(/page\.html: only images/);
    expect(refused.join('\n')).toMatch(/huge\.pdf is larger than 5 MB/);
    const full = acceptFiles([file('a.png', 1), file('b.png', 1)], ISSUE_ATTACHMENTS_PER_ISSUE - 1);
    expect(full.accepted).toHaveLength(1);
    expect(full.refused[0]).toMatch(/at most 10 attachments/);
});

it('fills a report from a failed run, linking the run and its conversation', () => {
    const draft = runIssueDraft({
        runId: 'run-1',
        threadId: 'c 1',
        status: 'failed',
        source: 'web',
        startedAt: 0,
        finishedAt: 1,
        error: 'The model provider timed out.',
        errorDetail: 'ETIMEDOUT 10.0.0.1:8016',
        title: 'Garden plan',
        dotName: 'Socio',
        ownerId: 'alice',
        ownerName: 'Alice',
        readable: true,
    });
    expect(draft.title).toBe('Run failed: The model provider timed out.');
    expect(draft.area).toBe('runs');
    expect(draft.body).toContain('[Garden plan](/chats/c%201)');
    expect(draft.body).toContain('`run-1`');
    expect(draft.body).toContain('ETIMEDOUT');
    // The filed item is linked to the run (CB-194).
    expect(draft.runId).toBe('run-1');
});

it('adds "File an issue" to the palette', () => {
    const commands = issuesModule.commands!({} as never);
    expect(commands.map((command) => [command.label, command.group])).toEqual([['File an issue', 'Actions']]);
    expect(issuesModule.slots?.['run.actions']).toHaveLength(1);
});

// --- Rendered ----------------------------------------------------------------

let root: Root;
let host: HTMLElement;
let routes: Record<string, (init?: RequestInit, url?: URL) => [number, unknown] | Promise<[number, unknown]>>;
let calls: { method: string; path: string; query: string; body?: unknown }[];

const state = {
    settings: { name: 'Brain', paused: false },
    tasks: [],
    memories: [],
    mode: 'live',
    configured: true,
} as unknown as State;
function shellFor(user: User): Shell {
    const workspace = {
        user,
        spaces: [],
        dots: [],
        conversations: [],
        setup: { missing: [] },
        calls: [],
    } as unknown as WorkspaceState;
    return {
        state,
        workspace,
        admin: user.role === 'admin',
        configured: true,
        homeDot: { id: 'd1', name: 'Socio' },
    } as unknown as Shell;
}

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    window.matchMedia = (query: string) =>
        ({
            matches: false,
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
        }) as unknown as MediaQueryList;
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;
    routes = {};
    calls = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://app.test');
        const path = url.pathname;
        const method = init?.method ?? 'GET';
        calls.push({
            method,
            path,
            query: url.search,
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        const handler = routes[`${method} ${path}`];
        const [status, body] = handler ? await handler(init, url) : [404, { error: 'Not found.' }];
        return new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
        });
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    closeReport();
    host.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

async function until(check: () => boolean, what: string) {
    for (let i = 0; i < 200; i++) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${document.body.textContent}`);
}
function render(node: ReactNode, user: User = alice) {
    act(() =>
        root.render(
            <ShellContext.Provider value={shellFor(user)}>
                <MemoryRouter>{node}</MemoryRouter>
            </ShellContext.Provider>,
        ),
    );
}
const byLabel = (label: string) => document.body.querySelector<HTMLElement>(`[aria-label="${label}"]`);
const buttons = (text: string) =>
    [...document.body.querySelectorAll('button')].filter((button) => button.textContent?.trim() === text);
const selection = {
    active: false,
    selected: new Set<number>(),
    toggle: () => {},
};

/** A drag event with the fields React and the board read. */
function drag(type: string, target: Element, payload: Record<string, string>) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
        value: {
            types: Object.keys(payload),
            getData: (key: string) => payload[key] ?? '',
            setData: (key: string, value: string) => (payload[key] = value),
            dropEffect: 'none',
            effectAllowed: 'all',
        },
    });
    act(() => {
        target.dispatchEvent(event);
    });
}

it('lets admins drag cards between columns; members get a read-only board', () => {
    const issues = [
        row({ number: 7, status: 'triage', title: 'Filed by Bob' }),
        row({ number: 8, status: 'open', assigneeId: 'alice' }),
    ];
    const onMove = vi.fn();
    const board = (canMove: boolean) => (
        <IssueBoard
            issues={issues}
            users={{ alice: 'Alice' }}
            statuses={BOARD_STATUSES}
            canMove={canMove}
            onMove={onMove}
            selection={selection}
        />
    );
    render(board(true));
    const columns = [...host.querySelectorAll('[data-slot="issue-column"]')];
    expect(columns.map((column) => column.getAttribute('data-status'))).toEqual(BOARD_STATUSES);
    const counts = columns.map((column) => column.querySelector('[data-slot="issue-column-count"]')?.textContent);
    expect(counts).toEqual(['1', '1', '0', '0', '0', '0', '0']);
    const card = host.querySelector('[data-issue="CB-7"]')!;
    expect(card.getAttribute('draggable')).toBe('true');
    expect(card.textContent).toContain('Medium');
    expect(card.textContent).toContain('Bug');
    // Version B (CB-308): the priority as a colored pill on the key's line,
    // `Kind · Area` under the title, no description snippet.
    expect(card.querySelector('[data-slot="priority-pill"]')?.getAttribute('data-priority')).toBe('medium');
    expect(card.querySelector('[data-slot="issue-card-excerpt"]')).toBeNull();
    expect(byLabel('Move CB-7')).not.toBeNull();
    expect(byLabel('Assigned to Alice')).toBeNull(); // only on CB-8's card
    expect(host.querySelector('[data-issue="CB-8"]')?.textContent).toContain('Assigned to Alice');
    // Drag CB-7 from triage to open.
    const payload: Record<string, string> = {};
    drag('dragstart', card, payload);
    expect(payload['application/x-socio-issue']).toBe('7');
    const open = columns[1]!;
    drag('dragenter', open, payload);
    drag('dragover', open, payload);
    drag('drop', open, payload);
    expect(onMove).toHaveBeenCalledWith(issues[0], 'open');
    // Dropping in its own column changes nothing.
    drag('drop', columns[0]!, payload);
    expect(onMove).toHaveBeenCalledTimes(1);

    render(board(false), bob);
    const memberCard = host.querySelector('[data-issue="CB-7"]')!;
    expect(memberCard.getAttribute('draggable')).toBe('false');
    expect(byLabel('Move CB-7')).toBeNull();
    drag('drop', host.querySelectorAll('[data-slot="issue-column"]')[1]!, {
        'application/x-socio-issue': '7',
    });
    expect(onMove).toHaveBeenCalledTimes(1);
    // The card still opens the issue.
    expect(memberCard.querySelector('a[data-slot="issue-link"]')?.getAttribute('href')).toBe('/issues/CB-7');
});

it('groups the list by status, closed sections collapsed, empty ones left out', async () => {
    render(
        <IssueList
            issues={[
                row({ number: 1, status: 'open', body: 'First **bold** words' }),
                row({ number: 2, status: 'done' }),
                row({ number: 3, status: 'wont_fix' }),
            ]}
            users={{}}
            canMove={false}
            onMove={() => {}}
            selection={selection}
        />,
    );
    const groups = [...host.querySelectorAll('[data-slot="issue-group"]')];
    expect(groups.map((group) => group.getAttribute('data-status'))).toEqual(['open', 'done', 'wont_fix']);
    const shown = () =>
        [...host.querySelectorAll('[data-slot="issue-row"]')].map((row) => row.getAttribute('data-issue'));
    expect(shown()).toEqual(['CB-1']);
    expect(host.textContent).toContain('First bold words');
    // Expanding Done shows its issue.
    act(() => groups[1]!.querySelector<HTMLButtonElement>('button')!.click());
    await until(() => shown().includes('CB-2'), 'done expanded');
    expect(shown()).toEqual(['CB-1', 'CB-2']);
});

it('rolls an optimistic change back when the server refuses it', async () => {
    const seen: IssueStatus[][] = [];
    let api: ReturnType<typeof useIssues> | undefined;
    function Harness() {
        const data = useIssues();
        useEffect(() => {
            api = data;
            if (data.issues) {
                seen.push(data.issues.map((i) => i.status));
            }
        });
        return null;
    }
    routes['GET /api/issues'] = () => [200, { issues: [row({ number: 5, status: 'triage' })], users: {} }];
    let refuse!: () => void;
    routes['PATCH /api/issues/5'] = () =>
        new Promise<[number, unknown]>((resolve) => {
            refuse = () => resolve([403, { error: 'Only an admin.' }]);
        });
    render(<Harness />);
    await until(() => seen.length > 0, 'the list');
    let failure: unknown;
    let finished: Promise<unknown>;
    await act(async () => {
        finished = api!.update(5, { status: 'open' }).catch((e: unknown) => {
            failure = e;
        });
    });
    expect(seen.at(-1)).toEqual(['open']); // observable while the HTTP reply is pending
    await act(async () => {
        refuse();
        await finished;
    });
    expect((failure as Error).message).toBe('Only an admin.');
    expect(seen.flat()).toContain('open'); // shown at once …
    expect(seen.at(-1)).toEqual(['triage']); // … and undone
    expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({
        status: 'open',
    });
});

function detailOf(fields: Partial<Issue>, comments: Partial<IssueComment>[] = []): IssueDetail {
    return {
        issue: issue({ number: 9, ...fields }),
        comments: comments.map((comment, index) => ({
            id: `c${index}`,
            issueId: 'i9',
            authorKind: 'user',
            authorId: 'bob',
            body: `Comment ${index}`,
            createdAt: 2,
            editedAt: null,
            ...comment,
        })),
        attachments: [],
        events: [
            {
                id: 'e1',
                issueId: 'i9',
                actorId: 'bob',
                kind: 'created',
                fromValue: null,
                toValue: null,
                createdAt: 1,
            },
        ],
        blockedBy: [],
        blocks: [],
        users: { alice: 'Alice', bob: 'Bob', carol: 'Carol' },
        components: {},
    };
}
async function openDetail(detail: IssueDetail, user: User) {
    routes['GET /api/issues/9'] = () => [200, detail];
    routes['GET /api/issues/assignees'] = () => [200, { users: [{ id: 'alice', name: 'Alice' }] }];
    render(
        <IssueDetailDialog
            number={9}
            user={user}
            update={async () => detail}
            onChanged={() => {}}
            onDeleted={() => {}}
            onClose={() => {}}
        />,
        user,
    );
    await until(() => !!document.body.querySelector('[data-slot="issue-comment-form"]'), 'the detail');
}
const comboboxes = () =>
    [...document.body.querySelectorAll('[role="combobox"]')].map(
        (box) => document.getElementById(box.getAttribute('aria-labelledby') ?? '')?.textContent,
    );

it('shows members their own triage issue editable and others read-only', async () => {
    await openDetail(
        detailOf({ reporterId: 'bob', status: 'triage' }, [{ authorId: 'bob' }, { authorId: 'carol' }]),
        bob,
    );
    expect(byLabel('Edit title')).not.toBeNull();
    expect(buttons('Edit description')).toHaveLength(1);
    // No triage fields, no delete: the fields are read-only.
    expect(comboboxes()).toEqual([]);
    expect(document.body.querySelector('[data-slot="issue-fields"]')).not.toBeNull();
    expect(buttons('Delete issue')).toHaveLength(0);
    // Their own comment: edit and delete; Carol's: neither.
    const comments = [...document.body.querySelectorAll('[data-slot="issue-comment"]')];
    const actions = (index: number) => [...comments[index]!.querySelectorAll('button')].map((b) => b.textContent);
    expect(actions(0)).toEqual(['Edit', 'Delete']);
    expect(actions(1)).toEqual([]);
    // Everyone can comment.
    expect(byLabel('Add a comment')).not.toBeNull();
});

it('gives members no editing on issues past triage or filed by others', async () => {
    await openDetail(detailOf({ reporterId: 'bob', status: 'open' }), bob);
    expect(byLabel('Edit title')).toBeNull();
    expect(buttons('Edit description')).toHaveLength(0);
    act(() => root.unmount());
    root = createRoot(host);
    await openDetail(detailOf({ reporterId: 'carol', status: 'triage' }), bob);
    expect(byLabel('Edit title')).toBeNull();
});

it('gives admins every field, deleting the issue and any comment', async () => {
    await openDetail(
        detailOf({ reporterId: 'bob', status: 'open' }, [{ authorId: 'bob' }, { authorId: 'alice' }]),
        alice,
    );
    expect(byLabel('Edit title')).not.toBeNull();
    expect(comboboxes()).toEqual(['Status', 'Priority', 'Kind', 'Area', 'Assignee']);
    expect(byLabel('Labels')).toBeNull(); // labeled by its field label
    expect(document.body.textContent).toContain('Resolution');
    expect(buttons('Delete issue')).toHaveLength(1);
    const comments = [...document.body.querySelectorAll('[data-slot="issue-comment"]')];
    const actions = (index: number) => [...comments[index]!.querySelectorAll('button')].map((b) => b.textContent);
    // Bob's comment: an admin may delete it, not edit it.
    expect(actions(0)).toEqual(['Delete']);
    expect(actions(1)).toEqual(['Edit', 'Delete']);
});

it('marks a deactivated assignee in the admin’s picker, which no longer offers them', async () => {
    const detail = detailOf({ reporterId: 'bob', status: 'open' });
    detail.issue.assigneeId = 'carol';
    routes['GET /api/issues/9'] = () => [200, detail];
    routes['GET /api/issues/assignees'] = () => [
        200,
        {
            users: [{ id: 'alice', name: 'Alice' }],
            deactivated: [{ id: 'carol', name: 'Carol' }],
        },
    ];
    render(
        <IssueDetailDialog
            number={9}
            user={alice}
            update={async () => detail}
            onChanged={() => {}}
            onDeleted={() => {}}
            onClose={() => {}}
        />,
        alice,
    );
    const assignee = () => [...document.body.querySelectorAll('[role="combobox"]')].at(-1)?.textContent;
    await until(() => assignee() === 'Carol (Deactivated)', 'the deactivated assignee');
});

const reportForm = () => document.body.querySelector<HTMLFormElement>('[data-slot="report-issue-form"]');
const discardPrompt = () => document.body.querySelector('[role="alertdialog"]');

function setReportValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const proto = Object.getPrototypeOf(element) as object;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
}

it('files a report with kind, priority, area and an attachment', async () => {
    routes['POST /api/issues'] = () => [201, detailOf({ number: 9 })];
    routes['POST /api/issues/9/attachments'] = () => [201, { id: 'a1' }];
    render(<ReportIssue moduleId="learning" />, bob);
    act(() => byLabel('Report issue')!.click());
    await until(() => !!reportForm(), 'the form');
    const form = reportForm()!;
    expect(comboboxes()).toEqual(['Kind', 'Priority', 'Area']);
    // The area defaults to the page's module.
    const area = form.querySelectorAll('[role="combobox"]')[2]!;
    expect(area.textContent).toContain('Learning');
    const title = form.querySelector('input:not([type="file"])') as HTMLInputElement;
    act(() => setReportValue(title, 'Skills page is blank'));
    act(() => setReportValue(form.querySelector('textarea')!, 'Open Skills.'));
    // Pick a file and a refused one.
    const input = form.querySelector<HTMLInputElement>('input[type="file"]')!;
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot.png', {
        type: 'image/png',
    });
    const html = new File(['<html>'], 'page.html', { type: 'text/html' });
    Object.defineProperty(input, 'files', {
        value: [png, html],
        configurable: true,
    });
    act(() => {
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await until(() => !!document.body.querySelector('[aria-label="Remove shot.png"]'), 'the pending file');
    expect(document.body.querySelector('[aria-label="Remove page.html"]')).toBeNull();
    act(() => form.requestSubmit());
    await until(() => calls.some((call) => call.path === '/api/issues/9/attachments'), 'the upload');
    expect(calls.find((call) => call.path === '/api/issues')?.body).toEqual({
        title: 'Skills page is blank',
        body: 'Open Skills.',
        kind: 'bug',
        priority: 'medium',
        area: 'learning',
    });
    const upload = calls.find((call) => call.path === '/api/issues/9/attachments');
    expect(upload?.body).toEqual({
        name: 'shot.png',
        mediaType: 'image/png',
        data: btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47)),
    });
    await until(() => !reportForm(), 'the dialog to close');
    expect(discardPrompt()).toBeNull();
    act(() => byLabel('Report issue')!.click());
    expect(reportForm()!.querySelector('input:not([type="file"])')?.getAttribute('value')).toBe('');
    expect(reportForm()!.querySelector('textarea')?.value).toBe('');
});

it.each([
    ['Escape', () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))],
    ['the close button', () => document.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!.click()],
    [
        'clicking outside',
        () => {
            const backdrop = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]')!;
            backdrop.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
            backdrop.click();
        },
    ],
    ['Cancel', () => buttons('Cancel')[0]!.click()],
] as const)('protects the issue draft when dismissed with %s', async (_name, dismiss) => {
    render(<ReportIssue moduleId="issues" />);
    act(() => openReport());
    const form = reportForm()!;
    const title = form.querySelector<HTMLInputElement>('input:not([type="file"])')!;
    const body = form.querySelector('textarea')!;
    await act(async () => {
        setReportValue(title, 'Keyboard draft');
        setReportValue(body, 'Steps that are still being written.');
        body.focus();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    act(() => void dismiss());
    expect(discardPrompt()?.textContent ?? '').toContain('Discard issue draft?');
    expect(document.activeElement).toBe(buttons('Keep editing')[0]);
    act(() => buttons('Keep editing')[0]!.click());
    await until(() => document.activeElement === body, 'focus to return to the draft');
    expect(title.value).toBe('Keyboard draft');
    expect(body.value).toBe('Steps that are still being written.');

    act(() => void dismiss());
    act(() => buttons('Discard draft')[0]!.click());
    expect(reportForm()).toBeNull();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    act(() => openReport());
    expect(reportForm()!.querySelector<HTMLInputElement>('input:not([type="file"])')!.value).toBe('');
    expect(reportForm()!.querySelector('textarea')!.value).toBe('');
});

it('closes an untouched report without confirmation', () => {
    render(<ReportIssue moduleId="issues" />);
    act(() => openReport());
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(reportForm()).toBeNull();
    expect(discardPrompt()).toBeNull();
});

it('opens the report from anywhere, filled in, but hides its button on Issues', async () => {
    render(<ReportIssue moduleId="issues" />);
    expect(byLabel('Report issue')).toBeNull();
    const run = {
        runId: 'r1',
        threadId: 'c1',
        status: 'failed',
        source: 'web',
        startedAt: 0,
        finishedAt: 1,
        error: 'Boom.',
        errorDetail: null,
        title: 'Plan',
        dotName: null,
        ownerId: null,
        ownerName: null,
        readable: false,
    } satisfies AgentRunSummary;
    act(() => openReport(runIssueDraft(run)));
    await until(() => !!document.body.querySelector('[data-slot="report-issue-form"]'), 'the form');
    const title = document.body.querySelector<HTMLInputElement>(
        '[data-slot="report-issue-form"] input:not([type="file"])',
    )!;
    expect(title.value).toBe('Run failed: Boom.');
    expect(document.body.querySelector('[data-slot="report-issue-form"]')!.textContent).toContain(
        'It will be linked to the failed run.',
    );
    expect(document.body.querySelectorAll('[role="combobox"]')[2]!.textContent).toContain('Runs');
    // The run's button shows only on failed runs.
    act(() => root.unmount());
    root = createRoot(host);
    render(
        <>
            <FileIssueFromRun run={run} />
            <FileIssueFromRun run={{ ...run, runId: 'r2', status: 'finished' }} />
        </>,
    );
    expect(buttons('File issue')).toHaveLength(1);
});

// --- Dot requests -----------------------------------------------------------

const requestIssue = (fields: Partial<Issue> = {}) =>
    row({
        kind: 'request',
        labels: ['dot-request'],
        status: 'triage',
        title: 'Socio request: send email',
        reporterId: 'dot:d1',
        demand: 3,
        ...fields,
    });

it('toggles the socio requests lane as a label filter', () => {
    const issues = [requestIssue({ number: 1 }), row({ number: 2 })];
    const on = toggleDotRequests(NO_FILTERS);
    expect(dotRequestsOnly(on)).toBe(true);
    expect(filterIssues(issues, on).map((i) => i.number)).toEqual([1]);
    expect(dotRequestsOnly(toggleDotRequests(on))).toBe(false);
    expect(dotRequestsOnly({ ...on, label: ['dot-request', 'ux'] })).toBe(false);

    let filters: IssueFilters = NO_FILTERS;
    function Harness() {
        return (
            <IssueToolbar
                filters={filters}
                setFilters={(update) => {
                    filters = update(filters);
                }}
                shown={1}
                total={2}
                dotRequests={1}
            />
        );
    }
    render(<Harness />);
    const toggle = host.querySelector<HTMLButtonElement>('[data-slot="issue-dot-requests"]')!;
    expect(toggle.textContent).toBe('Socio requests1');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    act(() => toggle.click());
    expect(filters.label).toEqual(['dot-request']);
});

it('shows a socio request’s demand on its card and row, and none on other issues', () => {
    const issues = [requestIssue({ number: 4 }), row({ number: 5 })];
    render(
        <IssueBoard
            issues={issues}
            users={{}}
            statuses={BOARD_STATUSES}
            canMove={false}
            onMove={() => {}}
            selection={selection}
        />,
    );
    const demand = (key: string) => host.querySelector(`[data-issue="${key}"] [data-slot="issue-demand"]`)?.textContent;
    expect(demand('CB-4')).toBe('3 asks');
    expect(demand('CB-5')).toBeUndefined();
    expect(host.querySelector('[data-issue="CB-4"]')?.textContent).toContain('Socio request');
    render(
        <IssueList
            issues={[requestIssue({ number: 6, demand: 1, status: 'open' })]}
            users={{}}
            canMove={false}
            onMove={() => {}}
            selection={selection}
        />,
    );
    expect(host.querySelector('[data-issue="CB-6"] [data-slot="issue-demand"]')?.textContent).toBe('1 ask');
});

it('lists who asked in the detail, for members and admins alike', async () => {
    const detail = (): IssueDetail => ({
        ...detailOf({
            kind: 'request',
            labels: ['dot-request'],
            reporterId: 'dot:d1',
            demand: 2,
        }),
        requesters: [
            { dotId: 'd1', userId: 'bob', createdAt: 1 },
            { dotId: 'd2', userId: 'alice', createdAt: 2 },
        ],
        users: {
            alice: 'Alice',
            bob: 'Bob',
            'dot:d1': 'Scout',
            'dot:d2': 'Ledger',
        },
    });
    for (const user of [bob, alice]) {
        await openDetail(detail(), user);
        const section = document.body.querySelector('[data-slot="issue-requesters"]')!;
        expect(section.textContent).toContain('Requested by (2)');
        expect([...section.querySelectorAll('li')].map((li) => li.textContent?.split(' · ')[0])).toEqual([
            'Scout for Bob',
            'Ledger for Alice',
        ]);
        expect(document.body.querySelector('[data-slot="issue-demand"]')?.textContent).toBe('2 asks');
        expect(document.body.textContent).toContain('Filed by Scout');
        act(() => root.unmount());
        root = createRoot(host);
    }
    // Other issues have no such section.
    await openDetail(detailOf({}), alice);
    expect(document.body.querySelector('[data-slot="issue-requesters"]')).toBeNull();
});

it('shows the user’s socio request notices once, then marks them seen', async () => {
    const success = vi.spyOn(toast, 'success').mockReturnValue(1);
    const info = vi.spyOn(toast, 'info').mockReturnValue(2);
    const notices = [
        {
            id: 'n1',
            number: 4,
            capability: 'send email',
            status: 'done' as const,
            resolution: 'Shipped.',
            dots: ['Scout'],
            createdAt: 1,
        },
        {
            id: 'n2',
            number: 5,
            capability: 'read pdf',
            status: 'wont_fix' as const,
            resolution: null,
            dots: [],
            createdAt: 1,
        },
    ];
    routes['GET /api/dot-requests/notices'] = () => [200, { notices }];
    routes['POST /api/dot-requests/notices/seen'] = () => [200, { seen: 2 }];
    render(<DotRequestNotices />, bob);
    await until(() => calls.some((call) => call.path === '/api/dot-requests/notices/seen'), 'the notices marked seen');
    expect(success).toHaveBeenCalledWith(
        'Socio request done: send email',
        expect.objectContaining({
            description: 'CB-4 (asked by Scout) · Shipped.',
        }),
    );
    expect(info).toHaveBeenCalledWith(
        'Socio request won’t be built: read pdf',
        expect.objectContaining({ description: 'CB-5' }),
    );
    expect(calls.find((call) => call.path === '/api/dot-requests/notices/seen')?.body).toEqual({ ids: ['n1', 'n2'] });
    expect(noticeText(notices[0]!).title).toBe('Socio request done: send email');
});

it('an open issue deleted in another tab says so, never asked for (no 404)', async () => {
    // The earlier tests' renders opened Node's own channel: start afresh.
    closeChangeChannel();
    FakeBroadcastChannel.reset();
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    const other = new FakeBroadcastChannel(CHANGES_CHANNEL);
    const detail = detailOf({ status: 'open' });
    let listed = [issueSummary(detail.issue)];
    routes['GET /api/issues'] = () => [200, { issues: listed, users: {} }];
    routes['GET /api/issues/9'] = () => (listed.length ? [200, detail] : [404, { error: 'Issue not found.' }]);
    routes['GET /api/issues/assignees'] = () => [200, { users: [] }];
    function Page() {
        const data = useIssues();
        return (
            <IssueDetailDialog
                number={9}
                initial={detail}
                user={alice}
                update={async () => detail}
                onChanged={data.replace}
                onDeleted={data.remove}
                onClose={() => {}}
                reread={data.reread}
            />
        );
    }
    const errors = vi.spyOn(console, 'error');
    try {
        render(<Page />);
        await until(() => !!document.body.querySelector('[data-slot="issue-comment-form"]'), 'the detail');
        await until(() => calls.some((call) => call.path === '/api/issues'), 'the list');
        await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
        // Changed elsewhere and kept: one read of the list, then the issue.
        calls = [];
        other.postMessage([{ topic: 'issue', id: '9' }]);
        await until(() => calls.some((call) => call.path === '/api/issues/9'), 'the issue again');
        expect(calls.map((call) => call.path)).toEqual(['/api/issues', '/api/issues/9']);
        // Deleted elsewhere: the list no longer has it, so it isn't asked for.
        listed = [];
        calls = [];
        other.postMessage([{ topic: 'issue', id: '9' }]);
        await until(
            () => document.body.querySelector('[data-slot="issue-missing"]')?.textContent === ISSUE_DELETED,
            'the deleted state',
        );
        await act(() => new Promise((resolve) => setTimeout(resolve, 150)));
        expect(calls.map((call) => call.path)).toEqual(['/api/issues']);
        expect(buttons('Back to issues')).toHaveLength(1);
        expect(errors).not.toHaveBeenCalled();
    } finally {
        closeChangeChannel();
    }
});

// --- Votes and Dot comments (CB-83, CB-84) -------------------------------------

it('shows votes on cards and rows and toggles the person’s own vote', async () => {
    const voted = row({ number: 4, votes: 2, voted: true });
    routes['POST /api/issues/5/vote'] = () => [200, detailOf({ number: 5, votes: 1, voted: true })];
    routes['DELETE /api/issues/4/vote'] = () => [403, { error: 'Nope.' }];
    render(
        <IssueBoard
            issues={[voted, row({ number: 5 })]}
            users={{}}
            statuses={BOARD_STATUSES}
            canMove={false}
            onMove={() => {}}
            selection={selection}
        />,
    );
    const vote = (key: string) =>
        host.querySelector<HTMLButtonElement>(`[data-issue="${key}"] [data-slot="issue-vote"]`)!;
    expect(vote('CB-4').textContent).toBe('2');
    expect(vote('CB-4').getAttribute('aria-pressed')).toBe('true');
    expect(vote('CB-5').textContent).toBe('0');
    expect(vote('CB-5').getAttribute('aria-label')).toBe('Vote for CB-5 (0 votes)');
    act(() => vote('CB-5').click());
    expect(vote('CB-5').textContent).toBe('1');
    expect(vote('CB-5').getAttribute('aria-pressed')).toBe('true');
    await until(() => calls.some((c) => c.method === 'POST' && c.path === '/api/issues/5/vote'), 'the vote');
    // Refused: shown as it was, with the error.
    const error = vi.spyOn(toast, 'error').mockImplementation(() => 0);
    act(() => vote('CB-4').click());
    await until(() => error.mock.calls.length > 0, 'the error');
    expect(error).toHaveBeenCalledWith('Nope.');
    expect(vote('CB-4').textContent).toBe('2');
    expect(vote('CB-4').getAttribute('aria-pressed')).toBe('true');
    render(
        <IssueList
            issues={[row({ number: 6, votes: 7, status: 'open' })]}
            users={{}}
            canMove={false}
            onMove={() => {}}
            selection={selection}
        />,
    );
    expect(vote('CB-6').textContent).toBe('7');
});

it('shows a socio’s comment as the socio for the person, deletable by that person, and votes in the detail', async () => {
    const dotComment: Partial<IssueComment> = {
        authorKind: 'agent',
        authorId: 'dot:d1',
        body: 'Evidence from Bob.',
        dot: {
            dotId: 'd1',
            dotOwnerId: null,
            userId: 'bob',
            trigger: 'chat',
            causeId: null,
            createdAt: 2,
        },
    };
    const detail = {
        ...detailOf({ votes: 4 }, [dotComment]),
        users: { bob: 'Bob', 'dot:d1': 'Scout' },
    };
    expect(canDeleteComment(detail.comments[0]!, bob)).toBe(true);
    expect(canDeleteComment(detail.comments[0]!, { ...bob, id: 'carol' })).toBe(false);
    await openDetail(detail, bob);
    const comment = document.body.querySelector('[data-slot="issue-comment"]')!;
    expect(comment.textContent).toContain('Scout for Bob');
    expect([...comment.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Delete']);
    expect(document.body.querySelector('[data-slot="issue-vote"]')?.textContent).toBe('4');
});

it('shows a connected agent’s filing, comment and history rows as the agent for the person (CB-90)', async () => {
    const agent = {
        grantId: 'g1',
        clientId: 'https://claude.ai/cimd',
        clientName: 'Claude Code',
        label: 'Claude Code on laptop',
        userId: 'bob',
        createdAt: 1,
    };
    const base = detailOf({ reporterId: 'bob' }, [{ body: 'From the terminal.', agent }, { body: 'From the web.' }]);
    const detail: IssueDetail = {
        ...base,
        filedByAgent: agent,
        events: [{ ...base.events[0]!, agent }],
    };
    await openDetail(detail, bob);
    expect(document.body.textContent).toContain('Filed by Claude Code on laptop for Bob');
    const comments = [...document.body.querySelectorAll('[data-slot="issue-comment"]')].map(
        (comment) => comment.textContent,
    );
    expect(comments[0]).toContain('Claude Code on laptop for Bob');
    expect(comments[1]).toContain('Bob');
    expect(comments[1]).not.toContain('Claude Code');
    act(() => root.unmount());
    root = createRoot(host);
    render(
        <IssueHistory
            events={[...detail.events, { ...base.events[0]!, id: 'e2', kind: 'comment_added' }]}
            users={detail.users}
        />,
    );
    const rows = [...document.body.querySelectorAll('[data-slot="issue-event"] .font-medium')].map(
        (row) => row.textContent,
    );
    expect(rows).toEqual(['Claude Code on laptop for Bob', 'Bob']);
});

it('shows new socio history attribution beside the acting person while leaving legacy history alone', () => {
    const event = {
        id: 'event',
        issueId: 'issue',
        actorId: 'dot:researcher',
        kind: 'blocks' as const,
        fromValue: null,
        toValue: 'CB-2',
        createdAt: 1,
    };
    render(
        <IssueHistory
            events={[
                {
                    ...event,
                    dot: {
                        dotId: 'researcher',
                        dotOwnerId: null,
                        userId: 'alice',
                        trigger: 'chat',
                        causeId: null,
                        createdAt: 1,
                    },
                },
                { ...event, id: 'legacy' },
            ]}
            users={{ 'dot:researcher': 'Researcher', alice: 'Alice' }}
        />,
    );
    const names = [...host.querySelectorAll('[data-slot="issue-event"] .font-medium')].map((row) => row.textContent);
    expect(names).toEqual(['Researcher for Alice', 'Researcher']);
});

// --- Lean lists (CB-71) --------------------------------------------------------

it('filters with excerpts at once, then with the server’s search of descriptions', async () => {
    const late = `${'Words before it. '.repeat(20)}The cron job fails.`;
    const list = [
        row({ number: 1, title: 'Login fails on Safari' }),
        row({ number: 2, title: 'Digest is late', body: late }),
        row({ number: 3, title: 'Dark mode', body: 'The sidebar is too bright' }),
    ];
    expect(list[1]!.excerpt).not.toContain('cron');
    expect(list[1]).not.toHaveProperty('body');
    routes['GET /api/issues'] = () => [200, { issues: list, users: {} }];
    // The server's matches: here by title or full description.
    routes['GET /api/issues/search'] = (_, url) => {
        const q = url!.searchParams.get('q')!.toLowerCase();
        return [
            200,
            {
                numbers: [
                    { number: 1, text: 'login fails on safari' },
                    { number: 2, text: `digest is late ${late.toLowerCase()}` },
                    { number: 3, text: 'dark mode the sidebar is too bright' },
                ]
                    .filter((issue) => issue.text.includes(q))
                    .map((issue) => issue.number),
            },
        ];
    };
    const router = createMemoryRouter([{ path: '/issues', element: <IssuesPage /> }], { initialEntries: ['/issues'] });
    act(() =>
        root.render(
            <ShellContext.Provider value={shellFor(bob)}>
                <RouterProvider router={router} />
            </ShellContext.Provider>,
        ),
    );
    const shown = () =>
        [...host.querySelectorAll('[data-slot="issue-card"]')].map((card) => card.getAttribute('data-issue'));
    await until(() => shown().length === 3, 'the board');
    const input = byLabel('Search issues') as HTMLInputElement;
    const search = (value: string) =>
        act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    // An excerpt's word shows at once, before the server answers.
    search('sidebar');
    expect(shown()).toEqual(['CB-3']);
    // Past the excerpt: only the server finds it.
    search('cron');
    expect(shown()).toEqual([]);
    await until(() => shown().join() === 'CB-2', 'the server’s match');
    expect(calls.filter((call) => call.path === '/api/issues/search').at(-1)?.query).toBe('?q=cron');
    // Cleared: every issue, and no more searches.
    const asked = calls.length;
    search('');
    await until(() => shown().length === 3, 'every issue');
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(calls.slice(asked).some((call) => call.path === '/api/issues/search')).toBe(false);
});

it('shows the won’t fix column from the Status menu, not a line of its own (CB-308)', async () => {
    const list = [row({ number: 1, status: 'open' }), row({ number: 2, status: 'wont_fix' })];
    routes['GET /api/issues'] = () => [200, { issues: list, users: {} }];
    const router = createMemoryRouter([{ path: '/issues', element: <IssuesPage /> }], { initialEntries: ['/issues'] });
    act(() =>
        root.render(
            <ShellContext.Provider value={shellFor(bob)}>
                <RouterProvider router={router} />
            </ShellContext.Provider>,
        ),
    );
    const column = () => host.querySelector('[data-slot="issue-column"][data-status="wont_fix"]');
    await until(() => !!host.querySelector('[data-issue="CB-1"]'), 'the board');
    expect(column()).toBeNull();
    expect(host.textContent).not.toContain('Show won’t fix');
    // The count sits at the end of the filter row.
    expect(host.querySelector('[data-slot="issue-toolbar-count"]')?.textContent).toBe('2 issues');
    act(() => {
        byLabel('Filter by status')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    const show = document.body.querySelector<HTMLElement>('[data-slot="issue-show-wont-fix"]');
    expect(show?.textContent).toBe('Show won’t fix1');
    act(() => show!.click());
    await until(() => !!column(), 'the won’t fix column');
    expect(column()!.querySelector('[data-issue="CB-2"]')).not.toBeNull();
});

it('closes an issue back where its link was clicked, a deep link to the board (CB-119)', () => {
    expect(issueCloseTarget({ fromIssues: true })).toBe(-1);
    expect(issueCloseTarget(OPENED_FROM_CHAT)).toBe(-1);
    for (const state of [null, undefined, {}, { fromChat: false }, 'chat']) {
        expect(issueCloseTarget(state)).toBe('/issues');
    }
});

it('returns to the chat when an issue opened from it closes (CB-119)', async () => {
    routes['GET /api/issues'] = () => [200, { issues: [], users: {} }];
    routes['GET /api/issues/cards'] = () => [200, []];
    routes['GET /api/issues/9'] = () => [200, detailOf({ title: 'Media' })];
    routes['GET /api/issues/assignees'] = () => [200, { users: [] }];
    const routerFor = (path: string) =>
        createMemoryRouter(
            [
                {
                    path: '/chats/:id',
                    element: (
                        <ChatTranscript
                            calls={[]}
                            messages={[
                                {
                                    id: 'm',
                                    role: 'assistant',
                                    content: 'Filed it.\n\n[Open CB-9](/issues/CB-9) ↗',
                                },
                            ]}
                        />
                    ),
                },
                {
                    path: '/issues',
                    element: <IssuesPage />,
                    children: [{ path: ':issueKey', element: null }],
                },
            ],
            { initialEntries: [path] },
        );
    const show = (router: ReturnType<typeof routerFor>) =>
        act(() =>
            root.render(
                <ShellContext.Provider value={shellFor(bob)}>
                    <RouterProvider router={router} />
                </ShellContext.Provider>,
            ),
        );
    const issueShown = () => !!document.body.querySelector('[data-slot="issue-comment-form"]');
    const closeIssue = () => act(() => buttons('Close')[0]!.click());

    // From the chat: the link opens the issue; closing goes back to the chat.
    let router = routerFor('/chats/c1');
    const unregister = setAppNavigator((path, state) => void router.navigate(path, { state }));
    try {
        show(router);
        await until(() => !!host.querySelector('[data-chat-body="assistant"] a'), 'the link');
        act(() => host.querySelector<HTMLElement>('[data-chat-body="assistant"] a')!.click());
        await until(issueShown, 'the issue');
        expect(router.state.location.pathname).toBe('/issues/CB-9');
        closeIssue();
        await until(() => router.state.location.pathname === '/chats/c1', 'the chat');
        expect(host.querySelector('[data-chat-body="assistant"]')).not.toBeNull();

        // Opened directly: closing shows the board.
        act(() => root.unmount());
        root = createRoot(host);
        router = routerFor('/issues/CB-9');
        show(router);
        await until(issueShown, 'the issue');
        closeIssue();
        await until(() => router.state.location.pathname === '/issues', 'the board');
    } finally {
        unregister();
    }
});

// --- Blocked-by links (CB-29) -------------------------------------------------

const withLinks = (detail: IssueDetail, links: Pick<IssueDetail, 'blockedBy' | 'blocks' | 'related'>) => ({
    ...detail,
    ...links,
});

it('shows the blockers on a card and the list, only while any is open', () => {
    render(
        <IssueBoard
            issues={[row({ number: 7, status: 'open', openBlockers: [4, 5] }), row({ number: 8, status: 'open' })]}
            users={{}}
            statuses={BOARD_STATUSES}
            canMove={false}
            onMove={() => {}}
            selection={selection}
        />,
    );
    const badge = host.querySelector('[data-issue="CB-7"] [data-slot="issue-blocked"]');
    expect(badge?.textContent).toBe('Blocked by 2');
    expect(badge?.getAttribute('title')).toBe('Waiting for 2 open issues');
    expect(host.querySelector('[data-issue="CB-8"] [data-slot="issue-blocked"]')).toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    render(
        <IssueList
            issues={[row({ number: 3, status: 'open', openBlockers: [4] })]}
            users={{}}
            canMove={false}
            onMove={() => {}}
            selection={selection}
        />,
    );
    expect(host.querySelector('[data-issue="CB-3"] [data-slot="issue-blocked"]')?.getAttribute('title')).toBe(
        'Waiting for 1 open issue',
    );
});

it('lists what an issue waits for, blocks and is related to; admins change any link, members related ones', async () => {
    const links = {
        blockedBy: [
            { number: 4, title: 'Fix the parser', status: 'in_progress' as const },
            { number: 5, title: 'Ship the fix', status: 'done' as const },
        ],
        blocks: [{ number: 12, title: 'Release', status: 'open' as const }],
        related: [{ number: 30, title: 'Similar crash', status: 'open' as const }],
    };
    const detail = withLinks(detailOf({ status: 'open', openBlockers: [4] }), links);
    routes['GET /api/issues/titles'] = () => [
        200,
        [
            { number: 4, title: 'Fix the parser', status: 'in_progress' },
            { number: 20, title: 'Another one', status: 'open' },
        ],
    ];
    await openDetail(detail, alice);
    const rows = () =>
        [...document.body.querySelectorAll('[data-slot="issue-link-row"]')].map((item) => [
            item.closest('ul')?.getAttribute('data-slot'),
            item.getAttribute('data-open'),
            [...item.querySelectorAll('span, a')].map((part) => part.textContent).join('|'),
        ]);
    expect(rows()).toEqual([
        ['issue-blockers', 'true', 'CB-4In progress|CB-4|In progress|Fix the parser'],
        ['issue-blockers', 'false', 'CB-5Done|CB-5|Done|Ship the fix'],
        ['issue-blocks', 'true', 'CB-12Open|CB-12|Open|Release'],
        ['issue-related', 'true', 'CB-30Open|CB-30|Open|Similar crash'],
    ]);
    expect(document.body.querySelector('[data-slot="issue-blocked"]')?.textContent).toBe('Blocked by 1');
    // Each row's type, from this issue's side, and its removal.
    const kind = (key: string) => byLabel(`Link to ${key}`) as HTMLSelectElement | null;
    expect(['CB-4', 'CB-12', 'CB-30'].map((key) => kind(key)?.value)).toEqual(['blocked_by', 'blocks', 'related']);
    expect([...kind('CB-30')!.options].map((option) => option.textContent)).toEqual([
        'Related to',
        'Blocks',
        'Blocked by',
    ]);
    expect(byLabel('Remove link to CB-12')).not.toBeNull();

    // Link by key: related unless another type is chosen; read again.
    routes['PUT /api/issues/9/links/20'] = () => [200, detail];
    const input = byLabel('Issue to link') as HTMLInputElement;
    const type = byLabel('Link type') as HTMLSelectElement;
    expect(type.value).toBe('related');
    expect(buttons('Add')[0]!.disabled).toBe(true);
    const typeIn = (value: string) =>
        act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    typeIn('cb-20');
    act(() => buttons('Add')[0]!.click());
    await until(() => calls.some((call) => call.path === '/api/issues/9/links/20'), 'the add');
    expect(calls.find((call) => call.method === 'PUT')).toMatchObject({
        method: 'PUT',
        path: '/api/issues/9/links/20',
        body: { relation: 'related' },
    });
    await until(() => input.value === '', 'the cleared draft');
    calls.length = 0;
    act(() => {
        type.value = 'blocked_by';
        type.dispatchEvent(new Event('change', { bubbles: true }));
    });
    typeIn('CB-20');
    act(() => buttons('Add')[0]!.click());
    await until(() => calls.some((call) => call.method === 'PUT'), 'the add');
    expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({
        relation: 'blocked_by',
    });

    // Change a link's type in place.
    calls.length = 0;
    routes['PUT /api/issues/9/links/30'] = () => [200, detail];
    act(() => {
        const select = kind('CB-30')!;
        select.value = 'blocks';
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await until(() => calls.some((call) => call.method === 'PUT'), 'the change');
    expect(calls.find((call) => call.method === 'PUT')).toMatchObject({
        path: '/api/issues/9/links/30',
        body: { relation: 'blocks' },
    });

    // A refused change says why, and nothing else moves.
    calls.length = 0;
    const error = vi.spyOn(toast, 'error').mockImplementation(() => 1);
    routes['PUT /api/issues/9/links/12'] = () => [409, { error: 'CB-12 already waits for CB-9.' }];
    act(() => {
        const select = kind('CB-12')!;
        select.value = 'blocked_by';
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await until(() => error.mock.calls.length > 0, 'the refusal');
    expect(error).toHaveBeenCalledWith('CB-12 already waits for CB-9.');

    routes['DELETE /api/issues/9/links/4'] = () => [200, detail];
    act(() => byLabel('Remove link to CB-4')!.click());
    await until(() => calls.some((call) => call.method === 'DELETE'), 'the removal');
    expect(calls.find((call) => call.method === 'DELETE')?.path).toBe('/api/issues/9/links/4');

    // Members relate issues and lift related links; blocking ones they read.
    act(() => root.unmount());
    root = createRoot(host);
    calls.length = 0;
    await openDetail(detail, bob);
    expect(rows()).toHaveLength(4);
    expect(kind('CB-4')).toBeNull();
    expect(kind('CB-30')).toBeNull();
    expect(byLabel('Remove link to CB-4')).toBeNull();
    expect(byLabel('Remove link to CB-12')).toBeNull();
    expect(byLabel('Remove link to CB-30')).not.toBeNull();
    const memberType = byLabel('Link type') as HTMLSelectElement;
    expect([...memberType.options].map((option) => option.value)).toEqual(['related']);
    const memberInput = byLabel('Issue to link') as HTMLInputElement;
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(memberInput, 'CB-20');
        memberInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => buttons('Add')[0]!.click());
    await until(() => calls.some((call) => call.method === 'PUT'), 'the add');
    expect(calls.find((call) => call.method === 'PUT')).toMatchObject({
        path: '/api/issues/9/links/20',
        body: { relation: 'related' },
    });
    routes['DELETE /api/issues/9/links/30'] = () => [200, detail];
    const removeRelated = () => byLabel('Remove link to CB-30') as HTMLButtonElement;
    await until(() => !removeRelated().disabled, 'the add to finish');
    act(() => removeRelated().click());
    await until(() => calls.some((call) => call.method === 'DELETE'), 'the removal');
    expect(calls.find((call) => call.method === 'DELETE')?.path).toBe('/api/issues/9/links/30');
});

it('keeps the link editor usable from the keyboard and on a narrow screen', async () => {
    await openDetail(
        withLinks(detailOf({ status: 'open' }), {
            related: [{ number: 30, title: 'Similar crash', status: 'open' }],
        }),
        alice,
    );
    const form = document.body.querySelector('[data-slot="issue-link-form"]')!;
    // Native controls in reading order: type, issue, add; each labeled.
    expect(
        [...form.querySelectorAll('select, input, button')].map(
            (control) => control.getAttribute('aria-label') ?? control.textContent?.trim(),
        ),
    ).toEqual(['Link type', 'Issue to link', 'Add']);
    // Enter in the field submits it, as the form does.
    expect(form.tagName).toBe('FORM');
    // It wraps instead of overflowing; the field takes what is left.
    expect(form.className).toContain('flex-wrap');
    expect(byLabel('Issue to link')!.className).toContain('min-w-[6rem]');
    // A row's title wraps anywhere; its controls don't push it out.
    const row = document.body.querySelector('[data-slot="issue-link-row"]')!;
    expect(row.querySelector('a')!.className).toContain('[overflow-wrap:anywhere]');
    expect(row.firstElementChild!.className).toContain('min-w-0');
});

it('offers members the link form even when nothing is linked yet', async () => {
    await openDetail(detailOf({ status: 'open' }), bob);
    expect(document.body.querySelector('[data-slot="issue-link-form"]')).not.toBeNull();
    expect(document.body.textContent).toContain('No linked issues.');
    act(() => root.unmount());
    root = createRoot(host);
    await openDetail(detailOf({ status: 'open' }), alice);
    expect(document.body.querySelector('[data-slot="issue-link-form"]')).not.toBeNull();
});

// --- Automatic triage (CB-30) -------------------------------------------------

const proposal = {
    state: 'proposed' as const,
    kind: 'bug' as const,
    area: 'server' as const,
    priority: 'high' as const,
    labels: ['ux' as const],
    components: [],
    reason: 'The import loses data.',
    commentId: 'c1',
    createdAt: 1,
    decidedAt: null,
    decidedBy: null,
};

it('lets an admin apply or ignore the proposal, and shows members only what was proposed', async () => {
    const detail = { ...detailOf({ status: 'triage' }), triage: proposal };
    await openDetail(detail, alice);
    const card = () => document.body.querySelector('[data-slot="issue-triage"]')!;
    expect(card().textContent).toContain('Triage proposal');
    expect(card().textContent).toContain('Bug');
    expect(card().textContent).toContain('Server');
    // The same priority pill as the board's cards.
    expect(card().querySelector('[data-slot="priority-pill"]')?.textContent).toBe('High');
    expect(card().textContent).toContain('ux');
    expect(card().textContent).toContain('The import loses data.');
    const decided = (state: 'applied' | 'ignored') => ({
        ...detail,
        triage: { ...proposal, state, decidedAt: 5, decidedBy: 'alice' },
    });
    // The server answers with the detail, and the open issue is read again.
    routes['POST /api/issues/9/triage/apply'] = () => {
        routes['GET /api/issues/9'] = () => [200, decided('applied')];
        return [200, decided('applied')];
    };
    act(() => buttons('Apply')[0]!.click());
    await until(() => !!card().querySelector('[data-slot="issue-triage-decision"]'), 'the decision');
    expect(card().querySelector('[data-slot="issue-triage-decision"]')?.textContent).toMatch(/^Applied by Alice/);
    expect(buttons('Apply')).toHaveLength(0);
    expect(buttons('Ignore')).toHaveLength(0);
    expect(calls.filter((call) => call.method === 'POST').map((call) => call.path)).toEqual([
        '/api/issues/9/triage/apply',
    ]);

    // Ignore, on a fresh proposal.
    act(() => root.unmount());
    root = createRoot(host);
    routes['POST /api/issues/9/triage/ignore'] = () => {
        routes['GET /api/issues/9'] = () => [200, decided('ignored')];
        return [200, decided('ignored')];
    };
    await openDetail(detail, alice);
    act(() => buttons('Ignore')[0]!.click());
    await until(
        () =>
            (card().querySelector('[data-slot="issue-triage-decision"]')?.textContent ?? '').startsWith(
                'Ignored by Alice',
            ),
        'the ignore',
    );

    // A member sees it, with no way to decide.
    act(() => root.unmount());
    root = createRoot(host);
    await openDetail(detail, bob);
    expect(card().textContent).toContain('The import loses data.');
    expect(card().textContent).toContain('An admin can apply or ignore it');
    expect(buttons('Apply')).toHaveLength(0);
    expect(buttons('Ignore')).toHaveLength(0);
    // No proposal, no card.
    act(() => root.unmount());
    root = createRoot(host);
    await openDetail(detailOf({ status: 'triage' }), alice);
    expect(document.body.querySelector('[data-slot="issue-triage"]')).toBeNull();
});
