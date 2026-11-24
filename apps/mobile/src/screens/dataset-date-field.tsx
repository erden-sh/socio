import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Platform, Pressable, View } from 'react-native';

import type { WriteCell } from '@socio/shared/dataset-views/contract';

import { pickedValue, pickerDate } from '../shell/dataset-writes';
import { useColors, useScheme } from '../theme/scheme';
import { AppSymbol, Button, Text } from '../ui';

// A date or date-and-time field's picker (CB-469): the system's own,
// @react-native-community/datetimepicker. iOS draws UIDatePicker inline (the
// calendar, and the time wheel for a datetime) under the field's row, with
// Cancel and Save; Android opens Material's date dialog, then its time dialog
// for a datetime, and sets the value as the dialog is confirmed. A calendar
// date is picked in UTC so it is the same day in any zone; a datetime in the
// view's zone (`timeZone`). Clear empties it.

export function DateField(props: {
    label: string;
    /** The value as text, '' for none. */
    text: string;
    value: unknown;
    time: boolean;
    timeZone: string;
    onChange: (to: WriteCell) => void;
    /** The row is open for editing (iOS's inline picker); Android opens its dialog at once. */
    onClose?: () => void;
    busy?: boolean;
    testID: string;
}) {
    const scheme = useScheme();
    const colors = useColors();
    const zone = props.time ? props.timeZone : 'UTC';
    const [draft, setDraft] = useState(() => pickerDate(props.value, props.time));
    const [open, setOpen] = useState(false);
    const openAndroid = () => {
        DateTimePickerAndroid.open({
            value: pickerDate(props.value, props.time),
            mode: 'date',
            timeZoneName: zone,
            onValueChange: (_event, day) => {
                if (!props.time) {
                    props.onChange(pickedValue(day, false));
                    return;
                }
                DateTimePickerAndroid.open({
                    value: day,
                    mode: 'time',
                    timeZoneName: zone,
                    onValueChange: (_e, at) => props.onChange(pickedValue(at, true)),
                });
            },
        });
    };
    const empty = props.text === '';
    return (
        <View className="gap-2" testID={props.testID}>
            <View className="flex-row items-center gap-2">
                <Pressable
                    className="min-h-11 min-w-0 flex-1 flex-row items-center gap-2"
                    accessibilityRole="button"
                    accessibilityLabel={`${props.label}, ${empty ? 'none' : props.text}`}
                    accessibilityHint={props.time ? 'Picks a date and time' : 'Picks a date'}
                    onPress={() => {
                        if (Platform.OS === 'android') {
                            openAndroid();
                        } else {
                            setDraft(pickerDate(props.value, props.time));
                            setOpen(!open);
                        }
                    }}
                    testID={`${props.testID}-open`}
                >
                    <AppSymbol name="calendar" size={16} color="muted-foreground" />
                    <Text tone={empty ? 'muted' : 'default'} className="min-w-0 flex-1">
                        {empty ? (props.time ? 'Choose a date and time' : 'Choose a date') : props.text}
                    </Text>
                </Pressable>
                {empty ? null : (
                    <Button
                        label={`Clear ${props.label}`}
                        icon="x"
                        iconOnly
                        variant="ghost"
                        busy={props.busy === true}
                        onPress={() => {
                            setOpen(false);
                            props.onChange(null);
                        }}
                        testID={`${props.testID}-clear`}
                    />
                )}
            </View>
            {Platform.OS === 'ios' && open ? (
                <View className="gap-2">
                    <DateTimePicker
                        value={draft}
                        mode={props.time ? 'datetime' : 'date'}
                        display="inline"
                        timeZoneName={zone}
                        themeVariant={scheme}
                        accentColor={colors.primary}
                        onValueChange={(_event, date) => setDraft(date)}
                        testID={`${props.testID}-picker`}
                    />
                    <View className="flex-row justify-end gap-3">
                        <Button
                            label="Cancel"
                            variant="ghost"
                            onPress={() => {
                                setOpen(false);
                                props.onClose?.();
                            }}
                        />
                        <Button
                            label="Save"
                            onPress={() => {
                                setOpen(false);
                                props.onChange(pickedValue(draft, props.time));
                            }}
                            testID={`${props.testID}-save`}
                        />
                    </View>
                </View>
            ) : null}
        </View>
    );
}
