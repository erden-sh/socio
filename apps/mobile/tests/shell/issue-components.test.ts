import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { IssueComponentLabel, IssueComponentOption } from '@socio/shared/issues/issue-components';
import type { IssueDetail, IssueSummary } from '@socio/shared/issues/issue-types';

import { boardPrefsText, boardView, NO_BOARD_PREFS, readBoardPrefs, toggleComponentFacet } from '../../src/shell/board';
import { issueFormFields, withIssueField } from '../../src/shell/file-issue';
import {
    componentChip,
    componentChips,
    componentEventText,
    componentFacetOptions,
    componentPicker,
    COMPONENTS_FULL,
    filterByComponents,
    NO_COMPONENT_OPTIONS,
    STATE_NOTE,
    toggleComponent,
} from '../../src/shell/issue-components';
import { issueDetailView, type IssueDetailInput, TRIAGE_WAITING } from '../../src/shell/issue-detail';

// Issue components on the phone (CB-442): the web's chip words and states,
// the picker's groups and limit, the Board's exact-match facet and its chips,
// the issue page's chips, admin row, history line and triage suggestions, and
// nothing at all from a server before components.

const LABELS: Record<string, IssueComponentLabel> = {
    'plugins:*': { label: 'All plugins', kind: 'plugins', state: 'live' },
    'plugin:forms': { label: 'Forms', kind: 'plugin', state: 'live' },
    'plugin:old': { label: 'Old sync', kind: 'plugin', state: 'uninstalled' },
    'plugin:off': { label: 'Polls', kind: 'plugin', state: 'disabled' },
    'app:crm': { label: 'CRM', kind: 'app', state: 'live', ownerName: 'Ada' },
    'app:gone@7': { label: 'Timesheets', kind: 'app', state: 'deleted', ownerName: 'Ben' },
};

const OPTIONS: IssueComponentOption[] = [
    { ref: 'plugins:*', label: 'All plugins', kind: 'plugins' },
    { ref: 'apps:*', label: 'All apps', kind: 'apps' },
    { ref: 'plugin:forms', label: 'Forms', kind: 'plugin', state: 'live' },
    { ref: 'plugin:off', label: 'Polls', kind: 'plugin', state: 'disabled' },
    { ref: 'app:crm', label: 'CRM', kind: 'app', ownerName: 'Ada' },
];

const list = (options: IssueComponentOption[] | null, more: Partial<{ failed: boolean; settled: boolean }> = {}) => ({
    value: options === null ? null : { options },
    fetchedAt: options === null ? null : 1,
    settled: true,
    failed: false,
    ...more,
});

describe('a component as a chip (the web’s ComponentChip)', () => {
    it('says its state as the web words it, and mutes one that is gone', () => {
        // The web's notes are its en-US words (issues.terms, component.state); a live one has none.
        const web = JSON.parse(
            readFileSync(
                join(import.meta.dirname, '../../../../packages/i18n/locales/en-US/issues.terms.json'),
                'utf8',
            ),
        ) as { component: { state: Record<string, string> } };
        for (const [state, note] of Object.entries(STATE_NOTE)) {
            expect(web.component.state[state] ?? null).toBe(note);
        }
        expect(componentChip('plugin:old', LABELS)).toMatchObject({
            label: 'Old sync',
            gone: true,
            note: '(uninstalled)',
        });
        expect(componentChip('app:gone@7', LABELS)).toMatchObject({
            label: 'Timesheets',
            plugin: false,
            gone: true,
            note: '(deleted)',
            accessibilityLabel: 'Component: Timesheets, owned by Ben, deleted',
        });
        expect(componentChip('plugin:off', LABELS)).toMatchObject({ gone: false, note: '(off)' });
        expect(componentChip('plugin:forms', LABELS)).toMatchObject({ plugin: true, gone: false, note: null });
    });

    it('names a ref from the picker’s options, the wildcards’ fixed names, then only its id', () => {
        expect(componentChip('app:crm', {}, OPTIONS).label).toBe('CRM');
        expect(componentChip('apps:*').label).toBe('All apps');
        expect(componentChip('plugin:unknown').label).toBe('unknown');
    });

    it('shows two on a card, then "+n" with the rest named for screen readers', () => {
        const view = componentChips(['plugin:forms', 'app:crm', 'plugins:*', 'plugin:old'], LABELS);
        expect(view.chips.map((chip) => chip.label)).toEqual(['Forms', 'CRM']);
        expect(view.more).toEqual({ label: '+2', accessibilityLabel: 'And All plugins, Old sync' });
        expect(componentChips(undefined).chips).toEqual([]);
    });
});

