import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    chatSwipeActions,
    SWIPE_ARCHIVE,
    SWIPE_DELETE,
    SWIPE_PANE,
    SWIPE_READ,
    swipeGroup,
    swipeLayout,
    swipePaneContentHeight,
    swipePaneLook,
    swipeTone,
} from '../../src/shell/swipe-actions';
import type { NewOutboxWrite } from '../../src/sync/outbox';
import { markRoomReadFromList, ROOM_READ_KIND } from '../../src/sync/room-send';
import { ANDROID_GROUPED, groupedRadius, IOS_GROUPED, ROW_INSET, separatorInset } from '../../src/ui/grouped-colors';
import { REFRESH_MIN_MS, refreshDone } from '../../src/ui/refresh-timing';
import { SEGMENTED_MAX, segmentedLayout } from '../../src/ui/segmented';

// Native lists and controls (the web's brand in each platform's own
// components): native
// segmented controls, pull to refresh on every list that syncs, flat and inset
// grouped lists on the system's colors, and swipe actions where the app
// already has the action.

const SRC = join(import.meta.dirname, '../../src');
const read = (file: string) => readFileSync(join(SRC, file), 'utf8');

describe('segmented controls', () => {
    it('are UISegmentedControl on iOS and Material’s segmented button on Android, at each one’s height', () => {
        const control = read('ui/segmented-control.tsx');
        expect(control).toContain("from '@react-native-segmented-control/segmented-control'");
        expect(control).toContain(
            "Platform.OS === 'ios' ? <IosSegmented {...props} /> : <MaterialSegmented {...props} />",
        );
        // Material 3: an outlined pill, the chosen segment filled with a check before its label.
        expect(control).toContain('rounded-full');
        expect(control).toContain('{on ? <AppSymbol name="check" size={18} color="foreground" /> : null}');
        expect(segmentedLayout('ios')).toEqual({ minHeight: 32 });
        expect(segmentedLayout('android')).toEqual({ minHeight: 40 });
        expect(SEGMENTED_MAX).toBe(4);
    });

    it('stand in for every drawn segmented tab: Appearance, Board and List, Recent and All pages, the Space’s tabs, Schedules and Jobs', () => {
        for (const file of [
            'screens/settings.tsx',
            'screens/board.tsx',
            'screens/space.tsx',
            'screens/space-sections.tsx',
            'screens/schedules.tsx',
        ]) {
            expect(read(file), file).toContain('<SegmentedControl');
        }
        // The old Board toggle's icon buttons are gone.
        expect(read('screens/board.tsx')).not.toContain('Columns3');
    });
});

describe('pull to refresh', () => {
    it('is the system’s RefreshControl, shown at least half a second', async () => {
        expect(read('ui/pull-to-refresh.tsx')).toContain('<RefreshControl');
        expect(REFRESH_MIN_MS).toBe(500);
        const waits: number[] = [];
        const wait = async (ms: number) => {
            waits.push(ms);
        };
        await refreshDone(1000, 1200, wait);
        await refreshDone(1000, 2000, wait);
        expect(waits).toEqual([300]);
    });

    it.each([
        ['screens/chats.tsx', 'useSyncRefresh(SYNCED)'],
        ['screens/board.tsx', 'useSyncRefresh(SYNCED)'],
        ['screens/spaces.tsx', 'useSyncRefresh(SYNCED)'],
        ['screens/approvals.tsx', 'useSyncRefresh(SYNCED)'],
        ['screens/activity.tsx', 'useSyncRefresh(SHELL_KINDS)'],
        ['screens/memories.tsx', 'useSyncRefresh(MEMORIES_KIND.collections)'],
        ['screens/space.tsx', 'space.pull()'],
    ])('%s refreshes what it syncs on a pull', (file, work) => {
        const screen = read(file);
        expect(screen).toContain('usePullToRefresh(');
        expect(screen).toContain(work);
        expect(screen).toContain('refreshControl={refreshControl}');
    });

    it('reads a Space’s Memory and Radar again on their tabs', () => {
        expect(read('screens/space.tsx')).toContain('spaceSection(store.sections, spaceId, tab).refresh()');
    });
});

