import { useSyncExternalStore } from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { tapNotice } from '../platform/push-taps';
import { GlassSurface, Text } from '../ui';
import { useAnnouncement } from '../ui/use-announcement';

// What a notification's tap says over every screen:
// "Switched to Acme" when it switched the workspace first, or why it opened
// nothing. It sits outside the workspace's tree in src/app.tsx, since a switch
// mounts that tree again. A card at the top in Liquid Glass on iOS 26 (it
// floats over a page), said once as it appears, gone after a few seconds or a
// tap.

export function TapNoticeLayer() {
    const notice = useSyncExternalStore(tapNotice.subscribe, tapNotice.get);
    return notice === null ? null : <TapNoticeCard key={notice.id} text={notice.text} />;
}

function TapNoticeCard(props: { text: string }) {
    const insets = useSafeAreaInsets();
    useAnnouncement(props.text, { onAppear: true });
    return (
        <View pointerEvents="box-none" className="absolute right-0 left-0 px-3" style={{ top: insets.top + 8 }}>
            <GlassSurface
                testID="tap-notice"
                radius={16}
                fallbackClassName="border border-border bg-card"
                className="p-4"
            >
                <Pressable
                    accessibilityRole="alert"
                    accessibilityLiveRegion="polite"
                    onPress={tapNotice.dismiss}
                    testID="tap-notice-text"
                >
                    <Text weight="medium">{props.text}</Text>
                </Pressable>
            </GlassSurface>
        </View>
    );
}
