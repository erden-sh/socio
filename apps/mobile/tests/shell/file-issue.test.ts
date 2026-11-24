import { rmSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentRunSummary } from '@socio/shared/types';

import type { UserDb } from '../../src/data';
import {
    AREA_CHOICES,
    CANCEL_DRAFT_QUESTION,
    cancelIssue,
    DISCARD_DRAFT,
    discardIssueDraft,
    editIssueFields,
    FILE_ISSUE_LEAD,
    FILE_ISSUE_RUN,
    FILE_ISSUE_RUN_GONE,
    fileIssueView,
    forRun,
    issueFormFields,
    KEEP_DRAFT,
    KIND_CHOICES,
    openIssueFor,
    PENDING_ACTION_LABELS,
    PRIORITY_CHOICES,
    runIssueFields,
    withIssueField,
} from '../../src/shell/file-issue';
import { pendingIssueRows } from '../../src/shell/issue-filing';
import { openDrafts } from '../../src/sync/chat-drafts';
import { heldIssueFiles, ISSUE_ATTACHMENT_KIND } from '../../src/sync/issue-attachments';
import { ISSUE_CREATE_KIND, ISSUE_DRAFT, ISSUE_REFUSALS, type IssueFields } from '../../src/sync/issue-create';
import type { HoldGroup, Outbox, OutboxRow } from '../../src/sync/outbox';
import type { OverlayItem } from '../../src/sync/outbox-overlay';
import { userDb } from '../sync/outbox-fakes';

// Filing an issue: the FileIssue form's view model over the
// `issue:new` draft, the run it links to, Edit's held files, the Board's
// `CB-?` actions, and the draft surviving a kill on a real user.db.

const FIELDS: IssueFields = { title: 'Export fails', body: '', kind: 'bug', priority: 'medium', area: null };

const view = (fields: Partial<IssueFields> = {}, rest: Partial<Parameters<typeof fileIssueView>[0]> = {}) =>
    fileIssueView({
        fields: { ...FIELDS, ...fields },
        editing: false,
        busy: false,
        picking: false,
        editable: true,
        ...rest,
    });

describe('the form', () => {
    it('opens on the web’s defaults: Bug, Medium, no area', () => {
        expect(issueFormFields('')).toEqual({ title: '', body: '', kind: 'bug', priority: 'medium', area: null });
        expect(issueFormFields('not json')).toEqual(issueFormFields(''));
    });

    it('keeps each change in the draft as JSON, and an untouched form as no draft at all', () => {
        let text = withIssueField('', { title: 'Export' });
        text = withIssueField(text, { kind: 'feature', area: 'spaces' });
        expect(issueFormFields(text)).toEqual({
            title: 'Export',
            body: '',
            kind: 'feature',
            priority: 'medium',
            area: 'spaces',
        });
        text = withIssueField(text, { title: '', kind: 'bug', area: null });
        expect(text).toBe('');
    });

    it('links to the run it was opened for, and to none from New issue', () => {
        const typed = withIssueField('', { title: 'Run failed' });
        const forTheRun = forRun(typed, 'run-1');
        expect(issueFormFields(forTheRun)).toMatchObject({ title: 'Run failed', runId: 'run-1' });
        expect(forRun(forTheRun, 'run-1')).toBe(forTheRun);
        expect(issueFormFields(forRun(forTheRun, null)).runId).toBeUndefined();
        // A run's link alone keeps the draft; dropping it leaves none.
        expect(forRun(forRun('', 'run-2'), undefined)).toBe('');
        expect(view({ runId: 'run-1' }).lead).toBe(`${FILE_ISSUE_LEAD} ${FILE_ISSUE_RUN}`);
        expect(view().lead).toBe(FILE_ISSUE_LEAD);
    });

    it('files a title of 3 to 200 characters, trimmed, like the server', () => {
        expect(view().canFile).toBe(true);
        expect(view({ title: '' })).toMatchObject({ canFile: false, titleHint: null });
        expect(view({ title: ' ab  ' })).toMatchObject({ canFile: false, titleHint: 'At least 3 characters.' });
        expect(view({ title: 'x'.repeat(201) }).canFile).toBe(false);
        expect(view({ body: 'x'.repeat(20_001) }).canFile).toBe(false);
    });

    it('waits while it files, while a pick is copied, and on a draft it can’t change', () => {
        expect(view({}, { busy: true })).toMatchObject({ canFile: false, action: 'Filing…', editable: false });
        expect(view({}, { picking: true }).canFile).toBe(false);
        expect(view({}, { editable: false })).toMatchObject({ canFile: false, editable: false });
        expect(view({}, { editing: true })).toMatchObject({ heading: 'Edit issue', action: 'Send again' });
        expect(view()).toMatchObject({ heading: 'New issue', action: 'File issue' });
    });

    it('offers the web’s choices in its order, with “No area” first', () => {
        expect(KIND_CHOICES.map((choice) => choice.label)).toEqual([
            'Bug',
            'Feature',
            'Improvement',
            'Docs',
            'Chore',
            expect.any(String),
        ]);
        expect(PRIORITY_CHOICES.map((choice) => choice.value)).toEqual(['critical', 'high', 'medium', 'low']);
        expect(AREA_CHOICES[0]).toEqual({ value: null, label: 'No area', testID: 'file-issue-area-none' });
        expect(AREA_CHOICES.find((choice) => choice.value === 'chat')?.label).toBe('Web chat');
        expect(new Set(AREA_CHOICES.map((choice) => choice.testID)).size).toBe(AREA_CHOICES.length);
    });
});

