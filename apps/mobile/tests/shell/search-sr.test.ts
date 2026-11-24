import { describe, expect, it } from 'vitest';

import type { IssueStatus, IssueSummary } from '@socio/shared/issues/issue-types';
import type { PageHit } from '@socio/shared/pages/page-search';
import { searchCommands } from '@socio/shared/search/rank';

import type { ChatRow } from '../../src/shell/chat-list';
import {
    OFFLINE_LINE,
    type SearchInput,
    type SearchLink,
    type SearchView,
    searchView,
    WAITING_LINE,
} from '../../src/shell/search';
import type { SpaceRow } from '../../src/shell/spaces';
import type { ServerSearchState } from '../../src/sync/server-search';

// Search over issues and pages, ranked by the web palette's ranking
// (shared's searchCommands), with the server's matches after the local rows.

const issue = (number: number, title: string, status: IssueStatus = 'open'): IssueSummary => ({
    number,
    title,
    status,
    priority: 'medium',
    kind: 'bug',
    area: null,
    labels: [],
    assigneeId: null,
    updatedAt: 1000 + number,
    excerpt: '',
});

const space = (id: string, name: string): SpaceRow => ({
    id,
    name,
    description: null,
    private: false,
    accessibilityLabel: name,
});

const chat = (id: string, title: string): ChatRow => ({
    id,
    title,
    socio: 'Everyday',
    character: 'stoneCrab' as ChatRow['character'],
    room: false,
    roomRole: null,
    unread: null,
    unreadLabel: null,
    accessibilityLabel: title,
});

const hit = (id: string, spaceId: string, title: string, snippet: string): PageHit => ({
    id,
    spaceId,
    title,
    updatedAt: 0,
    snippet: [{ text: snippet, match: false }],
    matched: 'word',
    freshness: { basis: 'edited', at: NOW - 3 * 86_400_000 },
});

const NOW = Date.UTC(2026, 10, 9);
const ISSUES = [
    issue(12, 'Login button does nothing'),
    issue(7, 'Export loses dates', 'triage'),
    issue(3, 'Dark mode'),
];
const SPACES = [space('ops', 'Ops runbooks'), space('eng', 'Engineering')];
const BASE: SearchInput = {
    query: '',
    chats: [chat('c1', 'Login plans')],
    socios: [],
    spaces: SPACES,
    issues: ISSUES,
    role: 'member',
    now: NOW,
};

const keys = (view: SearchView, id?: string) =>
    view.sections.filter((s) => id === undefined || s.id === id).flatMap((s) => s.items.map((item) => item.key));
const done = (query: string, answer: { pages?: PageHit[]; issues?: number[] }): ServerSearchState => ({
    status: 'done',
    answer: {
        query,
        pages: answer.pages === undefined ? null : { query, corrected: null, results: answer.pages, more: false },
        issues: answer.issues ?? null,
    },
});

