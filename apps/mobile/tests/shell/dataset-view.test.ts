import { describe, expect, it } from 'vitest';

import type { ViewRowsRequest } from '@socio/shared/dataset-views/contract';
import {
    BOARD_FIXTURE,
    CALENDAR_FIXTURE,
    FIXTURE_CONTEXT,
    GALLERY_FIXTURE,
    LIST_FIXTURE,
    TABLE_FIXTURE,
    UNKNOWN_FIXTURE,
    VIEW_FIXTURES,
} from '@socio/shared/dataset-views/fixtures/index';
import { sameText } from '@socio/shared/dataset-views/format';

import {
    boardView,
    calendarEntries,
    calendarRange,
    calendarTitle,
    columnPicker,
    emptyColumn,
    columnValue,
    conditionText,
    editText,
    fieldEditor,
    firstRequest,
    filterDraft,
    filterNode,
    moveTargets,
    openView,
    operatorChoices,
    paletteTone,
    parseEdit,
    phoneCalendarOpening,
    phoneOrder,
    recordView,
    rowCard,
    stepCalendar,
    tableView,
    toggledOption,
    withColumnHidden,
    withFieldHidden,
    withPriority,
    withQuery,
} from '../../src/shell/dataset-view';
import { createFixtureViewSource, FIXTURE_REF } from '../../src/sync/fixture-source';

// A dataset view on the phone (CB-469), held to the shared contract fixtures
// (CB-451): every fixture opens in the phone's layout with its note,
// the fixture source answers each as its fixture says and computes the same
// rows itself, and the layouts' models keep full parity (every field, every
// board column, every calendar range), with drafts that keep unknown parts.

const format = { timeZone: FIXTURE_CONTEXT.timeZone };
const fixtureRequest = (request: ViewRowsRequest) => request;

describe('every contract fixture on the phone', () => {
    for (const fixture of VIEW_FIXTURES) {
        it(`${fixture.name}: opens as the phone reads it, with the fixture's page`, async () => {
            const source = createFixtureViewSource();
            const list = await source.list(FIXTURE_REF);
            const definition = await source.definition(FIXTURE_REF, fixture.definition.view.id);
            const page = await source.rows(FIXTURE_REF, fixture.definition.view.id, fixtureRequest(fixture.request));
            expect(page).toEqual(fixture.page);
            const opened = openView(list, definition.view, page, definition.skipped);
            expect(opened.layout).toBe(fixture.expect.phone.layout);
            if (fixture.expect.phone.note !== undefined) {
                expect(opened.notes).toContain(fixture.expect.phone.note);
            }
            expect(opened.compact).toEqual(fixture.expect.compact);
            expect(opened.visible).toEqual(fixture.expect.visible);
            expect(opened.titleField).toBe(fixture.expect.titleField);
            // Every page row's every visible field reaches a card: the lead, or the rest once expanded.
            for (const row of page.rows) {
                const card = rowCard(row, opened, page, format);
                const shown = [card.title, ...card.lead.map((f) => f.text), ...card.more.map((f) => f.text)];
                for (const [field, text] of Object.entries(fixture.expect.formatted[row.key] ?? {})) {
                    if (text === '' || field === 'secret') {
                        continue;
                    }
                    expect(
                        shown.some((s) => sameText(s, text)),
                        `${row.key}.${field}`,
                    ).toBe(true);
                }
            }
        });
    }

    it('reads the first page as each fixture does: a table’s and gallery’s size, a date-ordered list at today', () => {
        expect(firstRequest(TABLE_FIXTURE.definition.view, 'table', null)).toEqual(TABLE_FIXTURE.request);
        expect(firstRequest(GALLERY_FIXTURE.definition.view, 'gallery', null)).toEqual(GALLERY_FIXTURE.request);
        expect(firstRequest(LIST_FIXTURE.definition.view, 'list', null)).toEqual(LIST_FIXTURE.request);
        expect(firstRequest(BOARD_FIXTURE.definition.view, 'board', null)).toEqual(BOARD_FIXTURE.request);
        expect(firstRequest(CALENDAR_FIXTURE.definition.view, 'calendar', CALENDAR_FIXTURE.request.range!)).toEqual(
            CALENDAR_FIXTURE.request,
        );
    });

    for (const fixture of [TABLE_FIXTURE, LIST_FIXTURE, BOARD_FIXTURE, CALENDAR_FIXTURE, GALLERY_FIXTURE]) {
        it(`${fixture.name}: computes the fixture's rows itself once a draft is in play`, async () => {
            const source = createFixtureViewSource();
            const id = fixture.definition.view.id;
            await source.saveDraft(FIXTURE_REF, id, fixture.definition.view, fixture.definition.view.version);
            const page = await source.rows(FIXTURE_REF, id, fixture.request);
            expect(page.draftUsed).toBe(true);
            expect(page.rows.map((row) => row.key)).toEqual(fixture.page.rows.map((row) => row.key));
            expect(page.compact).toEqual(fixture.page.compact);
            if (fixture.page.totals !== undefined) {
                expect(page.totals).toEqual(fixture.page.totals);
            }
            if (fixture.page.groups !== undefined) {
                expect(page.groups?.map((g) => [g.key, g.count, g.folded])).toEqual(
                    fixture.page.groups.map((g) => [g.key, g.count, g.folded]),
                );
            }
        });
    }
});