const FAILED_RUN: AgentRunSummary = {
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
    ownerId: 'user-a',
    ownerName: 'Ana',
    readable: true,
};

describe('a failed run’s "File issue"', () => {
    it('fills the form as the web’s runIssueDraft does', () => {
        // packages/client/tests/issues-ui.test.tsx's case, the same run.
        const fields = runIssueFields(FAILED_RUN);
        expect(fields.title).toBe('Run failed: The model provider timed out.');
        expect(fields).toMatchObject({ kind: 'bug', priority: 'medium', area: 'runs', runId: 'run-1' });
        expect(fields.body).toBe(
            [
                'A turn failed in [Garden plan](/chats/c%201) with Socio.',
                '',
                '- Run: `run-1`',
                '- Started: 1970-01-01T00:00:00.000Z',
                '- Source: web',
                '',
                '**Error:** The model provider timed out.',
                '',
                '```',
                'ETIMEDOUT 10.0.0.1:8016',
                '```',
            ].join('\n'),
        );
        const unreadable = runIssueFields({
            ...FAILED_RUN,
            readable: false,
            title: null,
            dotName: null,
            error: '  two\n lines ',
            errorDetail: null,
        });
        expect(unreadable.title).toBe('Run failed: two lines');
        expect(unreadable.body.split('\n')[0]).toBe('A turn failed in a conversation.');
        expect(unreadable.body).not.toContain('```');
        expect(runIssueFields({ ...FAILED_RUN, error: 'x'.repeat(300) }).title).toHaveLength(200);
        expect(runIssueFields({ ...FAILED_RUN, error: null }).title).toBe('Run failed: failed');
    });

    it('fills an empty box for the run, keeps what was typed, and leaves a box already linked alone', () => {
        expect(issueFormFields(forRun('', 'run-1', FAILED_RUN))).toEqual(runIssueFields(FAILED_RUN));
        const typed = withIssueField('', { title: 'Mine', area: 'spaces' });
        expect(issueFormFields(forRun(typed, 'run-1', FAILED_RUN))).toEqual({
            ...runIssueFields(FAILED_RUN),
            title: 'Mine',
            area: 'spaces',
        });
        const linked = withIssueField(forRun('', 'run-1', FAILED_RUN), { body: '' });
        expect(forRun(linked, 'run-1', FAILED_RUN)).toBe(linked);
        // Another run's summary, or none, only links.
        expect(issueFormFields(forRun('', 'run-2', FAILED_RUN))).toMatchObject({ title: '', runId: 'run-2' });
        expect(issueFormFields(forRun('', 'run-1'))).toMatchObject({ title: '', runId: 'run-1' });
    });

    it('writes the filled box into the issue:new draft, and nothing when it is unchanged', () => {
        const kept = new Map<string, string>();
        const writes: string[] = [];
        const drafts = {
            read: (scope: string) => ({ text: kept.get(scope) ?? '' }) as never,
            write: (scope: string, text: string) => {
                writes.push(scope);
                kept.set(scope, text);
            },
        };
        openIssueFor(drafts, 'run-1', FAILED_RUN);
        expect(issueFormFields(kept.get(ISSUE_DRAFT)!)).toEqual(runIssueFields(FAILED_RUN));
        // FileIssue's own open for the same run changes nothing.
        openIssueFor(drafts, 'run-1');
        expect(writes).toEqual([ISSUE_DRAFT]);
    });
});

