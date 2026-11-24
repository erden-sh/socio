import { useEffect, useSyncExternalStore } from 'react';
import { AccessibilityInfo, type AccessibilityActionEvent, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { appState } from '../platform/app-state';
import { buildNotice } from '../platform/build-info';
import { type BuildNotice, noticeClockRuns } from '../shell/build-info';
import { Button, GlassSurface, AppSymbol, Text } from '../ui';
import { useAnnouncement } from '../ui/use-announcement';

import { NOTICE_SHOWN_MS } from './notice-banner';

// The install confirmation (src/shell/build-info.ts): once, after the app runs a build other than
// the one it last ran, "Updated to build 2829 (was 2790)" or "Older build installed: 2790 (was
// 2829)" shows at the top of whatever screen is up, sign-in and lock included, in the in-app
// notices' card (notice-banner.tsx): the same glass, said once as it appears, Dismiss as its button
// and action, gone after 15 s unless a screen reader is on. A higher build has the check in the
// primary color, a lower one the warning triangle in the destructive one, so the two read apart at
// a glance. Its 15 s run only while the app is in front: inactive (the app switcher, Control
// Center) or in the background, the clock stops and starts over on return, so a notice that shows
// once is seen.
// It never blocks anything: the check that makes it runs after launch, unawaited.

export function BuildNoticeLayer() {
    const notice = useSyncExternalStore(buildNotice.subscribe, buildNotice.get);
    return notice === null ? null : <BuildNoticeCard notice={notice} onClose={buildNotice.dismiss} />;
}

const CLOSE = 'Dismiss';

function BuildNoticeCard({ notice, onClose }: { notice: BuildNotice; onClose: () => void }) {
    const insets = useSafeAreaInsets();
    const away = !noticeClockRuns(useSyncExternalStore(appState.subscribe, appState.current));
    useAnnouncement(notice.text, { onAppear: true });
    useEffect(() => {
        if (away) {
            return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        let live = true;
        AccessibilityInfo.isScreenReaderEnabled().then(
            (reading) => {
                if (live && !reading) {
                    timer = setTimeout(onClose, NOTICE_SHOWN_MS);
                }
            },
            () => {},
        );
        return () => {
            live = false;
            clearTimeout(timer);
        };
    }, [onClose, away]);
    const act = (event: AccessibilityActionEvent) => {
        const name = event.nativeEvent.actionName;
        if (name === 'dismiss' || name === 'escape') {
            onClose();
        }
    };
    const higher = notice.kind === 'higher';
    return (
        <View pointerEvents="box-none" className="absolute right-0 left-0 px-3" style={{ top: insets.top + 8 }}>
            <GlassSurface
                testID="build-notice"
                radius={16}
                fallbackClassName="border border-border bg-card"
                className="p-3"
            >
                <View
                    accessible
                    accessibilityRole="alert"
                    accessibilityLabel={notice.text}
                    accessibilityLiveRegion="polite"
                    accessibilityActions={[
                        { name: 'dismiss', label: CLOSE },
                        { name: 'escape', label: CLOSE },
                    ]}
                    onAccessibilityAction={act}
                    testID={higher ? 'build-notice-higher' : 'build-notice-lower'}
                >
                    <View importantForAccessibility="no-hide-descendants" className="flex-row items-center gap-3">
                        <AppSymbol
                            name={higher ? 'circle-check' : 'triangle-alert'}
                            color={higher ? 'primary' : 'destructive'}
                        />
                        <View className="min-w-0 flex-1">
                            <Text weight="medium">{notice.text}</Text>
                        </View>
                        <Button
                            label={CLOSE}
                            icon="x"
                            iconOnly
                            variant="ghost"
                            onPress={onClose}
                            testID="build-notice-close"
                        />
                    </View>
                </View>
            </GlassSurface>
        </View>
    );
}
