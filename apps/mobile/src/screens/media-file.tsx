import { type StaticScreenProps, useNavigation } from '@react-navigation/native';
import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, View } from 'react-native';

import type { AttachmentView, MediaItem } from '@socio/shared/media-types';
import { MODULE_IDS } from '@socio/shared/modules';

import { useCollections, useHasWorkspaceScope, useLiveQuery, useWorkspaceScope } from '../live';
import { useNativeBar } from '../navigation/native-bar';
import { mediaFolderAction } from '../navigation/tabs';
import {
    openFilePreview,
    saveFileCopy,
    shareFile,
    type TextPreview,
    useFileBytes,
    useTextPreview,
} from '../platform/media-files';
import {
    type ActionNotice,
    type ActionOutcome,
    actionNotice,
    attachmentFileView,
    bytesLine,
    FILE_GONE,
    FILE_GONE_LINE,
    type FileBytes,
    type FileAction,
    type FileDetail,
    fileSource,
    hintFileView,
    itemFileView,
    type MediaFileParams,
    type MediaFileSource,
    type MediaFileView,
    NO_PREVIEW,
    OPEN_FILE,
    PREVIEW_FAILED,
    SAVE_FILE,
    SHARE_FILE,
    TEXT_PREVIEW_MORE,
    TRY_AGAIN,
} from '../shell/media';
import { moduleEntry } from '../shell/modules';
import { chatsQuery, sociosQuery } from '../shell/queries';
import { findAttachmentItem, readAttachment, readMediaItem } from '../sync/media-library';
import { AppSymbol, Button, GroupedCard, RowSeparator, Screen, separatorInset, Text, ToneTile } from '../ui';
import { cx } from '../ui/cx';
import { EmptyState, useWayBack } from '../ui/empty-state';

import { StatusBanners, useOpenChat } from './shell-parts';

// A file's page in Media (CB-558), the `MediaFile` route: the web's
// MediaPreview on a phone. It opens by library item (the Media list), by chat
// attachment (a file chip in a chat or room: no browser, no "Opens in your
// browser") or by issue attachment, and draws at once from what the caller
// knew of the file.
// - The bytes come through the workspace's session into the phone's `files/`
//   (src/platform/media-files.ts), never through a browser.
// - A picture shows in the page and opens the image viewer; text shows its
//   first 256 KB, as the web's preview does (under its actions and details,
//   which a long text would otherwise push far down); a PDF or any other file has Open,
//   the system's preview (Quick Look on iOS, the app the person picks on
//   Android), over its details.
// - Share is the system's share sheet and Save its save panel, in place of the
//   web's Download.
// - A chat attachment that isn't in the person's library (someone else's file
//   in a room) shows from its own record, by its attachment id.
// Never kept as the last screen: a relaunch downloads nothing no one tapped.

const MODULE = moduleEntry(MODULE_IDS.media);
const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

/** Lines of text drawn as one `Text`: a long file is many short ones, not one the layout chokes on. */
const TEXT_CHUNK_LINES = 80;

export function MediaFileScreen({ route }: StaticScreenProps<MediaFileParams>) {
    const source = fileSource(route.params ?? {});
    const scoped = useHasWorkspaceScope();
    if (!scoped) {
        return <View testID="media-file-screen" className="flex-1 bg-screen" collapsable={false}></View>;
    }
    return source === null ? <Gone /> : <FilePage source={source} hint={route.params} />;
}

function Gone() {
    useNativeBar({ title: MODULE.title });
    return <GoneBody />;
}

/** What the page read of the file: its library item, its attachment record, that it is gone, or nothing yet. */
type FileRecord =
    | { readonly state: 'reading' }
    | { readonly state: 'failed' }
    | { readonly state: 'gone' }
    | { readonly state: 'item'; readonly item: MediaItem }
    | { readonly state: 'attachment'; readonly attachment: AttachmentView };

/**
 * Reads the file's record online, once per page (and again on Try again): a library item by its id; a
 * chat attachment by its own id, then its library item when the library has one; nothing for an
 * issue's attachment, which the issue already described.
 */
