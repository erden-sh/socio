import { type Ref, useState } from 'react';
import {
    Platform,
    TextInput,
    type TextInputInstance,
    type TextInputProps,
    useWindowDimensions,
    View,
} from 'react-native';

import { useColors, useScheme } from '../theme/scheme';

import { cx } from './cx';
import { Text } from './text';
import { textMetrics } from './type-scale';
import { useAnnouncement } from './use-announcement';

// A text field: a label over the web's Input
// (packages/client/src/components/ui/input.tsx), with a hint or an error under
// it. The input is the web's: rounded-md, a border in the input token (the
// ring's when focused, with its 3 px halo: ring/50, or destructive/20 and /40
// in dark with an error), transparent in light and input/30 in dark, 16 px text
// (the web's size on phones, so iOS never zooms), but 44 pt tall at least.
// The border and the halo are drawn by a view around the TextInput, whose own
// style never changes: Android drops a TextInput's padding when its border
// color changes. The keyboard is the platform's: pass keyboardType, returnKeyType, onSubmitEditing,
// autoComplete and textContentType through, and a ref to move focus on.
// Screen readers find one element, the input, named by the label, as the web's
// <label for> names its input: the label you see is hidden from them, so it
// isn't read twice. An error is said when it appears or changes: a live region
// on Android, an announcement on iOS (use-announcement.ts).

export interface FieldProps extends Omit<TextInputProps, 'style' | 'className' | 'placeholderTextColor'> {
    readonly label: string;
    /** A line under the field on what to enter; an error takes its place. */
    readonly hint?: string;
    /** What's wrong with the value, said by screen readers when it appears or changes. */
    readonly error?: string;
    readonly ref?: Ref<TextInputInstance>;
}

export function Field({ label, hint, error, ref, editable = true, onFocus, onBlur, testID, ...props }: FieldProps) {
    const [focused, setFocused] = useState(false);
    const { fontScale } = useWindowDimensions();
    const colors = useColors();
    const scheme = useScheme();
    const invalid = error !== undefined && error !== '';
    useAnnouncement(invalid ? error : undefined, { onAppear: true });
    return (
        <View className="gap-1.5 self-stretch">
            <Text variant="subheadline" weight="medium" accessibilityElementsHidden importantForAccessibility="no">
                {label}
            </Text>
            <View
                className={cx(
                    'rounded-md border bg-transparent dark:bg-input/30',
                    invalid ? 'border-destructive' : focused ? 'border-ring' : 'border-input',
                    !editable && 'opacity-50',
                )}
                style={
                    focused
                        ? {
                              outlineWidth: 3,
                              outlineStyle: 'solid',
                              outlineColor: invalid
                                  ? `${colors.destructive}${scheme === 'dark' ? '66' : '33'}`
                                  : `${colors.ring}80`,
                          }
                        : undefined
                }
            >
                <TextInput
                    {...props}
                    ref={ref}
                    testID={testID}
                    editable={editable}
                    accessibilityLabel={label}
                    accessibilityHint={invalid ? error : hint}
                    accessibilityState={{ disabled: !editable }}
                    onFocus={(event) => {
                        setFocused(true);
                        onFocus?.(event);
                    }}
                    onBlur={(event) => {
                        setFocused(false);
                        onBlur?.(event);
                    }}
                    className="min-h-[42px] px-3 py-2 text-foreground"
                    style={textMetrics('body', fontScale, Platform.OS)}
                    placeholderTextColorClassName="accent-muted-foreground"
                    cursorColorClassName="accent-primary"
                    selectionColorClassName="accent-primary"
                    selectionHandleColorClassName="accent-primary"
                />
            </View>
            {invalid ? (
                <Text tone="destructive" accessibilityRole="alert" accessibilityLiveRegion="polite">
                    {error}
                </Text>
            ) : hint === undefined ? null : (
                <Text variant="subheadline" tone="muted">
                    {hint}
                </Text>
            )}
        </View>
    );
}
