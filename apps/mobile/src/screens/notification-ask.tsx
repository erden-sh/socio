import { useNavigation } from '@react-navigation/native';
import { useEffect, useRef } from 'react';
import { View } from 'react-native';

import { notificationAsk, useNotificationAsk } from '../platform/notification-ask';
import { ASK_COPY } from '../push';
import { Button, AppSymbol, Text } from '../ui';

// The notification ask's explanation (src/push/permission-ask.ts): a
// sheet sized to its words, with Allow (then the system prompt) and Not now.
// Closing it any other way (a swipe, back) is Not now. `NotificationAskWatcher`,
// in the shell's tabs, opens it when a trigger asks.

export function NotificationAskScreen() {
    const navigation = useNavigation();
    const chose = useRef(false);
    useEffect(
        () => () => {
            if (!chose.current) {
                notificationAsk.notNow();
            }
        },
        [],
    );
    const answer = (allow: boolean) => {
        chose.current = true;
        if (allow) {
            notificationAsk.allow();
        } else {
            notificationAsk.notNow();
        }
        navigation.goBack();
    };
    return (
        <View testID="notification-ask" className="gap-4 bg-sheet p-6">
            <View className="items-center gap-3">
                <AppSymbol name="bell" size={32} color="primary" />
                <Text accessibilityRole="header" variant="headline" className="text-center">
                    {ASK_COPY.title}
                </Text>
                <Text variant="subheadline" tone="muted" className="text-center">
                    {ASK_COPY.body}
                </Text>
            </View>
            <View className="gap-2">
                <Button label={ASK_COPY.allow} onPress={() => answer(true)} testID="notification-ask-allow" />
                <Button
                    variant="ghost"
                    label={ASK_COPY.notNow}
                    onPress={() => answer(false)}
                    testID="notification-ask-not-now"
                />
            </View>
        </View>
    );
}

/** Opens the explanation over whatever shows when a trigger asks (mounted in the shell's tabs). */
export function NotificationAskWatcher() {
    const navigation = useNavigation();
    const showing = useNotificationAsk().showing;
    useEffect(() => {
        if (showing !== null) {
            navigation.navigate('NotificationAsk');
        }
    }, [showing, navigation]);
    return null;
}
