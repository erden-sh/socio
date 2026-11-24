import { useNavigation } from '@react-navigation/native';
import { Image } from 'expo-image';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Alert, Animated, Linking, Pressable, ScrollView, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { type AttachmentInfo, fileChipView, loadAttachmentInfo } from '../chat/attachment-info';
import {
    ATTACH_LABEL,
    addProblemsLine,
    CAMERA_DENIED,
    failedTileAction,
    type MessageFile,
    PICK_CAMERA,
    PICK_FAILED,
    PICK_FILES,
    PICK_PHOTOS,
    PICK_TONES,
    type PickSource,
    pasteImages,
    TRAY_TILE,
    type TrayItem,
    trayItems,
    viewerImages,
} from '../chat/attachment-tray';
import { useWorkspaceScope } from '../live';
import { useAttachmentPicture } from '../platform/image-cache';
import { clearPickerCache, pick, removePasted, sizeOf } from '../platform/pickers';
import type { Attachment, Attachments } from '../sync/attachments';
import type { WorkspaceScope } from '../sync/scope';
import { useScheme } from '../theme/scheme';
import { theme, type ToneName } from '../theme/theme';
import { AppSymbol, Text } from '../ui';
import { Squircle } from '../ui/squircle';

import { useOpenLink } from './open-link';

// Attachments on the phone (src/chat/attachment-tray.ts has the rules):
// - `useTray(draftScope)`: the composer's tray from the scope's attachments,
//   and `add(source)`, which opens a picker and copies what it gives, and
//   `paste(uris)`, which takes images pasted into the box the same way.
// - `AttachButton` and `AttachMenu`: the composer's "+", which opens a row of
//   three colored choices over the box (Photos, Camera, Files), the same on
//   both platforms.
// - `AttachmentTray`: T3 Code's strip over the box, 72 pt tiles, each a
//   picture's thumbnail or a file's tone and extension, an indeterminate bar
//   while it uploads, Retry when it failed, and a remove button.
// - `MessageAttachments`: a message's files in its bubble, pictures as
//   thumbnails that open the viewer, the rest as chips with their size that
//   download the file in the browser, as the web's do (CB-413).

const PICK_ICONS = { photos: 'image', camera: 'camera', files: 'paperclip' } as const;
const PICK_LABELS: Readonly<Record<PickSource, string>> = {
    photos: PICK_PHOTOS,
    camera: PICK_CAMERA,
    files: PICK_FILES,
};
const PICK_ORDER: readonly PickSource[] = ['photos', 'camera', 'files'];

const EMPTY: readonly Attachment[] = [];

export interface Tray {
    readonly items: readonly TrayItem[];
    /** The line over the box: what a pick couldn't attach, or why the picker didn't open. */
    readonly notice: string | null;
    readonly busy: boolean;
    add(source: PickSource): void;
    /** Images pasted into the box: expo-paste-input's files (CB-358). */
    paste(uris: readonly string[]): void;
    remove(id: string): void;
    retry(id: string): void;
}

/**
 * The tray of draft scope `scope` (null: no composer to attach to).
 * `existing` counts files already on their way toward the limit, and
 * `onAdded` runs once a pick or paste has copied its files (a refused filing's
 * Edit gives each one a row at once).
 */