describe('the picker (CB-442: All, Plugins, Apps, at most ten)', () => {
    it('groups the options, says an app’s owner and a plugin that is off, and marks the chosen', () => {
        const view = componentPicker({ list: list(OPTIONS), value: ['plugin:forms'], query: '' });
        expect(view.groups.map((group) => group.title)).toEqual(['All', 'Plugins', 'Apps']);
        expect(view.groups[1]!.choices.map((choice) => [choice.label, choice.detail, choice.selected])).toEqual([
            ['Forms', null, true],
            ['Polls', 'off', false],
        ]);
        expect(view.groups[2]!.choices[0]!.detail).toBe('Ada');
        expect(view.line).toBeNull();
        expect(view.searchable).toBe(false);
    });

    it('searches names and owners, accents and case folded', () => {
        expect(componentPicker({ list: list(OPTIONS), value: [], query: 'ada' }).groups).toEqual([
            expect.objectContaining({ title: 'Apps' }),
        ]);
        expect(componentPicker({ list: list(OPTIONS), value: [], query: 'zzz' }).empty).toBe('No matching components.');
    });

    it('keeps a chosen ref no longer offered, by its label, so it can be removed', () => {
        const view = componentPicker({ list: list(OPTIONS), value: ['app:gone@7'], labels: LABELS, query: '' });
        expect(view.others.map((choice) => [choice.label, choice.detail, choice.selected])).toEqual([
            ['Timesheets', '(deleted)', true],
        ]);
    });

    it('takes at most ten: the rest are disabled, and toggling an eleventh changes nothing', () => {
        const ten = Array.from({ length: 10 }, (_, n) => `app:a${n}`);
        const view = componentPicker({ list: list(OPTIONS), value: ten, query: '' });
        expect(view.full).toBe(COMPONENTS_FULL);
        expect(view.groups.flatMap((group) => group.choices).every((choice) => choice.disabled)).toBe(true);
        expect(toggleComponent(ten, 'plugin:forms')).toEqual(ten);
        expect(toggleComponent(ten, 'app:a0')).toEqual(ten.slice(1));
    });

    it('says when there is nothing to choose, or the list couldn’t be read', () => {
        expect(componentPicker({ list: list([]), value: [], query: '' }).line).toBe(NO_COMPONENT_OPTIONS);
        expect(componentPicker({ list: list(OPTIONS, { failed: true }), value: [], query: '' }).line).toBe(
            'Needs a connection',
        );
    });
});

let n = 0;
const summary = (components: string[]): IssueSummary =>
    ({
        number: ++n,
        title: `Issue ${n}`,
        status: 'open',
        priority: 'medium',
        kind: 'bug',
        area: null,
        labels: [],
        assigneeId: null,
        updatedAt: 1,
        excerpt: '',
        votes: 0,
        voted: false,
        components,
    }) as IssueSummary;

