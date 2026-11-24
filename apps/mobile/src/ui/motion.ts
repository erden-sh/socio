// The app's motion: each platform's own springs where the app moves
// something itself (the workspace drawer, a disclosure's chevron, the page
// editor's bar title). Pushes, pops, sheets, menus and the tab bar are the
// system's and keep its motion.
//
// - iOS: UIKit's spring without bounce (a damping ratio of 1), as
//   `UISpringTimingParameters`' smooth spring, with a response (the period
//   of the undamped spring) of 0.4 s for things that move across the screen
//   and 0.3 s for small ones.
// - Android: Material 3's motion scheme (Expressive), whose spatial springs
//   are 0.9 damped at stiffness 700 (default) and 1400 (fast), and whose
//   effects springs (opacity, color) are critically damped at 1600.
//
// With Reduce Motion on, callers jump to the end: no spring, so no overshoot.
// No React Native here, so tests/ui runs it under Node; every function is a
// worklet, so reanimated's UI thread can call it.

/** A spring's physics, in reanimated's and React Native Animated's terms (mass 1). */
export interface SpringSpec {
    readonly stiffness: number;
    readonly damping: number;
    readonly mass: 1;
}

/** What moves: across the screen (`spatial`), a small part (`fast`), or a fade (`effects`). */
export type SpringKind = 'spatial' | 'fast' | 'effects';

/** A spring with damping ratio `ratio` and stiffness `stiffness`, mass 1. */
function physics(ratio: number, stiffness: number): SpringSpec {
    'worklet';
    return { stiffness, damping: Math.round(2 * ratio * Math.sqrt(stiffness) * 10) / 10, mass: 1 };
}

/** A spring with damping ratio `ratio` that takes `response` seconds per undamped period (UIKit's terms). */
function response(ratio: number, seconds: number): SpringSpec {
    'worklet';
    const omega = (2 * Math.PI) / seconds;
    return physics(ratio, Math.round(omega * omega * 10) / 10);
}

/** The platform's spring for `kind`: UIKit's smooth spring on iOS, Material 3's elsewhere. */
export function systemSpring(os: string, kind: SpringKind): SpringSpec {
    'worklet';
    if (os === 'ios') {
        return response(1, kind === 'fast' ? 0.3 : 0.4);
    }
    if (kind === 'effects') {
        return physics(1, 1600);
    }
    return physics(0.9, kind === 'fast' ? 1400 : 700);
}

/** The damping ratio of `spring`: 1 or more never overshoots its end. */
export function dampingRatio(spring: SpringSpec): number {
    'worklet';
    return spring.damping / (2 * Math.sqrt(spring.stiffness * spring.mass));
}