describe('Cancel with a draft', () => {
    it('closes at once with nothing typed and no file, else asks Keep draft or Discard', () => {
        expect(cancelIssue(issueFormFields(''), 0)).toBe('close');
        // The chips and a run's link alone aren't text.
        expect(cancelIssue(issueFormFields(withIssueField('', { kind: 'feature', runId: 'run-1' })), 0)).toBe('close');
        expect(cancelIssue({ title: '   ', body: '\n' }, 0)).toBe('close');
        expect(cancelIssue({ title: 'Export', body: '' }, 0)).toBe('ask');
        expect(cancelIssue({ title: '', body: 'Steps' }, 0)).toBe('ask');
        expect(cancelIssue({ title: '', body: '' }, 1)).toBe('ask');
        expect(CANCEL_DRAFT_QUESTION).toMatch(/draft/);
        expect([KEEP_DRAFT.label, DISCARD_DRAFT.label]).toEqual(['Keep draft', 'Discard']);
        expect(DISCARD_DRAFT.destructive).toBe(true);
        expect(KEEP_DRAFT.destructive).toBeUndefined();
    });

    it('Discard deletes the issue:new draft and every file in its tray', async () => {
        const kept = new Map([[ISSUE_DRAFT, withIssueField('', { title: 'Export' })]]);
        const drafts = { write: (scope: string, text: string) => void kept.set(scope, text) };
        const discarded: string[] = [];
        const attachments = {
            list: (scope: string) => (scope === ISSUE_DRAFT ? [{ id: 'f1' }, { id: 'f2' }] : []) as never,
            discard: async (id: string) => {
                discarded.push(id);
                if (id === 'f2') {
                    throw new Error('busy');
                }
            },
        };
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await discardIssueDraft(drafts, attachments);
        expect(kept.get(ISSUE_DRAFT)).toBe('');
        expect(discarded).toEqual(['f1', 'f2']);
        // One that won't go is logged; the rest still go.
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });
});

