import { useNavigation } from '@react-navigation/native';
import type { StaticScreenProps } from '@react-navigation/native';
import { Image } from 'expo-image';
import { useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ViewerImage } from '../chat/attachment-tray';
import { useHasWorkspaceScope } from '../live';
import { useAttachmentPicture } from '../platform/image-cache';
import { AppSymbol, Text } from '../ui';

// The viewer (the web's AttachmentViewer): a message's or the tray's
// pictures at full size on black, swiped through sideways, with the name and
// "2 of 3" over them and a close button. A picture the phone holds (the tray,
// a pending bubble) shows from its copy; one from the transcript from the
// image cache, downloaded through authedFetch if it isn't there yet.

export function AttachmentViewerScreen({ route }: StaticScreenProps<{ images: ViewerImage[]; index: number }>) {
    return useHasWorkspaceScope() ? <Viewer images={route.params.images} start={route.params.index} /> : null;
}

function Viewer({ images, start }: { images: readonly ViewerImage[]; start: number }) {
    const navigation = useNavigation();
    const insets = useSafeAreaInsets();
    const { width } = useWindowDimensions();
    const first = Math.min(Math.max(0, start), Math.max(0, images.length - 1));
    const [shown, setShown] = useState(first);
    const current = images[shown];
    return (
        <View testID="attachment-viewer" className="flex-1 bg-black">
            <FlatList
                data={images}
                horizontal
                pagingEnabled
                initialScrollIndex={first}
                getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
                keyExtractor={(image) => image.id}
                showsHorizontalScrollIndicator={false}
                onMomentumScrollEnd={(event) => setShown(Math.round(event.nativeEvent.contentOffset.x / width))}
                renderItem={({ item }) => <Page image={item} width={width} />}
            />
            <View
                className="absolute right-0 left-0 flex-row items-center gap-3 px-4"
                style={{ top: insets.top + 8 }}
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
                    onPress={() => navigation.goBack()}
                    hitSlop={4}
                    className="size-11 items-center justify-center rounded-full bg-white/15 active:bg-white/25"
                >
                    <AppSymbol name="x" size={20} color="white" />
                </Pressable>
            </View>
        </View>
    );
}

function Page({ image, width }: { image: ViewerImage; width: number }) {
    const picture = useAttachmentPicture(image.id, image.local, image.kind);
    return (
        <View style={{ width }} className="flex-1 items-center justify-center">
            {picture.state === 'ready' ? (
                <Image
                    source={{ uri: picture.uri }}
                    cachePolicy="memory"
                    contentFit="contain"
                    style={{ width, height: '100%' }}
                    accessibilityLabel={image.name}
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
        </View>
    );
}