describe('lists', () => {
    it('take the system’s grouped colors on iOS and Material’s surfaces on Android, with no border', () => {
        expect(IOS_GROUPED).toEqual({
            page: 'systemGroupedBackground',
            cell: 'secondarySystemGroupedBackground',
            plainCell: 'secondarySystemBackground',
            separator: 'separator',
        });
        expect(ANDROID_GROUPED.light).toMatchObject({ page: 'muted', cell: 'card' });
        expect(ANDROID_GROUPED.dark).toMatchObject({ page: 'screen', cell: 'secondary' });
        expect(groupedRadius('ios')).toBe(24);
        const parts = read('screens/shell-parts.tsx');
        const section = parts.slice(parts.indexOf('export function Section'), parts.indexOf('export function ListRow'));
        expect(section).toContain('<GroupedCard>');
        expect(section).not.toContain('border');
        expect(read('ui/grouped.tsx')).toContain('PlatformColor(IOS_GROUPED[role])');
    });

    it('draw the hairline between rows from the text, past the leading item', () => {
        expect(ROW_INSET).toBe(12);
        expect(separatorInset(null)).toBe(12);
        // A chat's 40 pt mascot and its 12 pt gap: Messages' inset.
        expect(separatorInset(40)).toBe(64);
        const parts = read('screens/shell-parts.tsx');
        expect(parts).toContain(
            '<RowSeparator inset={separatorInset(props.leading === undefined ? null : (props.leadingSize ?? 40))} />',
        );
        expect(parts).not.toContain("'border-t border-border'");
    });

    it('make Chats full-width rows with no card, as Messages', () => {
        const chats = read('screens/chats.tsx');
        expect(chats).not.toContain('border-x border-border bg-card');
        expect(chats).toContain('<SwipeRow {...manage.swipes(item)}');
    });

    it('make Settings, the socio page, a Space, the Spaces and an issue inset grouped pages', () => {
        const settings = read('screens/settings.tsx');
        expect(settings).toContain("edges={['right', 'bottom', 'left']} grouped>");
        // Notes under a section are its footer, as iOS's Settings has them.
        for (const footer of [
            'APPEARANCE_HINT',
            'HAPTICS_ROW.subtitle',
            'ADVANCED_ROW.subtitle',
            'ACCOUNT_NOTE',
            'CACHE_NOTE',
            'KEPT_SPACES_SECTION.note',
        ]) {
            expect(settings, footer).toContain(`footer={${footer}}`);
        }
        expect(settings).not.toContain('border-t border-border');
        expect(read('screens/socio.tsx')).toContain('grouped onScrollY');
        expect(read('screens/socio.tsx')).toContain('<GroupedCard testID={testID}>');
        expect(read('screens/spaces.tsx')).toMatch(/\sgrouped\s+refreshControl=\{refreshControl\}/);
        expect(read('screens/space.tsx')).toMatch(/\sgrouped\s+refreshControl=\{refreshControl\}/);
        const issue = read('screens/issue.tsx');
        expect(issue).toContain('<GroupedRoot testID="issue-screen">');
        expect(issue).not.toContain('rounded-xl border border-border bg-card">');
        expect(read('screens/issue-admin.tsx')).not.toContain('rounded-xl border border-border bg-card');
    });
});

