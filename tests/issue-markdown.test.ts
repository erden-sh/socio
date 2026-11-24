import { readFileSync } from 'node:fs';

import { afterEach, expect, it } from 'vitest';

import type { IssueDetail, IssueList } from '@socio/shared/issues/issue-types';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { issuesMarkdown, parseIssuesMarkdown } from '../src/server/issues/markdown.js';

import { makeTestRuntime } from './helpers/test-runtime.js';
import { formatAs } from './support/format.js';

// A copy of the ISSUES.md file as it stood before the tracker (CB-1…CB-17).
const FIXTURE = new URL('./fixtures/ISSUES.md', import.meta.url);
const markdown = readFileSync(FIXTURE, 'utf8');
const tableOf = (text: string) => text.split('\n').filter((line) => line.startsWith('|'));

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function fixture() {
    const { workspace, platform, app, dispose } = await makeTestRuntime({
        config: { baseUrl: '', apiKey: '', model: '', runtimeUrl: '' },
        app: {
            auth: {
                provider: new MockAuthProvider(DEFAULT_MOCK_USERS, 'secret-0123456789abcdef-xyz'),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    for (const user of DEFAULT_MOCK_USERS) {
        workspace.recordUser(user);
    }
    const as = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0];
        return (path: string, method = 'GET', body?: unknown) =>
            app.request(`/api${path}`, {
                method,
                headers: {
                    cookie,
                    ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
    };
    return { workspace, platform, alice: await as('alice'), bob: await as('bob') };
}

it('parses every issue in an ISSUES.md file with its number, fields and section', () => {
    const issues = parseIssuesMarkdown(markdown);
    expect(issues.map((issue) => issue.number)).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
    const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
    expect(byNumber.get(1)).toEqual({
        number: 1,
        title: 'Telegram link button was a tiny unlabeled footer icon',
        body: 'The only entry point was a 14 px paper-plane icon between the user name and "Switch user". Now a labeled **Telegram** sidebar item with the connection status.',
        status: 'done',
        priority: 'medium',
        kind: 'bug',
        area: 'telegram',
        labels: [],
        resolution: 'Fixed in 380fb4c',
    });
    expect(byNumber.get(3)).toMatchObject({
        title: "The model couldn't read images: `qwen38-flash` ran without `--vision`",
        status: 'done',
        area: 'model',
        labels: ['owner:lead'],
        resolution: null,
    });
    // Multi-paragraph sections are kept verbatim.
    expect(byNumber.get(3)!.body).toMatch(/^`TensorFold\//);
    expect(byNumber.get(3)!.body).toContain('\n\nDone 2026-10-07: TensorFold');
    expect(byNumber.get(4)).toMatchObject({
        priority: 'high',
        area: 'runs',
        resolution: 'Fixed in 8262d4c, 43b1a8a',
    });
    expect(byNumber.get(7)).toMatchObject({
        status: 'open',
        priority: 'low',
        area: 'server',
        labels: [],
        resolution: null,
    });
    expect(byNumber.get(9)).toMatchObject({
        area: 'deploy',
        labels: ['owner:user'],
    });
    expect(byNumber.get(10)).toMatchObject({
        status: 'in_progress',
        kind: 'chore',
        area: 'docs',
        labels: ['owner:lead'],
    });
    expect(byNumber.get(11)).toMatchObject({
        kind: 'improvement',
        area: 'telegram',
        labels: ['owner:user'],
    });
    expect(byNumber.get(16)).toMatchObject({ kind: 'chore', area: 'deploy' });
    expect(byNumber.get(17)).toMatchObject({ area: 'spaces', status: 'done' });
    expect(issues.filter((issue) => issue.status === 'open').map((i) => i.number)).toEqual([7, 8, 9, 12, 16]);
    for (const issue of issues) {
        expect(issue.body.length).toBeGreaterThan(20);
    }
});

it('reports malformed files instead of guessing', () => {
    const row = (cells: string) => `| ID | Issue | Severity | Status | Owner |\n| -- | -- | -- | -- | -- |\n${cells}\n`;
    for (const [text, error] of [
        ['# Issues\n\nNo table.', 'No issue table found'],
        [row('| CB-1 | A title | urgent | open | |'), 'unknown severity'],
        [row('| CB-1 | A title | low | closed | |'), 'unknown status'],
        [row('| CB-1 | A title | low | open | bob |'), 'unknown owner'],
        [row('| 7 | A title | low | open | |'), 'Unknown issue ID'],
        [row('| CB-1 | A title | low | open | |\n| CB-1 | Again | low | open | |'), 'appears twice'],
        [`${row('| CB-1 | A title | low | open | |')}\n## CB-2 Orphan\n\nText.\n`, 'no table row'],
    ]) {
        expect(() => parseIssuesMarkdown(text), text).toThrow(error);
    }
});

it('exports a snapshot that round-trips the table and is formatter-clean', async () => {
    const parsed = parseIssuesMarkdown(markdown);
    const { platform } = await fixture();
    await platform.board.issues.import(parsed);
    const exported = issuesMarkdown(await platform.board.issues.list());
    // Identical rows; only the "(proxy)" qualifier on CB-9's owner is dropped.
    expect(tableOf(exported)).toEqual(tableOf(markdown.replace('user (proxy)', 'user        ')));
    // Importing the snapshot gives the same issues back.
    expect(parseIssuesMarkdown(exported)).toEqual(
        parsed.map((issue) => (issue.number === 9 ? { ...issue, labels: ['owner:user'] } : issue)),
    );
    expect(await formatAs('ISSUES.md', exported)).toBe(exported);
});

it('imports through an admin-only, idempotent route and exports for everyone', async () => {
    const { alice, bob, platform } = await fixture();
    expect((await bob('/issues/import', 'POST', { markdown })).status).toBe(403);
    const first = await alice('/issues/import', 'POST', { markdown });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
        created: Array.from({ length: 17 }, (_, i) => i + 1),
        skipped: [],
    });
    const snapshot = async () => {
        const issues = await platform.board.issues.list();
        const events = [];
        for (const issue of issues) {
            events.push(...(await platform.board.issues.events(issue.id)));
        }
        return { issues, events };
    };
    const before = await snapshot();
    expect(before.events.every((event) => event.kind === 'imported')).toBe(true);
    const again = await json(alice('/issues/import', 'POST', { markdown }));
    expect(again).toEqual({
        created: [],
        skipped: Array.from({ length: 17 }, (_, i) => i + 1),
    });
    expect(await snapshot()).toEqual(before);

    const cb4 = await json<IssueDetail>(bob('/issues/CB-4'));
    expect(cb4.issue).toMatchObject({
        number: 4,
        status: 'done',
        priority: 'high',
        reporterId: 'import',
        source: 'import',
        resolution: 'Fixed in 8262d4c, 43b1a8a',
    });
    expect(cb4.issue.closedAt).toBe(cb4.issue.createdAt);
    expect(cb4.users).toEqual({ import: 'Imported' });
    // New issues continue after the highest imported number.
    const next = await json<IssueDetail>(bob('/issues', 'POST', { title: 'Filed after the import' }));
    expect(next.issue.number).toBe(18);

    const exported = await bob('/issues/export.md');
    expect(exported.status).toBe(200);
    expect(exported.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    const text = await exported.text();
    expect(tableOf(text).slice(2, 19)).toEqual(tableOf(issuesMarkdown(before.issues)).slice(2));
    expect(tableOf(text)[19]).toMatch(/^\| CB-18 \| Filed after the import +\| medium +\| triage +\| +\|$/);
    expect((await json<IssueList>(bob('/issues'))).issues.map((issue) => issue.number)).toHaveLength(18);
    const malformed = await alice('/issues/import', 'POST', {
        markdown: '# Nothing here',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
        error: 'No issue table found (a row starting “| ID |”).',
    });
});

const json = async <T = unknown>(response: Response | Promise<Response>) => (await (await response).json()) as T;
