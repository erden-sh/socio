import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ATTACHMENT_HINT } from '@socio/shared/issues/issue-attachment-files';
import { type IssueDetail, ISSUE_LABELS } from '@socio/shared/issues/issue-types';

import { linkTarget } from '../../src/chat/markdown-links';
import { issueAction } from '../../src/navigation/tabs';
import {
    ATTACH_TO_ISSUE,
    fieldChoices,
    ISSUE_SECTIONS,
    type IssueDetailInput,
    issueDetailView,
    labelChoices,
    NO_FILES,
    NOT_SENT,
    resolutionValue,
} from '../../src/shell/issue-detail';
import {
    issueOfParam,
    issueParam,
    issueScreen,
    keptIssue,
    LAST_SCREEN_KEY,
    lastScreen,
    preloadKeptIssue,
} from '../../src/shell/last-screen';
import { COMMENT_EDIT_KIND, COMMENT_REFUSALS, ISSUE_COMMENT_KIND } from '../../src/sync/issue-comments';
import { ISSUE_CREATE_KIND, ISSUE_REFUSALS } from '../../src/sync/issue-create';
import { ISSUE_EDIT_REFUSALS, ISSUE_UPDATE_KIND, toggleLabel } from '../../src/sync/issue-edit';
import type { UnsentWrite } from '../../src/sync/outbox';
import type { OverlayItem } from '../../src/sync/outbox-overlay';

// An issue's screen: the held detail with this device's writes laid
// over, for a member, an issue filed offline and one that is gone; the route
// and the last screen.

const T = Date.UTC(2026, 10, 8, 14, 45);
const BEN = 'u-ben';
const ADA = 'u-ada';
const ben = { id: BEN, name: 'Ben', role: 'member' as const };

function detail(fields: Partial<IssueDetail['issue']> = {}): IssueDetail {
    return {
        issue: {
            id: 'i12',
            number: 12,
            title: 'Search misses accents',
            body: 'Typing **café** finds nothing.',
            status: 'triage',
            priority: 'medium',
            kind: 'bug',
            area: null,
            labels: ['dot-request'],
            reporterId: BEN,
            assigneeId: ADA,
            resolution: null,
            source: 'web',
            createdAt: T,
            updatedAt: T,
            closedAt: null,
            votes: 2,
            voted: false,
            ...fields,
        },
        comments: [
            {
                id: 'c1',
                issueId: 'i12',
                authorKind: 'user',
                authorId: ADA,
                body: 'Seen it.',
                createdAt: T + 1,
                editedAt: null,
            },
            {
                id: 'c2',
                issueId: 'i12',
                authorKind: 'user',
                authorId: BEN,
                body: 'Mine.',
                createdAt: T + 2,
                editedAt: T + 3,
            },
        ],
        attachments: [
            {
                id: 'a1',
                issueId: 'i12',
                commentId: null,
                name: 'shot.png',
                mediaType: 'image/png',
                size: 10,
                sha256: 'x',
                uploaderId: BEN,
                createdAt: T,
            },
            {
                id: 'a2',
                issueId: 'i12',
                commentId: 'c1',
                name: 'log.txt',
                mediaType: 'text/plain',
                size: 10,
                sha256: 'y',
                uploaderId: ADA,
                createdAt: T,
            },
        ],
        events: [
            { id: 'e1', issueId: 'i12', actorId: BEN, kind: 'created', fromValue: null, toValue: null, createdAt: T },
            {
                id: 'e2',
                issueId: 'i12',
                actorId: ADA,
                kind: 'status',
                fromValue: 'triage',
                toValue: 'open',
                createdAt: T + 5,
            },
        ],
        blockedBy: [{ number: 3, title: 'Unicode folding', status: 'open' }],
        blocks: [],
        related: [],
        users: { [BEN]: 'Ben', [ADA]: 'Ada' },
    };
}

const ready = { gone: false, settled: true, failed: false, fetchedAt: T };

function input(fields: Partial<IssueDetailInput> = {}): IssueDetailInput {
    return {
        key: '12',
        detail: detail(),
        item: ready,
        overlays: [],
        unsent: [],
        user: ben,
        me: BEN,
        resolve: () => null,
        timeZone: 'UTC',
        ...fields,
    };
}

