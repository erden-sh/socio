import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MODULE_TONE_PLACE } from '../../src/navigation/bar-items';
import { ISSUE_SEARCH_LABEL, ISSUE_SEARCH_PLACEHOLDER, STATUS_RING } from '../../src/shell/board';
import { spaceHeading, spaceIntro } from '../../src/shell/space-library';
import { SPACES_INTRO } from '../../src/shell/spaces';

// The page headings and controls the PWA comparison asked for, where the
// screens draw them (read as source, as tests/ui/type-roles.test.ts reads the
// type roles' use): the big titles with their tone tiles ("module tones stay on
// page headers"), the search fields with an icon and no label over them, the
// Board's hollow status rings, Settings' items and the Inbox's Deny and
// Approve.

const app = join(import.meta.dirname, '../..');
const src = (file: string) => readFileSync(join(app, 'src', file), 'utf8');
const web = (file: string) => readFileSync(join(app, '../../packages/client/src', file), 'utf8');

describe('the big titles (CB-420: the bar’s large title, the web’s words)', () => {
    it('are the system bar’s, with the web’s line under them and the tone where MODULE_TONE_PLACE puts it', () => {
        const parts = src('screens/shell-parts.tsx');
        const intro = parts.slice(parts.indexOf('export function PageIntro'), parts.indexOf('const INTRO_TILE'));
        expect(intro).toContain('introTile(MODULE_TONE_PLACE)');
        expect(intro).toContain('<ToneTile tone={tile.tone} icon={tile.icon} size={INTRO_TILE} />');
        expect(intro).not.toContain('variant="title"');
    });

    it('lead every module page’s first line with its tile (`intro`), and none sits alone', () => {
        expect(MODULE_TONE_PLACE).toBe('intro');
        const pages: Record<string, RegExp> = {
            'screens/board.tsx': /subtitle=\{view\.subtitle\}/,
            'screens/memories.tsx': /subtitle=\{MEMORIES_INTRO\}/,
            'screens/spaces.tsx': /subtitle=\{SPACES_INTRO\}/,
            'screens/space.tsx': /subtitle=\{spaceIntro\(heading, recent\.length\)\}/,
            'screens/settings.tsx': /subtitle=\{SETTINGS_HEADING\.description\}/,
            'screens/approvals.tsx': /subtitle=\{APPROVALS_INTRO\}/,
            'screens/runs.tsx': /subtitle=\{admin \? RUNS_INTRO_ADMIN : RUNS_INTRO_MEMBER\}/,
            'screens/schedules.tsx': /subtitle=\{SCHEDULES_INTRO\}/,
            'screens/activity.tsx': /subtitle=\{ACTIVITY_INTRO\}/,
            'screens/learning.tsx': /subtitle=\{learningIntro\(admin\)\}/,
        };
        for (const [file, subtitle] of Object.entries(pages)) {
            const source = src(file);
            const intro = source.slice(source.indexOf('<PageIntro'));
            const props = intro.slice(0, intro.indexOf('/>'));
            expect(props, file).toMatch(subtitle);
            expect(props, file).toContain('tile={{ tone:');
            expect(source, file).not.toMatch(/<PageIntro\s+subtitle=\{null\}/);
        }
    });

    it('give the Spaces the web’s Spaces description as their first line', () => {
        expect(web('modules/spaces/module.tsx')).toContain(`description: '${SPACES_INTRO}'`);
    });

    it('give a Space with no description its pages counted as its first line', () => {
        const space = { id: 'ops', name: 'Ops', createdAt: 1 } as Parameters<typeof spaceHeading>[0][number];
        expect(spaceIntro(spaceHeading([space], 'ops'), 3)).toBe('3 pages');
        expect(spaceIntro(spaceHeading([{ ...space, description: 'Runbooks' }], 'ops'), 3)).toBe('Runbooks');
        expect(spaceIntro(spaceHeading([{ ...space, private: true }], 'ops'), 1)).toBe('Private');
        expect(spaceIntro(null, 1)).toBe('1 page');
    });

    it('give a Space’s library the Space’s name, in the Spaces tone', () => {
        const space = src('screens/space.tsx');
        expect(space).toMatch(/useNativeBar\(\{\s+title: heading\?\.name \?\? SPACES\.title,\s+tone: SPACES\.tone,/);
        expect(space).toContain('tile={{ tone: SPACES.tone, icon: MODULE_ICONS[SPACES.icon] }}');
        expect(space).not.toContain('HeaderBar');
    });

    it('give the Board "Issues" as the web’s, in its tone, with the counts under it', () => {
        const board = src('screens/board.tsx');
        expect(board).toMatch(/title: ISSUES_MODULE\.title,\s+tone: ISSUES_MODULE\.tone,/);
        expect(board).toMatch(/<PageIntro\s+subtitle=\{view\.subtitle\}/);
        expect(board).toContain('tile={{ tone: ISSUES_MODULE.tone, icon: MODULE_ICONS[ISSUES_MODULE.icon] }}');
    });

    it('give Settings its title, tone and description', () => {
        const settings = src('screens/settings.tsx');
        expect(settings).toContain('useNativeBar({ title: SETTINGS_HEADING.title, tone: SETTINGS_MODULE.tone });');
        expect(settings).toMatch(/<PageIntro\s+subtitle=\{SETTINGS_HEADING\.description\}/);
    });
});

describe('the search fields', () => {
    it('show a search icon and no label, and keep their name for screen readers', () => {
        const field = src('ui/search-field.tsx');
        expect(field).toContain('<AppSymbol name="search"');
        expect(field).toContain('accessibilityLabel={label}');
        expect(field).not.toMatch(/<Text[\s>]/);
        expect(web('modules/issues/IssueToolbar.tsx')).toContain('aria-label="Search issues"');
    });

    it('are the Board’s, with no "Search issues" over it, and the library’s "Search pages"', () => {
        expect(ISSUE_SEARCH_LABEL).toBe('Search issues');
        expect(ISSUE_SEARCH_PLACEHOLDER).toBe('Search');
        const board = src('screens/board.tsx');
        // Android's drawn field; iOS's is the bar's own (CB-420, `barSearch`).
        expect(board).toMatch(/\{barSearch\(Platform\.OS\) \? null : \(\s+<SearchField\s+label=\{ISSUE_SEARCH_LABEL\}/);
        expect(board).toContain('search: { placeholder: ISSUE_SEARCH_PLACEHOLDER, onChange: setQuery },');
        expect(board).not.toContain('<Field');
        const space = src('screens/space.tsx');
        expect(space).toMatch(/\{barSearch\(Platform\.OS\) \? null : \(\s+<SearchField\s+label=\{PAGE_SEARCH_LABEL\}/);
        expect(space).toContain('search: { placeholder: PAGE_SEARCH_LABEL, onChange: setQuery }');
    });
});

describe('the Board’s status chips', () => {
    it('mark each status with the web’s hollow ring in its tone, never a filled dot', () => {
        expect(web('modules/issues/IssueBadges.tsx')).toContain(
            'size-2 shrink-0 rounded-full border-[1.5px] border-current',
        );
        expect(STATUS_RING).toEqual({ size: 8, borderWidth: 1.5 });
        const board = src('screens/board.tsx');
        const picker = board.slice(board.indexOf('function ColumnPicker'), board.indexOf('function TonePill'));
        expect(picker).toContain('borderWidth: STATUS_RING.borderWidth');
        expect(picker).toContain('borderColor: tones[column.tone].foreground');
        expect(picker).not.toContain('backgroundColor: tones[column.tone]');
    });
});

describe('Settings’ items', () => {
    it('choose Appearance in the platform’s segmented control and keep it, show the name and link the web’s settings', () => {
        const settings = src('screens/settings.tsx');
        // UISegmentedControl on iOS; on Android a Material radio group (ui/segmented-control.tsx).
        expect(settings).toContain('<SegmentedControl');
        expect(src('ui/segmented-control.tsx')).toContain('accessibilityRole="radiogroup"');
        expect(src('ui/segmented-control.tsx')).toContain('accessibilityRole="radio"');
        expect(settings).toContain('.set({ appearance })');
        expect(settings).toContain('<AccountSection />');
        expect(settings).toContain('openLink(WEB_SETTINGS_ROW.href, { web: true })');
    });

    it('apply Appearance app-wide through uniwind’s theme', () => {
        expect(src('platform/device-settings.ts')).toContain(
            'followAppearance(deviceSettings, (theme) => Uniwind.setTheme(theme))',
        );
    });
});

describe('the approvals at the top of Chats (CB-455)', () => {
    it('decide in place through the scope’s approvals, by the request page’s rules', () => {
        const inbox = src('screens/attention.tsx');
        expect(inbox).toContain('inboxDecisionView(request, approvals.context(row.id), approvals.notice(row.id))');
        expect(inbox).toContain('onAction={(key) => approvals.act(row.id, key)}');
        expect(inbox).toContain('useChatApprovals(');
    });
});