describe('the table', () => {
    it('leads with the priority fields, keeps the title as its sticky column and totals every matching row', async () => {
        const source = createFixtureViewSource();
        const list = await source.list(FIXTURE_REF);
        const page = TABLE_FIXTURE.page;
        const opened = openView(list, TABLE_FIXTURE.definition.view, page);
        const table = tableView(page, opened, format);
        expect(table.sticky?.field).toBe('title');
        expect(table.columns.map((c) => c.field)).toEqual([
            'room',
            'starts_at',
            'amount',
            'done',
            'owner',
            'tags',
            'photo',
        ]);
        expect(table.rows.map((r) => r.first)).toEqual(['Standup', 'Retro', 'Offsite', 'lunch']);
        expect(table.totals?.cells[2]).toBe('Sum $1,149.50');
        expect(table.totals?.cells[4]).toBe('Filled 3');
        expect(phoneOrder(opened)).toEqual(['title', 'room', 'starts_at', 'amount', 'done', 'owner', 'tags', 'photo']);
    });
});

describe('the board', () => {
    const opened = openView(BOARD_FIXTURE.list, BOARD_FIXTURE.definition.view, BOARD_FIXTURE.page);

    it('lists every column in the view’s order, hidden ones too, and swipes between the visible ones', () => {
        const board = boardView(BOARD_FIXTURE.page, opened, format, undefined);
        expect(board.columns.map((c) => [c.key, c.hidden, c.count])).toEqual([
            ['opt_b', false, 0],
            [null, false, 1],
            ['opt_a', true, 1],
            ['opt_c', false, 1],
        ]);
        expect(board.swipeable.map((c) => c.key)).toEqual(['opt_b', null, 'opt_c']);
        // It opens on the first visible column with cards: Room B leads with none.
        expect(board.focus).toBe(1);
        expect(board.cards).toHaveLength(1);
        expect(boardView(BOARD_FIXTURE.page, opened, format, 'opt_b').cards).toEqual([]);
        expect(emptyColumn('Room B')).toBe('Nothing in Room B.');
        expect(columnPicker(board).hidden.map((c) => c.label)).toEqual(['Room A']);
        expect(board.columns.find((c) => c.key === 'opt_a')?.total).toBe('Sum $125.50');
    });

    it('focuses any column, a hidden one with its own rows, and moves a card to every column', async () => {
        const roof = boardView(BOARD_FIXTURE.page, opened, format, 'opt_c');
        expect(roof.cards.map((c) => c.key)).toEqual(['"b5"']);
        expect(roof.cards[0]?.lead.map((f) => f.text)).toEqual(['Cam Lee']);
        const source = createFixtureViewSource();
        const hidden = await source.rows(FIXTURE_REF, 'v_board', { schema: 1, group: 'opt_a' });
        const roomA = boardView(BOARD_FIXTURE.page, opened, format, 'opt_a', hidden.rows);
        expect(roomA.swipeable.map((c) => c.key)).toEqual(['opt_b', null, 'opt_c', 'opt_a']);
        expect(roomA.cards.map((c) => c.key)).toEqual(['"b1"']);
        expect(moveTargets(roomA, 'opt_a').map((t) => [t.key, t.checked])).toEqual([
            ['opt_b', false],
            [null, false],
            ['opt_a', true],
            ['opt_c', false],
        ]);
        const room = BOARD_FIXTURE.list.fields.find((f) => f.field === 'room')!;
        expect(columnValue(null, room)).toBeNull();
        expect(columnValue('opt_b', room)).toBe('opt_b');
    });

    it('shows a hidden column again as a draft that lists every column', () => {
        const board = boardView(BOARD_FIXTURE.page, opened, format, undefined);
        const next = withColumnHidden(BOARD_FIXTURE.definition.view, board, 'opt_a', false);
        expect(next.options.columns).toEqual([
            { value: 'opt_b' },
            { value: null },
            { value: 'opt_a' },
            { value: 'opt_c' },
        ]);
    });
});

