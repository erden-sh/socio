import type { Edge } from 'react-native-safe-area-context';

/**
 * A tab's safe areas: the native tab bar keeps the bottom one clear (on iOS its
 * scroll view insets itself under the glass bar; src/navigation/shell-tabs.tsx).
 */
export const TAB_EDGES: readonly Edge[] = ['top', 'right', 'left'];

/**
 * A tab in its own stack (Chats, the Inbox, More; navigation/tab-stack.tsx): the
 * tab's bar keeps the top clear and, on iOS, UIKit insets the content by the bar
 * and the tab bar (CB-420).
 */
export const TAB_STACK_EDGES: readonly Edge[] = ['right', 'left'];

/**
 * Whether a tab's root follows the keyboard: never, unless it has a field of its own
 * (Search). A tab switch is native first: iOS shows Search's keyboard as its tab is
 * chosen (`tabBarSearchAutoFocus`), and the tab that was showing hears that keyboard
 * before React Navigation tells it it lost focus, so the focus rule (CB-461) comes too
 * late, and React Native's keyboard insets scrolled the list under its bar (CB-462).
 * With no field, a tab's root has nothing to lift, so it never listens.
 */
export const TAB_ROOT_KEYBOARD = false;