describe('Search over issues and pages', () => {
    it('lists no issue before anything is typed, and "File an issue" among the workspace rows', () => {
        const view = searchView(BASE);
        expect(keys(view, 'issues')).toEqual([]);
        const file = view.sections.flatMap((s) => s.items).find((item) => item.key === 'file-issue') as SearchLink;
        expect(file.target).toEqual({ kind: 'file-issue' });
        expect(keys(searchView({ ...BASE, query: 'report' }))).toEqual(['file-issue']);
    });

    it('puts an exact key first, its section before the others', () => {
        const view = searchView({ ...BASE, query: 'cb-12' });
        expect(view.sections[0]?.id).toBe('issues');
        expect(keys(view, 'issues')[0]).toBe('issue-12');
        const [row] = view.sections[0]!.items as SearchLink[];
        expect(row).toMatchObject({
            label: 'Login button does nothing',
            subtitle: 'CB-12 · Open',
            target: { kind: 'issue', key: '12' },
            accessibilityLabel: 'CB-12, Login button does nothing, Open',
        });
    });

    it('ranks as the web palette does over the same commands', () => {
        // The web's issue commands (issues/module.ts loadCommands) and Spaces' (spaces/module.tsx).
        const web = [
            ...SPACES.map((s) => ({ id: `space-${s.id}`, label: s.name, group: 'Spaces', keywords: ['space', ''] })),
            ...[...ISSUES]
                .sort((a, b) => b.number - a.number)
                .map((i) => ({
                    id: `issue-${i.number}`,
                    label: i.title,
                    group: 'Issues',
                    hint: `CB-${i.number}`,
                    keywords: [`CB-${i.number}`, i.status.replace('_', ' ')],
                    searchOnly: true,
                })),
        ];
        for (const query of ['login', 'e', 'triage', 'eng', 'cb-3', 'dark mo', 'ops run']) {
            const ours = keys(searchView({ ...BASE, chats: [], query })).filter(
                (key) => key.startsWith('issue-') || key.startsWith('space-'),
            );
            expect([...ours].sort(), query).toEqual(
                searchCommands(web, query)
                    .map((c) => c.id)
                    .sort(),
            );
            for (const group of ['issues', 'spaces'] as const) {
                const prefix = group === 'issues' ? 'issue-' : 'space-';
                expect(keys(searchView({ ...BASE, chats: [], query }), group), query).toEqual(
                    searchCommands(web, query)
                        .map((c) => c.id)
                        .filter((id) => id.startsWith(prefix)),
                );
            }
        }
    });

    it('adds the server’s issue matches after the local ones, and only issues it holds', () => {
        const query = 'button';
        const view = searchView({ ...BASE, query, server: done(query, { issues: [3, 12, 99] }) });
        expect(keys(view, 'issues')).toEqual(['issue-12', 'issue-3']);
        // An answer to another query is never shown.
        expect(keys(searchView({ ...BASE, query, server: done('butto', { issues: [3] }) }), 'issues')).toEqual([
            'issue-12',
        ]);
    });

    it('adds the server’s pages, in Spaces it lists, each opening the reader with its Space, freshness and text', () => {
        const query = 'deploy';
        const view = searchView({
            ...BASE,
            query,
            server: done(query, {
                pages: [hit('p1', 'ops', 'Deploys', 'how we  deploy on Fridays'), hit('p2', 'gone', 'Hidden', 'x')],
            }),
        });
        expect(keys(view, 'pages')).toEqual(['page-p1']);
        const [page] = view.sections.find((s) => s.id === 'pages')!.items as SearchLink[];
        expect(page).toMatchObject({
            label: 'Deploys',
            subtitle: 'Ops runbooks · Edited 3 days ago\nhow we deploy on Fridays',
            subtitleLines: 2,
            target: { kind: 'space-page', spaceId: 'ops', pageId: 'p1' },
        });
        expect(view.noMatches).toBe(false);
    });

    it('takes page titles held on the phone through its hook, the server’s line replacing theirs', () => {
        const pages = [{ spaceId: 'eng', id: 'p9', title: 'Release checklist' }];
        const local = searchView({ ...BASE, pages, query: 'release' });
        expect(keys(local, 'pages')).toEqual(['page-p9']);
        expect((local.sections[0]!.items[0] as SearchLink).subtitle).toBe('Engineering');
        const merged = searchView({
            ...BASE,
            pages,
            query: 'release',
            server: done('release', { pages: [hit('p9', 'eng', 'Release checklist', 'steps')] }),
        });
        expect(keys(merged, 'pages')).toEqual(['page-p9']);
        expect((merged.sections[0]!.items[0] as SearchLink).subtitle).toContain('steps');
    });

    it('shows the local rows offline with the connection line, and waits before saying nothing matches', () => {
        const offline = searchView({ ...BASE, query: 'login', server: { status: 'offline', query: 'login' } });
        expect(keys(offline)).toEqual(['chat-c1', 'issue-12']);
        expect(offline.serverLine).toBe(OFFLINE_LINE);
        const waiting = searchView({ ...BASE, query: 'zzz', server: { status: 'waiting', query: 'zzz' } });
        expect(waiting).toMatchObject({ sections: [], noMatches: false, serverLine: WAITING_LINE });
        expect(searchView({ ...BASE, query: 'zzz', server: done('zzz', { pages: [], issues: [] }) })).toMatchObject({
            noMatches: true,
            serverLine: null,
        });
    });
});