describe('the Board (CB-442: the Component facet and the cards’ chips)', () => {
    const issues = [
        summary(['plugin:forms']),
        summary(['plugins:*']),
        summary(['app:crm', 'plugin:forms']),
        summary([]),
    ];
    const board = (components: string[] = []) =>
        boardView({
            issues,
            users: {},
            components: LABELS,
            overlays: [],
            prefs: { ...NO_BOARD_PREFS, column: 'open', components },
            query: '',
        });

    it('offers the refs on listed issues, wildcards first, and matches exactly', () => {
        expect(board().componentFacet.map((option) => option.label)).toEqual(['All plugins', 'Forms', 'CRM']);
        const forms = board(['plugin:forms']);
        expect(forms.rows.map((row) => (row.type === 'issue' ? row.number : null)).sort()).toEqual(
            [issues[0]!.number, issues[2]!.number].sort(),
        );
        expect(forms.countLine).toBe('2 of 4');
        expect(forms.facetCount).toBe(1);
        expect(forms.filtersActive).toBe(true);
        expect(filterByComponents(issues, ['plugins:*'])).toEqual([issues[1]]);
    });

    it('keeps the chosen components with the board’s choices', () => {
        const prefs = { ...NO_BOARD_PREFS, components: toggleComponentFacet([], 'app:crm') };
        expect(readBoardPrefs(boardPrefsText(prefs)).components).toEqual(['app:crm']);
        expect(readBoardPrefs(JSON.stringify({ components: ['nope', 'app:crm', 4] })).components).toEqual(['app:crm']);
        expect(componentFacetOptions([], LABELS, ['app:crm'])).toEqual(['app:crm']);
    });

    it('puts the chips on each row and says them to screen readers', () => {
        const row = board().rows.find((item) => item.type === 'issue' && item.number === issues[2]!.number);
        expect(row?.type === 'issue' && row.components.chips.map((chip) => chip.label)).toEqual(['CRM', 'Forms']);
        expect(row?.type === 'issue' && row.accessibilityLabel).toContain('Components: CRM, Forms');
    });

    it('from a server before components: no facet, no chips', () => {
        const old = boardView({
            issues: [{ ...summary([]), components: undefined } as IssueSummary],
            users: {},
            components: null,
            overlays: [],
            prefs: NO_BOARD_PREFS,
            query: '',
        });
        expect(old.componentFacet).toEqual([]);
        expect(old.rows.every((row) => row.type !== 'issue' || row.components.chips.length === 0)).toBe(true);
    });
});

const T = Date.UTC(2026, 10, 8, 14, 45);
const ADA = 'u-ada';
const BEN = 'u-ben';

function detail(fields: Partial<IssueDetail> = {}): IssueDetail {
    return {
        issue: {
            id: 'i12',
            number: 12,
            title: 'Forms drops answers',
            body: '',
            status: 'triage',
            priority: 'medium',
            kind: 'bug',
            area: null,
            labels: [],
            reporterId: BEN,
            assigneeId: null,
            resolution: null,
            source: 'web',
            createdAt: T,
            updatedAt: T,
            closedAt: null,
            components: ['plugin:forms', 'app:gone@7'],
        },
        comments: [],
        attachments: [],
        events: [
            {
                id: 'e1',
                issueId: 'i12',
                actorId: ADA,
                kind: 'components',
                fromValue: '["app:gone@7"]',
                toValue: '["app:gone@7","plugin:forms"]',
                createdAt: T + 1,
            },
        ],
        users: { [ADA]: 'Ada', [BEN]: 'Ben' },
        components: LABELS,
        ...fields,
    };
}

const input = (fields: Partial<IssueDetailInput> = {}): IssueDetailInput => ({
    key: '12',
    detail: detail(),
    item: { gone: false, settled: true, failed: false, fetchedAt: T },
    overlays: [],
    unsent: [],
    user: { id: BEN, name: 'Ben', role: 'member' },
    me: BEN,
    resolve: () => null,
    timeZone: 'UTC',
    ...fields,
});

