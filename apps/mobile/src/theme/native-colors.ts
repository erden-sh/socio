import { type ColorValue, DynamicColorIOS, Platform, PlatformColor } from 'react-native';
import { Uniwind } from 'uniwind';

import { useColors, useScheme } from './scheme';
import {
    accentColors,
    IOS_SYSTEM_COLORS,
    isContrastAccent,
    isSystemNeutral,
    systemVariableNames,
    toneColors,
} from './system-colors';
import type { ColorToken, ToneName } from './theme';

// system-colors.ts's tables, applied. On iOS the neutral tokens'
// CSS variables become UIKit's semantic colors once, before the first frame,
// so every class name in them follows Light, Dark and Increase Contrast; a
// prop that takes a value (an SF Symbol's tint, a spinner) asks
// `useColorValue`, which gives the same system color, or an accent's or a
// tone's DynamicColorIOS with its Increase Contrast variant. Android keeps the
// web's hex tokens.

const ios = Platform.OS === 'ios';

/** On iOS, points the neutral tokens' CSS variables at the system's colors (`src/app.tsx` calls it at import). */
export function applySystemColors(): void {
    if (!ios) {
        return;
    }
    const variables = Object.fromEntries(
        Object.entries(systemVariableNames()).map(([variable, name]) => [variable, PlatformColor(name)]),
    );
    for (const scheme of ['light', 'dark'] as const) {
        // uniwind's variables are typed as strings; on native a value that isn't a color string is
        // handed to the style as it is (createVarGetter), and React Native resolves PlatformColor.
        Uniwind.updateCSSVariables(scheme, variables as unknown as Record<string, string>);
    }
}

/** A token's color for a prop that takes a value: iOS's system color or Increase Contrast's variant, else the hex. */
export function useColorValue(token: ColorToken): ColorValue {
    const scheme = useScheme();
    const colors = useColors();
    if (ios && isSystemNeutral(token)) {
        return PlatformColor(IOS_SYSTEM_COLORS[token]);
    }
    if (ios && isContrastAccent(token)) {
        return DynamicColorIOS(accentColors(token, scheme));
    }
    return colors[token];
}

/** A module tone's words and icons: stronger under Increase Contrast on iOS. */
export function useToneColor(tone: ToneName): ColorValue {
    const scheme = useScheme();
    const colors = toneColors(tone, scheme);
    return ios ? DynamicColorIOS(colors) : colors.light;
}
