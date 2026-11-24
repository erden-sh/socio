import type { LinkAction } from './links';
import { routeTab } from './routes';
import { isTabName, type TabName } from './tabs';

// Opening a tab's page from over the tabs. The pages pushed inside a tab
// live in the tabs' own stacks (routes.ts `tab`), so an action that names one,
// dispatched from a screen on the root stack (a sheet: a room invite's Join,
// the Account sheet's Unsent rows; a compose page sheet: File an issue's File,
// New Space's Create), finds no navigator above it that has the page. React
// Navigation hands such an action to the container's `onUnhandledAction`
// (root-navigation.tsx), which dispatches what this returns: the root stack
// back to the tabs (`handOff`, which a compose sheet's draft question lets
// pass, as it lets its own replace), then the page pushed in the tab the person
// is in, or in the page's own tab when that tab has no such page. A replace
// becomes a push: the sheet it replaced is gone, so Back goes to what was
// under it. An action that names its `tab` (New room's Create: the room opens
// in Chats) opens there whichever tab shows. No React Native here, so
// tests/navigation runs it under Node.

/** The slice of React Navigation's state this reads. */
export interface ShellNavState {
    readonly key: string;
    readonly index?: number;
    readonly routeNames?: readonly string[];
    readonly routes: readonly { readonly name: string; readonly state?: ShellNavState }[];
}

/** The root stack's action back to the tabs, marked so a compose sheet's draft question lets it pass. */
export const handOffAction = (root: string) =>
    ({ type: 'POP_TO', payload: { name: 'Tabs', handOff: true }, target: root }) as const;

/** Whether a removal is the hand-off to a tab's page (a draft that was just sent never asks). */
export const isHandOff = (action: { readonly type: string; readonly payload?: object }) =>
    action.type === 'POP_TO' && (action.payload as { handOff?: unknown } | undefined)?.handOff === true;

const OPENS = new Set(['NAVIGATE', 'PUSH', 'REPLACE']);

/**
 * What to dispatch for `action`, which no navigator took, given the root stack's state: nothing
 * when it names no tab's page, or while the gate shows no tabs.
 */
export function tabPageRedirect(
    action: { readonly type: string; readonly payload?: object },
    root: ShellNavState | undefined,
): LinkAction[] {
    const payload = action.payload as
        | { readonly name?: unknown; readonly params?: object; readonly tab?: unknown }
        | undefined;
    const name = payload?.name;
    if (!OPENS.has(action.type) || typeof name !== 'string' || root === undefined) {
        return [];
    }
    // `tab` (`inOwnTabAction`) opens the page in that tab, whichever tab shows.
    const wanted = isTabName(payload?.tab) ? payload.tab : null;
    const home = routeTab(name) === null ? null : (wanted ?? routeTab(name));
    const at = root.routes.findIndex((route) => route.name === 'Tabs');
    if (home === null || at === -1) {
        return [];
    }
    const steps: LinkAction[] = [];
    if ((root.index ?? root.routes.length - 1) > at) {
        steps.push(handOffAction(root.key));
    }
    const type = action.type === 'REPLACE' ? 'PUSH' : action.type;
    const params = payload?.params;
    const tabs = root.routes[at]!.state;
    const shown = tabs?.routes[tabs.index ?? 0];
    const stack = shown?.state;
    if (
        stack !== undefined &&
        isTabName(shown?.name) &&
        (wanted === null || shown.name === wanted) &&
        stack.routeNames?.includes(name) === true
    ) {
        steps.push({ type, payload: { name, params }, target: stack.key });
        return steps;
    }
    const opens = { screen: name, params, initial: false };
    steps.push(
        tabs === undefined
            ? { type: 'NAVIGATE', payload: { name: 'Tabs', params: { screen: home, params: opens } }, target: root.key }
            : { type: 'NAVIGATE', payload: { name: home satisfies TabName, params: opens }, target: tabs.key },
    );
    return steps;
}

/**
 * The redirect's steps in two parts: what goes at once, and what waits until the sheet's removal
 * has mounted. On Android, the sheet's removal and the page's push in one commit make Fabric insert
 * a view that still has its old parent (react-native-screens), and the app stops (`addViewAt`, CB-470:
 * New Space's Create and New room's did on main). So there the push waits for the next frame.
 */
export function redirectSteps(steps: readonly LinkAction[], os: string): { now: LinkAction[]; later: LinkAction[] } {
    const [first, ...rest] = steps;
    return first !== undefined && os === 'android' && isHandOff(first) && rest.length > 0
        ? { now: [first], later: rest }
        : { now: [...steps], later: [] };
}