describe('swipe actions', () => {
    it('give a private chat Archive at the edge (the full swipe) and Delete, red, inside it', () => {
        expect(chatSwipeActions({ room: false, unread: null })).toEqual({
            trailing: [SWIPE_DELETE, SWIPE_ARCHIVE],
            leading: [],
        });
        expect(swipeTone(SWIPE_DELETE.tone).background).toBe('destructive');
        expect(swipeTone(SWIPE_ARCHIVE.tone).background).toBe('primary');
    });

    it('give a room Mark read toward the leading edge while it has unread, and nothing else', () => {
        expect(chatSwipeActions({ room: true, unread: 3 })).toEqual({ trailing: [], leading: [SWIPE_READ] });
        expect(chatSwipeActions({ room: true, unread: null })).toEqual({ trailing: [], leading: [] });
    });

    it('draw iOS 26’s filled circles on iOS and Material’s full-bleed panes on Android', () => {
        expect(swipePaneLook('ios')).toMatchObject({ fill: 'circle', circle: 36, pane: 64 });
        expect(swipePaneLook('android').fill).toBe('pane');
    });

    it('fit the symbol and its word inside a chat row, centered, with room to spare (CB-454)', () => {
        // A chat row: a 40 pt mascot and 12 pt above and below it.
        const row = 64;
        for (const os of ['ios', 'android']) {
            const look = swipePaneLook(os);
            expect(swipePaneContentHeight(look), os).toBeLessThanOrEqual(row - 8);
            expect(look.labelMaxScale, os).toBeLessThanOrEqual(1.1);
        }
        const pane = read('screens/swipe-row.tsx');
        expect(pane).toContain('<View className="flex-1 items-center justify-center gap-1 px-1">');
        expect(pane).toContain('maxFontSizeMultiplier={look.labelMaxScale}');
        expect(pane).toContain('size={look.icon}');
    });

    it('open past 40% of the panes and arm the full swipe past them and over half the row', () => {
        expect(swipeLayout(2, 393)).toEqual({ pane: SWIPE_PANE, openAt: 64, fullAt: 216.15 });
        expect(swipeLayout(2, 300).fullAt).toBe(2 * SWIPE_PANE + 48);
        expect(swipeLayout(2, 393, swipePaneLook('ios').pane)).toMatchObject({ pane: 64, openAt: 51.2 });
    });

    it('swipe only past 12 pt sideways, a negative offset from the right (CB-453)', () => {
        const row = read('screens/swipe-row.tsx');
        // gesture-handler's activeOffsetX is [dragOffsetFromRight, dragOffsetFromLeft]: a positive
        // offset from the right made any move a swipe, so the list never scrolled from a row.
        expect(row).toContain('dragOffsetFromRight={-12}');
        expect(row).toContain('dragOffsetFromLeft={12}');
        expect(row).not.toMatch(/dragOffsetFromRight=\{\d/);
        expect(row).toContain('enabled: rows.enabled');
    });

    it('keep one row open, close it on a scroll or a tap elsewhere, and stop swipes while scrolling (CB-453)', () => {
        const closed: string[] = [];
        const row = (name: string) => ({ name, close: () => closed.push(name) });
        const group = swipeGroup<ReturnType<typeof row>>();
        const a = row('a');
        const b = row('b');
        group.willOpen(a);
        group.willOpen(a);
        expect(closed).toEqual([]);
        group.willOpen(b);
        expect(closed).toEqual(['a']);
        // A scroll closes the open row and holds the swipes until it settles.
        group.scrollBegin();
        expect(closed).toEqual(['a', 'b']);
        expect(group.state).toEqual({ open: null, scrolling: true });
        group.scrollEnd();
        expect(group.state.scrolling).toBe(false);
        // A tap elsewhere only closes the open row; with none open it goes through.
        group.willOpen(a);
        expect(group.closeOpen()).toBe(true);
        expect(group.closeOpen()).toBe(false);
        group.willOpen(b);
        group.closed(b);
        expect(group.closeOpen()).toBe(false);

        const chats = read('screens/chats.tsx');
        expect(chats).toContain('{...swipes.handlers}');
        expect(chats).toContain('<SwipeGroupProvider value={swipes.value}>');
        expect(chats).toContain('if (!swipes.closeOpen()) {');
        const swipeRow = read('screens/swipe-row.tsx');
        expect(swipeRow).toContain('group.scrollBegin();');
        expect(swipeRow).toContain('enabled.set(false);');
        // Rows swipe again once the list is idle, never only on a momentum end, which an overscroll
        // bounce at the top may never send (seen on iOS: no row swiped after one).
        expect(swipeRow).not.toContain('onMomentumScrollBegin');
        expect(swipeRow).toMatch(
            /onScroll: \(_event[^)]*\) => \{\n\s+if \(group\.state\.scrolling\) \{\n\s+settleLater\(\);/,
        );
    });

    it('buzz once as the full swipe arms, by the Haptics setting, and run the primary on release', () => {
        const row = read('screens/swipe-row.tsx');
        expect(row).toContain("from 'react-native-gesture-handler/ReanimatedSwipeable'");
        expect(row).toContain('if (edge !== null && armed.current !== edge && haptics) {');
        expect(row).toContain('Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)');
        expect(row).toContain("const primary = edge === 'trailing' ? trailing.at(-1) : leading[0];");
    });

    it('send Delete through the chat’s native confirm and Archive through its Undo toast', () => {
        const chats = read('screens/chats.tsx');
        expect(chats).toContain('onPress: () => act(row, view.name)');
        expect(chats).toContain('Alert.alert(DELETE_TITLE, deleteSentence(row.title)');
        expect(chats).toContain('setArchived(row)');
    });

    it('mark a room read from the list up to the newest run the history holds, as the room screen does', async () => {
        const enqueued: NewOutboxWrite[] = [];
        const released: string[] = [];
        const history = {
            pulled: 0,
            use: () => () => released.push('released'),
            pull: async () => {
                history.pulled += 1;
                return true;
            },
            list: () => [{ seq: 4 }, { seq: 9 }],
        };
        const outbox = {
            rows: () => [],
            enqueue: async (row: NewOutboxWrite) => {
                enqueued.push(row);
            },
            update: async () => false,
            revisionOf: () => 0,
        };
        let id = 0;
        const marked = await markRoomReadFromList(
            {
                histories: { preload: async () => history as never },
                outbox: outbox as never,
                newId: () => `id-${++id}`,
            },
            'room-1',
        );
        expect(marked).toBe(true);
        expect(history.pulled).toBe(1);
        expect(released).toEqual(['released']);
        expect(enqueued).toHaveLength(1);
        expect(enqueued[0]).toMatchObject({ kind: ROOM_READ_KIND, lane: 'room-read:room-1' });
        expect(JSON.parse(enqueued[0]!.payload)).toEqual({ roomId: 'room-1', seq: 9 });
    });
});