function useFileRecord(source: MediaFileSource, attempt: number): FileRecord {
    const scope = useWorkspaceScope();
    const key = `${source.kind}:${source.id}:${attempt}`;
    const [read, setRead] = useState<{ key: string; record: FileRecord } | null>(null);
    useEffect(() => {
        if (source.kind === 'issue') {
            return undefined;
        }
        const controller = new AbortController();
        const { signal } = controller;
        const settle = (record: FileRecord) => {
            if (!signal.aborted) {
                setRead({ key, record });
            }
        };
        const run = async () => {
            if (source.kind === 'item') {
                const item = await readMediaItem(scope.fetch, source.id, signal);
                settle(item.state === 'gone' ? { state: 'gone' } : { state: 'item', item: item.value });
                return;
            }
            const attachment = await readAttachment(scope.fetch, source.id, signal);
            if (attachment.state === 'gone' || attachment.value.path === null) {
                settle({ state: 'gone' });
                return;
            }
            // Shown by its own record at once; its library item, if the library has one, fills in the rest.
            settle({ state: 'attachment', attachment: attachment.value });
            const item = await findAttachmentItem(scope.fetch, attachment.value, signal).catch(() => null);
            if (item !== null) {
                settle({ state: 'item', item });
            }
        };
        run().catch((error: unknown) => {
            console.warn('[media] the file’s details did not load', error);
            settle({ state: 'failed' });
        });
        return () => controller.abort();
    }, [scope, source.kind, source.id, key]);
    if (source.kind === 'issue') {
        return { state: 'failed' };
    }
    return read?.key === key ? read.record : { state: 'reading' };
}

function FilePage({ source, hint }: { source: MediaFileSource; hint: MediaFileParams }) {
    const collections = useCollections();
    const { data: dots } = useLiveQuery({ query: sociosQuery(collections) });
    const { data: chats } = useLiveQuery({ query: chatsQuery(collections) });
    const [attempt, setAttempt] = useState(0);
    const record = useFileRecord(source, attempt);
    const socioName = (id: string) => dots.find((dot) => dot.id === id)?.name;
    const chatTitle = (id: string) => chats.find((chat) => chat.id === id)?.title ?? null;
    const view: MediaFileView =
        record.state === 'item'
            ? itemFileView(record.item, socioName, undefined, source.kind === 'attachment' ? source.id : undefined)
            : record.state === 'attachment'
              ? attachmentFileView(record.attachment, chatTitle)
              : hintFileView(source, hint);
    useNativeBar({ title: view.name });
    if (record.state === 'gone') {
        return <GoneBody />;
    }
    return <FileBody view={view} attempt={attempt} onRetry={() => setAttempt((count) => count + 1)} />;
}

function GoneBody() {
    const back = useWayBack('MediaFile');
    return (
        <View testID="media-file-screen" className="flex-1 bg-screen" collapsable={false}>
            <Screen centered edges={['right', 'bottom', 'left']}>
                <EmptyState
                    tile={{ tone: MODULE.tone, icon: 'file' }}
                    headline={FILE_GONE}
                    line={FILE_GONE_LINE}
                    action={back}
                    testID="media-file-gone"
                />
            </Screen>
        </View>
    );
}