const overlay = (fields: Partial<OverlayItem> & Pick<OverlayItem, 'collection' | 'key' | 'value'>): OverlayItem => ({
    mode: 'patch',
    id: `row-${fields.key}`,
    state: 'queued',
    reason: null,
    createdAt: T + 10,
    ...fields,
});

const read = (file: string) => readFileSync(join(import.meta.dirname, '../..', file), 'utf8');

describe('the issue page’s order', () => {
    it('puts the conversation first, then the fields and links, in the web’s order', () => {
        expect(ISSUE_SECTIONS).toEqual(['description', 'files', 'comments', 'history', 'triage', 'fields', 'links']);
        const web = read('../../packages/client/src/modules/issues/IssueDetail.tsx');
        const at = (text: string) => {
            const index = web.indexOf(text);
            expect(index, text).toBeGreaterThan(-1);
            return index;
        };
        const order = [
            at('<Section title="Description">'),
            at('<AttachmentGrid'),
            at('Comments ({detail.comments.length})'),
            at('History ({detail.events.length})'),
            at('<IssueTriage detail={detail}'),
            at('<AdminFields detail={detail}'),
            at('<IssueLinks detail={detail}'),
        ];
        expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it('draws its parts by that order, with no part placed by hand', () => {
        const screen = read('src/screens/issue.tsx');
        expect(screen).toContain('ISSUE_SECTIONS.map((section)');
        const start = screen.indexOf('ISSUE_SECTIONS.map((section)');
        const end = screen.indexOf('</ScrollView>', start);
        // Each part is drawn once, in the map; the comments' own files are inside CommentView.
        for (const part of ['<Description', '<Comments', '<History', '<Triage', '<Fields', '<AdminFields', '<Links']) {
            expect(screen.split(part).length - 1, part).toBe(1);
            expect(screen.indexOf(part), part).toBeGreaterThan(start);
            expect(screen.indexOf(part), part).toBeLessThan(end);
        }
        // The issue's own files are its Attachments section (O-6), drawn in the map too.
        expect(screen.slice(start, end)).toContain('<IssueAttachments key={section}');
        expect(screen.split('<IssueAttachments ').length - 1).toBe(1);
        expect(screen.slice(0, start)).not.toContain('<Files');
    });

    it('says when it was updated after it was filed, as the web’s meta line does', () => {
        const changed = detail({ updatedAt: T + 3 * 60 * 60 * 1000 });
        expect(issueDetailView(input({ detail: changed })).filed).toBe(
            'Filed by Ben · Nov 8, 2:45 PM · updated Nov 8, 5:45 PM',
        );
        expect(issueDetailView(input()).filed).toBe('Filed by Ben · Nov 8, 2:45 PM');
    });
});

describe('the issue’s screen', () => {
    it('shows a member the web’s detail, editable where issue editing allows', () => {
        const view = issueDetailView(input());
        expect(view.state).toBe('ready');
        expect(view.label).toBe('CB-12');
        expect(view.filed).toBe('Filed by Ben · Nov 8, 2:45 PM');
        expect(view.status).toEqual({ label: 'Triage', tone: 'violet' });
        expect(view.fields).toContainEqual({ label: 'Labels', value: 'Socio request' });
        expect(view.fields).toContainEqual({ label: 'Assignee', value: 'Ada' });
        expect(view.links).toEqual([
            expect.objectContaining({ key: '3', relation: 'Blocked by', label: 'CB-3', status: 'Open' }),
        ]);
        expect(view.files.map((file) => [file.id, file.picture])).toEqual([['a1', true]]);
        expect(view.comments.map((c) => [c.id, c.author, c.canEdit, c.canDelete, c.edited])).toEqual([
            ['c1', 'Ada', false, false, false],
            ['c2', 'Ben', true, true, true],
        ]);
        expect(view.comments[0]!.files.map((file) => [file.name, file.picture])).toEqual([['log.txt', false]]);
        expect(view.history.map((event) => `${event.actor} ${event.text}`)).toEqual([
            'Ben filed the issue',
            'Ada changed status from Triage to Open',
        ]);
        // Their own issue in triage: the title and description; out of triage, not.
        expect(view.canEditText).toBe(true);
        expect(issueDetailView(input({ detail: detail({ status: 'open' }) })).canEditText).toBe(false);
        expect(issueDetailView(input({ detail: detail({ reporterId: ADA }) })).canEditText).toBe(false);
        expect(view.vote).toMatchObject({ voted: false, votes: 2, label: 'Vote' });
        expect(view.vote!.accessibilityLabel).toBe('Vote for CB-12, 2 votes');
        expect(JSON.stringify(view)).not.toMatch(/\bDot\b/);
    });

    it('lays this device’s vote, edits, comments and files over, in the app’s words', () => {
        const view = issueDetailView(
            input({
                overlays: [
                    overlay({ collection: 'issues', key: '12', value: { voted: true, votes: 3 } }),
                    overlay({
                        collection: 'issues',
                        key: '12',
                        value: { title: 'Accents', body: 'New' },
                        state: 'unconfirmed',
                    }),
                    overlay({
                        collection: 'issue-comments',
                        key: 'pending-comment-1',
                        mode: 'insert',
                        value: { issue: '12', body: '+1', authorId: BEN },
                    }),
                    overlay({ collection: 'issue-comments', key: 'c2', value: { issue: '12', body: 'Mine, edited' } }),
                    overlay({ collection: 'issue-comments', key: 'c1', value: { issue: '12', deleted: true } }),
                    overlay({
                        collection: 'issue-attachments',
                        key: 'row-f',
                        mode: 'insert',
                        value: {
                            issue: '12',
                            commentId: null,
                            fileId: 'f',
                            name: 'more.png',
                            mediaType: 'image/png',
                            size: 4,
                        },
                    }),
                    // Another issue's rows lay nothing here.
                    overlay({ collection: 'issues', key: '13', value: { title: 'Other' } }),
                ],
            }),
        );
        expect(view.vote).toMatchObject({ voted: true, votes: 3, pending: true, label: 'Voted' });
        expect(view.title).toBe('Accents');
        expect(view.pending).toBe('Couldn’t confirm this was sent');
        // An edit's base is the server's, never the overlay's.
        expect(view.base).toEqual({ title: 'Search misses accents', body: 'Typing **café** finds nothing.' });
        expect(view.comments.map((c) => [c.id, c.body, c.pending])).toEqual([
            ['c2', 'Mine, edited', 'Waiting to send'],
            ['pending-comment-1', '+1', 'Waiting to send'],
        ]);
        expect(view.files.map((file) => [file.name, file.picture, file.pending])).toEqual([
            ['shot.png', true, null],
            ['more.png', false, 'Waiting to send'],
        ]);
    });

    it('counts every file on the issue toward the server’s 10, its comments’ and the waiting ones too (O-6)', () => {
        expect(issueDetailView(input()).fileCount).toBe(2);
        const waiting = issueDetailView(
            input({
                overlays: [
                    overlay({
                        collection: 'issue-attachments',
                        key: 'row-g',
                        mode: 'insert',
                        value: { issue: '12', commentId: null, fileId: 'g', name: 'g.png', mediaType: 'image/png' },
                    }),
                ],
            }),
        );
        expect(waiting.fileCount).toBe(3);
        const none = issueDetailView(input({ detail: { ...detail(), attachments: [] } }));
        expect(none.files).toEqual([]);
        expect(none.fileCount).toBe(0);
    });

    it('words the empty Attachments section and its Attach as the web does, but for paste (O-6)', () => {
        expect(NO_FILES).toBe(`None yet. Attach a photo or a file. ${ATTACHMENT_HINT}`);
        expect(ATTACH_TO_ISSUE).toBe('Attach files to the issue');
    });

    it('counts nobody’s vote as 0, which the chip shows (O-4)', () => {
        const view = issueDetailView(input({ detail: detail({ votes: 0, voted: false }) }));
        expect(view.vote).toMatchObject({ voted: false, votes: 0, label: 'Vote' });
        expect(view.vote!.accessibilityLabel).toBe('Vote for CB-12, 0 votes');
        // A held issue with no count yet still has one.
        const unset = issueDetailView(input({ detail: detail({ votes: undefined }) }));
        expect(unset.vote!.votes).toBe(0);
    });

    it('says what the server refused on this issue, with Keep mine and Keep theirs for a conflict', () => {
        const refused = (
            fields: Partial<UnsentWrite> & Pick<UnsentWrite, 'id' | 'kind' | 'lane' | 'reason' | 'payload'>,
        ) => ({ dependsOn: null, payloadVersion: 1, createdAt: T, ...fields }) as UnsentWrite;
        const view = issueDetailView(
            input({
                overlays: [
                    overlay({
                        collection: 'issue-comments',
                        key: 'pending-comment-2',
                        mode: 'insert',
                        state: 'unsent',
                        value: { issue: '12', body: 'Refused', authorId: BEN },
                    }),
                ],
                unsent: [
                    refused({
                        id: 'u1',
                        kind: ISSUE_UPDATE_KIND,
                        lane: 'issue:12',
                        reason: ISSUE_EDIT_REFUSALS.conflict,
                        payload: JSON.stringify({ issue: '12', fields: { title: { value: 'Mine', base: 'Old' } } }),
                    }),
                    refused({
                        id: 'pending-comment-2',
                        kind: ISSUE_COMMENT_KIND,
                        lane: 'issue-comments:12',
                        reason: COMMENT_REFUSALS.invalid,
                        createdAt: T + 1,
                        payload: JSON.stringify({
                            issue: '12',
                            body: 'Refused',
                            authorId: BEN,
                            serverAt: null,
                            seen: [],
                        }),
                    }),
                    refused({
                        id: 'u3',
                        kind: COMMENT_EDIT_KIND,
                        lane: 'issue-comments:99',
                        reason: COMMENT_REFUSALS.notYours,
                        payload: JSON.stringify({ issue: '99', commentId: 'x', body: 'elsewhere' }),
                    }),
                ],
            }),
        );
        expect(view.problems.map((p) => [p.id, p.why, p.actions])).toEqual([
            ['u1', 'Couldn’t save: someone changed it first', ['keep-mine', 'keep-theirs']],
            ['pending-comment-2', 'It couldn’t be sent as written', ['retry', 'copy', 'discard']],
        ]);
        const comment = view.comments.find((c) => c.id === 'pending-comment-2')!;
        expect([comment.pending, comment.canEdit, comment.canDelete]).toEqual([NOT_SENT, false, false]);
    });

    it('shows an issue filed offline from its filing, as CB-?, and reads nothing for it', () => {
        const key = 'pending-issue-a';
        const view = issueDetailView(
            input({
                key,
                detail: null,
                item: { gone: false, settled: true, failed: false, fetchedAt: null },
                overlays: [
                    overlay({
                        collection: 'issues',
                        key,
                        mode: 'insert',
                        value: {
                            key,
                            number: null,
                            title: 'Filed offline',
                            body: '',
                            status: 'triage',
                            kind: 'bug',
                            priority: 'high',
                            area: null,
                        },
                    }),
                    overlay({ collection: 'issues', key, value: { voted: true, votes: 1 } }),
                ],
            }),
        );
        expect(view).toMatchObject({ state: 'ready', label: 'CB-?', title: 'Filed offline', body: null, filed: null });
        expect(view.vote).toMatchObject({ voted: true, votes: 1 });
        expect(view.voteBase).toEqual({ voted: false, votes: 0 });
        expect(view.canEditText).toBe(true);
        // The filing says where it stands.
        expect(view.pending).toBe('Waiting to send');
    });

    it('offers Edit, not Retry, on a refused filing, which opens FileIssue', () => {
        const key = 'pending-issue-b';
        const refused = (
            fields: Partial<UnsentWrite> & Pick<UnsentWrite, 'id' | 'kind' | 'lane' | 'reason' | 'payload'>,
        ) => ({ dependsOn: null, payloadVersion: 1, createdAt: T, ...fields }) as UnsentWrite;
        const value = {
            key,
            number: null,
            title: 'Refused filing',
            body: 'Steps.',
            status: 'triage',
            kind: 'bug',
            priority: 'medium',
            area: null,
        };
        const view = issueDetailView(
            input({
                key,
                detail: null,
                item: { gone: false, settled: true, failed: false, fetchedAt: null },
                overlays: [overlay({ collection: 'issues', key, mode: 'insert', state: 'unsent', value })],
                unsent: [
                    refused({
                        id: key,
                        kind: ISSUE_CREATE_KIND,
                        lane: `issue:${key}`,
                        reason: ISSUE_REFUSALS.invalid,
                        payload: JSON.stringify({
                            title: 'Refused filing',
                            body: 'Steps.',
                            kind: 'bug',
                            priority: 'medium',
                            area: null,
                            reporterId: BEN,
                            after: null,
                            serverAt: null,
                        }),
                    }),
                ],
            }),
        );
        // The problem says it; the pending mark doesn't repeat it.
        expect(view.pending).toBeNull();
        expect(view.problems.map((problem) => [problem.id, problem.actions])).toEqual([
            [key, ['edit', 'copy', 'discard']],
        ]);
    });

    it('says a gone issue is gone, an unread one offline, and waits for the first read', () => {
        const none = { detail: null, overlays: [] };
        expect(issueDetailView(input({ ...none, item: { ...ready, gone: true, fetchedAt: null } })).state).toBe('gone');
        expect(issueDetailView(input({ ...none, item: { ...ready, failed: true, fetchedAt: null } })).state).toBe(
            'offline',
        );
        expect(issueDetailView(input({ ...none, item: { ...ready, settled: false, fetchedAt: null } })).state).toBe(
            'loading',
        );
        // A copy held while the server can't be reached says its age.
        expect(issueDetailView(input({ item: { ...ready, failed: true } })).age).toBe('Saved Nov 8, 2:45 PM');
    });
});

describe('the issue’s route and last screen', () => {
    it('names an issue by its CB- key in the route, and a filing by its local key', () => {
        expect(issueParam('12')).toBe('CB-12');
        expect(issueParam('pending-issue-a')).toBe('pending-issue-a');
        expect(issueOfParam('CB-12')).toBe('12');
        expect(issueOfParam('12')).toBe('12');
        expect(issueOfParam('pending-issue-a')).toBe('pending-issue-a');
        for (const bad of ['CB-0', 'CB-x', 'local-abc', '', null, undefined]) {
            expect(issueOfParam(bad), String(bad)).toBeNull();
        }
    });

    it('opens a reply’s issue chip on the issue’s screen', () => {
        const target = linkTarget('/issues/CB-7', 'https://acme.example');
        expect(target?.kind).toBe('issue');
        const key = target?.kind === 'issue' ? issueOfParam(target.key) : null;
        expect(issueAction(key!)).toEqual({ type: 'PUSH', payload: { name: 'Issue', params: { key: 'CB-7' } } });
    });

    it('keeps Issue/<key> as the last screen, and reads a kept issue from disk before the first frame', async () => {
        expect(issueScreen('12')).toBe('Issue/12');
        expect(keptIssue('Issue/12')).toBe('12');
        expect(keptIssue('Issue/')).toBeNull();
        expect(lastScreen('Issue/12')).toBe('Home');
        const values = new Map<string, string>([[LAST_SCREEN_KEY, issueScreen('12')]]);
        const read: string[] = [];
        const scope = {
            viewState: { get: (key: string) => values.get(key) ?? null },
            issueDetails: { preload: async (key: string) => void read.push(key) },
        };
        await preloadKeptIssue(scope);
        // A filing has nothing on disk; a read that fails leaves it to the screen.
        values.set(LAST_SCREEN_KEY, issueScreen('pending-issue-a'));
        await preloadKeptIssue(scope);
        expect(read).toEqual(['12']);
        const errors: unknown[] = [];
        values.set(LAST_SCREEN_KEY, issueScreen('3'));
        await preloadKeptIssue(
            {
                ...scope,
                issueDetails: {
                    preload: () => Promise.reject(new Error('disk')),
                },
            },
            (error) => errors.push(error),
        );
        expect(errors).toHaveLength(1);
    });
});

describe('an admin’s fields', () => {
    const order = (label: string) => (ISSUE_LABELS as readonly string[]).indexOf(label);
    const ada = { id: ADA, name: 'Ada', role: 'admin' as const };

    it('gives a member none, and an admin every field the web’s AdminFields has', () => {
        expect(issueDetailView(input()).admin).toBeNull();
        const admin = issueDetailView(input({ user: ada, me: ADA })).admin!;
        expect(admin.fields.map((field) => [field.label, field.value, field.pending])).toEqual([
            ['Status', 'Triage', false],
            ['Priority', 'Medium', false],
            ['Kind', 'Bug', false],
            ['Area', 'No area', false],
            ['Labels', 'Socio request', false],
            ['Assignee', 'Ada', false],
            ['Resolution', 'None', false],
        ]);
        expect(admin.base).toEqual(admin.values);
        // An admin edits anyone's title and description too (shared's canEditText).
        expect(issueDetailView(input({ user: ada, me: ADA, detail: detail({ status: 'open' }) })).canEditText).toBe(
            true,
        );
    });

    it('shows a waiting edit over the server’s values, marked, with the server’s values as its base', () => {
        const view = issueDetailView(
            input({
                user: ada,
                me: ADA,
                overlays: [
                    overlay({ collection: 'issues', key: '12', value: { status: 'open', assigneeId: null } }),
                    overlay({ collection: 'issues', key: '12', value: { priority: 'high' }, state: 'sent' }),
                ],
            }),
        );
        const admin = view.admin!;
        const row = (label: string) => admin.fields.find((field) => field.label === label)!;
        expect([row('Status').value, row('Status').pending]).toEqual(['Open', true]);
        expect(row('Status').accessibilityLabel).toBe('Status, Open, Waiting to send');
        expect([row('Assignee').value, row('Assignee').pending]).toEqual(['Unassigned', true]);
        expect([row('Priority').value, row('Priority').pending]).toEqual(['High', false]);
        expect(admin.values).toMatchObject({ status: 'open', assigneeId: null, priority: 'high' });
        expect(admin.base).toMatchObject({ status: 'triage', assigneeId: ADA, priority: 'medium' });
        expect(view.status?.label).toBe('Open');
        // A refused edit lays nothing: "Couldn't save" says why.
        const refusedView = issueDetailView(
            input({
                user: ada,
                me: ADA,
                overlays: [overlay({ collection: 'issues', key: '12', value: { status: 'done' }, state: 'unsent' })],
            }),
        );
        expect(refusedView.admin!.fields[0]).toMatchObject({ value: 'Triage', pending: false });
    });

    it('offers an admin a filing’s fields too (CB-?)', () => {
        const view = issueDetailView(
            input({
                key: 'pending-issue-1',
                detail: null,
                user: ada,
                me: ADA,
                overlays: [
                    overlay({
                        collection: 'issues',
                        key: 'pending-issue-1',
                        mode: 'insert',
                        value: {
                            key: 'pending-issue-1',
                            number: null,
                            title: 'Offline',
                            body: '',
                            status: 'triage',
                            kind: 'bug',
                            priority: 'medium',
                            area: null,
                        },
                    }),
                ],
            }),
        );
        expect(view.admin?.base).toEqual({
            status: 'triage',
            priority: 'medium',
            kind: 'bug',
            area: null,
            labels: [],
            components: [],
            assigneeId: null,
            resolution: null,
        });
    });

    it('lists each field’s choices in the web’s order, the one shown selected', () => {
        const values = issueDetailView(input({ user: ada, me: ADA })).admin!.values;
        const status = fieldChoices('status', values);
        expect(status.map((choice) => choice.label)).toEqual([
            'Triage',
            'Open',
            'Ready',
            'In progress',
            'In review',
            'Blocked',
            'Done',
            'Won’t fix',
        ]);
        expect(status.filter((choice) => choice.selected).map((choice) => choice.value)).toEqual(['triage']);
        const area = fieldChoices('area', values);
        expect(area[0]).toEqual({ value: null, label: 'No area', selected: true });
        expect(fieldChoices('priority', values).find((choice) => choice.selected)?.label).toBe('Medium');
        expect(labelChoices(values).find((choice) => choice.value === 'dot-request')).toMatchObject({
            label: 'Socio request',
            selected: true,
        });
        expect(JSON.stringify([status, area, labelChoices(values)])).not.toMatch(/\bDot\b/);
    });

    it('turns labels on and off in the web’s order, and reads a blank resolution as none', () => {
        expect(toggleLabel(['dot-request'], 'dot-request')).toEqual([]);
        expect(toggleLabel(['ux', 'dot-request'], 'regression')).toEqual(
            ['regression', 'ux', 'dot-request'].sort((a, b) => order(a) - order(b)),
        );
        expect(resolutionValue('  ')).toBeNull();
        expect(resolutionValue('Fixed in 380fb4c')).toBe('Fixed in 380fb4c');
    });
});
