import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { chatMenu } from '../../src/chat/chat-header';
import { ARCHIVE, COPY, DELETE, messageMenu, RENAME, SHARE } from '../../src/chat/long-press';
import { DISCARD_DRAFT, KEEP_DRAFT } from '../../src/shell/file-issue';
import { chosenAction, MENU_SYMBOLS, nativeMenuItems } from '../../src/shell/native-menu';
import { DISCARD_SPACE, newSpaceAsks } from '../../src/shell/new-space';
import { CHANGE_COVER, MOVE, REMOVE_COVER, SET_COVER } from '../../src/shell/page-menus';

// CB-421 (the owner's 2026-11-18 rule: each platform's own components): every
// ⋯ and every long-press opens the system's menu (MenuView: UIMenu and the
// context menu on iOS, Material's popup on Android), behind ActionMenu, with
// the menu items still the rows' accessibility actions.

const SRC = join(import.meta.dirname, '../../src');
const read = (file: string) => readFileSync(join(SRC, file), 'utf8');

describe('the native menu items', () => {
    it('carry SF Symbols on iOS and none on Android, red when destructive, dimmed when disabled', () => {
        const items = [COPY, { ...SHARE, disabled: true }, DELETE];
        // Each symbol has its color: MenuView tints one without a color clear on the new architecture.
        const colors = { icon: '#111111', destructive: '#dd0000' };
        expect(nativeMenuItems(items, 'ios', colors)).toEqual([
            { id: 'copy', title: 'Copy', image: 'doc.on.doc', imageColor: '#111111' },
            {
                id: 'share',
                title: 'Share',
                image: 'square.and.arrow.up',
                imageColor: '#111111',
                attributes: { disabled: true },
            },
            { id: 'delete', title: 'Delete', image: 'trash', imageColor: '#dd0000', attributes: { destructive: true } },
        ]);
        expect(nativeMenuItems(items, 'android')).toEqual([
            { id: 'copy', title: 'Copy' },
            { id: 'share', title: 'Share', attributes: { disabled: true } },
            { id: 'delete', title: 'Delete', attributes: { destructive: true } },
        ]);
    });

    it('checks the choice that holds, and takes an action’s own symbol over the table’s', () => {
        expect(nativeMenuItems([{ name: 'any', label: 'Any', checked: true, icon: 'circle' }], 'ios')).toMatchObject([
            { id: 'any', title: 'Any', image: 'circle', state: 'on' },
        ]);
        expect(nativeMenuItems([{ name: 'unknown', label: 'Plain' }], 'ios')).toEqual([
            { id: 'unknown', title: 'Plain' },
        ]);
    });

    it('gives every action the app’s menus hold a symbol', () => {
        const actions = [
            ...messageMenu([
                { kind: 'up', label: 'Good reply', on: false, count: null, accessibilityLabel: 'Good reply' },
                { kind: 'down', label: 'Bad reply', on: false, count: null, accessibilityLabel: 'Bad reply' },
                { kind: 'retry', label: 'Try again', on: false, count: null, accessibilityLabel: 'Try again' },
                { kind: 'needs-work', label: 'Needs work', on: false, count: null, accessibilityLabel: 'Needs work' },
            ]),
            RENAME,
            ARCHIVE,
            DELETE,
            ...chatMenu(false),
            MOVE,
            SET_COVER,
            CHANGE_COVER,
            REMOVE_COVER,
            KEEP_DRAFT,
            DISCARD_DRAFT,
            { name: 'report-issue', label: '' },
            { name: 'pause-all', label: '' },
            { name: 'resume-all', label: '' },
        ];
        for (const action of actions) {
            expect(MENU_SYMBOLS[action.name], action.name).toBeTypeOf('string');
        }
    });

    it('runs only a known action that isn’t disabled', () => {
        const actions = [COPY, { ...SHARE, disabled: true }];
        expect(chosenAction(actions, 'copy')).toBe(COPY);
        expect(chosenAction(actions, 'share')).toBeNull();
        expect(chosenAction(actions, 'nope')).toBeNull();
        expect(chosenAction(actions, undefined)).toBeNull();
    });
});

describe('every menu is the system’s', () => {
    it('is MenuView behind ActionMenu, with no drawn sheet of menu items left', () => {
        const menu = read('screens/action-menu.tsx');
        expect(menu).toContain("import { MenuView } from '@react-native-menu/menu';");
        expect(menu).toContain('shouldOpenOnLongPress={longPress}');
        expect(menu).not.toContain('function SheetMenu');
        // Only the text prompt is drawn over the screen now.
        expect(menu.match(/<Modal\b/g)).toHaveLength(1);
    });

    it('opens on each ⋯ and filter button, and on each row and message a long-press', () => {
        // Home's ⋯ is in its native bar (CB-431): a menu bar item with useHomeMenu's items.
        expect(read('screens/home.tsx')).toMatch(
            /id: 'home-menu',\s+label: HOME_MENU_LABEL,\s+symbol: 'ellipsis',[\s\S]*?menu,/,
        );
        // The chat's ⋯ is in the native bar: a menu bar item (navigation/bar-items.ts).
        expect(read('screens/chat-header.tsx')).toContain('const menu: MenuRequest | null =');
        expect(read('screens/schedules.tsx')).toContain('<ActionMenu request={props.menu} trigger="press"');
        expect(read('screens/chats.tsx')).toContain('<ActionMenu request={manage.menu(item)} trigger="longPress">');
        const space = read('screens/space.tsx');
        expect(space.match(/<ActionMenu request=\{menu\.request \?\? null\} trigger="longPress"/g)).toHaveLength(2);
        const chat = read('screens/chat.tsx');
        expect(chat).toContain('<ActionMenu request={menu} trigger="longPress">');
        expect(chat).toContain('<ActionMenu request={row.streaming ? null : menu} trigger="longPress">');
    });

    it('leaves no long-press that opens a menu of its own', () => {
        for (const file of ['screens/chats.tsx', 'screens/space.tsx', 'screens/chat.tsx']) {
            const source = read(file);
            expect(source, file).not.toContain('menu.open(');
            expect(source, file).not.toMatch(/onLongPress=\{\(\) =>/);
        }
    });
});

describe('a compose page sheet asks before a draft goes', () => {
    it('asks on File an issue’s Cancel, swipe and Back while it holds a draft, never on filing', () => {
        const screen = read('screens/file-issue.tsx');
        expect(screen).toContain("usePreventRemove(cancelIssue(fields, tray.items.length) === 'ask'");
        expect(screen).toContain("if (data.action.type === 'REPLACE' || isHandOff(data.action)) {");
        expect(screen).toContain('onCancel={() => navigation.goBack()}');
    });

    it('asks on New Space once something is typed', () => {
        expect(newSpaceAsks('', '  ')).toBe(false);
        expect(newSpaceAsks('Plans', '')).toBe(true);
        expect(newSpaceAsks('', 'What we ship')).toBe(true);
        expect(DISCARD_SPACE.destructive).toBe(true);
        expect(read('screens/new-space.tsx')).toContain('usePreventRemove(newSpaceAsks(name, description)');
    });
});
