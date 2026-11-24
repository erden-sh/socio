import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { GoalView, ScheduleView } from '@socio/shared/schedule-types';
import type { Conversation, Dot, DotRun, State } from '@socio/shared/types';

import { tabRoot } from '../../src/navigation/presets';
import { ROUTES } from '../../src/navigation/routes';
import { socioAction } from '../../src/navigation/tabs';
import type { AuthedFetch } from '../../src/net/authed-fetch';
import { NetworkError } from '../../src/net/errors';
import { NO_INSTRUCTIONS } from '../../src/shell/home';
import {
    SOCIO_CHATS_SHOWN,
    SOCIO_RUNS_OFFLINE,
    type SocioPageView,
    socioPage,
    socioStatusLine,
} from '../../src/shell/socio';
import { readSocioRuns, socioRunsPath } from '../../src/sync/socio-runs';
import { SYMBOLS } from '../../src/ui/symbols';

// CB-431: a socio's page (the web's DotHome, `/dots/:dotId`), Home's socio rows
// that open it with their own compose button beside them, and Home's native
// bar with New chat in it instead of the teal pill.

const src = (file: string) => readFileSync(join(import.meta.dirname, '../../src', file), 'utf8');

const NOW = Date.UTC(2026, 10, 19, 15, 0);
const MIN = 60_000;

const dot = (id: string, fields: Partial<Dot> = {}) =>
    ({ id, name: id === 'd1' ? 'Sebas' : 'Librarian', instructions: 'Be helpful.', createdAt: 1, ...fields }) as Dot;

const chat = (id: string, fields: Partial<Conversation> = {}) =>
    ({ id, dotId: 'd1', title: `Chat ${id}`, createdAt: NOW - 10 * MIN, ...fields }) as Conversation;

const run = (runId: string, fields: Partial<DotRun> = {}): DotRun => ({
    runId,
    threadId: 'c1',
    title: 'Weekly digest',
    status: 'finished',
    source: 'web',
    startedAt: NOW - 5 * MIN,
    finishedAt: NOW - 4 * MIN,
    ...fields,
});

const STATE = { settings: { paused: false }, tasks: [] } as unknown as Pick<State, 'settings' | 'tasks'>;

function page(fields: Partial<Parameters<typeof socioPage>[0]> = {}): SocioPageView {
    const view = socioPage({
        socioId: 'd1',
        dots: [dot('d1'), dot('d2')],
        state: STATE,
        chats: [],
        runs: { kind: 'ok', runs: [] },
        schedules: [],
        goals: [],
        now: NOW,
        ...fields,
    });
    if (view === null) {
        throw new Error('no page');
    }
    return view;
}

const section = (view: SocioPageView, id: string) => view.sections.find((one) => one.id === id)!;