describe('the issue page (CB-442)', () => {
    it('shows the components as chips in the fields, after the labels, as the web’s read-only fields', () => {
        const view = issueDetailView(input());
        expect(view.fields.map((field) => field.label)).toEqual([
            'Status',
            'Priority',
            'Kind',
            'Area',
            'Labels',
            'Components',
            'Assignee',
        ]);
        const field = view.fields.find((item) => item.label === 'Components')!;
        expect(field.chips!.map((chip) => [chip.label, chip.note])).toEqual([
            ['Forms', null],
            ['Timesheets', '(deleted)'],
        ]);
        expect(view.admin).toBeNull();
    });

    it('gives an admin a Components row with the chips, the edit’s base the server’s set', () => {
        const admin = issueDetailView(input({ user: { id: ADA, name: 'Ada', role: 'admin' } })).admin!;
        const row = admin.fields.find((field) => field.field === 'components')!;
        expect(row.label).toBe('Components');
        expect(row.chips!.map((chip) => chip.label)).toEqual(['Forms', 'Timesheets']);
        expect(admin.base.components).toEqual(['plugin:forms', 'app:gone@7']);
        expect(admin.fields.map((field) => field.field).indexOf('components')).toBe(
            admin.fields.map((field) => field.field).indexOf('labels') + 1,
        );
    });

    it('marks a pending components edit and shows the new set, a new ref named from the kept options', () => {
        const admin = issueDetailView(
            input({
                user: { id: ADA, name: 'Ada', role: 'admin' },
                options: [{ ref: 'app:crm', label: 'CRM', kind: 'app' }],
                overlays: [
                    {
                        collection: 'issues',
                        key: '12',
                        mode: 'patch',
                        id: 'row-1',
                        state: 'queued',
                        reason: null,
                        createdAt: T + 9,
                        value: { components: ['app:crm'] },
                    },
                ],
            }),
        ).admin!;
        const row = admin.fields.find((field) => field.field === 'components')!;
        expect(row.pending).toBe(true);
        expect(row.chips!.map((chip) => chip.label)).toEqual(['CRM']);
    });

    it('says a components change in the history in the web’s words', () => {
        expect(issueDetailView(input()).history.map((event) => event.text)).toEqual(['added the component Forms']);
        expect(
            componentEventText(
                { fromValue: '["app:crm","plugins:*","plugin:old"]', toValue: '["plugin:forms"]' },
                LABELS,
            ),
        ).toBe('added the component Forms; removed the components CRM, All plugins and Old sync');
        expect(componentEventText({ fromValue: null, toValue: null })).toBe('changed the components');
    });

    it('shows the triage proposal with the suggested components the reader may see', () => {
        const view = issueDetailView(
            input({
                detail: detail({
                    triage: {
                        state: 'proposed',
                        kind: 'bug',
                        area: 'server',
                        priority: 'high',
                        labels: [],
                        components: ['plugin:forms'],
                        reason: 'Suggested from the description.',
                        commentId: null,
                        createdAt: T,
                        decidedAt: null,
                        decidedBy: null,
                    },
                }),
            }),
        );
        expect(view.triage).toMatchObject({ tags: ['Bug', 'Server', 'High'], note: TRIAGE_WAITING, decided: null });
        expect(view.triage!.components.map((chip) => chip.label)).toEqual(['Forms']);
    });

    it('from a server before components: no field, no admin row', () => {
        const old = detail({ components: undefined });
        delete (old.issue as { components?: string[] }).components;
        const member = issueDetailView(input({ detail: old }));
        expect(member.fields.map((field) => field.label)).not.toContain('Components');
        const admin = issueDetailView(input({ detail: old, user: { id: ADA, name: 'Ada', role: 'admin' } })).admin!;
        expect(admin.fields.map((field) => field.field)).not.toContain('components');
    });
});

describe('File an issue (CB-442)', () => {
    it('keeps a box with only components as a draft, and reads them back', () => {
        const text = withIssueField('', { components: ['plugin:forms'] });
        expect(text).not.toBe('');
        expect(issueFormFields(text).components).toEqual(['plugin:forms']);
        expect(withIssueField(text, { components: [] })).toBe('');
    });
});
