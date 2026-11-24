/**
 * Touch targets in a room's screens (CB-219): on a touch screen a control
 * is at least 44 px tall (or square, for an icon), however compact it is
 * with a mouse. `pointer-coarse`, as the 16 px fields in globals.css: an
 * iPhone in landscape is wider than a phone's breakpoint.
 */
export const touchTarget = 'pointer-coarse:min-h-11';
/** An icon-only control: 44 px square on a touch screen. */
export const touchIcon = 'pointer-coarse:size-11';
