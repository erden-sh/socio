// The workspace drawer (Slack's), drawn by hand with gesture-handler and
// reanimated (shell-drawer.tsx) over the native tabs and their tab bar. It
// holds only the workspace list (src/shell/workspaces.ts). This file holds the
// drawer's geometry, when a swipe may open it and how a drag settles (a spring
// that carries the finger's speed, like Slack's). No React Native here, so
// tests/navigation runs it under Node; what the pan calls is a worklet, so
// reanimated runs it on the UI thread (drawer-gesture.ts).

import { type SpringSpec, systemSpring } from '../ui/motion';

/** How far from the left edge a swipe opens the drawer, in points. */
export const DRAWER_EDGE = 24;

/**
 * Whether a pan may move the drawer. Open, it may on both platforms (anywhere,
 * to close it). Closed, only on iOS and only on Home, from the left edge
 * (drawerHitSlop), as Slack's: Android's gesture navigation takes a swipe
 * from either edge as back, so there the workspace button alone opens it.
 */
export const drawerPanEnabled = (open: boolean, onHome: boolean, os: string) => open || (os === 'ios' && onHome);

/** Where a pan may start: the left edge while closed, anywhere while open. */
export const drawerHitSlop = (open: boolean) => (open ? undefined : ({ left: 0, width: DRAWER_EDGE } as const));

/** The drawer's widest, in points: a phone always sees a strip of the page beside it. */
export const DRAWER_MAX_WIDTH = 320;

/** How far ahead a release's speed carries the drawer, in seconds of travel. */
const TOSS = 0.08;

/** The drawer's width on a window `windowWidth` wide: 85 % of it, at most DRAWER_MAX_WIDTH. */
export const drawerWidth = (windowWidth: number) => Math.round(Math.min(DRAWER_MAX_WIDTH, windowWidth * 0.85));

/** How open the drawer is (0 to 1) after a drag of `translationX` from `start` open. */
export function dragProgress(start: number, translationX: number, width: number): number {
    'worklet';
    if (width <= 0) {
        return start >= 0.5 ? 1 : 0;
    }
    return Math.min(1, Math.max(0, start + translationX / width));
}

/** Whether a drag released at `progress`, moving at `velocityX`, settles open. */
export function settlesOpen(progress: number, velocityX: number, width: number): boolean {
    'worklet';
    return progress + (width > 0 ? (velocityX * TOSS) / width : 0) > 0.5;
}

/** A release's speed in drawer widths a second: the spring starts at the finger's speed. */
export function progressVelocity(velocityX: number, width: number): number {
    'worklet';
    return width > 0 ? velocityX / width : 0;
}

/** How the drawer settles, or null to jump there (Reduce Motion on: its slide is decoration, no spring, no overshoot). */
export function drawerSettle(
    os: string,
    reduceMotion: boolean,
    velocity: number,
): (SpringSpec & { readonly velocity: number }) | null {
    'worklet';
    return reduceMotion ? null : { ...systemSpring(os, 'spatial'), velocity };
}

/** What the panel and the scrim draw for `progress`: never past closed or open, whatever the spring does. */
export function shownProgress(progress: number): number {
    'worklet';
    return Math.min(1, Math.max(0, progress));
}
