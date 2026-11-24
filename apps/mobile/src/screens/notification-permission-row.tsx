import { Linking, Pressable, View } from 'react-native';

import { notificationAsk } from '../platform/notification-ask';
import type { SettingsNotificationRow } from '../push';
import { AppSymbol, Text } from '../ui';

// Where the phone's notifications stand while they aren't on
// (src/push/permission-ask.ts's `settingsRow`), in Settings and on the
// Notifications screen: "Turn on notifications" (the system prompt),
// "Notifications are off" to the phone's Settings, or the line saying this build
// can't have them, always its section's first row. Its words wrap and the row
// grows with them.

export function NotificationPermissionRow({ row }: { row: SettingsNotificationRow }) {
    if (row.kind === 'unavailable') {
        return (
            <View
                testID={row.testID}
                accessible
                accessibilityLabel={row.title}
                className="flex-row items-center gap-3 p-3"
                style={{ minHeight: 44 }}
            >
                <AppSymbol name="bell-off" color="muted-foreground" />
                <Text className="min-w-0 flex-1">{row.title}</Text>
            </View>
        );
    }
    return (
        <Pressable
            testID={row.testID}
            accessibilityRole="button"
            accessibilityLabel={row.title}
            accessibilityHint={row.subtitle}
            onPress={() => (row.kind === 'denied' ? void Linking.openSettings() : notificationAsk.turnOn())}
            className="flex-row items-center gap-3 p-3 active:bg-accent"
            style={{ minHeight: 56 }}
        >
            <AppSymbol name={row.kind === 'denied' ? 'bell-off' : 'bell'} color="muted-foreground" />
            <View className="min-w-0 flex-1 gap-0.5">
                <Text weight="medium">{row.title}</Text>
                <Text variant="footnote" tone="muted">
                    {row.subtitle}
                </Text>
            </View>
            <AppSymbol name="chevron-right" color="muted-foreground" />
        </Pressable>
    );
}
