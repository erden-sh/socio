import type { ColorValue } from 'react-native';

import { useColorValue } from '../theme/native-colors';
import type { ColorToken } from '../theme/theme';

import { GLYPHS } from './symbol-glyphs';
import type { SymbolName, SymbolWeight } from './symbols';

// What both platforms' AppSymbol share (app-symbol.tsx, app-symbol.ios.tsx):
// the props, the color (a token's, the system's on iOS: native-colors.ts), the
// accessibility props and lucide's icon. Its own file, since `./app-symbol`
// is the .ios file itself on iOS.

export interface AppSymbolProps {
    readonly name: SymbolName;
    /** In points: its box, the web's size-4 by default. */
    readonly size?: number;
    /** A theme color, `white` (on a destructive or a photo), or a value (a tone's, `useToneColor`). */
    readonly color?: ColorToken | 'white' | { readonly value: ColorValue };
    /** The SF Symbol's weight on iOS, the text's beside it (symbols.ts); lucide's strokes are 2 wide. */
    readonly weight?: SymbolWeight;
    /** The chosen state's filled form (a vote cast): SF's `.fill`, lucide's shape filled. */
    readonly filled?: boolean;
    /** What a screen reader says; without it, the icon is hidden from them. */
    readonly label?: string;
    readonly testID?: string;
}

/** The color a symbol draws in. */
export function useSymbolColor(color: AppSymbolProps['color']): ColorValue {
    const token = color === undefined || color === 'white' || typeof color === 'object' ? 'foreground' : color;
    const value = useColorValue(token);
    return color === 'white' ? '#ffffff' : typeof color === 'object' ? color.value : value;
}

/** The accessibility props of a symbol: hidden unless it has a label. */
export function symbolAccessibility(label: string | undefined) {
    const hidden = label === undefined;
    return {
        accessible: !hidden,
        accessibilityLabel: label,
        accessibilityRole: hidden ? undefined : ('image' as const),
        accessibilityElementsHidden: hidden,
        importantForAccessibility: hidden ? ('no-hide-descendants' as const) : ('yes' as const),
    };
}

/** lucide's icon for a name, in its color. */
export function LucideSymbol({ name, size = 16, color, filled = false, label, testID }: AppSymbolProps) {
    const Glyph = GLYPHS[name];
    const tint = useSymbolColor(color);
    return (
        <Glyph
            testID={testID}
            size={size}
            color={tint as string}
            fill={filled ? (tint as string) : 'none'}
            strokeWidth={2}
            {...symbolAccessibility(label)}
        />
    );
}
