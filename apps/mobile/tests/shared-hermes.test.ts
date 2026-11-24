import { afterEach, describe, expect, it } from 'vitest';

import { approvalAsk, carryingOn, decidedOnCard, mustOpenFirst } from '@socio/shared/approvals-view';
import { compareBoardOrder, filterIssues, NO_FILTERS } from '@socio/shared/issues/issue-board';
import type { IssueSummary } from '@socio/shared/issues/issue-types';
import { personTones } from '@socio/shared/rooms/room-speakers';
import { answeringSocios, messageTargets, problemText, targetsLine } from '@socio/shared/rooms/room-view';
import type { RoomSocioView } from '@socio/shared/rooms/rooms';
import { searchCommands } from '@socio/shared/search/rank';
import { ianaTimeZone } from '@socio/shared/time-zone';

// Hermes, which runs the app, has no Intl.supportedValuesOf, so the socio/hermes
// lint rule flags it (scripts/lint/socio-rules.mjs). Shared's time-zone code
// checks for it before the call; this runs that code with it gone.
describe('shared’s time zones without Intl.supportedValuesOf, as on Hermes', () => {
    const original = Object.getOwnPropertyDescriptor(Intl, 'supportedValuesOf');
    afterEach(() => {
        if (original) {
            Object.defineProperty(Intl, 'supportedValuesOf', original);
        }
    });

    it('still takes zone names, and gives a link in lower case the zone it resolves to', () => {
        expect(original).toBeDefined();
        Reflect.deleteProperty(Intl, 'supportedValuesOf');
        expect('supportedValuesOf' in Intl).toBe(false);
        expect(ianaTimeZone('America/New_York')).toBe('America/New_York');
        expect(ianaTimeZone(' america/new_york ')).toBe('America/New_York');
        expect(ianaTimeZone('US/Eastern')).toBe('US/Eastern');
        expect(ianaTimeZone('us/eastern')).toBe('America/New_York');
        expect(ianaTimeZone('Mars/Olympus_Mons')).toBeUndefined();
    });
});

// The board's filter and sort on what Hermes has: the search folds
// case and accents with normalize('NFKD') and \p{M} (shared's foldText),
// and neither may reach for the array methods Hermes lacks.
describe('the board’s filter and sort without Array#toSorted, toReversed or toSpliced, as on Hermes', () => {
    const methods = ['toSorted', 'toReversed', 'toSpliced'] as const;
    const originals = methods.map((name) => [name, Object.getOwnPropertyDescriptor(Array.prototype, name)] as const);
    afterEach(() => {
        for (const [name, descriptor] of originals) {
            if (descriptor) {
                Object.defineProperty(Array.prototype, name, descriptor);
            }
        }
    });

    const row = (number: number, fields: Partial<IssueSummary> = {}): IssueSummary => ({
        number,
        title: `Issue ${number}`,
        status: 'open',
        priority: 'medium',
        kind: 'bug',
        area: null,
        labels: [],
        assigneeId: null,
        updatedAt: 1,
        excerpt: '',
        ...fields,
    });

    it('folds case and accents in the search, and sorts in the server’s order', () => {
        for (const name of methods) {
            Reflect.deleteProperty(Array.prototype, name);
            expect(name in []).toBe(false);
        }
        const issues = [
            row(1, { title: 'Café menu', priority: 'low' }),
            row(2, { title: 'ÉCOLE', excerpt: 'Ñandú crossing', priority: 'critical' }),
            row(3, { title: 'Résumé upload', updatedAt: 5 }),
            row(4, { title: 'cafe hours', updatedAt: 5 }),
        ];
        const numbers = (q: string) => filterIssues(issues, { ...NO_FILTERS, q }).map((issue) => issue.number);
        expect(numbers('CAFE')).toEqual([1, 4]);
        expect(numbers('café')).toEqual([1, 4]);
        expect(numbers('ecole nandu')).toEqual([2]);
        expect(numbers('resume')).toEqual([3]);
        expect(numbers('cb-4')).toEqual([4]);
        expect([...issues].sort(compareBoardOrder).map((issue) => issue.number)).toEqual([2, 4, 3, 1]);
    });
});

