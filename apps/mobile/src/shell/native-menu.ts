import type { MenuAction } from '../chat/long-press';

// The native menus (CB-421; the owner, 2026-11-18: each platform's own
// components): every ⋯ and every long-press opens the system's menu through
// @react-native-menu/menu's MenuView, as T3 Code's do. On iOS a ⋯ opens a
// UIMenu pull-down from its button and a long-press a context menu with the
// row lifted as its preview; on Android a Material popup menu at the button
// or row. `useActionMenu`'s items stay the one source, so the rows'
// accessibility actions and the menus never part. No React Native here:
// tests/shell runs it under Node.

/** One item as MenuView takes it (its `MenuAction`, without the colors). */
export interface NativeMenuItem {
    readonly id: string;
    readonly title: string;
    /** An SF Symbol, iOS only: Android's Material popups carry no icons. */
    readonly image?: string;
    /**
     * The symbol's color. Always set with an image: MenuView on the new
     * architecture sends an unset color as 0 and tints the symbol clear.
     */
    readonly imageColor?: string;
    readonly state?: 'on';
    readonly attributes?: { readonly destructive?: boolean; readonly disabled?: boolean };
}

/**
 * Each action's SF Symbol, by its name: one table for every menu, so a menu
 * never draws an icon language of its own. An action not here has none.
 */
export const MENU_SYMBOLS: Readonly<Record<string, string>> = {
    reply: 'arrowshape.turn.up.left',
    copy: 'doc.on.doc',
    share: 'square.and.arrow.up',
    'react:up': 'hand.thumbsup',
    'react:down': 'hand.thumbsdown',
    'react:retry': 'arrow.clockwise',
    'react:needs-work': 'wrench.adjustable',
    rename: 'pencil',
    archive: 'archivebox',
    delete: 'trash',
    'report-issue': 'exclamationmark.bubble',
    'pause-all': 'pause.circle',
    'resume-all': 'play.circle',
    'save-page': 'doc.badge.plus',
    schedule: 'calendar.badge.clock',
    move: 'folder',
    'set-cover': 'photo',
    'remove-cover': 'rectangle.badge.minus',
    'turn-into-folder': 'folder',
    'turn-into-page': 'doc.text',
    'new-page': 'doc.badge.plus',
    'new-folder': 'folder.badge.plus',
    'keep-draft': 'square.and.arrow.down',
    'discard-draft': 'trash',
};

/** The symbols' colors: the label's, and the destructive red. */
export interface MenuIconColors {
    readonly icon: string;
    readonly destructive: string;
}

/** A menu's items for MenuView on `os`: destructive ones red, disabled ones dimmed, a choice checked. */
export function nativeMenuItems(
    actions: readonly MenuAction[],
    os: string,
    colors: MenuIconColors = { icon: '#000000', destructive: '#ff3b30' },
): NativeMenuItem[] {
    return actions.map((action) => {
        const symbol = action.icon ?? MENU_SYMBOLS[action.name];
        const attributes =
            action.destructive === true || action.disabled === true
                ? {
                      ...(action.destructive === true ? { destructive: true } : {}),
                      ...(action.disabled === true ? { disabled: true } : {}),
                  }
                : undefined;
        return {
            id: action.name,
            title: action.label,
            ...(os === 'ios' && symbol !== undefined
                ? { image: symbol, imageColor: action.destructive === true ? colors.destructive : colors.icon }
                : {}),
            ...(action.checked === true ? { state: 'on' as const } : {}),
            ...(attributes === undefined ? {} : { attributes }),
        };
    });
}

/** The action a menu's `onPressAction` named, unless it is disabled or unknown. */
export function chosenAction(actions: readonly MenuAction[], id: string | undefined): MenuAction | null {
    const action = actions.find((known) => known.name === id);
    return action === undefined || action.disabled === true ? null : action;
}

/** What opens the menu: a tap on a ⋯ or a field's button, or a long-press on a row. */
export type MenuTrigger = 'press' | 'longPress';

/**
 * How a long-press row hands the gesture to the menu: its own `onLongPress`
 * does nothing (the system's menu opens), so a hold never ends in a tap.
 */
export const LONG_PRESS_TO_MENU = () => {};

/** A ⋯ button's own `onPress` under a `press` menu: the menu takes the tap, the button only draws it. */
export const MENU_TAKES_TAP = () => {};