function FileBody({ view, attempt, onRetry }: { view: MediaFileView; attempt: number; onRetry: () => void }) {
    const navigation = useNavigation();
    const openChat = useOpenChat();
    const { bytes, recheck } = useFileBytes(view, attempt);
    const [notice, setNotice] = useState<ActionNotice | null>(null);
    const [busy, setBusy] = useState<FileAction | null>(null);
    const uri = bytes.state === 'ready' ? bytes.uri : null;
    const works: Record<FileAction, (file: string) => Promise<ActionOutcome>> = {
        open: (file) => openFilePreview(file, view.mediaType, view.name),
        share: (file) => shareFile(file, view.mediaType, view.name),
        save: (file) => saveFileCopy(file, view.mediaType, view.name),
    };
    // Each action looks at the copy first: one deleted since the page opened is downloaded again,
    // and an action that can't go ahead says so with Try again.
    const run = (name: FileAction) => {
        if (busy !== null) {
            return;
        }
        setBusy(name);
        setNotice(null);
        recheck()
            .then(async (now) => (now.state === 'ready' ? works[name](now.uri) : 'no-copy'))
            .then((outcome) => setNotice(actionNotice(name, outcome, view.name)))
            .catch((error: unknown) => {
                console.warn('[media] the action failed', error);
                setNotice(actionNotice(name, 'failed', view.name));
            })
            .finally(() => setBusy(null));
    };
    const viewPicture = () => {
        if (uri === null) {
            return;
        }
        void recheck().then((now) => {
            if (now.state === 'ready') {
                navigation.navigate('AttachmentViewer', {
                    images: [{ id: view.cacheKey, name: view.name, local: now.uri }],
                    index: 0,
                });
            }
        });
    };
    // Text can run to 256 KB: its actions and details come first, so they are never a long scroll away.
    const textLast = view.preview === 'text' && uri !== null;
    const preview = <Preview view={view} bytes={bytes} onViewPicture={viewPicture} onRetry={onRetry} />;
    return (
        <View testID="media-file-screen" className="flex-1 bg-screen" collapsable={false}>
            <Screen edges={['right', 'bottom', 'left']} grouped>
                <StatusBanners />
                {textLast ? null : preview}
                <View className="flex-row flex-wrap gap-2">
                    {view.preview === 'image' ? null : (
                        <Button
                            label={OPEN_FILE}
                            icon="external-link"
                            variant={view.preview === 'text' ? 'secondary' : 'primary'}
                            disabled={uri === null}
                            busy={busy === 'open'}
                            onPress={() => run('open')}
                            accessibilityHint="Opens the file in a preview"
                            testID="media-file-open"
                        />
                    )}
                    <Button
                        label={SHARE_FILE}
                        icon="share"
                        variant="secondary"
                        disabled={uri === null}
                        busy={busy === 'share'}
                        onPress={() => run('share')}
                        testID="media-file-share"
                    />
                    <Button
                        label={SAVE_FILE}
                        icon="download"
                        variant="secondary"
                        disabled={uri === null}
                        busy={busy === 'save'}
                        onPress={() => run('save')}
                        accessibilityHint="Saves a copy where you choose"
                        testID="media-file-save"
                    />
                </View>
                {notice === null ? null : (
                    <View className="gap-2">
                        <Text
                            variant="footnote"
                            tone="muted"
                            accessibilityLiveRegion="polite"
                            testID="media-file-notice"
                        >
                            {notice.line}
                        </Text>
                        {notice.retry === null ? null : (
                            <View className="flex-row">
                                <Button
                                    label={TRY_AGAIN}
                                    variant="secondary"
                                    busy={busy === notice.retry}
                                    onPress={() => notice.retry !== null && run(notice.retry)}
                                    testID="media-file-action-retry"
                                />
                            </View>
                        )}
                    </View>
                )}
                {view.details.length === 0 ? null : (
                    <GroupedCard testID="media-file-details">
                        {view.details.map((detail, index) => (
                            <DetailRow
                                key={detail.label}
                                detail={detail}
                                first={index === 0}
                                onOpenChat={(id) => openChat({ id, room: false })}
                                onOpenFolder={(folder) => navigation.dispatch(mediaFolderAction(folder))}
                            />
                        ))}
                    </GroupedCard>
                )}
                {textLast ? preview : null}
            </Screen>
        </View>
    );
}

