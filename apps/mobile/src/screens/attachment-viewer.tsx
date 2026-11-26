import { useNavigation } from '@react-navigation/native';
import type { StaticScreenProps } from '@react-navigation/native';
import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import {
    GestureDetector,
    usePanGesture,
    usePinchGesture,
    useSimultaneousGestures,
    useTapGesture,
} from 'react-native-gesture-handler';
import Animated, {
    scrollTo,
    useAnimatedRef,
    useAnimatedStyle,
    useDerivedValue,
    useReducedMotion,
    useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ViewerImage } from '../chat/attachment-tray';
import { backdropOpacity, dismissScale, DOUBLE_TAP_DELAY_MS, fittedSize, type Size } from '../chat/image-viewer';
import { useHasWorkspaceScope } from '../live';
import { useAttachmentPicture } from '../platform/image-cache';
import { AppSymbol, Text } from '../ui';

import {
    movePager,
    NO_START,
    type PagerDrive,
    type PageZoom,
    pageGestureCallbacks,
    resetZoom,
    type ViewerDismiss,
} from './attachment-viewer-gesture';

// The viewer (the web's AttachmentViewer): a message's or the tray's
// pictures at full size on black, swiped through sideways, with the name and
// "2 of 3" over them and a close button. A picture the phone holds (the tray,
// a pending bubble) shows from its copy; one from the transcript from the
// image cache, downloaded through authedFetch if it isn't there yet.
//
// Its gestures are iOS Photos' (CB-536, CB-537; attachment-viewer-gesture.ts):
// pinch or double-tap to zoom, drag to pan while zoomed, sideways to the next
// picture only at fit (the drag moves the pager, which never scrolls by itself, so
// a pinch never races its scroll; screen readers get Next and Previous picture
// actions instead), and at fit a drag down or up moves the picture and fades
// the backdrop and the chrome, so the screen underneath shows through (the
// route's preset is a transparent modal); let go far or fast enough and it
// leaves through the stack's own goBack, short of that it springs back. The
// close button, Android's back and VoiceOver's escape still close it.

export function AttachmentViewerScreen({ route }: StaticScreenProps<{ images: ViewerImage[]; index: number }>) {
    return useHasWorkspaceScope() ? <Viewer images={route.params.images} start={route.params.index} /> : null;
}

function Viewer({ images, start }: { images: readonly ViewerImage[]; start: number }) {
    const navigation = useNavigation();
    const insets = useSafeAreaInsets();
    const page = useWindowDimensions();
    const { width } = page;
    const first = Math.min(Math.max(0, start), Math.max(0, images.length - 1));
    const [shown, setShown] = useState(first);
    const reduceMotion = useReducedMotion();
    // The pager's offset, moved by a page's drag on the UI thread and scrolled to there.
    const pagerRef = useAnimatedRef<Animated.FlatList<ViewerImage>>();
    const pagerX = useSharedValue(first * width);
    useDerivedValue(() => {
        scrollTo(pagerRef, pagerX.get(), 0, false);
    });
    const dy = useSharedValue(0);
    const fade = useSharedValue(1);
    const dismiss: ViewerDismiss = { dy, fade };
    const current = images[shown];
    const close = () => navigation.goBack();
    const turnTo = (index: number) => {
        const next = Math.min(images.length - 1, Math.max(0, index));
        movePager(pagerX, next, width, Platform.OS, reduceMotion);
        setShown(next);
    };
    const backdropStyle = useAnimatedStyle(() => ({ opacity: backdropOpacity(dy.get(), page.height) * fade.get() }));
    const chromeStyle = useAnimatedStyle(() => ({ opacity: backdropOpacity(dy.get(), page.height) * fade.get() }));
    return (
        <View
            testID="attachment-viewer"
            className="flex-1"
            accessibilityViewIsModal
            onAccessibilityEscape={close}
            accessibilityActions={
                images.length > 1
                    ? [
                          { name: 'next', label: 'Next picture' },
                          { name: 'previous', label: 'Previous picture' },
                      ]
                    : undefined
            }
            onAccessibilityAction={(event) => turnTo(event.nativeEvent.actionName === 'next' ? shown + 1 : shown - 1)}
        >
            <Animated.View style={[StyleSheet.absoluteFill, backdropStyle]} className="bg-black" />
            <Animated.FlatList
                ref={pagerRef}
                data={images}
                horizontal
                scrollEnabled={false}
                initialScrollIndex={first}
                getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
                keyExtractor={(image) => image.id}
                showsHorizontalScrollIndicator={false}
                showsVerticalScrollIndicator={false}
                renderItem={({ item, index }) => (
                    <Page
                        image={item}
                        page={page}
                        active={index === shown}
                        pager={{ x: pagerX, index, count: images.length }}
                        dismiss={dismiss}
                        onPage={setShown}
                        onDismiss={close}
                    />
                )}
            />
            <Animated.View
                className="absolute right-0 left-0 flex-row items-center gap-3 px-4"
                style={[{ top: insets.top + 8 }, chromeStyle]}
                pointerEvents="box-none"
            >
                <View className="flex-1">
                    <Text weight="medium" numberOfLines={1} className="text-white">
                        {current?.name ?? ''}
                    </Text>
                    {images.length > 1 ? (
                        <Text variant="footnote" className="text-white/70">
                            {`${shown + 1} of ${images.length}`}
                        </Text>
                    ) : null}
                </View>
                <Pressable
                    testID="attachment-viewer-close"
                    accessibilityRole="button"
                    accessibilityLabel="Close"
                    onPress={close}
                    hitSlop={4}
                    className="size-11 items-center justify-center rounded-full bg-white/15 active:bg-white/25"
                >
                    <AppSymbol name="x" size={20} color="white" />
                </Pressable>
            </Animated.View>
        </View>
    );
}

