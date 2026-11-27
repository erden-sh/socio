import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    ACCOUNT_LINKS,
    homeMenu,
    PAUSE_ALL,
    PAUSE_QUESTION,
    REPORT_ISSUE,
    RESUME_ALL,
    SETTINGS_PATH,
    setAllPaused,
} from '../../src/shell/account';

// Parity batch C (CB-402):
// Home's ⋯ menu, the account sheet's links to the web's person menu, the Chats
// tab as one grouped list, and Search's field and room rows. The view models
// run under Node; the .tsx files are read as text.

const src = join(import.meta.dirname, '../../src');
const read = (file: string) => readFileSync(join(src, file), 'utf8');
const client = (file: string) => readFileSync(join(src, '../../../packages/client/src', file), 'utf8');

describe('Home’s ⋯ menu', () => {
    it('holds Report issue, and for an admin Pause all socios, or Resume while paused', () => {
        const names = (role: Parameters<typeof homeMenu>[0], paused: boolean) =>
            homeMenu(role, paused).map((action) => action.label);
        expect(names('member', false)).toEqual([REPORT_ISSUE]);
        expect(names(null, false)).toEqual([REPORT_ISSUE]);
        expect(names('admin', false)).toEqual([REPORT_ISSUE, PAUSE_ALL]);
        // An older server may still send the retired `operator` role (CB-390): an admin.
        expect(names('operator' as never, true)).toEqual([REPORT_ISSUE, RESUME_ALL]);
    });

    it('words Pause and Resume as the web’s header, and asks with the web’s paused line', () => {
        const header = client('shell/AppHeader.tsx');
        // The web's words are its en-US dictionary's (shell).
        const shell = JSON.parse(
            readFileSync(new URL('../../../../packages/i18n/locales/en-US/shell.json', import.meta.url), 'utf8'),
        ) as { header: Record<string, string>; 'paused-banner': string };
        expect(shell.header.resume).toBe(RESUME_ALL);
        expect(shell.header.pause).toBe(PAUSE_ALL);
        expect(header).toContain("t('shell:header.resume') : t('shell:header.pause')");
        expect(header).toContain("shell.mutate('/settings', 'PATCH', { paused: !paused })");
        expect(PAUSE_QUESTION.cancel).toBe('Cancel');
        expect(shell['paused-banner']).toContain('Active compute stops and scheduled tasks wait.');
    });

    it('sends the web’s PATCH /api/settings with { paused }, and says whether the server took it', async () => {
        const calls: unknown[] = [];
        const ok = await setAllPaused(async (path, init) => {
            calls.push([path, init]);
            return { ok: true };
        }, true);
        expect(ok).toBe(true);
        expect(calls).toEqual([[SETTINGS_PATH, { method: 'PATCH', json: { paused: true } }]]);
        expect(SETTINGS_PATH).toBe('/api/settings');
        expect(await setAllPaused(async () => ({ ok: false }), false)).toBe(false);
        expect(
            await setAllPaused(async () => {
                throw new Error('offline');
            }, true),
        ).toBe(false);
    });

    it('is in Home’s native bar beside the account button, asking before Pause (CB-431)', () => {
        const bar = read('screens/home.tsx');
        const hook = bar.slice(bar.indexOf('function useHomeBar('));
        // From the bar's end: the account, then ⋯ (no Compose: CB-431); the workspace button at its start.
        expect(hook.indexOf("id: 'open-account'")).toBeLessThan(hook.indexOf("id: 'home-menu'"));
        expect(hook).not.toContain('home-new-chat');
        expect(hook.indexOf('left: [')).toBeLessThan(hook.indexOf("id: 'open-workspaces'"));
        expect(hook.indexOf("id: 'open-workspaces'")).toBeLessThan(hook.indexOf('right: ['));
        const parts = read('screens/home-parts.tsx');
        const menu = parts.slice(parts.indexOf('export function useHomeMenu'));
        expect(menu).toContain("navigation.navigate('FileIssue')");
        expect(menu).toContain('Alert.alert(PAUSE_QUESTION.title, PAUSE_QUESTION.message');
        expect(menu).toContain('setAllPaused(scope.fetch, paused)');
        expect(menu).toContain('scope.scheduler.poke()');
        // The system's pull-down from the bar button (CB-421): a UIMenu bar item, Material's popup on Android.
        expect(menu).toContain('return { actions, onAction: act };');
    });
});

