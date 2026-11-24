import { Platform, Pressable } from 'react-native';

import { AppSymbol, type SymbolName } from '../ui';

// A row's own glyphs in each platform's set (CB-431): drawn by
// AppSymbol (src/ui/app-symbol.tsx), an SF Symbol on iOS and lucide's icon on
// Android, so they speak the icon language of the bars and the tab bar.

/** iOS's disclosure chevron, Android's (a list row that opens a page: Settings', Contacts'): UIKit's semibold, muted. */
export function Disclosure() {
    return <AppSymbol name="chevron-right" size={14} weight="semibold" color="muted-foreground" />;
}

/** The glyph in a SymbolButton, in points: a step over the system's 22 and Material's 24 (the owner, 2026-11-19). */
export const SYMBOL_BUTTON_GLYPH = { ios: 26, android: 28 } as const;

/**
 * A row's own icon button (CB-431): 44 pt square on iOS (the HIG's least hit
 * target), the symbol in the brand's primary, dimmed as it is pressed; a
 * 48 dp Material icon button on Android with its borderless ripple.
 */
export function SymbolButton(props: {
    readonly name: SymbolName;
    readonly label: string;
    readonly hint?: string;
    readonly onPress: () => void;
    readonly testID?: string;
}) {
    const ios = Platform.OS === 'ios';
    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={props.label}
            accessibilityHint={props.hint}
            onPress={props.onPress}
            hitSlop={0}
            android_ripple={{ borderless: true, radius: 24 }}
            className={
                ios ? 'size-11 items-center justify-center active:opacity-40' : 'size-12 items-center justify-center'
            }
        >
            <AppSymbol
                name={props.name}
                size={ios ? SYMBOL_BUTTON_GLYPH.ios : SYMBOL_BUTTON_GLYPH.android}
                color="primary"
            />
        </Pressable>
    );
}
