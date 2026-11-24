import type { ColorToken } from '../theme/theme';

// Each button variant's look on each platform, under Node: button.tsx
// draws it. iOS 26's capsule styles (filled, tinted, gray, plain) and
// Material 3's common buttons (filled, tonal, outlined, text), the brand's
// teal as the tint everywhere. `fill` is painted by style, so iOS takes the
// system's gray fill and Increase Contrast's primary (native-colors.ts);
// button.tsx's BUTTON_BOXES hold what class names paint (a tint at an
// opacity, a border, the disabled shade, the padding), in full so
// tests/ui/class-names.test.ts reads them.

export type ButtonVariant = 'primary' | 'tinted' | 'secondary' | 'ghost' | 'destructive';

/** What a button's fill is: a token, iOS's gray (`tertiarySystemFill`), or none. */
export type ButtonFill = 'primary' | 'gray' | null;

export interface ButtonLook {
    readonly fill: ButtonFill;
    /** Whether disabled shows the primary's disabled shade (filled), not half opacity. */
    readonly disabledShade: boolean;
    /** The words' and the symbol's color. */
    readonly words: ColorToken | 'white';
    /** iOS dims a button as it is pressed (UIKit's highlight); Android ripples. */
    readonly pressedOpacity: number;
}

const IOS: Readonly<Record<ButtonVariant, ButtonLook>> = {
    primary: {
        fill: 'primary',
        disabledShade: true,
        words: 'primary-foreground',
        pressedOpacity: 0.7,
    },
    tinted: {
        fill: null,
        disabledShade: false,
        words: 'primary',
        pressedOpacity: 0.6,
    },
    secondary: {
        fill: 'gray',
        disabledShade: false,
        words: 'primary',
        pressedOpacity: 0.6,
    },
    ghost: { fill: null, disabledShade: false, words: 'primary', pressedOpacity: 0.4 },
    destructive: {
        fill: null,
        disabledShade: false,
        words: 'white',
        pressedOpacity: 0.7,
    },
};

const ANDROID: Readonly<Record<ButtonVariant, ButtonLook>> = {
    primary: {
        fill: 'primary',
        disabledShade: true,
        words: 'primary-foreground',
        pressedOpacity: 1,
    },
    tinted: {
        fill: null,
        disabledShade: false,
        words: 'primary',
        pressedOpacity: 1,
    },
    secondary: {
        fill: null,
        disabledShade: false,
        words: 'primary',
        pressedOpacity: 1,
    },
    ghost: { fill: null, disabledShade: false, words: 'primary', pressedOpacity: 1 },
    destructive: {
        fill: null,
        disabledShade: false,
        words: 'white',
        pressedOpacity: 1,
    },
};

/** A variant's look on `os`. */
export function buttonLook(variant: ButtonVariant, os: string): ButtonLook {
    return (os === 'ios' ? IOS : ANDROID)[variant];
}