export function useTray(
    scope: string | null,
    options: { readonly existing?: number; readonly onAdded?: () => void } = {},
): Tray {
    const { existing = 0, onAdded } = options;
    const { attachments } = useWorkspaceScope();
    const [store] = useState(() => trayStore(attachments));
    const files = useSyncExternalStore(store.subscribe, () => store.get(scope));
    const items = trayItems(files);
    const [notice, setNotice] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const add = (source: PickSource) => {
        if (scope === null || busy) {
            return;
        }
        setNotice(null);
        setBusy(true);
        (async () => {
            const limits = await attachments.limits();
            const room = limits.perMessage - existing - attachments.list(scope).length;
            if (room <= 0) {
                setNotice(addProblemsLine([{ name: '', reason: 'too-many' }], limits));
                return;
            }
            const picked = await pick(source, room);
            if (picked.kind === 'denied') {
                Alert.alert(CAMERA_DENIED, undefined, [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Open Settings', onPress: () => void Linking.openSettings() },
                ]);
                return;
            }
            if (picked.kind === 'picked') {
                const { added, problems } = await attachments.add(scope, picked.files, { existing });
                setNotice(addProblemsLine(problems, limits));
                if (added.length > 0) {
                    onAdded?.();
                }
            }
        })()
            .catch((error: unknown) => {
                console.warn('[attachments] the picker failed', error);
                setNotice(PICK_FAILED);
            })
            .finally(() => {
                // Every file the pickers wrote is copied or refused by now.
                clearPickerCache();
                setBusy(false);
            });
    };
    const paste = (uris: readonly string[]) => {
        if (scope === null) {
            // No tray to take them: the files still go.
            for (const uri of uris) {
                removePasted(uri).catch((error: unknown) => console.warn('[attachments] a paste not deleted', error));
            }
            return;
        }
        setNotice(null);
        void pasteImages(
            uris,
            {
                limits: () => attachments.limits(),
                count: () => existing + attachments.list(scope).length,
                add: async (files) => {
                    const result = await attachments.add(scope, files, { existing });
                    if (result.added.length > 0) {
                        onAdded?.();
                    }
                    return result;
                },
                sizeOf,
                remove: removePasted,
                onError: (error) => console.warn('[attachments] the paste failed', error),
            },
            new Date(),
        ).then(setNotice);
    };
    return {
        items,
        notice,
        busy,
        add,
        paste,
        remove: (id) => {
            attachments.discard(id).catch((error: unknown) => console.warn('[attachments] not removed', error));
        },
        retry: (id) => attachments.retry(id),
    };
}

/** The files outbox rows `rowIds` carry, in order, for React: the same array while they haven't changed. */
export function useCarriedFiles(rowIds: readonly string[]): readonly Attachment[] {
    const { attachments } = useWorkspaceScope();
    const [store] = useState(() => carriedStore(attachments));
    return useSyncExternalStore(store.subscribe, () => store.get(rowIds));
}

function carriedStore(attachments: Pick<Attachments, 'carried' | 'subscribe'>) {
    let last: readonly Attachment[] = EMPTY;
    return {
        subscribe: (listener: () => void) => attachments.subscribe(listener),
        get(rowIds: readonly string[]): readonly Attachment[] {
            const files = rowIds.flatMap((id) => attachments.carried(id));
            const same = files.length === last.length && files.every((file, index) => file === last[index]);
            if (!same) {
                last = files.length === 0 ? EMPTY : files;
            }
            return last;
        },
    };
}

/** A tray's files for React: the same array while they haven't changed, so the external store settles. */
function trayStore(attachments: Pick<Attachments, 'list' | 'subscribe'>) {
    let last: { scope: string | null; files: readonly Attachment[] } = { scope: null, files: EMPTY };
    return {
        subscribe: (listener: () => void) => attachments.subscribe(listener),
        get(scope: string | null): readonly Attachment[] {
            const files = scope === null ? EMPTY : attachments.list(scope);
            const same =
                last.scope === scope &&
                files.length === last.files.length &&
                files.every((file, index) => file === last.files[index]);
            if (!same) {
                last = { scope, files: files.length === 0 ? EMPTY : files };
            }
            return last.files;
        },
    };
}

/** The composer's "+": opens and closes the attach menu. */
export function AttachButton({ open, onPress, disabled }: { open: boolean; onPress: () => void; disabled: boolean }) {
    return (
        <Pressable
            testID="composer-attach"
            accessibilityRole="button"
            accessibilityLabel={ATTACH_LABEL}
            accessibilityState={{ expanded: open, disabled }}
            disabled={disabled}
            onPress={onPress}
            hitSlop={2}
            className="size-10 items-center justify-center rounded-full bg-muted active:opacity-70"
            style={{ opacity: disabled ? 0.5 : 1, transform: [{ rotate: open ? '45deg' : '0deg' }] }}
        >
            <AppSymbol name="plus" size={20} color="foreground" />
        </Pressable>
    );
}

