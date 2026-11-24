import { Platform, Text as NativeText, type TextProps as NativeTextProps, useWindowDimensions } from 'react-native';

import { useColorValue } from '../theme/native-colors';
import type { FontWeightName } from '../theme/theme';

import { cx } from './cx';
import { fontWeight, monoFamily, textLook, type TextVariant } from './type-scale';

// Text on each platform's own type scale: a variant names a role, an iOS text
// style (`body`, `subheadline`, `footnote`, …) or what the app gives one (`title`, `row-title`, `meta`,
// `message`), and each platform draws it its own way: iOS's text style in SF
// Pro, Material 3's role in Roboto (type-scale.ts). The default is the Body:
// 17 pt on iOS, bodyLarge's 16 on Android. It scales with the system's text
// size (Dynamic Type, Android's font size), never under 12 pt, and wraps rather
// than clips. A prop given beside the variant wins. Its neutral tones are the
// system's label colors on iOS (native-colors.ts, by the CSS variables), and
// the primary and destructive tones take Increase Contrast's variants there.

const TONES = {
    default: 'text-foreground',
    muted: 'text-muted-foreground',
    primary: 'text-primary',
    destructive: 'text-destructive',
    'on-primary': 'text-primary-foreground',
    'on-secondary': 'text-secondary-foreground',
    'on-destructive': 'text-white',
    'on-bubble': 'text-user-bubble-foreground',
    'on-pending-bubble': 'text-user-bubble-pending-foreground',
} as const;

export type TextTone = keyof typeof TONES;

export interface TextProps extends NativeTextProps {
    /** The text's role (type-scale.ts's TEXT_ROLES): an iOS text style or one of the app's; the Body by default. */
    readonly variant?: TextVariant;
    readonly weight?: FontWeightName;
    readonly tone?: TextTone;
    /** Monospace, for real code only (a command, a code span, an id to copy); meta is `variant="meta"`. */
    readonly mono?: boolean;
}

export function Text({ variant, weight, tone, mono, className, style, maxFontSizeMultiplier, ...props }: TextProps) {
    const { fontScale } = useWindowDimensions();
    const look = textLook(variant ?? 'body', Platform.OS, fontScale);
    const max = maxFontSizeMultiplier ?? look.maxFontSizeMultiplier;
    const shown = tone ?? look.tone ?? 'default';
    const accent = useColorValue(shown === 'destructive' ? 'destructive' : 'primary');
    const strong = Platform.OS === 'ios' && (shown === 'primary' || shown === 'destructive');
    return (
        <NativeText
            {...props}
            {...(max === undefined ? {} : { maxFontSizeMultiplier: max })}
            className={cx(TONES[shown], className)}
            style={[
                { fontSize: look.fontSize, lineHeight: look.lineHeight, fontWeight: fontWeight(weight ?? look.weight) },
                look.letterSpacing === undefined ? null : { letterSpacing: look.letterSpacing },
                look.uppercase ? { textTransform: 'uppercase' } : null,
                look.tabular ? { fontVariant: ['tabular-nums'] } : null,
                mono === true ? { fontFamily: monoFamily(Platform.OS), fontVariant: ['tabular-nums'] } : null,
                strong ? { color: accent } : null,
                style,
            ]}
        />
    );
}