describe('the account sheet’s links', () => {
    it('are the web person menu’s Report issue, Getting started & guides, Release notes and Account & security', () => {
        expect(ACCOUNT_LINKS.map((link) => [link.label, link.target])).toEqual([
            ['Report issue', { kind: 'file-issue' }],
            ['Getting started & guides', { kind: 'web', href: '/docs/getting-started' }],
            ['Release notes', { kind: 'web', href: '/releases' }],
            ['Account & security', { kind: 'web', href: '/settings/account' }],
        ]);
    });

    it('open the web’s own addresses for them', () => {
        expect(client('components/app-sidebar.tsx')).toContain("onReleaseNotes={go(() => void navigate('/releases'))}");
        expect(client('shell/AppShell.tsx')).toContain("settingsPath('account')");
        expect(client('modules/settings/sections.ts')).toContain('`/settings/${section}`');
        expect(client('modules/onboarding/guides.ts')).toContain("'getting-started',");
        expect(client('modules/onboarding/guides.ts')).toContain("article: '/docs/' + article");
        expect(client('components/nav-user.tsx')).toContain('Account &amp; security');
    });

    it('sit over Sign out, which keeps Leave workspace (CB-383) under it; the web ones in the in-app browser', () => {
        const account = read('screens/account.tsx');
        const sheet = account.slice(account.indexOf('function Account()'), account.indexOf('const LINK_ICONS'));
        expect(sheet.indexOf('<AccountLinks />')).toBeGreaterThan(sheet.indexOf('<UnsentList />'));
        expect(sheet.indexOf('<AccountLinks />')).toBeLessThan(sheet.indexOf('testID="sign-out"'));
        expect(sheet.indexOf('testID="sign-out"')).toBeLessThan(sheet.indexOf('<LeaveWorkspace'));
        expect(account).toContain("navigation.dispatch(StackActions.replace('FileIssue'))");
        expect(account).toContain('openLink(link.target.href, { web: true })');
    });
});

describe('the Chats tab', () => {
    it('is a flat list of full-width rows, Messages’, with no card or border', () => {
        const chats = read('screens/chats.tsx');
        expect(chats).not.toContain('rounded-xl');
        expect(chats).not.toContain('border-x');
        expect(chats).toContain('first={index === 0}');
        // Edge to edge: no side padding; the header keeps its own.
        expect(chats).toContain('contentContainerClassName="py-2"');
        expect(chats).toContain('<View className="gap-3 px-4 pb-2">');
    });
});

describe('the Search tab’s field and rows', () => {
    const search = read('screens/search.tsx');

    it('has the web’s search field, its icon and no label over it', () => {
        expect(search).toContain('<SearchField');
        expect(search).not.toContain('<Field');
        expect(search).not.toContain('label="Search"');
    });

    it('draws a chat or room as the chat list does, a room with the room’s tile', () => {
        const row = search.slice(search.indexOf("case 'chat':"), search.indexOf("case 'link':"));
        expect(row).toContain('<ChatListRow');
        expect(row).toContain('chatListItem(item.chat, undefined, 0)');
        expect(row).not.toContain('SocioAvatar');
        expect(read('screens/chat-rows.tsx')).toContain('leading={row.room ? <RoomTile /> : <SocioAvatar');
    });

    it('opens New chat with the default socio and Add memory on Memories, its Add sheet up (batch F)', () => {
        expect(search).toContain('navigation.dispatch(newChatAction(target.socioId))');
        expect(search).toContain('navigation.dispatch(addMemoryAction())');
        expect(search).toContain('defaultSocioId(dots, state)');
    });
});
