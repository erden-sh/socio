import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MODULE_IDS } from '@socio/shared/modules';

import { workspaceLayout } from '../../src/data/layout';
import {
    DRAWER_EDGE,
    DRAWER_MAX_WIDTH,
    dragProgress,
    drawerSettle,
    drawerHitSlop,
    drawerPanEnabled,
    drawerWidth,
    progressVelocity,
    settlesOpen,
    shownProgress,
} from '../../src/navigation/drawer';
import { DRAWER_FOOTER, drawerWorkspaces, workspaceLogoPath } from '../../src/shell/workspaces';
import { systemSpring } from '../../src/ui/motion';

// The workspace drawer (Slack's):
// its workspace rows and footer, how a drag settles and Reduce Motion, when a
// swipe may open it, and that the app is wired to it. No React Native renderer
// under Node, so the .tsx files are read as text. Maestro's flows wait for a
// later harness.

const src = join(import.meta.dirname, '../../src');
const read = (file: string) => readFileSync(join(src, file), 'utf8');

const ROOT = '/data/app';
const id = (c: string) => c.repeat(64);
const row = (c: string, fields: Partial<Parameters<typeof drawerWorkspaces>[0][number]> = {}) => ({
    id: id(c),
    origin: `https://${c}.socio.test`,
    state: 'ready',
    name: `Workspace ${c}`,
    logo: null,
    personName: 'Ana',
    personEmail: 'ana@example.test',
    lastUsed: 1,
    endedAt: null,
    leaseLockedAt: null,
    unread: null,
    waiting: null,
    ...fields,
});

describe('the drawer’s workspace rows', () => {
    it('lists every ready workspace, the open one first and highlighted, then the most recently used', () => {
        const rows = drawerWorkspaces(
            [
                row('a', { lastUsed: 5 }),
                row('b', { lastUsed: 9 }),
                row('c', { lastUsed: 7 }),
                row('d', { state: 'pending' }),
            ],
            id('c'),
            ROOT,
        );
        expect(rows.map((r) => [r.name, r.active])).toEqual([
            ['Workspace c', true],
            ['Workspace b', false],
            ['Workspace a', false],
        ]);
        expect(rows[0]).toMatchObject({ host: 'c.socio.test', testID: 'drawer-workspace-c.socio.test' });
    });

    it('shows the staged logo from the workspace’s directory, else the mascot', () => {
        const [withLogo, without] = drawerWorkspaces(
            [row('a', { logo: 'logo.png', lastUsed: 2 }), row('b', { logo: null })],
            id('a'),
            ROOT,
        );
        expect(withLogo!.logoPath).toBe(`${workspaceLayout(ROOT, id('a')).directory}/logo.png`);
        expect(without!.logoPath).toBeNull();
        // Never a path the registry didn't write: a damaged name shows the mascot.
        expect(workspaceLogoPath(ROOT, id('a'), '../other/logo.png')).toBeNull();
        expect(workspaceLogoPath(ROOT, id('a'), 'logo.svg')).toBeNull();
    });

    it('badges the unread the registry kept, capped as the web caps counts, and says it', () => {
        const [a, b, c] = drawerWorkspaces(
            [row('a', { unread: 3, lastUsed: 3 }), row('b', { unread: 140, lastUsed: 2 }), row('c', { unread: 0 })],
            id('a'),
            ROOT,
        );
        expect([a!.unreadLabel, b!.unreadLabel, c!.unreadLabel]).toEqual(['3', '99+', null]);
        expect(a!.accessibilityLabel).toBe('Workspace a, a.socio.test, current workspace, 3 unread');
        expect(c!.accessibilityLabel).toBe('Workspace c, c.socio.test');
    });

    it('says a state the person must know under the host: signed out, locked, or didn’t open', () => {
        const rows = drawerWorkspaces(
            [
                row('a', { lastUsed: 3 }),
                row('b', { endedAt: 5, lastUsed: 2 }),
                row('c', { leaseLockedAt: 5, lastUsed: 1 }),
            ],
            id('a'),
            ROOT,
            { failed: true },
        );
        expect(rows.map((r) => r.notice)).toEqual(['Didn’t open', 'Signed out', 'Locked']);
        expect(drawerWorkspaces([row('a')], id('a'), ROOT)[0]!.notice).toBeNull();
    });

    it('never shows the person’s email: the account sheet keeps account things', () => {
        for (const r of drawerWorkspaces([row('a'), row('b')], id('a'), ROOT)) {
            expect(JSON.stringify(r)).not.toContain('ana@example.test');
        }
    });

    it('ends with Add a workspace, Settings and Help, Help the web’s help center', () => {
        expect(DRAWER_FOOTER.map((f) => [f.label, f.action.kind])).toEqual([
            ['Add a workspace', 'add-workspace'],
            ['Settings', 'settings'],
            ['Help', 'web'],
        ]);
        expect(DRAWER_FOOTER[1]!.action).toEqual({ kind: 'settings', id: MODULE_IDS.settings });
        expect(DRAWER_FOOTER[2]!.action).toEqual({ kind: 'web', href: '/docs' });
        // The web's Help module opens /docs (packages/client's help module).
        expect(readFileSync(join(src, '../../../packages/client/src/modules/help/module.tsx'), 'utf8')).toContain(
            "opens: { path: '/docs' }",
        );
    });

    it('opens Help in the in-app browser of the open workspace, and hides it with none open', () => {
        const panel = read('screens/drawer-panel.tsx');
        expect(panel).not.toContain('Comes in a later release');
        expect(panel).not.toContain("'placeholder'");
        expect(panel).toContain('const openLink = useOpenLink();');
        expect(panel).toContain('onWeb={(href) => openLink(href, { web: true })}');
        expect(panel).toContain('openId={null} onWeb={null}');
        expect(panel).toContain("row.action.kind !== 'web' || onWeb !== null");
    });
});