/** The three choices over the box, each in its own tone; `testID` names them where a screen has two. */
export function AttachMenu({
    onPick,
    testID = 'composer-attach',
}: {
    onPick: (source: PickSource) => void;
    testID?: string;
}) {
    const tones = theme[useScheme()].tones;
    return (
        <View className="flex-row gap-2" testID={`${testID}-menu`}>
            {PICK_ORDER.map((source) => {
                const tone = tones[PICK_TONES[source]];
                return (
                    <Pressable
                        key={source}
                        testID={`${testID}-${source}`}
                        accessibilityRole="button"
                        accessibilityLabel={PICK_LABELS[source]}
                        onPress={() => onPick(source)}
                        className="min-h-11 flex-1 flex-row items-center justify-center gap-2 rounded-xl px-3 py-2 active:opacity-70"
                        style={{ backgroundColor: tone.tint }}
                    >
                        <AppSymbol
                            name={PICK_ICONS[source]}
                            size={18}
                            weight="medium"
                            color={{ value: tone.foreground }}
                        />
                        <Text weight="medium" style={{ color: tone.foreground }}>
                            {PICK_LABELS[source]}
                        </Text>
                    </Pressable>
                );
            })}
        </View>
    );
}

/** T3 Code's attachment strip: one tile per file, over the box. */
export function AttachmentTray({ tray, testID = 'composer-tray' }: { tray: Tray; testID?: string }) {
    const navigation = useNavigation();
    if (tray.items.length === 0) {
        return null;
    }
    const pictures = tray.items.flatMap((item) =>
        item.picture === null ? [] : [{ id: item.id, name: item.name, local: item.picture }],
    );
    return (
        <ScrollView
            horizontal
            testID={testID}
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ gap: 8, paddingTop: 6, paddingRight: 6 }}
        >
            {tray.items.map((item) => (
                <TrayTile
                    key={item.id}
                    item={item}
                    onRemove={() => tray.remove(item.id)}
                    onRetry={() => tray.retry(item.id)}
                    onOpen={() => {
                        const index = pictures.findIndex((picture) => picture.id === item.id);
                        if (index >= 0) {
                            navigation.navigate('AttachmentViewer', { images: pictures, index });
                        }
                    }}
                />
            ))}
        </ScrollView>
    );
}

