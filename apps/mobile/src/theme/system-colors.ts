import type { ColorToken, Scheme, ToneName } from './theme';
import { theme } from './theme';

// The system's neutrals on iOS (the owner, 2026-11-18: the web's
// brand in each platform's own components). The page, its words, the muted
// lines and the hairlines take UIKit's semantic colors (systemBackground,
// label, secondaryLabel, separator) through PlatformColor, so Light, Dark,
// a sheet's elevated background and Increase Contrast follow the system as in
// Apple's apps. The brand's teal and the module tones stay the web's; under
// Increase Contrast they take the stronger variants the theme generator
// writes (theme.json's `increasedContrast`), through DynamicColorIOS. Android
// keeps the web's tokens, as Material's surfaces. No React Native here, so the
// Node tests read the tables as the app does; native-colors.ts applies them.

/** Each neutral token iOS draws in a system color, and UIColor's name for it. */
export const IOS_SYSTEM_COLORS = {
    screen: 'systemBackground',
    background: 'systemBackground',
    sheet: 'systemBackground',
    header: 'systemBackground',
    foreground: 'label',
    'screen-foreground': 'label',
    'sheet-foreground': 'label',
    'header-foreground': 'label',
    'card-foreground': 'label',
    'popover-foreground': 'label',
    'secondary-foreground': 'label',
    'accent-foreground': 'label',
    'muted-foreground': 'secondaryLabel',
    border: 'separator',
} as const satisfies Partial<Record<ColorToken, string>>;

export type SystemNeutral = keyof typeof IOS_SYSTEM_COLORS;

export const isSystemNeutral = (token: string): token is SystemNeutral => Object.hasOwn(IOS_SYSTEM_COLORS, token);

/** An accent token that has an Increase Contrast variant. */
export type ContrastAccent = keyof (typeof theme)['light']['increasedContrast']['colors'];

export const isContrastAccent = (token: string): token is ContrastAccent =>
    Object.hasOwn(theme.light.increasedContrast.colors, token);

/** DynamicColorIOS's four colors, as plain hex: the scheme's, and Increase Contrast's. */
export interface DynamicHex {
    readonly light: string;
    readonly dark: string;
    readonly highContrastLight: string;
    readonly highContrastDark: string;
}

/**
 * An accent's colors for DynamicColorIOS, in the app's scheme: both halves the
 * scheme's own (the person's Light or Dark can differ from the system's, and
 * the trait follows it anyway), Increase Contrast's from theme.json.
 */
export function accentColors(token: ContrastAccent, scheme: Scheme): DynamicHex {
    const normal = theme[scheme].colors[token];
    const strong = theme[scheme].increasedContrast.colors[token];
    return { light: normal, dark: normal, highContrastLight: strong, highContrastDark: strong };
}

/** A tone's words and icon for DynamicColorIOS: the tone, stronger under Increase Contrast. */
export function toneColors(tone: ToneName, scheme: Scheme): DynamicHex {
    const normal = theme[scheme].tones[tone].foreground;
    const strong = theme[scheme].increasedContrast.tones[tone];
    return { light: normal, dark: normal, highContrastLight: strong, highContrastDark: strong };
}

/**
 * The CSS variables uniwind reads, overridden on iOS (`--color-screen` …):
 * every class name in a neutral token (`bg-screen`, `text-muted-foreground`,
 * `border-border`) then draws the system color. uniwind mixes an opacity class
 * (`/50`) only from a hex, and keeps a system color whole, so a token here may
 * take an opacity only where the system color is translucent itself
 * (`SYSTEM_OPACITY_CLASSES`: the select ring and the idle dot, secondaryLabel);
 * the accents, which have such class names, change in the primitives instead
 * (native-colors.ts's `useColorValue`). tests/theme/system-colors.test.ts holds
 * the table to the class names in src/.
 */
export const systemVariableNames = (): Readonly<Record<string, string>> =>
    Object.fromEntries(Object.entries(IOS_SYSTEM_COLORS).map(([token, name]) => [`--color-${token}`, name]));

/** The opacity class names on a system neutral, each drawn at the system color's own translucency on iOS. */
export const SYSTEM_OPACITY_CLASSES = ['bg-muted-foreground/70', 'border-muted-foreground/50'] as const;