describe("a socio's page", () => {
    it('heads with its name, character, description and state, Idle with nothing running', () => {
        const view = page();
        expect(view).toMatchObject({ id: 'd1', name: 'Sebas', description: 'Be helpful.', state: 'idle', doing: null });
        expect(socioStatusLine(view)).toBe('Idle');
        expect(page({ dots: [dot('d1', { instructions: '  ' })] }).description).toBe(NO_INSTRUCTIONS);
        expect(
            socioPage({
                socioId: 'gone',
                dots: [],
                state: STATE,
                chats: [],
                runs: { kind: 'loading' },
                schedules: [],
                goals: [],
                now: NOW,
            }),
        ).toBeNull();
    });

    it('says what it is doing while a task or a turn of it runs, and Paused over everything', () => {
        const working = page({
            runs: { kind: 'ok', runs: [run('r1', { status: 'running', title: 'Plan the week' })] },
        });
        expect(working.state).toBe('working');
        expect(socioStatusLine(working)).toBe('Working on “Plan the week”');
        const task = page({
            state: {
                settings: { paused: false },
                tasks: [{ id: 't1', dotId: 'd1', status: 'running', title: 'Morning brief', prompt: 'x' }],
            } as never,
        });
        expect(socioStatusLine(task)).toBe('Working on “Morning brief”');
        expect(section(task, 'now').rows.map((row) => [row.title, row.target])).toEqual([
            ['Morning brief', { kind: 'task', id: 't1' }],
        ]);
        const paused = page({ state: { settings: { paused: true }, tasks: [] } as never });
        expect(paused.state).toBe('paused');
        expect(socioStatusLine(paused)).toBe('Paused');
    });

    it('lists its own active chats newest first, three until Show all, and its archived ones apart', () => {
        const chats = [
            chat('c1', { createdAt: NOW - 50 * MIN }),
            chat('c2', { createdAt: NOW - 40 * MIN }),
            chat('c3', { createdAt: NOW - 30 * MIN }),
            chat('c4', { createdAt: NOW - 20 * MIN }),
            chat('other', { dotId: 'd2' }),
            chat('old', { archivedAt: NOW - 60 * MIN }),
        ];
        const view = page({ chats });
        const active = section(view, 'chats');
        expect(active.rows.map((row) => row.target)).toEqual([
            { kind: 'chat', id: 'c4', room: false },
            { kind: 'chat', id: 'c3', room: false },
            { kind: 'chat', id: 'c2', room: false },
        ]);
        expect(active.rows).toHaveLength(SOCIO_CHATS_SHOWN);
        expect(active.more).toBe(1);
        expect(active.rows[0]?.detail).toBe('20m ago');
        expect(section(page({ chats, expanded: new Set(['chats']) }), 'chats').rows).toHaveLength(4);
        expect(section(view, 'archived').rows.map((row) => row.title)).toEqual(['Chat old']);
    });

    it('shows its goals and schedules that will run again, soonest first, with the next run', () => {
        const schedule = (id: string, fields: Partial<ScheduleView>) =>
            ({
                id,
                title: id,
                dotId: 'd1',
                status: 'scheduled',
                cadence: 'every day at 09:00',
                nextRunAt: null,
                ...fields,
            }) as ScheduleView;
        const goal = {
            id: 'G-1',
            dotId: 'd1',
            title: 'Ship the app',
            status: 'active',
            scheduleId: 'goal-s',
            nextRunAt: NOW + 60 * MIN,
        } as GoalView;
        const view = page({
            schedules: [
                schedule('late', { nextRunAt: NOW + 120 * MIN }),
                schedule('soon', { nextRunAt: NOW + 30 * MIN }),
                schedule('goal-s', {}),
                schedule('done', { status: 'completed' }),
                schedule('theirs', { dotId: 'd2' }),
            ],
            goals: [goal],
        });
        const rows = section(view, 'scheduled').rows;
        expect(rows.map((row) => row.key)).toEqual(['goal-G-1', 'schedule-soon', 'schedule-late']);
        expect(rows[0]?.target).toEqual({ kind: 'schedule', id: 'goal-s' });
        expect(rows[1]?.detail).toMatch(/^Every day at 09:00 · Next run /);
        expect(section(view, 'scheduled').footer?.target).toEqual({ kind: 'schedules' });
        expect(section(page(), 'scheduled').empty).toBe('Nothing scheduled');
        // Its scheduled tasks from the shell too, unless a schedule row names them.
        const tasks = page({
            schedules: [schedule('soon', { nextRunAt: NOW + 30 * MIN })],
            state: {
                settings: { paused: false },
                tasks: [
                    {
                        id: 't1',
                        dotId: 'd1',
                        status: 'scheduled',
                        title: 'Weekly digest',
                        prompt: 'x',
                        cadence: 'every week',
                        nextRunAt: NOW + 60 * MIN,
                    },
                    {
                        id: 'soon',
                        dotId: 'd1',
                        status: 'scheduled',
                        title: 'soon',
                        prompt: 'x',
                        nextRunAt: NOW + 30 * MIN,
                    },
                    { id: 't2', dotId: 'd1', status: 'cancelled', title: 'gone', prompt: 'x', nextRunAt: null },
                    { id: 't3', dotId: 'd2', status: 'scheduled', title: 'theirs', prompt: 'x', nextRunAt: NOW },
                ],
            } as never,
        });
        expect(section(tasks, 'scheduled').rows.map((row) => [row.key, row.target])).toEqual([
            ['schedule-soon', { kind: 'schedule', id: 'soon' }],
            ['task-t1', { kind: 'task', id: 't1' }],
        ]);
        expect(section(tasks, 'scheduled').rows[1]?.detail).toMatch(/^Every week · Next run /);
    });

    it('lists its recent turns from the web’s read, and says so offline', () => {
        const view = page({ runs: { kind: 'ok', runs: [run('r1'), run('r2', { status: 'failed', threadId: 'c2' })] } });
        const recent = section(view, 'recent');
        expect(recent.rows.map((row) => [row.detail, row.target])).toEqual([
            ['5m ago', { kind: 'chat', id: 'c1', room: false }],
            ['Failed · 5m ago', { kind: 'chat', id: 'c2', room: false }],
        ]);
        expect(recent.footer?.target).toEqual({ kind: 'runs' });
        const offline = page({ runs: { kind: 'offline' } });
        expect(section(offline, 'recent').empty).toBe(SOCIO_RUNS_OFFLINE);
        expect(section(offline, 'now').empty).toBe(SOCIO_RUNS_OFFLINE);
    });

    it('takes no new chat when archived', () => {
        expect(page({ dots: [dot('d1', { archivedAt: NOW })] }).archived).toBe(true);
        const screen = src('screens/socio.tsx');
        expect(screen).toContain('view === null || view.archived\n                ? []');
        expect(screen).toContain('{view.archived ? (');
    });
});

