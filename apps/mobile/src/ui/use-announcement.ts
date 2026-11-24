import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

import { announcement, announcesHere } from './announcement';

// A live region on iOS. React Native's accessibilityLiveRegion works on Android
// only, and VoiceOver says nothing when a view with the alert role appears, so
// on iOS a message is announced when it appears (if `onAppear`) and whenever it
// changes, queued behind what VoiceOver is saying. Android keeps its live
// region, which the view that shows the message sets. A message no view shows
// (`shown: false`) has no live region, so Android is told it here too.

export function useAnnouncement(
    message: string | undefined,
    { onAppear, shown = true }: { readonly onAppear: boolean; readonly shown?: boolean },
) {
    const said = useRef(onAppear ? undefined : message);
    useEffect(() => {
        const text = announcement(said.current, message);
        said.current = message;
        if (text === undefined || !announcesHere(Platform.OS, { shown })) {
            return;
        }
        if (Platform.OS === 'ios') {
            AccessibilityInfo.announceForAccessibilityWithOptions(text, { queue: true });
        } else {
            AccessibilityInfo.announceForAccessibility(text);
        }
    }, [message, shown]);
}