describe('the drawer’s motion', () => {
    it('is 85 % of the window, at most 320 points, opened from a 24-point edge', () => {
        expect(drawerWidth(393)).toBe(DRAWER_MAX_WIDTH);
        expect(drawerWidth(320)).toBe(272);
        expect(DRAWER_EDGE).toBe(24);
        expect(drawerHitSlop(false)).toEqual({ left: 0, width: DRAWER_EDGE });
        expect(drawerHitSlop(true)).toBeUndefined();
    });

    it('opens by a swipe only on iOS and only on Home; open, a swipe closes it on both', () => {
        expect(drawerPanEnabled(false, true, 'ios')).toBe(true);
        expect(drawerPanEnabled(false, false, 'ios')).toBe(false);
        // Android's gesture navigation takes the edge as back: the workspace button opens it there.
        expect(drawerPanEnabled(false, true, 'android')).toBe(false);
        expect(drawerPanEnabled(true, false, 'android')).toBe(true);
        expect(drawerPanEnabled(true, false, 'ios')).toBe(true);
    });

    it('follows a drag between closed and open, never past either', () => {
        expect(dragProgress(0, 150, 300)).toBe(0.5);
        expect(dragProgress(1, -75, 300)).toBe(0.75);
        expect(dragProgress(0, -40, 300)).toBe(0);
        expect(dragProgress(1, 90, 300)).toBe(1);
        expect(dragProgress(0.4, 10, 0)).toBe(0);
    });

    it('settles open past halfway, or with a fling the way it moves', () => {
        expect(settlesOpen(0.6, 0, 300)).toBe(true);
        expect(settlesOpen(0.4, 0, 300)).toBe(false);
        expect(settlesOpen(0.2, 2000, 300)).toBe(true);
        expect(settlesOpen(0.8, -2000, 300)).toBe(false);
    });

    it('settles with the platform’s spring from the finger’s speed, at once with Reduce Motion on', () => {
        expect(progressVelocity(600, 300)).toBe(2);
        expect(progressVelocity(600, 0)).toBe(0);
        expect(drawerSettle('ios', false, 2)).toEqual({ ...systemSpring('ios', 'spatial'), velocity: 2 });
        expect(drawerSettle('android', false, -1)).toEqual({ ...systemSpring('android', 'spatial'), velocity: -1 });
        // Reduce Motion: no spring, so no overshoot; it jumps.
        expect(drawerSettle('ios', true, 2)).toBeNull();
        expect(drawerSettle('android', true, 2)).toBeNull();
        const gesture = read('navigation/drawer-gesture.ts');
        expect(gesture).toContain(
            'progress.set(spring === null ? target : withSpring(target, { ...spring, reduceMotion: ReduceMotion.System }));',
        );
        const drawer = read('navigation/shell-drawer.tsx');
        expect(drawer).toContain('useReducedMotion()');
        expect(drawer).toContain('settleDrawer(progress, toOpen, 0, Platform.OS, reduceMotion);');
    });

    it('never draws the panel past open or closed, whatever the spring does', () => {
        expect(shownProgress(1.04)).toBe(1);
        expect(shownProgress(-0.02)).toBe(0);
        expect(shownProgress(0.3)).toBe(0.3);
        const drawer = read('navigation/shell-drawer.tsx');
        expect(drawer).toContain('translateX: (shownProgress(progress.get()) - 1) * width');
        expect(drawer).toContain('opacity: shownProgress(progress.get())');
    });

    it('runs the pan on the UI thread: worklets made outside the React Compiler’s reach', () => {
        const drawer = read('navigation/shell-drawer.tsx');
        expect(drawer).not.toContain('runOnJS');
        expect(drawer).toContain('const callbacks = drawerPanCallbacks({');
        expect(drawer).toContain('onUpdate: callbacks.onUpdate,');
        const gesture = read('navigation/drawer-gesture.ts');
        // A plain function, not a component or a hook, so the compiler never rewrites it.
        expect(gesture).toContain('export function drawerPanCallbacks(pan: DrawerPan) {');
        for (const callback of ['onActivate', 'onUpdate', 'onDeactivate']) {
            expect(gesture).toMatch(new RegExp(`${callback}: \\([^)]*\\) => \\{\\n\\s+'worklet';`));
        }
        // Only the side it settles on goes back to React.
        expect(gesture).toContain('scheduleOnRN(onSettled, toOpen);');
        const math = read('navigation/drawer.ts');
        for (const name of ['dragProgress', 'settlesOpen', 'progressVelocity', 'drawerSettle', 'shownProgress']) {
            expect(math).toMatch(new RegExp(`export function ${name}\\([^]*?\\{\\n {4}'worklet';`));
        }
    });
});