// The approval rules lower a label with toLocaleLowerCase and the
// app's locale, which Hermes has; nothing else beyond plain JavaScript.
describe('shared’s approval rules, as the app runs them', () => {
    it('import into the app and give what is asked as data', () => {
        expect(approvalAsk({ dotName: 'Ada', capabilityLabel: 'Create a schedule' })).toEqual({
            socio: 'Ada',
            capability: 'create a schedule',
        });
        expect(mustOpenFirst({ review: { mustOpen: true, opened: false } })).toBe(true);
        expect(decidedOnCard(null)).toBe(false);
        expect(carryingOn({ continuation: { status: 'running', id: null, detail: null, waitingFor: 0 } })).toBe(true);
    });
});

// The palette's ranking folds text with shared's foldText:
// String.prototype.normalize('NFKD') and the \p{M} property escape, both in
// Hermes. It needs no Intl.Segmenter, which Hermes lacks; this runs it with it gone.
describe('shared’s palette ranking without Intl.Segmenter, as on Hermes', () => {
    const original = Object.getOwnPropertyDescriptor(Intl, 'Segmenter');
    afterEach(() => {
        if (original) {
            Object.defineProperty(Intl, 'Segmenter', original);
        }
    });

    it('matches across case and accents, composed or not, and ranks the exact key first', () => {
        Reflect.deleteProperty(Intl, 'Segmenter');
        expect('Segmenter' in Intl).toBe(false);
        const entries = [
            { label: 'Crash in CB-120 export', hint: 'CB-120', group: 'Issues' },
            { label: 'Login fails on Safari', hint: 'CB-12', group: 'Issues' },
            { label: 'Cafe\u0301 notes', group: 'Pages' },
            { label: 'Résumé', group: 'Pages' },
        ];
        const labels = (query: string) => searchCommands(entries, query).map((entry) => entry.label);
        expect(labels('cb-12')).toEqual(['Login fails on Safari', 'Crash in CB-120 export']);
        expect(labels('CAFÉ')).toEqual(['Cafe\u0301 notes']);
        expect(labels('resume')).toEqual(['Résumé']);
    });
});

// The room view rules sort copies, and word an unanswered turn from
// its code with shared's table: nothing beyond plain JavaScript. This runs
// them with the array methods Hermes lacks gone.
describe('shared’s room view rules without Array#toSorted, toReversed or toSpliced, as on Hermes', () => {
    const methods = ['toSorted', 'toReversed', 'toSpliced'] as const;
    const originals = methods.map((name) => [name, Object.getOwnPropertyDescriptor(Array.prototype, name)] as const);
    afterEach(() => {
        for (const [name, descriptor] of originals) {
            if (descriptor) {
                Object.defineProperty(Array.prototype, name, descriptor);
            }
        }
    });

    it('routes a message, tones same-named people and words a failed turn', () => {
        for (const name of methods) {
            Reflect.deleteProperty(Array.prototype, name);
            expect(name in []).toBe(false);
        }
        const socios: RoomSocioView[] = [
            { dotId: 'd2', name: 'Manny', status: 'active', lead: false },
            { dotId: 'd1', name: 'Sebas', status: 'active', lead: true },
        ];
        expect(answeringSocios(socios).map((socio) => socio.name)).toEqual(['Sebas', 'Manny']);
        expect(targetsLine(messageTargets('@Manny then @Sebas', socios))).toBe('Manny, then Sebas');
        const tones = personTones(
            [
                { id: 'b', name: 'Ana' },
                { id: 'a', name: 'Ana' },
            ],
            6,
        );
        expect(tones.get('b')).toBe(((tones.get('a') ?? 0) + 1) % 6);
        expect(
            problemText({ runId: 'r', status: 'failed', code: 'cycle_tokens', author: { name: 'Ben', you: false } }),
        ).toBe(
            'Ben’s message wasn’t answered: It used the most model tokens one message may use, so the socio stopped.',
        );
        expect(problemText({ runId: 'r', status: 'failed', author: { name: 'Ben', you: false } })).toBe(
            'Ben’s message wasn’t answered: The socio couldn’t finish this turn.',
        );
    });
});
