import NativeSegmentedControl, {
    type SegmentedControlProps as NativeProps,
} from '@react-native-segmented-control/segmented-control';
import type { ComponentType } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';

import { useColors, useScheme } from '../theme/scheme';

import { AppSymbol } from './app-symbol';
import { cx } from './cx';
import { segmentedLayout, type SegmentedOption } from './segmented';
import { Text } from './text';

// A segmented control (the owner's 2026-11-18 rule: each platform's own
// components): one choice of two to four, side by side. iOS draws
// UISegmentedControl itself (@react-native-segmented-control/segmented-control,
// T3 Code's choice of a native one), with its own type, glass and VoiceOver
// ("Light, 1 of 3, selected"). Android has no native one React Native can
// reach, so it is Material 3's segmented button drawn to its spec: a 40 dp
// outlined pill, the segments split by the outline, the chosen one filled with
// the secondary container and a check before its label. More choices than four
// belong in a menu (Runs' filter).

// Its types declare a class React 19's JSX types don't take; it is a component all the same.
const RNSegmentedControl = NativeSegmentedControl as unknown as ComponentType<NativeProps>;

export interface SegmentedControlProps<Value extends string> {
    readonly options: readonly SegmentedOption<Value>[];
    readonly selected: Value;
    readonly onSelect: (value: Value) => void;
    /** What the choice is, for screen readers ("Appearance"). */
    readonly accessibilityLabel: string;
    readonly testID?: string;
}

export function SegmentedControl<Value extends string>(props: SegmentedControlProps<Value>) {
    return Platform.OS === 'ios' ? <IosSegmented {...props} /> : <MaterialSegmented {...props} />;
}

function IosSegmented<Value extends string>(props: SegmentedControlProps<Value>) {
    const scheme = useScheme();
    const layout = segmentedLayout('ios');
    return (
        <RNSegmentedControl
            testID={props.testID}
            accessibilityLabel={props.accessibilityLabel}
            values={props.options.map((option) => option.label)}
            selectedIndex={Math.max(
                0,
                props.options.findIndex((option) => option.value === props.selected),
            )}
            // The app's Light or Dark, which may differ from the phone's.
            appearance={scheme}
            onChange={({ nativeEvent }) => {
                const option = props.options[nativeEvent.selectedSegmentIndex];
                if (option !== undefined && option.value !== props.selected) {
                    props.onSelect(option.value);
                }
            }}
            style={{ minHeight: layout.minHeight }}
        />
    );
}

function MaterialSegmented<Value extends string>(props: SegmentedControlProps<Value>) {
    const colors = useColors();
    const layout = segmentedLayout('android');
    return (
        <View
            testID={props.testID}
            accessibilityRole="radiogroup"
            accessibilityLabel={props.accessibilityLabel}
            className="flex-row overflow-hidden rounded-full"
            style={{ minHeight: layout.minHeight, borderWidth: 1, borderColor: colors.border }}
        >
            {props.options.map((option, index) => {
                const on = option.value === props.selected;
                return (
                    <Pressable
                        key={option.value}
                        testID={option.testID}
                        accessibilityRole="radio"
                        accessibilityLabel={option.accessibilityLabel ?? option.label}
                        accessibilityState={{ checked: on }}
                        onPress={() => {
                            if (!on) {
                                props.onSelect(option.value);
                            }
                        }}
                        android_ripple={{ color: colors.accent }}
                        className={cx(
                            'flex-1 flex-row items-center justify-center gap-2 px-3',
                            on ? 'bg-secondary' : 'bg-transparent',
                        )}
                        style={
                            index === 0
                                ? undefined
                                : { borderLeftWidth: StyleSheet.hairlineWidth * 2, borderColor: colors.border }
                        }
                    >
                        {on ? <AppSymbol name="check" size={18} color="foreground" /> : null}
                        <Text variant="button" weight="medium" numberOfLines={1}>
                            {option.label}
                        </Text>
                    </Pressable>
                );
            })}
        </View>
    );
}