/** One of the web's detail rows: its label, its value, and a chevron when it opens a chat or a folder. */
function DetailRow(props: {
    detail: FileDetail;
    first: boolean;
    onOpenChat: (threadId: string) => void;
    onOpenFolder: (folder: string) => void;
}) {
    const { detail } = props;
    const press =
        detail.threadId !== undefined
            ? () => props.onOpenChat(detail.threadId as string)
            : detail.folder !== undefined
              ? () => props.onOpenFolder(detail.folder as string)
              : null;
    const body = (
        <>
            {props.first ? null : <RowSeparator inset={separatorInset(null)} />}
            <Text tone="muted" className="shrink-0">
                {detail.label}
            </Text>
            <Text className="min-w-0 flex-1 text-right" numberOfLines={2}>
                {detail.value}
            </Text>
            {press === null ? null : <AppSymbol name="chevron-right" color="muted-foreground" />}
        </>
    );
    const row = 'min-h-11 flex-row items-center gap-3 p-3';
    return press === null ? (
        <View accessible accessibilityLabel={`${detail.label}, ${detail.value}`} className={row} testID={detail.testID}>
            {body}
        </View>
    ) : (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${detail.label}, ${detail.value}`}
            onPress={press}
            className={cx(row, 'active:bg-accent')}
            testID={detail.testID}
        >
            {body}
        </Pressable>
    );
}

/** The file itself: its picture, the start of its text, or its type's tile with why there is no preview. */
function Preview(props: { view: MediaFileView; bytes: FileBytes; onViewPicture: () => void; onRetry: () => void }) {
    const { view, bytes } = props;
    const line = bytesLine(bytes);
    const text = useTextPreview(view.preview === 'text' && bytes.state === 'ready' ? bytes.uri : null);
    if (bytes.state !== 'ready') {
        return (
            <View className="items-center gap-3 rounded-xl bg-card p-6" testID="media-file-waiting">
                <ToneTile tone={MODULE.tone} icon={view.symbol} surface="card" />
                {bytes.state === 'loading' ? <ActivityIndicator accessibilityLabel="Downloading the file" /> : null}
                <Text variant="subheadline" tone="muted" className="text-center" testID="media-file-state">
                    {line}
                </Text>
                {bytes.state === 'failed' ? (
                    <Button label={TRY_AGAIN} variant="secondary" onPress={props.onRetry} testID="media-file-retry" />
                ) : null}
            </View>
        );
    }
    if (view.preview === 'image') {
        return (
            <Pressable
                accessibilityRole="imagebutton"
                accessibilityLabel={`View ${view.name}`}
                onPress={props.onViewPicture}
                className="overflow-hidden rounded-xl bg-card"
                testID="media-file-picture"
            >
                <Image
                    source={{ uri: bytes.uri }}
                    cachePolicy="memory"
                    contentFit="contain"
                    style={{ width: '100%', height: 320 }}
                    accessible={false}
                />
            </Pressable>
        );
    }
    if (view.preview === 'text') {
        return <TextBlock text={text} />;
    }
    return (
        <View className="flex-row items-center gap-3 rounded-xl bg-card p-4" testID="media-file-no-preview">
            <ToneTile tone={MODULE.tone} icon={view.symbol} surface="card" />
            <Text variant="subheadline" tone="muted" className="min-w-0 flex-1">
                {NO_PREVIEW}
            </Text>
        </View>
    );
}

/** Text in the web's monospace block, drawn a chunk of lines at a time. */
function TextBlock({ text }: { text: TextPreview | 'failed' | null }) {
    if (text === 'failed') {
        return (
            <Text variant="subheadline" tone="muted" testID="media-file-text-failed">
                {PREVIEW_FAILED}
            </Text>
        );
    }
    if (text === null) {
        return (
            <View className="items-center rounded-xl bg-card p-6">
                <ActivityIndicator accessibilityLabel="Loading the preview" />
            </View>
        );
    }
    const lines = text.text.split('\n');
    const chunks: string[] = [];
    for (let at = 0; at < lines.length; at += TEXT_CHUNK_LINES) {
        chunks.push(lines.slice(at, at + TEXT_CHUNK_LINES).join('\n'));
    }
    return (
        <View className="rounded-xl bg-card p-3" testID="media-file-text">
            {chunks.map((chunk, index) => (
                <Text
                    // oxlint-disable-next-line react/no-array-index-key -- the chunks of one text never reorder
                    key={index}
                    variant="footnote"
                    selectable
                    style={{ fontFamily: MONO }}
                >
                    {chunk}
                </Text>
            ))}
            {text.more ? (
                <Text variant="footnote" tone="muted" className="pt-2" testID="media-file-text-more">
                    {TEXT_PREVIEW_MORE}
                </Text>
            ) : null}
        </View>
    );
}
