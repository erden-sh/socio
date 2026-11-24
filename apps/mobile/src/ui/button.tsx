import { ActivityIndicator, Platform, PlatformColor, Pressable } from 'react-native';

import { useColorValue } from '../theme/native-colors';

import { AppSymbol } from './app-symbol';
import { buttonLook, type ButtonVariant } from './button-look';
import { cx } from './cx';
import type { SymbolName } from './symbols';
import { Text } from './text';

export type { ButtonVariant } from './button-look';

// A button in each platform's own style (the owner, 2026-11-18: the
// web's brand in each platform's components), with the brand's teal as its
// tint (button-look.ts says each variant's look on each platform):
// - iOS 26: a capsule. `primary` filled for the main action, `tinted` the tint
//   at a low opacity, `secondary` gray (the system's tertiary fill, the words
//   in the tint), `ghost` plain (the words in the tint), `destructive` filled
//   red. The words in the `button` role (iOS's medium button: the Subheadline,
//   semibold) and an SF Symbol at the same weight. Pressed, it dims, as UIKit's
//   do.
// - Android: Material 3's common buttons, fully rounded: filled (`primary`,
//   `destructive`), tonal (`tinted`, `secondary`: the tint's container) and
//   text (`ghost`), with the ripple.
// 44 pt tall at least (a phone's target), as wide as its label in a row or a
// centered column and across a plain column (a form's actions). Disabled keeps
// a filled button's words readable on the primary's disabled shade, the others
// at half opacity. It grows with its label at large text sizes.

export interface ButtonProps {
    /** Its words, or what a screen reader says for an icon-only button. */
    readonly label: string;
    readonly onPress: () => void;
    readonly variant?: ButtonVariant;
    readonly icon?: SymbolName;
    /** Only the icon shows, in a 44 pt circle. */
    readonly iconOnly?: boolean;
    readonly disabled?: boolean;
    /** Working: a spinner in place of the icon, and no taps until it ends. */
    readonly busy?: boolean;
    readonly accessibilityHint?: string;
    readonly testID?: string;
}

const ios = Platform.OS === 'ios';

/** What class names paint, per platform and variant: the tint at an opacity, a border, the disabled shade, the padding. */
const BUTTON_BOXES = {
    ios: {
        primary: { box: 'disabled:bg-primary-disabled', padding: 'px-5 py-2' },
        tinted: { box: 'bg-primary/10', padding: 'px-5 py-2' },
        secondary: { box: '', padding: 'px-5 py-2' },
        ghost: { box: '', padding: 'px-3 py-2' },
        destructive: { box: 'bg-destructive dark:bg-destructive/60', padding: 'px-5 py-2' },
    },
    android: {
        primary: { box: 'disabled:bg-primary-disabled', padding: 'px-6 py-2' },
        tinted: { box: 'bg-primary/10', padding: 'px-6 py-2' },
        secondary: { box: 'border border-border', padding: 'px-6 py-2' },
        ghost: { box: '', padding: 'px-3 py-2' },
        destructive: { box: 'bg-destructive dark:bg-destructive/60', padding: 'px-6 py-2' },
    },
} as const satisfies Record<'ios' | 'android', Record<ButtonVariant, { box: string; padding: string }>>;

export function Button({
    label,
    onPress,
    variant = 'primary',
    icon,
    iconOnly = false,
    disabled = false,
    busy = false,
    accessibilityHint,
    testID,
}: ButtonProps) {
    const look = buttonLook(variant, Platform.OS);
    const paint = BUTTON_BOXES[ios ? 'ios' : 'android'][variant];
    const inactive = disabled || busy;
    // The fill and the words: iOS's gray fill and Increase Contrast's accents (native-colors.ts).
    const primary = useColorValue('primary');
    const tint = useColorValue(look.words === 'white' ? 'primary' : look.words);
    const words = look.words === 'white' ? '#ffffff' : tint;
    const fill =
        look.fill === 'primary' && !(disabled && look.disabledShade)
            ? primary
            : look.fill === 'gray'
              ? PlatformColor('tertiarySystemFill')
              : null;
    return (
        <Pressable
            testID={testID}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityHint={accessibilityHint}
            accessibilityState={{ disabled: inactive, busy }}
            disabled={inactive}
            onPress={onPress}
            android_ripple={ios ? undefined : { borderless: false, foreground: true }}
            className={cx(
                'min-h-11 flex-row items-center justify-center gap-2 overflow-hidden rounded-full',
                iconOnly ? 'min-w-11' : paint.padding,
                paint.box,
            )}
            style={({ pressed }) => [
                fill === null ? null : { backgroundColor: fill },
                ios && pressed ? { opacity: look.pressedOpacity } : null,
                inactive && !busy && !look.disabledShade ? { opacity: 0.5 } : null,
            ]}
        >
            {busy ? (
                <ActivityIndicator size="small" color={words} />
            ) : icon === undefined ? null : (
                <AppSymbol name={icon} weight="semibold" color={{ value: words }} />
            )}
            {iconOnly ? null : (
                <Text variant="button" className="shrink text-center" style={{ color: words }}>
                    {label}
                </Text>
            )}
        </Pressable>
    );
}