function TrayTile(props: { item: TrayItem; onRemove: () => void; onRetry: () => void; onOpen: () => void }) {
    const { item } = props;
    const tone = theme[useScheme()].tones[item.tone];
    const failed = failedTileAction(item);
    return (
        <View style={{ width: TRAY_TILE, height: TRAY_TILE }} testID={`composer-tray-${item.id}`}>
            <Pressable
                accessibilityRole={item.picture === null ? 'text' : 'imagebutton'}
                accessibilityLabel={item.label}
                disabled={item.picture === null}
                onPress={props.onOpen}
                className="flex-1 overflow-hidden rounded-2xl"
                style={{ backgroundColor: tone.tint }}
            >
                {item.picture === null ? (
                    <View className="flex-1 items-center justify-center gap-1 p-2">
                        <TileGlyph text={item.kind === 'text'} size={22} color={tone.foreground} />
                        <Text variant="footnote" weight="medium" numberOfLines={1} style={{ color: tone.foreground }}>
                            {item.extension || 'FILE'}
                        </Text>
                    </View>
                ) : (
                    <Image
                        source={{ uri: item.picture }}
                        cachePolicy="memory"
                        contentFit="cover"
                        style={{ width: TRAY_TILE, height: TRAY_TILE }}
                        accessible={false}
                    />
                )}
                {item.uploading ? <IndeterminateBar /> : null}
                {failed === null ? null : (
                    <Pressable
                        testID={`composer-tray-${item.id}-${failed.action}`}
                        accessibilityRole="button"
                        accessibilityLabel={failed.accessibilityLabel}
                        onPress={failed.action === 'retry' ? props.onRetry : props.onRemove}
                        className="absolute inset-0 items-center justify-center gap-1 bg-black/55 p-1"
                    >
                        {failed.action === 'retry' ? <AppSymbol name="rotate-cw" size={16} color="white" /> : null}
                        <Text variant="footnote" weight="medium" numberOfLines={2} className="text-center text-white">
                            {failed.label}
                        </Text>
                    </Pressable>
                )}
            </Pressable>
            <Pressable
                testID={`composer-tray-${item.id}-remove`}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${item.name}`}
                onPress={props.onRemove}
                hitSlop={8}
                className="absolute -top-1.5 -right-1.5 size-6 items-center justify-center rounded-full border-2 border-card bg-foreground"
            >
                <AppSymbol name="x" size={12} color="background" />
            </Pressable>
        </View>
    );
}

/** A thin bar sliding along a tile's bottom while it uploads; still under Reduce Motion. */
function IndeterminateBar() {
    const reduceMotion = useReducedMotion();
    const [offset] = useState(() => new Animated.Value(0));
    useEffect(() => {
        if (reduceMotion) {
            offset.setValue(0.5);
            return undefined;
        }
        const loop = Animated.loop(Animated.timing(offset, { toValue: 1, duration: 1100, useNativeDriver: true }));
        offset.setValue(0);
        loop.start();
        return () => loop.stop();
    }, [offset, reduceMotion]);
    const width = TRAY_TILE * 0.4;
    return (
        <View
            accessibilityLabel="Uploading"
            className="absolute right-2 bottom-2 left-2 h-1 overflow-hidden rounded-full bg-black/25"
        >
            <Animated.View
                className="h-1 rounded-full bg-white"
                style={{
                    width,
                    transform: [
                        {
                            translateX: offset.interpolate({
                                inputRange: [0, 1],
                                outputRange: [-width, TRAY_TILE - 16],
                            }),
                        },
                    ],
                }}
            />
        </View>
    );
}

/** A picture's side in a bubble. */
const BUBBLE_PICTURE = 148;

/** A message's files in its bubble: pictures that open the viewer, then chips. */
export function MessageAttachments({ files, testID }: { files: readonly MessageFile[]; testID: string }) {
    const navigation = useNavigation();
    if (files.length === 0) {
        return null;
    }
    const pictures = viewerImages(files);
    return (
        <View
            className="flex-row flex-wrap items-end justify-end gap-2"
            testID={testID}
            accessibilityLabel="Attachments"
        >
            {files.map((file) =>
                file.picture ? (
                    <BubblePicture
                        key={file.id}
                        file={file}
                        onOpen={() =>
                            navigation.navigate('AttachmentViewer', {
                                images: pictures,
                                index: Math.max(
                                    0,
                                    pictures.findIndex((picture) => picture.id === file.id),
                                ),
                            })
                        }
                    />
                ) : (
                    <FileChip key={file.id} file={file} />
                ),
            )}
        </View>
    );
}

function BubblePicture({ file, onOpen }: { file: MessageFile; onOpen: () => void }) {
    const picture = useAttachmentPicture(file.id, file.local);
    const muted = theme[useScheme()].tones.slate;
    if (picture.state === 'gone') {
        return <FileChip file={file} removed />;
    }
    return (
        <Pressable
            testID={`chat-picture-${file.id}`}
            accessibilityRole="imagebutton"
            accessibilityLabel={`View ${file.name}`}
            onPress={onOpen}
            disabled={picture.state !== 'ready'}
            className="overflow-hidden rounded-2xl"
            style={{ width: BUBBLE_PICTURE, height: BUBBLE_PICTURE, backgroundColor: muted.tint }}
        >
            {picture.state === 'ready' ? (
                <Image
                    source={{ uri: picture.uri }}
                    cachePolicy="memory"
                    contentFit="cover"
                    style={{ width: BUBBLE_PICTURE, height: BUBBLE_PICTURE }}
                    accessible={false}
                />
            ) : (
                <View className="flex-1 items-center justify-center">
                    <AppSymbol
                        name={picture.state === 'failed' ? 'image-off' : 'image'}
                        size={24}
                        color="muted-foreground"
                    />
                </View>
            )}
        </Pressable>
    );
}

function FileChip({ file, removed = false }: { file: MessageFile; removed?: boolean }) {
    const tone = theme[useScheme()].tones[file.tone as ToneName];
    const info = useAttachmentInfo(removed || file.local !== null ? null : file.id);
    const view = fileChipView(file, info, removed);
    const openLink = useOpenLink();
    const href = view.href;
    return (
        <Pressable
            testID={`chat-file-${file.id}`}
            accessibilityRole={href === null ? 'text' : 'link'}
            accessibilityLabel={view.accessibilityLabel}
            disabled={href === null}
            onPress={() => {
                if (href !== null) {
                    openLink(href);
                }
            }}
            className="max-w-full flex-row items-center gap-2 rounded-2xl border border-border bg-card p-2 active:opacity-70"
        >
            <Squircle size={32} color={tone.tint}>
                {view.removed ? (
                    <AppSymbol name="image-off" size={16} color="muted-foreground" />
                ) : (
                    <TileGlyph text={file.mime.startsWith('text/')} size={16} color={tone.foreground} />
                )}
            </Squircle>
            <View className="shrink">
                <Text weight="medium" numberOfLines={1}>
                    {file.name}
                </Text>
                <Text variant="footnote" tone="muted">
                    {view.note}
                </Text>
            </View>
            {href === null ? null : <AppSymbol name="download" size={14} color="muted-foreground" />}
        </Pressable>
    );
}

/** Each scope's answers about its files, so a chip scrolled back into view asks nothing again. */
const infos = new WeakMap<WorkspaceScope, Map<string, Promise<AttachmentInfo | null>>>();

/** A file's size, or that it is gone (`loadAttachmentInfo`), asked once per scope; null until known or when `id` is. */
function useAttachmentInfo(id: string | null): AttachmentInfo | null {
    const scope = useWorkspaceScope();
    const [found, setFound] = useState<{ id: string; info: AttachmentInfo } | null>(null);
    useEffect(() => {
        if (id === null) {
            return undefined;
        }
        let asked = infos.get(scope);
        if (asked === undefined) {
            asked = new Map();
            infos.set(scope, asked);
        }
        let answer = asked.get(id);
        if (answer === undefined) {
            const cache = asked;
            answer = loadAttachmentInfo(scope.fetch, id, scope.signal).catch((error: unknown) => {
                // Asked again the next time the chip shows.
                cache.delete(id);
                console.warn('[attachments] the file’s details did not load', error);
                return null;
            });
            asked.set(id, answer);
        }
        let live = true;
        answer.then((info) => {
            if (live && info !== null) {
                setFound({ id, info });
            }
        });
        return () => {
            live = false;
        };
    }, [scope, id]);
    return found !== null && found.id === id ? found.info : null;
}

/** A file's icon in its tone's color (a text file's lines, else a page). */
function TileGlyph({ text, size, color }: { text: boolean; size: number; color: string }) {
    return <AppSymbol name={text ? 'file-text' : 'file'} size={size} color={{ value: color }} />;
}

/** A card's picture (the computer's screenshot): full width, the whole picture, opening the viewer. */
export function CardPicture({ image, testID }: { image: { id: string; name: string }; testID: string }) {
    const navigation = useNavigation();
    const picture = useAttachmentPicture(image.id);
    const muted = theme[useScheme()].tones.slate;
    if (picture.state === 'gone') {
        return null;
    }
    return (
        <Pressable
            testID={testID}
            accessibilityRole="imagebutton"
            accessibilityLabel={`View ${image.name}`}
            disabled={picture.state !== 'ready'}
            onPress={() => navigation.navigate('AttachmentViewer', { images: [{ ...image, local: null }], index: 0 })}
            className="aspect-video items-center justify-center self-stretch overflow-hidden rounded-lg"
            style={{ backgroundColor: muted.tint }}
        >
            {picture.state === 'ready' ? (
                <Image
                    source={{ uri: picture.uri }}
                    cachePolicy="memory"
                    contentFit="contain"
                    style={{ width: '100%', height: '100%' }}
                    accessible={false}
                />
            ) : (
                <AppSymbol
                    name={picture.state === 'failed' ? 'image-off' : 'image'}
                    size={24}
                    color="muted-foreground"
                />
            )}
        </Pressable>
    );
}
