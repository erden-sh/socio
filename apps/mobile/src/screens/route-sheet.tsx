import { type StaticScreenProps, useNavigation } from '@react-navigation/native';
import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { createRouteSheets, newSheetId, sheetRoute } from '../navigation/route-sheets';
import { keyboardScroll, Text } from '../ui';

// A screen's picker in a native sheet (CB-421, navigation/route-sheets.ts):
// the screen calls `useRouteSheet` with what the sheet shows, or null while
// it is closed; the `Sheet` and `TallSheet` routes draw it. On iOS the sheet's
// root is its ScrollView, its title row sticking at the top.

export interface RouteSheetContent {
    readonly testID: string;
    /** Its title row's words; none when the body draws its own (a memory's form). */
    readonly title?: string;
    /** A line under the title ("For 3 selected issues"). */
    readonly subtitle?: string;
    /** The title row's buttons (Clear, Done). */
    readonly actions?: ReactNode;
    readonly body: ReactNode;
    /** A list that can be long: medium, then large. A short one stays at medium. */
    readonly tall?: boolean;
}

const sheets = createRouteSheets<RouteSheetContent>();

/**
 * Shows `content` in a native sheet while it isn't null. `onDismiss` is the
 * swipe down (or Android's Back): what the screen's Done or Cancel does.
 * The screen setting it to null closes the sheet.
 */
export function useRouteSheet(content: RouteSheetContent | null, onDismiss: () => void): void {
    const navigation = useNavigation();
    const [id, setId] = useState<string | null>(null);
    const shown = content !== null;
    if (shown && id === null) {
        setId(newSheetId());
    } else if (!shown && id !== null) {
        setId(null);
    }
    useEffect(() => {
        if (id === null || content === null) {
            return;
        }
        if (sheets.get(id) === null) {
            sheets.present(id, content, onDismiss);
            navigation.navigate(sheetRoute(content.tall === true), { id });
        } else {
            sheets.update(id, content);
        }
    });
    useEffect(() => {
        if (id === null) {
            return;
        }
        return () => sheets.close(id);
    }, [id]);
}

export function RouteSheetScreen({ route }: StaticScreenProps<{ id: string }>) {
    const { id } = route.params;
    const navigation = useNavigation();
    const insets = useSafeAreaInsets();
    const content = useSyncExternalStore(sheets.subscribe, () => sheets.get(id));
    const closed = content === null;
    useEffect(() => {
        if (closed) {
            navigation.goBack();
        }
    }, [closed, navigation]);
    useEffect(() => () => sheets.dismissed(id), [id]);
    if (content === null) {
        return <View className="flex-1 bg-sheet" />;
    }
    return (
        <ScrollView
            testID={content.testID}
            className="bg-sheet"
            {...(content.title === undefined ? {} : { stickyHeaderIndices: [0] })}
            contentContainerStyle={{ paddingBottom: 16 + insets.bottom }}
            // A field low in the sheet (a report's note, CB-382) stays above the keyboard on iOS.
            automaticallyAdjustKeyboardInsets
            {...keyboardScroll(Platform.OS)}
        >
            {content.title === undefined ? null : (
                <View className="flex-row items-center gap-3 bg-sheet px-4 pt-5 pb-3">
                    <View className="min-w-0 flex-1">
                        <Text accessibilityRole="header" weight="medium">
                            {content.title}
                        </Text>
                        {content.subtitle === undefined ? null : (
                            <Text variant="footnote" tone="muted">
                                {content.subtitle}
                            </Text>
                        )}
                    </View>
                    {content.actions}
                </View>
            )}
            <View className="gap-4 px-4">{content.body}</View>
        </ScrollView>
    );
}