describe("a socio's turns (the web's GET /api/dots/:id/runs)", () => {
    const fetchOf =
        (answer: () => Response): AuthedFetch =>
        async (input: string) => {
            expect(input).toBe('/api/dots/d%201/runs');
            return answer();
        };

    it('reads and checks them', async () => {
        expect(socioRunsPath('d 1')).toBe('/api/dots/d%201/runs');
        const runs = [run('r1')];
        expect(
            await readSocioRuns(
                fetchOf(() => Response.json(runs)),
                'd 1',
            ),
        ).toEqual(runs);
        await expect(
            readSocioRuns(
                fetchOf(() => Response.json([{ runId: 1 }])),
                'd 1',
            ),
        ).rejects.toThrow('something else');
        await expect(
            readSocioRuns(
                fetchOf(() => Response.json({ error: 'x' }, { status: 404 })),
                'd 1',
            ),
        ).rejects.toThrow('404');
        await expect(
            readSocioRuns(
                fetchOf(() => {
                    throw new NetworkError('/api/dots/d%201/runs');
                }),
                'd 1',
            ),
        ).rejects.toBeInstanceOf(NetworkError);
    });
});

describe('Home (CB-431)', () => {
    it('opens a socio’s page from its row, at the web’s path', () => {
        expect(ROUTES.Socio.linking).toBe('dots/:socioId');
        expect(socioAction('d1')).toEqual({ type: 'NAVIGATE', payload: { name: 'Socio', params: { socioId: 'd1' } } });
        expect(src('screens/home.tsx')).toContain(
            'onOpenSocio={(socioId) => navigation.dispatch(socioAction(socioId))}',
        );
        expect(src('navigation/tab-screens.tsx')).toContain('Socio: SocioScreen,');
    });

    it('gives each socio row and its compose button their own hit areas, side by side', () => {
        const parts = src('screens/home-parts.tsx');
        const row = parts.slice(parts.indexOf("section.id === 'socios'"), parts.indexOf('section.chats.map'));
        // The row presses only inside its flex-1 column; the button is its sibling, never inside it.
        expect(row).toMatch(/<View className="min-w-0 flex-1">\s+<ListRow[\s\S]*?onPress: \(\) => props\.onOpenSocio/);
        expect(row.indexOf('</View>\n                                    {props.onNewChat')).toBeGreaterThan(0);
        expect(row).toMatch(/<SymbolButton\s+name=\{SOCIO_NEW_CHAT_SYMBOL\}/);
        expect(parts).toContain("export const SOCIO_NEW_CHAT_SYMBOL = 'square-pen';");
        expect(SYMBOLS['square-pen'].sf).toBe('square.and.pencil');
        // 44 pt on iOS, Material's 48 dp icon button on Android.
        const button = src('screens/platform-symbol.tsx');
        expect(button).toContain(
            "'size-11 items-center justify-center active:opacity-40' : 'size-12 items-center justify-center'",
        );
        expect(button).toContain('android_ripple={{ borderless: true, radius: 24 }}');
        // The glyph is AppSymbol's: the SF Symbol on iOS, lucide's on Android.
        expect(button).toContain('<AppSymbol\n                name={props.name}');
    });

    it('has the native bar in one row: the logo, name and chevron leading it, no large title, no Compose', () => {
        const home = src('screens/home.tsx');
        const bar = home.slice(home.indexOf('function useHomeBar('));
        expect(bar).toContain("title: '',");
        expect(bar).toMatch(
            /kind: 'custom',\s+id: 'open-workspaces',[\s\S]*?bare: true,\s+element: \(\) => <WorkspaceBarButton \/>/,
        );
        expect(bar).toContain('element: () => <AccountButton inBar />');
        expect(home).not.toMatch(/HomeHeader|NewChatButton|home-new-chat/);
        expect(src('navigation/shell-tabs.tsx')).toContain(
            "Home: tabStack('Home', TABS.Home.label, HomeScreen, { large: false }),",
        );
        expect(tabRoot('Home', { large: false })).toMatchObject({ headerShown: true, headerLargeTitleEnabled: false });
        const parts = src('screens/home-parts.tsx');
        const button = parts.slice(parts.indexOf('export function WorkspaceBarButton'));
        // The name a Headline (an inline bar title's style), one line, truncating to leave the bar's end its items.
        expect(button).toMatch(/<Text\s+variant="headline"\s+numberOfLines=\{1\}\s+className="shrink"/);
        // It stops growing as UIKit's bar titles do, so the name isn't cut to a letter at AX5.
        expect(button).toContain('maxFontSizeMultiplier={BAR_TITLE_MAX_SCALE}');
        expect(button).toContain('style={{ maxWidth: width - WORKSPACE_BAR_RESERVE }}');
        expect(button).toContain('<AppSymbol name="chevron-down"');
        expect(button).toContain('onPress={drawer?.open}');
    });

    it('draws the row pencil a step larger, in its 44 pt target', () => {
        const button = src('screens/platform-symbol.tsx');
        expect(button).toContain('export const SYMBOL_BUTTON_GLYPH = { ios: 26, android: 28 } as const;');
        expect(button).toContain('size={ios ? SYMBOL_BUTTON_GLYPH.ios : SYMBOL_BUTTON_GLYPH.android}');
    });

    it('lets a bar hold items at its start and hide itself (native-bar.tsx)', () => {
        const bar = src('navigation/native-bar.tsx');
        expect(bar).toContain('options.unstable_headerLeftItems = () => iosBarItems(pressedLeft, customItem(left));');
        expect(bar).toContain('options.headerLeft = () => <MaterialBarItems items={pressedLeft} />;');
        expect(bar).toContain('...(item.bare === true ? { hidesSharedBackground: true } : {}),');
        expect(bar).toContain('...(current.hidden === undefined ? {} : { headerShown: !current.hidden }),');
        // Every key each time, the start's too.
        expect(bar).toContain('headerLeft: undefined,\n            unstable_headerLeftItems: undefined,');
    });
});