interface PageProps {
    readonly image: ViewerImage;
    readonly page: Size;
    /** The page the pager shows: the others go back to fit. */
    readonly active: boolean;
    readonly pager: PagerDrive;
    readonly dismiss: ViewerDismiss;
    readonly onPage: (index: number) => void;
    readonly onDismiss: () => void;
}

function Page({ image, page, active, pager, dismiss, onPage, onDismiss }: PageProps) {
    const picture = useAttachmentPicture(image.id, image.local, image.kind);
    const reduceMotion = useReducedMotion();
    const [natural, setNatural] = useState<Size | null>(null);
    const scale = useSharedValue(NO_START.scale);
    const x = useSharedValue(NO_START.x);
    const y = useSharedValue(NO_START.y);
    const start = useSharedValue(NO_START);
    const zoom: PageZoom = { scale, x, y, start };
    const ready = picture.state === 'ready';

    // A page the pager left goes back to fit.
    useEffect(() => {
        if (!active) {
            resetZoom({ scale, x, y, start });
        }
    }, [active, scale, x, y, start]);

    // Worklets from attachment-viewer-gesture.ts, named one by one: the worklets plugin reads this object.
    const callbacks = pageGestureCallbacks({
        zoom,
        dismiss,
        pager,
        page,
        fitted: fittedSize(page, natural),
        os: Platform.OS,
        reduceMotion,
        onPage,
        onDismiss,
    });
    const pinch = usePinchGesture({
        enabled: ready,
        onActivate: callbacks.pinchActivate,
        onUpdate: callbacks.pinchUpdate,
        onDeactivate: callbacks.pinchDeactivate,
    });
    // UIKit's double-tap window (about 0.35 s): gesture-handler's own default on iOS is 0.2 s, too
    // short for most people's second tap, so on iOS a double-tap never zoomed.
    const doubleTap = useTapGesture({
        enabled: ready,
        numberOfTaps: 2,
        maxDelay: DOUBLE_TAP_DELAY_MS,
        onActivate: callbacks.doubleTap,
    });
    // One finger: at fit it pages or dismisses, whichever way it goes more; zoomed in, it pans.
    // A drag works on a page still loading or offline too.
    const drag = usePanGesture({
        maxPointers: 1,
        activeOffsetX: [-10, 10],
        activeOffsetY: [-10, 10],
        onActivate: callbacks.dragActivate,
        onUpdate: callbacks.dragUpdate,
        onDeactivate: callbacks.dragDeactivate,
    });
    const gestures = useSimultaneousGestures(pinch, drag, doubleTap);

    const pictureStyle = useAnimatedStyle(() => {
        const away = dismiss.dy.get();
        const shrink = dismissScale(away, page.height);
        return {
            opacity: dismiss.fade.get(),
            transform: [{ translateX: x.get() }, { translateY: y.get() + away }, { scale: scale.get() * shrink }],
        };
    });

    return (
        <GestureDetector gesture={gestures}>
            <View style={{ width: page.width }} className="flex-1">
                <Animated.View style={pictureStyle} className="flex-1 items-center justify-center">
                    {ready ? (
                        <Image
                            source={{ uri: picture.uri }}
                            cachePolicy="memory"
                            contentFit="contain"
                            style={{ width: page.width, height: '100%' }}
                            accessibilityLabel={image.name}
                            onLoad={(event) => setNatural(event.source)}
                        />
                    ) : picture.state === 'loading' ? (
                        <ActivityIndicator color="#ffffff" accessibilityLabel="Loading the picture" />
                    ) : (
                        <View className="items-center gap-2 p-4">
                            <AppSymbol name="image-off" size={28} color="white" />
                            <Text className="text-center text-white">
                                {picture.state === 'gone'
                                    ? 'This picture was removed.'
                                    : 'This picture shows once you’re online.'}
                            </Text>
                        </View>
                    )}
                </Animated.View>
            </View>
        </GestureDetector>
    );
}