describe('the calendar', () => {
    it('opens on the day on a phone, and reads only the visible range of each mode (at most 92 days)', () => {
        expect(phoneCalendarOpening(CALENDAR_FIXTURE.definition.view)).toBe('day');
        expect(calendarRange('day', '2026-11-25')).toEqual({ from: '2026-11-25', to: '2026-11-25' });
        expect(calendarRange('week', '2026-11-25')).toEqual({ from: '2026-11-22', to: '2026-11-28' });
        expect(calendarRange('month', '2026-11-25')).toEqual({ from: '2026-11-01', to: '2026-12-12' });
        expect(calendarRange('agenda', '2026-11-25')).toEqual({ from: '2026-11-25', to: '2026-12-24' });
        expect(stepCalendar('month', '2026-11-25', 1)).toBe('2026-12-01');
        expect(stepCalendar('week', '2026-11-25', -1)).toBe('2026-11-18');
        expect(calendarTitle('week', '2026-11-25')).toBe('Nov 22 – Nov 28');
    });

    it('places entries by the answer’s date and end fields, in the viewer’s zone', async () => {
        const source = createFixtureViewSource();
        const page = await source.rows(FIXTURE_REF, 'v_calendar', {
            schema: 1,
            range: calendarRange('week', '2026-11-23'),
        });
        const opened = openView(CALENDAR_FIXTURE.list, CALENDAR_FIXTURE.definition.view, page);
        const entries = calendarEntries(page, opened, format);
        const standup = entries.find((e) => e.card.key === '"b1"')!;
        expect(standup).toMatchObject({
            startDay: '2026-11-23',
            startMinute: 9 * 60,
            endMinute: 9 * 60 + 30,
            multiDay: false,
        });
        expect(entries.map((e) => e.card.key).sort()).toEqual(['"b1"', '"b2"', '"b5"']);
    });
});

describe('the record sheet and its editing', () => {
    const page = TABLE_FIXTURE.page;
    const opened = openView(TABLE_FIXTURE.list, TABLE_FIXTURE.definition.view, page);

    it('shows every field, the hidden ones under More fields, each with the contract’s edit shape', () => {
        const record = recordView(page.rows[0]!, opened, TABLE_FIXTURE.list.rights, page, format);
        expect(record.title).toBe('Standup');
        expect(record.fields.map((f) => f.field)).toEqual(phoneOrder(opened));
        expect(record.more.map((f) => f.field)).toEqual([
            'id',
            'ends_at',
            'day',
            'share',
            'guests',
            'team',
            'notes',
            'meta',
        ]);
        const editor = (name: string) => [...record.fields, ...record.more].find((f) => f.field === name)!.editor.kind;
        expect([editor('title'), editor('room'), editor('done'), editor('tags'), editor('owner')]).toEqual([
            'text',
            'select',
            'checkbox',
            'multi',
            'person',
        ]);
        expect([editor('id'), editor('meta')]).toEqual(['readonly', 'readonly']);
        const readOnly = recordView(page.rows[0]!, opened, { write: false }, page, format);
        expect(readOnly.fields.every((f) => f.editor.kind === 'readonly')).toBe(true);
    });

    it('parses typed values by kind', () => {
        expect(parseEdit('1,250', { kind: 'number' })).toEqual({ ok: true, value: 1250 });
        expect(parseEdit('x', { kind: 'number' }).ok).toBe(false);
        expect(parseEdit('2026-02-30', { kind: 'date', time: false }).ok).toBe(false);
        expect(parseEdit('2026-12-01', { kind: 'date', time: false })).toEqual({ ok: true, value: '2026-12-01' });
        expect(parseEdit('2026-12-01 15:00', { kind: 'date', time: true })).toEqual({
            ok: true,
            value: '2026-12-01T15:00:00.000Z',
        });
        expect(editText('2026-11-23T14:00:00Z', { kind: 'date', time: true })).toBe('2026-11-23 14:00');
        expect(toggledOption(['t_x'], 't_y')).toEqual(['t_x', 't_y']);
        expect(toggledOption('["t_x","t_y"]', 't_x')).toEqual(['t_y']);
        expect(
            fieldEditor(
                UNKNOWN_FIXTURE.list.fields.find((f) => f.field === 'rating')!,
                { write: true },
            ),
        ).toEqual({
            kind: 'readonly',
        });
    });

    it('saves a cell as compare-and-set: a stale value is a conflict with the current one', async () => {
        const source = createFixtureViewSource();
        expect(await source.editCell(FIXTURE_REF, '"b1"', { field: 'title', from: 'Old', to: 'New' })).toMatchObject({
            outcome: 'conflict',
            conflict: { code: 'cell_conflict', field: 'title', current: 'Standup', row: { key: '"b1"' } },
        });
        const saved = await source.editCell(FIXTURE_REF, '"b1"', { field: 'title', from: 'Standup', to: 'Daily' });
        expect(saved).toMatchObject({ outcome: 'saved', written: { row: { values: { title: 'Daily' } } } });
        const page = await source.rows(FIXTURE_REF, 'v_table', TABLE_FIXTURE.request);
        expect(page.rows[0]?.values.title).toBe('Daily');
        expect(page.rows[0]?.stamp).not.toBe(TABLE_FIXTURE.page.rows[0]?.stamp);
    });
});