describe('the app wired to the drawer', () => {
    it('holds everything in gesture-handler’s root view', () => {
        const root = read('app.tsx');
        expect(root).toContain("import { GestureHandlerRootView } from 'react-native-gesture-handler';");
        expect(root.indexOf('<GestureHandlerRootView')).toBeLessThan(root.indexOf('<SafeAreaProvider>'));
    });

    it('wraps the native tab navigator, tab bar included, knowing whether Home shows', () => {
        expect(read('navigation/shell-tabs.tsx')).toContain(
            "<ShellDrawer onHome={state.routes[state.index]?.name === 'Home'} navigation={navigation}>",
        );
    });

    it('opens by an edge swipe and by Home’s workspace button, with gesture-handler and reanimated', () => {
        const drawer = read('navigation/shell-drawer.tsx');
        expect(drawer).toContain('usePanGesture({');
        expect(drawer).toContain('enabled: drawerPanEnabled(open, onHome, Platform.OS),');
        expect(drawer).toContain('hitSlop: drawerHitSlop(open),');
        // Closed, only a rightward pan opens it, and a vertical one (a scroll) never does.
        expect(drawer).toContain('activeOffsetX: open ? -10 : 10,');
        expect(drawer).toContain('failOffsetY: [-15, 15],');
        expect(drawer).toContain('<DrawerContext value={controls}>');
        expect(drawer).toContain("from 'react-native-reanimated'");
        const home = read('screens/home-parts.tsx');
        expect(home).toContain('const drawer = useDrawer();');
        expect(home).toContain('onPress={drawer?.open}');
        expect(home).toContain('testID="open-workspaces"');
    });

    it('can be closed from inside its modal view, by its Close button and VoiceOver’s escape', () => {
        const drawer = read('navigation/shell-drawer.tsx');
        expect(drawer).toContain('accessibilityViewIsModal={open}');
        expect(drawer).toContain('onAccessibilityEscape={controls.close}');
        expect(drawer).toContain('onClose={controls.close}');
        const panel = read('screens/drawer-panel.tsx');
        expect(panel).toContain('label="Close workspaces"');
        expect(panel).toContain('onPress={props.onClose}');
        expect(panel).toContain('testID="close-drawer"');
    });

    it('switches through the active scope, and the account sheet has no workspace list any more', () => {
        expect(read('screens/drawer-panel.tsx')).toContain('switchTo(row.id)');
        expect(read('screens/drawer-panel.tsx')).toContain('startAdding()');
        const account = read('screens/account.tsx');
        expect(account).not.toMatch(/<Switcher openId=\{scope/);
        // A workspace that didn't open still offers the switcher.
        expect(read('screens/workspace-failed.tsx')).toContain(
            '<Switcher openId={workspaceId} onOpen={retry} failed />',
        );
    });
});