describe('Edit and the Board’s CB-? rows', () => {
    const row = (id: string, kind: string, payload: unknown) => ({ id, kind, payload: JSON.stringify(payload) });

    it('opens Edit without the run only when the refusal was the run being gone', () => {
        const write = (reason: string) => ({
            kind: ISSUE_CREATE_KIND,
            payloadVersion: 1,
            reason,
            payload: JSON.stringify({
                title: 'Export fails',
                body: '',
                kind: 'bug',
                priority: 'medium',
                area: null,
                runId: 'run-1',
                reporterId: 'me',
                after: null,
                serverAt: null,
            }),
        });
        const gone = editIssueFields(write(ISSUE_REFUSALS.runGone))!;
        expect(gone).toMatchObject({ runUnlinked: true, fields: { title: 'Export fails', runId: null } });
        const refused = editIssueFields(write(ISSUE_REFUSALS.invalid))!;
        expect(refused).toMatchObject({ runUnlinked: false, fields: { runId: 'run-1' } });
        const lead = (opened: typeof gone) =>
            fileIssueView({
                fields: opened.fields,
                editing: true,
                busy: false,
                picking: false,
                editable: true,
                runUnlinked: opened.runUnlinked,
            }).lead;
        expect(lead(gone)).toBe(`${FILE_ISSUE_LEAD} ${FILE_ISSUE_RUN_GONE}`);
        expect(lead(refused)).toBe(`${FILE_ISSUE_LEAD} ${FILE_ISSUE_RUN}`);
        expect(editIssueFields({ ...write(ISSUE_REFUSALS.runGone), kind: 'chat-send' })).toBeNull();
    });

    it('restores the tray of a refused filing from its own file rows, which follow it', () => {
        const file = (fileId: string, name: string) => ({ issue: 'pending-issue-a', fileId, name, commentId: null });
        const groups = [
            {
                root: { id: 'pending-issue-a', kind: 'issue-create', lane: 'issue:a', cause: 'unsent', reason: 'x' },
                rows: [
                    row('f1', ISSUE_ATTACHMENT_KIND, file('a1', 'screen.jpg')),
                    row('c1', 'issue-comment', { body: 'hi' }),
                    row('f2', ISSUE_ATTACHMENT_KIND, file('a2', 'log.txt')),
                    row('f3', ISSUE_ATTACHMENT_KIND, 'not an object'),
                    // A comment's file isn't the form's.
                    row('f4', ISSUE_ATTACHMENT_KIND, { ...file('a4', 'c.png'), commentId: 'pending-comment-x' }),
                ] as unknown as OutboxRow[],
            },
        ] as HoldGroup[];
        expect(heldIssueFiles(groups, 'pending-issue-a')).toEqual([
            { rowId: 'f1', fileId: 'a1', name: 'screen.jpg' },
            { rowId: 'f2', fileId: 'a2', name: 'log.txt' },
        ]);
        expect(heldIssueFiles(groups, 'pending-issue-b')).toEqual([]);
    });

    it('gives each CB-? row its words, the text Copy takes and its buttons', () => {
        const item = (state: OverlayItem['state'], createdAt: number): OverlayItem => ({
            collection: 'issues',
            key: `pending-issue-${state}`,
            id: `pending-issue-${state}`,
            mode: 'insert',
            state,
            reason: state === 'unsent' ? 'issue-invalid' : null,
            createdAt,
            value: { title: 'Export fails', body: 'Steps.' },
        });
        const rows = pendingIssueRows(
            [item('unsent', 1), item('unconfirmed', 2), item('queued', 3)],
            new Map([['pending-issue-unconfirmed', ['43', '44']]]),
        );
        expect(rows.map((r) => [r.state, r.text, r.actions.map((a) => PENDING_ACTION_LABELS[a])])).toEqual([
            ['queued', 'Export fails\n\nSteps.', []],
            ['unconfirmed', 'Export fails\n\nSteps.', ['View', 'Send again']],
            ['unsent', 'Export fails\n\nSteps.', ['Edit', 'Copy', 'Discard']],
        ]);
    });
});

describe('the draft', () => {
    const directories: string[] = [];
    const files: UserDb[] = [];
    afterEach(async () => {
        for (const file of files.splice(0)) {
            await file.db.close();
        }
        for (const directory of directories.splice(0)) {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('survives a kill: what was typed is there after a relaunch', async () => {
        const store = await userDb();
        directories.push(store.directory);
        const first = await store.open();
        files.push(first);
        const outbox = {} as Outbox;
        const drafts = await openDrafts({ db: first.db, state: first.state, outbox });
        let text = withIssueField('', { title: 'Export fails' });
        text = withIssueField(text, { body: 'Steps to reproduce', priority: 'high', area: 'client' });
        drafts.write(ISSUE_DRAFT, text);
        await drafts.flush();
        // Killed: never closed. A new launch opens user.db again.
        const second = await store.open();
        files.push(second);
        const again = await openDrafts({ db: second.db, state: second.state, outbox });
        expect(issueFormFields(again.read(ISSUE_DRAFT).text)).toEqual({
            title: 'Export fails',
            body: 'Steps to reproduce',
            kind: 'bug',
            priority: 'high',
            area: 'client',
        });
        await again.close();
    });
});
