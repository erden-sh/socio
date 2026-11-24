import { type Ref, useState } from 'react';
import {
    Platform,
    TextInput,
    type TextInputInstance,
    type TextInputProps,
    useWindowDimensions,
    View,
} from 'react-native';

import { AppSymbol } from './app-symbol';
import { cx } from './cx';
import { textMetrics } from './type-scale';

// A search field: the web's search box (the Board's and a Space library's,
// `Input` with a leading lucide Search icon), with no label over it, since the
// icon and the placeholder say what it is (the PWA comparison's 6.5). Screen
// readers find one element, the input, named by `label` (the words the web's
// aria-label has: "Search issues", "Search pages"); the icon is hidden from
// them. The border is the Field's: the input token, the ring's while focused;
// 44 pt tall at least, 16 px text so iOS never zooms.

export interface SearchFieldProps extends Omit<
    TextInputProps,
    'style' | 'className' | 'placeholderTextColor' | 'accessibilityLabel'
> {
    /** What a screen reader calls it, and the placeholder unless one is given. */
    readonly label: string;
    /** To focus it from outside: Search's tab tapped again (CB-418). */
    readonly ref?: Ref<TextInputInstance>;
}

export function SearchField({ label, placeholder, onFocus, onBlur, testID, ref, ...props }: SearchFieldProps) {
    const [focused, setFocused] = useState(false);
    const { fontScale } = useWindowDimensions();
    return (
        <View
            className={cx(
                'min-h-11 flex-row items-center gap-2 rounded-md border bg-transparent px-3 dark:bg-input/30',
                focused ? 'border-ring' : 'border-input',
            )}
        >
            <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                <AppSymbol name="search" size={16} color="muted-foreground" />
            </View>
            <TextInput
                {...props}
                ref={ref}
                testID={testID}
                accessibilityLabel={label}
                placeholder={placeholder ?? label}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
                clearButtonMode="while-editing"
                onFocus={(event) => {
                    setFocused(true);
                    onFocus?.(event);
                }}
                onBlur={(event) => {
                    setFocused(false);
                    onBlur?.(event);
                }}
                className="min-h-[42px] flex-1 py-2 text-foreground"
                style={textMetrics('body', fontScale, Platform.OS)}
                placeholderTextColorClassName="accent-muted-foreground"
                cursorColorClassName="accent-primary"
                selectionColorClassName="accent-primary"
                selectionHandleColorClassName="accent-primary"
            />
        </View>
    );
}
