import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { ScheduleView } from '@socio/shared/schedule-types';
import type { Task } from '@socio/shared/types';

import {
    ACTIVITY_HEADING,
    activityRows,
    ANY_SCHEDULE,
    DELETED_SOCIO,
    filterButtonLabel,
    matchesSchedule,
    SCHEDULE_SEARCH_LABEL,
    SCHEDULE_STATUS_OPTIONS,
    scheduleSocioOptions,
    taskStatusTone,
} from '../../src/shell/schedules';

// Batch A of the 2026-11-18 parity audit (CB-401): the module pages' big
// titles beside their tone tiles through PageHeader, the neutral tabs and
// filters, Schedules' search and filters and a task's status in its tone.
// The screens draw on React Native, so
// they're read as source; the view models run under Node.

const read = (file: string) => readFileSync(new URL(`../../src/screens/${file}`, import.meta.url), 'utf8');

describe('the module pages’ headers (CB-420)', () => {
    const HEADINGS: readonly (readonly [string, string, string])[] = [
        ['approvals.tsx', 'approvals-heading', 'MODULE.title'],
        ['memories.tsx', 'memories-heading', 'MODULE.title'],
        ['learning.tsx', 'learning-heading', 'moduleTitle(MODULE, admin)'],
        ['activity.tsx', 'activity-heading', 'ACTIVITY_TITLE'],
        ['schedules.tsx', 'schedules-heading', 'SCHEDULES_TITLE'],
        ['runs.tsx', 'runs-heading', 'RUNS_TITLE'],
        ['spaces.tsx', 'spaces-heading', 'SPACES.title'],
    ];

    it.each(HEADINGS)(
        '%s names itself in the bar’s large title, in its tone, with its line and tile under it',
        (file, testID, title) => {
            const screen = read(file);
            const escaped = title.replace(/[{}().]/g, '\\$&');
            expect(screen).toMatch(
                new RegExp(`useNativeBar\\(\\{\\s+title: ${escaped},\\s+tone: (MODULE|SPACES)\\.tone`),
            );
            const intro = new RegExp(
                `<PageIntro\\s+[^>]*?tile=\\{\\{ tone: (MODULE|SPACES)\\.tone, icon: MODULE_ICONS\\[(MODULE|SPACES)\\.icon\\] \\}\\}\\s+testID="${testID}"`,
                's',
            );
            expect(screen).toMatch(intro);
            // No drawn header, and no second, 24 pt title in the page.
            expect(screen).not.toContain('HeaderBar');
            expect(screen).not.toContain('<PageHeader');
        },
    );

    it('gives each page the web’s words', () => {
        expect(ACTIVITY_HEADING).toBe('A little follow-through.');
        expect(read('learning.tsx')).toContain("(admin ? 'What your socios are learning.' : 'Skills.')");
        expect(read('approvals.tsx')).toMatch(/APPROVALS_INTRO =\s*'Actions with side effects wait for you:/);
    });
});

describe('the tabs and filters', () => {
    it.each(['schedules.tsx', 'space.tsx', 'space-sections.tsx', 'settings.tsx'])(
        '%s takes the platform’s segmented control, never a drawn one',
        (file) => {
            const screen = read(file);
            expect(screen).toContain('<SegmentedControl');
            expect(screen).not.toContain("? 'bg-accent' : 'bg-transparent active:bg-accent/50'");
            expect(screen).not.toContain('accessibilityRole="tablist"');
        },
    );

    it('gives Runs’ six filters a menu with the one shown checked, not tabs', () => {
        const runs = read('runs.tsx');
        expect(runs).toContain('trigger="press"');
        expect(runs).toContain('checked: filter === item.value');
        expect(runs).not.toContain('accessibilityRole="tablist"');
    });
});

const schedule = (fields: Partial<ScheduleView>): ScheduleView =>
    ({
        id: 's1',
        title: 'Weekly digest',
        status: 'scheduled',
        dotId: 'd-sebas',
        dotName: 'Sebas',
        jobName: null,
        ...fields,
    }) as ScheduleView;

describe('Schedules’ search and filters', () => {
    const rows = [
        schedule({ id: 'a', title: 'Weekly digest', dotId: 'd-sebas', dotName: 'Sebas' }),
        schedule({ id: 'b', title: 'Daily numbers', dotId: 'd-mingo', dotName: 'Mingo', status: 'paused' }),
        schedule({ id: 'c', title: 'Backup', dotId: null, dotName: null, jobName: 'nightly-export' }),
    ];
    const shown = (filter: Partial<typeof ANY_SCHEDULE>) =>
        rows.filter((row) => matchesSchedule(row, { ...ANY_SCHEDULE, ...filter })).map((row) => row.id);

    it('matches the title, socio or job, in any case', () => {
        expect(SCHEDULE_SEARCH_LABEL).toBe('Search title, socio or job');
        expect(shown({})).toEqual(['a', 'b', 'c']);
        expect(shown({ query: ' DIGEST ' })).toEqual(['a']);
        expect(shown({ query: 'mingo' })).toEqual(['b']);
        expect(shown({ query: 'export' })).toEqual(['c']);
    });

    it('narrows by status and by socio, a deleted one included', () => {
        expect(shown({ status: 'paused' })).toEqual(['b']);
        expect(shown({ socio: 'd-sebas' })).toEqual(['a']);
        expect(shown({ socio: DELETED_SOCIO })).toEqual(['c']);
        expect(shown({ status: 'paused', socio: 'd-sebas' })).toEqual([]);
    });

    it('offers the web’s choices and says what each button holds', () => {
        expect(SCHEDULE_STATUS_OPTIONS.map((option) => option.label)).toEqual([
            'Status: any',
            'Active',
            'Running',
            'Queued',
            'Paused',
            'Stopped',
            'Interrupted',
            'Completed',
            'Canceled',
        ]);
        const socios = scheduleSocioOptions(rows);
        expect(socios).toEqual([
            { value: '', label: 'Socio: any' },
            { value: DELETED_SOCIO, label: 'A deleted socio' },
            { value: 'd-mingo', label: 'Mingo' },
            { value: 'd-sebas', label: 'Sebas' },
        ]);
        expect(filterButtonLabel('Status', SCHEDULE_STATUS_OPTIONS, '')).toBe('Status: any');
        expect(filterButtonLabel('Status', SCHEDULE_STATUS_OPTIONS, 'scheduled')).toBe('Status: Active');
        expect(filterButtonLabel('Socio', socios, 'd-mingo')).toBe('Socio: Mingo');
    });

    it('shows them over the list on the screen, with the web’s line when nothing matches', () => {
        const screen = read('schedules.tsx');
        expect(screen).toContain('data.shown.schedules.filter((schedule) => matchesSchedule(schedule, filter))');
        expect(screen).toMatch(/<SearchField\s+label=\{SCHEDULE_SEARCH_LABEL\}/);
        expect(screen).toContain('testID="schedules-status-filter"');
        expect(screen).toContain('testID="schedules-socio-filter"');
        expect(screen).toContain('{NO_SCHEDULES_MATCH}');
        // Each filter is a pop-up button: the system's menu (CB-421), the value held checked.
        expect(screen).toContain('<ActionMenu request={props.menu} trigger="press"');
        expect(screen).toContain('checked: option.value === value,');
    });
});

describe('a task’s status in its tone', () => {
    const task = (fields: Partial<Task>): Task =>
        ({
            id: 't1',
            prompt: 'Post the daily sales numbers',
            status: 'completed',
            intervalSeconds: 86_400,
            nextRunAt: 1,
            updatedAt: 0,
            ...fields,
        }) as Task;

    it('reads Scheduled in emerald, as the web’s chip', () => {
        const [row] = activityRows([task({})], '', 60_000);
        expect(row).toMatchObject({ status: 'Scheduled', statusTone: 'emerald' });
        expect(taskStatusTone('running')).toBe('indigo');
        expect(taskStatusTone('failed')).toBe('rose');
        expect(taskStatusTone('interrupted')).toBe('rose');
        expect(taskStatusTone('paused')).toBe('amber');
        expect(taskStatusTone('cancelled')).toBeNull();
    });

    it('draws the tone on the list’s chip, its word always shown', () => {
        const screen = read('activity.tsx');
        expect(screen).toContain('trailing={<TaskStatus word={row.status} tone={row.statusTone} />}');
        expect(screen).toContain('const { foreground, tint } = colors.tones[tone];');
    });
});
