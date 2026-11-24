import { type ReactNode, useEffect, useSyncExternalStore } from 'react';
import { AccessibilityInfo, type AccessibilityActionEvent, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { InAppNotice } from '@socio/shared/notifications';

import { useHasWorkspaceScope, useWorkspaceScope } from '../live';
import { screenPath } from '../navigation/presence-path';
import { Button, GlassSurface, AppSymbol, Text } from '../ui';
import { useAnnouncement } from '../ui/use-announcement';

// Presence and in-app notices on screen (src/sync/presence.ts and
// notices.ts). `PresenceLayer` holds the root stack: any touch in the app, and
// each screen change (the native tab bar's taps never reach the app's views),
// counts as using it, and the screen's web path goes to the presence header.
// Over everything it shows the scope's in-app notice, one at a time: a card
// at the top, in Liquid Glass on iOS 26 (it floats over a page), with the
// notice's title and words, Open (its link, in the app) and Close. It is said
// once as it appears, and is one element to a screen reader, with Open as its
// activation and Dismiss (and iOS's escape gesture) as actions. It goes after
// NOTICE_SHOWN_MS as the web's toast does, but not while a screen reader is on.

/** How long a notice shows (the web's toast: 15 s). */
export const NOTICE_SHOWN_MS = 15_000;
const CLOSE = 'Dismiss';
const OPEN = 'Open';

/** A path in the workspace; anything else opens Home (the web's `inApp`). */
export const noticeTarget = (link: string) => (link.startsWith('/') && !link.startsWith('//') ? link : '/');

/** What a screen reader says for a notice. */
export const noticeWords = (notice: Pick<InAppNotice, 'title' | 'body'>) => {
    const title = notice.title.trim() === '' ? 'Notice' : notice.title.trim();
    const body = notice.body.trim();
    return body === '' ? title : `${title}. ${body}`;
};

export function PresenceLayer(props: { children: ReactNode; open: (path: string) => void }) {
    if (!useHasWorkspaceScope()) {
        return props.children;
    }
    return <ScopedPresence open={props.open}>{props.children}</ScopedPresence>;
}

function ScopedPresence(props: { children: ReactNode; open: (path: string) => void }) {
    const { presence, notices } = useWorkspaceScope();
    useEffect(() => {
        const follow = () => {
            presence.screen(screenPath.get());
            presence.touch();
        };
        follow();
        return screenPath.subscribe(follow);
    }, [presence]);
    const notice = useSyncExternalStore(notices.subscribe, notices.current);
    return (
        <View style={{ flex: 1 }} onTouchStart={() => presence.touch()}>
            {props.children}
            {notice === null ? null : (
                <NoticeCard
                    key={notice.id}
                    notice={notice}
                    onOpen={() => {
                        notices.dismiss(notice.id);
                        props.open(noticeTarget(notice.link));
                    }}
                    onClose={() => notices.dismiss(notice.id)}
                />
            )}
        </View>
    );
}

function NoticeCard(props: { notice: InAppNotice; onOpen: () => void; onClose: () => void }) {
    const { notice, onClose } = props;
    const insets = useSafeAreaInsets();
    const words = noticeWords(notice);
    useAnnouncement(words, { onAppear: true });
    useEffect(() => {
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
    }, [onClose]);
    const act = (event: AccessibilityActionEvent) => {
        const name = event.nativeEvent.actionName;
        if (name === 'activate') {
            props.onOpen();
        } else if (name === 'dismiss' || name === 'escape') {
            onClose();
        }
    };
    const title = notice.title.trim() === '' ? 'Notice' : notice.title.trim();
    const body = notice.body.trim();
    return (
        <View pointerEvents="box-none" className="absolute right-0 left-0 px-3" style={{ top: insets.top + 8 }}>
            <GlassSurface
                testID="in-app-notice"
                radius={16}
                fallbackClassName="border border-border bg-card"
                className="p-3"
            >
                <View
                    accessible
                    accessibilityRole="alert"
                    accessibilityLabel={words}
                    accessibilityLiveRegion="polite"
                    accessibilityActions={[
                        { name: 'activate', label: OPEN },
                        { name: 'dismiss', label: CLOSE },
                        { name: 'escape', label: CLOSE },
                    ]}
                    onAccessibilityAction={act}
                    testID="in-app-notice-card"
                >
                    {/* One element to a screen reader: on Android its parts would be focused too. */}
                    <View importantForAccessibility="no-hide-descendants" className="flex-row items-center gap-3">
                        <Pressable
                            onPress={props.onOpen}
                            testID="in-app-notice-open"
                            className="min-w-0 flex-1 flex-row items-center gap-3"
                        >
                            <AppSymbol name="bell" color="muted-foreground" />
                            <View className="min-w-0 flex-1">
                                <Text weight="medium" numberOfLines={1}>
                                    {title}
                                </Text>
                                {body === '' ? null : (
                                    <Text variant="subheadline" tone="muted" numberOfLines={2}>
                                        {body}
                                    </Text>
                                )}
                            </View>
                        </Pressable>
                        <Button
                            label={CLOSE}
                            icon="x"
                            iconOnly
                            variant="ghost"
                            onPress={onClose}
                            testID="in-app-notice-close"
                        />
                    </View>
                </View>
            </GlassSurface>
        </View>
    );
}
