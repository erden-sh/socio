import type { ColorToken } from '../theme/theme';

// Swipe actions on rows, under Node: which actions a row has, their
// colors and where a swipe opens and arms. Only actions the app already has:
// - a private chat's row (Chats): Archive, the primary (a full swipe; "Chat
//   archived" with Undo, the long-press menu's), and Delete, red, which asks
//   first as the menu's does (deletes are soft on the server, and the native
//   confirm stands before it);
// - a room with unread (Chats, the Inbox): Mark read, toward the leading edge,
//   the room screen's own read mark;
// - nothing on the Board's rows: a status change has six targets and is an
//   admin's alone, so no one swipe means it (the issue's fields set it).
// No pin: the app has none.

export type SwipeEdge = 'trailing' | 'leading';
export type SwipeTone = 'primary' | 'destructive' | 'neutral';

export interface SwipeActionView {
    /** Its accessibility action's name, the long-press menu's (`archive`, `delete`, `read`). */
    readonly name: string;
    readonly label: string;
    readonly tone: SwipeTone;
    readonly testID?: string;
}

export const SWIPE_ARCHIVE: SwipeActionView = { name: 'archive', label: 'Archive', tone: 'primary' };
export const SWIPE_DELETE: SwipeActionView = { name: 'delete', label: 'Delete', tone: 'destructive' };
export const SWIPE_READ: SwipeActionView = { name: 'read', label: 'Mark read', tone: 'primary' };

/** A row's actions toward each edge: the primary nearest the edge (last of `trailing`, first of `leading`). */
export function chatSwipeActions(row: { readonly room: boolean; readonly unread: number | null }): {
    readonly trailing: readonly SwipeActionView[];
    readonly leading: readonly SwipeActionView[];
} {
    if (row.room) {
        return { trailing: [], leading: (row.unread ?? 0) > 0 ? [SWIPE_READ] : [] };
    }
    // Delete inside, Archive at the edge: the full swipe archives, which Undo takes back.
    return { trailing: [SWIPE_DELETE, SWIPE_ARCHIVE], leading: [] };
}

/** Each tone's pane: its fill, and its symbol's and word's color on it (the web's tokens). */
export function swipeTone(tone: SwipeTone): {
    readonly background: ColorToken;
    readonly foreground: 'primary-foreground' | 'white' | 'secondary-foreground';
    readonly text: 'on-primary' | 'on-destructive' | 'on-secondary';
} {
    switch (tone) {
        case 'primary':
            return { background: 'primary', foreground: 'primary-foreground', text: 'on-primary' };
        case 'destructive':
            return { background: 'destructive', foreground: 'white', text: 'on-destructive' };
        case 'neutral':
            return { background: 'secondary', foreground: 'secondary-foreground', text: 'on-secondary' };
    }
}

/** A pane's width, in points: Mail's, room for "Archive" and "Mark read" at the default text size. */
export const SWIPE_PANE = 80;

/**
 * Where a row with `count` actions opens (released past `openAt`, it stays open showing them) and
 * where a full swipe arms (`fullAt`, past which release runs the primary): over half the row, and
 * never before the panes are all out. `pane` is the platform's (`swipePaneLook`).
 */
export function swipeLayout(count: number, rowWidth: number, pane: number = SWIPE_PANE) {
    const shown = pane * count;
    return {
        pane,
        openAt: shown * 0.4,
        fullAt: Math.max(shown + 48, rowWidth * 0.55),
    };
}

/** How one platform draws a pane (`swipePaneLook`). */
export interface SwipePaneLook {
    readonly fill: 'circle' | 'pane';
    /** The pane's width, in points. */
    readonly pane: number;
    /** The filled circle's size on iOS; 0 on Android, whose pane is the fill. */
    readonly circle: number;
    /** The symbol's size. */
    readonly icon: number;
    /** The word's role under the symbol (type-scale.ts). */
    readonly label: 'caption2' | 'footnote';
    /** How far the word grows with the system's text size: past it, it would leave the row (CB-454). */
    readonly labelMaxScale: number;
}

/**
 * How a pane draws on each platform: iOS 26's swipe actions are filled circles with the word under
 * them over the row's own color (Reminders, Mail); Android's (Gmail, Material) fill the pane. The
 * symbol and its word fit inside a chat row's 64 pt, centered (CB-454: a 48 pt circle and a footnote
 * filled the row to its edges and read as hanging below it): iOS's 36 pt circle (T3 Code's), a 4 pt
 * gap and a Caption 2 word, 54 pt in all.
 */
export function swipePaneLook(os: string): SwipePaneLook {
    return os === 'ios'
        ? { fill: 'circle', pane: 64, circle: 36, icon: 16, label: 'caption2', labelMaxScale: 1.1 }
        : { fill: 'pane', pane: SWIPE_PANE, circle: 0, icon: 20, label: 'footnote', labelMaxScale: 1.1 };
}

/** The tallest a pane's symbol and word stand, in points, at the default text size (they fit a 64 pt row). */
export function swipePaneContentHeight(look: SwipePaneLook): number {
    const lineHeight = look.label === 'caption2' ? 13 : 18;
    return (look.fill === 'circle' ? look.circle : look.icon) + 4 + lineHeight * look.labelMaxScale;
}

/**
 * The list's scroll and its rows' swipes (CB-453), Mail's rules: one row open at a time (opening
 * another closes it), a scroll or a tap on another row closes it (the tap only closes), and while
 * the list scrolls no row swipes, so a vertical drag that drifts sideways stays the list's. No React
 * Native here: screens/swipe-row.tsx holds the rows' methods and the gate's shared value.
 */
export interface SwipeGroupState<Row> {
    open: Row | null;
    scrolling: boolean;
}

export function swipeGroup<Row extends { close(): void }>() {
    const state: SwipeGroupState<Row> = { open: null, scrolling: false };
    const closeOpen = (): boolean => {
        const row = state.open;
        if (row === null) {
            return false;
        }
        state.open = null;
        row.close();
        return true;
    };
    return {
        state,
        /** A row starts to open: any other open row closes. */
        willOpen(row: Row) {
            if (state.open !== null && state.open !== row) {
                state.open.close();
            }
            state.open = row;
        },
        /** A row closed. */
        closed(row: Row) {
            if (state.open === row) {
                state.open = null;
            }
        },
        /** Closes the open row, if any: true when one was (a tap elsewhere then only closes it). */
        closeOpen,
        /** The list starts a drag: the open row closes, and no row swipes until it settles. */
        scrollBegin() {
            state.scrolling = true;
            closeOpen();
        },
        /** The list settled (its drag ended with no momentum, or its momentum ended). */
        scrollEnd() {
            state.scrolling = false;
        },
    };
}

export type SwipeGroup<Row extends { close(): void }> = ReturnType<typeof swipeGroup<Row>>;
