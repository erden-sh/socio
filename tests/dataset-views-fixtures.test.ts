// The view contract's fixtures (CB-451), run as the contract
// test the web client and Socio Mobile both run: see
// packages/shared/src/dataset-views/fixtures/types.ts.
import { describe, expect, it } from 'vitest';

import {
    rowChanges,
    rowLookup,
    viewDefinitionResponse,
    viewIndexPage,
    viewListResponse,
    viewRowsPage,
    viewRowsRequest,
} from '@socio/shared/dataset-views/contract';
import { compareRows, matchesFilter, sortIsEvaluable } from '@socio/shared/dataset-views/evaluate';
import { canEditField, readViewDefinition } from '@socio/shared/dataset-views/fallback';
import { BOOKINGS_ROWS, FIXTURE_CONTEXT, VIEW_FIXTURES } from '@socio/shared/dataset-views/fixtures/index';
import { formatCell, sameText } from '@socio/shared/dataset-views/format';
import {
    boardColumns,
    calendarOpening,
    resolveCompact,
    resolveTitleField,
    visibleFields,
} from '@socio/shared/dataset-views/presentation';
import { isStamp, parseStamp } from '@socio/shared/dataset-views/schema';
import { changesAction, planReconcile } from '@socio/shared/dataset-views/sync';

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe.each(VIEW_FIXTURES.map((f) => [f.name, f] as const))('view fixture %s', (_name, fixture) => {
    const ctx = {
        fields: fixture.fields,
        timeZone: FIXTURE_CONTEXT.timeZone,
        me: FIXTURE_CONTEXT.me,
        now: FIXTURE_CONTEXT.now,
    };

    it('is plain JSON, and every answer parses unchanged', () => {
        expect(json(fixture)).toEqual(fixture);
        expect(viewListResponse.parse(json(fixture.list))).toEqual(fixture.list);
        expect(viewDefinitionResponse.parse(json(fixture.definition))).toEqual(fixture.definition);
        expect(viewRowsPage.parse(json(fixture.page))).toEqual(fixture.page);
        expect(viewRowsRequest.safeParse(json(fixture.request)).success).toBe(true);
        expect(isStamp(fixture.page.datasetToken)).toBe(true);
        for (const row of fixture.page.rows) {
            expect(isStamp(row.stamp)).toBe(true);
        }
    });

    it('opens in the expected layout on each client, and round-trips its definition', () => {
        const web = readViewDefinition(json(fixture.definition.view), 'web');
        const phone = readViewDefinition(json(fixture.definition.view), 'phone');
        expect({ layout: web.layout, ...(web.layoutNote ? { note: web.layoutNote } : {}) }).toEqual(fixture.expect.web);
        expect({ layout: phone.layout, ...(phone.layoutNote ? { note: phone.layoutNote } : {}) }).toEqual(
            fixture.expect.phone,
        );
        expect(web.readOnly).toEqual(fixture.expect.readOnly);
        expect(web.unknownOptions).toEqual(fixture.expect.unknownOptions);
        // A draft is the definition read, edited and sent back whole: unknown parts survive.
        expect(JSON.parse(JSON.stringify(web.view))).toEqual(fixture.definition.view);
    });

    it('resolves the title, visible and compact fields, and what may be edited', () => {
        const view = fixture.definition.view;
        expect(resolveTitleField(view, fixture.fields)).toBe(fixture.expect.titleField);
        expect(visibleFields(view, fixture.fields)).toEqual(fixture.expect.visible);
        expect(resolveCompact(view, fixture.fields)).toEqual(fixture.expect.compact);
        expect(fixture.page.compact).toEqual(fixture.expect.compact);
        expect(fixture.page.fields.map((f) => f.field)).toEqual(fixture.expect.visible);
        expect(fixture.fields.filter((f) => canEditField(f, fixture.list.rights)).map((f) => f.field)).toEqual(
            fixture.expect.editable,
        );
    });

    it('filters and orders rows as the server did', () => {
        const query = fixture.definition.view.query;
        const matches = Object.fromEntries(
            BOOKINGS_ROWS.map((row) => [row.key, matchesFilter(row.values, query.filter, ctx) ?? null]),
        );
        expect(matches).toEqual(fixture.expect.matches);
        expect(sortIsEvaluable(query.sort, fixture.fields)).toBe(fixture.expect.sortEvaluable);
        const order = [...BOOKINGS_ROWS].sort((a, b) => compareRows(a, b, query.sort, ctx)).map((r) => r.key);
        expect(order).toEqual(fixture.expect.order);

        if (Object.values(matches).includes(null)) {
            return; // The client can't tell; it reads again online.
        }
        const sent = fixture.page.rows.map((r) => r.key);
        const expected = order.filter((key) => matches[key]);
        if (fixture.page.groups) {
            // A board: each group's rows in view order, every sent row a match.
            for (const group of fixture.page.groups) {
                const inGroup = fixture.page.rows.filter((r) => r.group === group.key).map((r) => r.key);
                expect(inGroup).toEqual(expected.filter((key) => inGroup.includes(key)));
            }
            expect(sent.every((key) => matches[key])).toBe(true);
        } else if (fixture.page.opensAt) {
            expect(sent).toEqual(expected.slice(expected.indexOf(fixture.page.opensAt.row)));
        } else {
            expect(sent).toEqual(expected);
        }
    });

    it('formats every cell it sends', () => {
        const page = fixture.page;
        for (const row of page.rows) {
            for (const field of page.fields) {
                const text = formatCell(row.values[field.field], field, {
                    locale: FIXTURE_CONTEXT.locale,
                    timeZone: FIXTURE_CONTEXT.timeZone,
                    users: page.users,
                    files: page.files,
                });
                const want = fixture.expect.formatted[row.key]?.[field.field];
                expect(want, `${row.key}.${field.field}`).toBeDefined();
                expect(sameText(text, want as string), `${row.key}.${field.field}: ${text} vs ${want}`).toBe(true);
            }
        }
    });

    it.runIf(!!fixture.expect.board)('orders board columns', () => {
        const view = fixture.definition.view;
        const groupField = fixture.fields.find((f) => f.field === view.options.groupField);
        expect(groupField).toBeDefined();
        expect(boardColumns(view, groupField!)).toEqual(fixture.expect.board);
        // The first page sends a group for every column, in that order.
        expect(fixture.page.groups?.map((g) => g.key)).toEqual(fixture.expect.board!.map((c) => c.value));
    });

    it.runIf(!!fixture.expect.calendar)('opens a calendar on the expected range', () => {
        const view = fixture.definition.view;
        expect(calendarOpening(view, 'web')).toBe(fixture.expect.calendar!.web);
        expect(calendarOpening(view, 'phone')).toBe(fixture.expect.calendar!.phone);
        expect(fixture.page.range?.dateField).toBe(view.options.dateField);
    });

    it.runIf(!!fixture.sync)('syncs a cache: changes, then a reconcile after a restore', () => {
        const sync = fixture.sync!;
        for (const answer of Object.values(sync.changes)) {
            expect(rowChanges.parse(json(answer))).toEqual(answer);
        }
        expect(changesAction(sync.changes.apply)).toBe('apply');
        expect(changesAction(sync.changes.reconcile)).toBe('reconcile');
        expect(changesAction(sync.changes.resync)).toBe('resync');
        expect(viewIndexPage.parse(json(sync.index))).toEqual(sync.index);
        expect(rowLookup.parse(json(sync.lookup))).toEqual(sync.lookup);
        const plan = planReconcile(sync.cached, sync.index.entries);
        expect(plan).toEqual(sync.plan);
        expect(sync.lookup.rows.map((r) => r.key)).toEqual(plan.fetch);

        // The rebuilt span is a fresh read: every row matches, in view order.
        const query = fixture.definition.view.query;
        const rebuilt = plan.order.map(
            (key) => sync.lookup.rows.find((r) => r.key === key) ?? BOOKINGS_ROWS.find((r) => r.key === key)!,
        );
        expect(rebuilt.every((r) => matchesFilter(r.values, query.filter, ctx) === true)).toBe(true);
        expect([...rebuilt].sort((a, b) => compareRows(a, b, query.sort, ctx)).map((r) => r.key)).toEqual(plan.order);

        // Stamps agree with the token: the current generation's are at most the token, and every
        // row carried over from an older generation is at or below the restore point, which every
        // stamp of the current generation is at or above.
        const token = parseStamp(sync.index.datasetToken)!;
        const stamps = sync.index.entries.map((e) => parseStamp(e.stamp)!);
        const current = stamps.filter((s) => s.generation === token.generation).map((s) => s.value);
        const older = stamps.filter((s) => s.generation !== token.generation).map((s) => s.value);
        expect(current.every((v) => v <= token.value)).toBe(true);
        expect(Math.max(...older)).toBeLessThanOrEqual(Math.min(...current, token.value));
        for (const row of sync.lookup.rows) {
            expect(row.stamp).toBe(sync.index.entries.find((e) => e.key === row.key)?.stamp);
        }
    });
});