describe('the sheets’ drafts', () => {
    it('edits the filter one level deep, with every operator of the kind, and applies it', async () => {
        const view = TABLE_FIXTURE.definition.view;
        const draft = filterDraft(view.query.filter);
        expect(draft).toEqual({
            mode: 'all',
            conditions: [{ field: 'room', op: 'is_not', value: 'opt_b' }],
            nested: false,
        });
        const fields = new Map(TABLE_FIXTURE.list.fields.map((f) => [f.field, f]));
        expect(conditionText(draft.conditions[0]!, fields)).toBe('Room is not Room B');
        const room = fields.get('room')!;
        expect(operatorChoices(room).map((o) => o.op)).toEqual([
            'is',
            'is_not',
            'is_any_of',
            'is_none_of',
            'is_empty',
            'is_not_empty',
        ]);
        const next = withQuery(view, {
            filter: filterNode({ mode: 'all', conditions: [{ field: 'room', op: 'is', value: 'opt_b' }] })!,
        });
        const source = createFixtureViewSource();
        await source.saveDraft(FIXTURE_REF, 'v_table', next, view.version);
        const page = await source.rows(FIXTURE_REF, 'v_table', TABLE_FIXTURE.request);
        expect(page.rows.map((r) => r.key)).toEqual(['"b2"']);
        expect((await source.definition(FIXTURE_REF, 'v_table')).draft?.definition.query.filter).toEqual({
            field: 'room',
            op: 'is',
            value: 'opt_b',
        });
        await source.dropDraft(FIXTURE_REF, 'v_table');
        expect((await source.rows(FIXTURE_REF, 'v_table', TABLE_FIXTURE.request)).rows).toHaveLength(4);
    });

    it('keeps the parts this client can’t read when it changes another part', () => {
        const view = UNKNOWN_FIXTURE.definition.view;
        const opened = openView(UNKNOWN_FIXTURE.list, view, null);
        expect(opened.reading.readOnly.filter).toBe(true);
        const next = withFieldHidden(withQuery(view, { sort: [{ field: 'title', dir: 'desc' }] }), 'mood', true);
        expect(next.query.filter).toEqual(view.query.filter);
        expect(next.query.groupBy).toEqual(view.query.groupBy);
        expect((next.query as Record<string, unknown>).pivot).toEqual({ by: 'room' });
        expect(next.options).toEqual(view.options);
        expect((next as Record<string, unknown>).color).toBe('teal');
        expect(next.fields.find((f) => f.field === 'title')).toEqual({ field: 'title', pin: true });
    });

    it('sets "Show first on small screens" as the next priority, and a hidden field drops its priority', () => {
        const view = LIST_FIXTURE.definition.view;
        const first = withPriority(view, 'room', true);
        expect(first.fields.find((f) => f.field === 'room')?.priority).toBe(3);
        const hidden = withFieldHidden(first, 'title', true);
        expect(hidden.fields.find((f) => f.field === 'title')).toEqual({ field: 'title', hidden: true });
        expect(filterDraft({ any: [{ field: 'a', op: 'is_empty' }, { all: [] }] } as never)).toMatchObject({
            mode: 'any',
            nested: true,
        });
        expect(paletteTone('blue')).toBe('sky');
        expect(paletteTone('glitter')).toBe('slate');
    });
});
