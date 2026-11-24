import { File } from 'expo-file-system';
import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';

import type { DirectoryPerson, ViewFile, ViewUser, WriteCell } from '@socio/shared/dataset-views/contract';
import { cellItems } from '@socio/shared/dataset-views/format';

import { fileUrl, PICK_CAMERA, PICK_FILES, PICK_PHOTOS, type PickSource } from '../chat/attachment-tray';
import { processPageImage } from '../platform/image-processor';
import { clearPickerCache, pick } from '../platform/pickers';
import {
    datasetTakes,
    offersFileAdd,
    personRows,
    pickedPeople,
    REFUSAL_COPY,
    refusalCopy,
} from '../shell/dataset-writes';
import type { ViewSource } from '../sync/view-source';
import { AppSymbol, Button, SearchField, Text } from '../ui';
import { cx } from '../ui/cx';

import { ActionMenu } from './action-menu';

// A dataset cell's pickers (CB-469, CB-451):
// - `PersonPicker`: the workspace's people from `GET /api/people` (ETag, read
//   once per screen: `usePeople`), searched as typed, one checked for a person
//   field or several for people. Someone the cell holds who has been
//   deactivated, or isn't in the workspace, shows muted ("Deactivated") and
//   can be removed but is never offered; their names come from the page's
//   `users`, else `POST /api/people/lookup`.
// - `FileCell`: the cell's files as chips with Remove, and Add file, the
//   composer's three choices (Photos, Camera, Files) as the system's menu.
//   `useDatasetUpload` picks through the attach picker (`src/platform/pickers.ts`,
//   CB-417), turns a HEIC or other photo type into JPEG (the page image
//   profile), refuses what a dataset doesn't take before sending, and uploads
//   the bytes to the dataset's files; the caller writes the id with a cell
//   edit or a new row. Add file shows only while `DATASET_FILE_UPLOADS` is on
//   (off until CB-532).

/** The directory, read the first time a picker needs it. */
export function usePeople(source: ViewSource, wanted: boolean) {
    const [people, setPeople] = useState<readonly DirectoryPerson[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        if (!wanted || people !== null) {
            return;
        }
        let live = true;
        source
            .people()
            .then((answer) => live && setPeople(answer.people))
            .catch(() => live && setError(REFUSAL_COPY.network));
        return () => {
            live = false;
        };
    }, [source, wanted, people]);
    return { people, error };
}

/** Names for the ids a cell holds that the page's map doesn't (a deactivated person included). */
export function useKnownPeople(
    source: ViewSource,
    users: Readonly<Record<string, ViewUser>>,
    ids: readonly string[],
): Readonly<Record<string, ViewUser>> {
    const [found, setFound] = useState<Readonly<Record<string, ViewUser>>>({});
    const missing = ids.filter((id) => users[id] === undefined && found[id] === undefined);
    const key = missing.join('\n');
    useEffect(() => {
        if (key === '') {
            return;
        }
        let live = true;
        source
            .lookupPeople(key.split('\n'))
            .then((answer) => live && setFound((held) => ({ ...held, ...answer.users })))
            .catch(() => {});
        return () => {
            live = false;
        };
    }, [source, key]);
    return { ...found, ...users };
}

export function PersonPicker(props: {
    label: string;
    raw: unknown;
    many: boolean;
    directory: readonly DirectoryPerson[] | null;
    directoryError: string | null;
    known: Readonly<Record<string, ViewUser>>;
    onPick: (to: WriteCell) => void;
    onDone: () => void;
    testID: string;
}) {
    const [query, setQuery] = useState('');
    const held = cellItems(props.raw);
    const rows = personRows(props.directory ?? [], held, props.known, query);
    return (
        <View className="gap-2" testID={props.testID}>
            <SearchField
                label={`Search people for ${props.label}`}
                placeholder="Search people"
                value={query}
                onChangeText={setQuery}
                autoCorrect={false}
                testID={`${props.testID}-search`}
            />
            {props.directory === null ? (
                <Text variant="subheadline" tone={props.directoryError === null ? 'muted' : 'destructive'}>
                    {props.directoryError ?? 'Loading people…'}
                </Text>
            ) : rows.length === 0 ? (
                <Text variant="subheadline" tone="muted">
                    {query.trim() === '' ? 'No one to choose yet.' : `No one matches “${query.trim()}”.`}
                </Text>
            ) : (
                <View className="overflow-hidden rounded-xl border border-border">
                    {rows.map((row, index) => (
                        <Pressable
                            key={row.id}
                            onPress={() =>
                                row.muted && !row.chosen
                                    ? undefined
                                    : props.onPick(pickedPeople(props.raw, row.id, props.many))
                            }
                            accessibilityRole={props.many ? 'checkbox' : 'radio'}
                            accessibilityState={{ checked: row.chosen }}
                            accessibilityLabel={row.note === undefined ? row.name : `${row.name}, ${row.note}`}
                            accessibilityHint={row.muted && row.chosen ? 'Removes them' : undefined}
                            className={cx(
                                'min-h-11 flex-row items-center gap-3 px-3 py-2 active:bg-accent',
                                index > 0 && 'border-t border-border',
                            )}
                            testID={`${props.testID}-${row.id}`}
                        >
                            <View
                                className={cx(
                                    'size-8 items-center justify-center rounded-full',
                                    row.muted ? 'bg-muted' : 'bg-primary/15',
                                )}
                            >
                                <Text variant="footnote" weight="semibold" tone={row.muted ? 'muted' : 'primary'}>
                                    {row.name.charAt(0).toUpperCase()}
                                </Text>
                            </View>
                            <View className="min-w-0 flex-1">
                                <Text numberOfLines={1} tone={row.muted ? 'muted' : 'default'}>
                                    {row.name}
                                </Text>
                                {row.note === undefined ? null : (
                                    <Text variant="footnote" tone="muted">
                                        {row.note}
                                    </Text>
                                )}
                            </View>
                            {row.chosen ? <AppSymbol name="check" color="primary" /> : null}
                        </Pressable>
                    ))}
                </View>
            )}
            <Button label="Done" variant="ghost" onPress={props.onDone} testID={`${props.testID}-done`} />
        </View>
    );
}

/** What an upload came to: the file's id and entry, or the words for why not. */
export type DatasetUploadResult =
    | { readonly ok: true; readonly id: string; readonly file: ViewFile }
    | { readonly ok: false; readonly message: string };

export const UPLOAD_COPY = {
    denied: 'Socio can’t use the camera. Allow it in Settings to take a photo.',
    failed: 'That didn’t open. Try again.',
} as const;

/** Picks one file with the attach picker and uploads it to the dataset; null when nothing was picked. */
async function pickAndUpload(
    source: ViewSource,
    datasetId: string,
    from: PickSource,
): Promise<DatasetUploadResult | null> {
    try {
        const picked = await pick(from, 1);
        if (picked.kind === 'denied') {
            return { ok: false, message: UPLOAD_COPY.denied };
        }
        const first = picked.kind === 'picked' ? picked.files[0] : undefined;
        if (first === undefined) {
            return null;
        }
        const file =
            first.mime.startsWith('image/') && !datasetTakes(first.mime) ? await processPageImage(first) : first;
        if (!datasetTakes(file.mime)) {
            return { ok: false, message: REFUSAL_COPY.unsupported_file };
        }
        const answer = await source.uploadFile(datasetId, {
            body: new File(fileUrl(file.uri)),
            name: file.name,
            type: file.mime,
            bytes: file.bytes,
        });
        if (answer.outcome === 'refused') {
            return { ok: false, message: refusalCopy(answer) };
        }
        const { id, ...entry } = answer.uploaded.file;
        return { ok: true, id, file: entry };
    } catch (error) {
        console.warn('[datasets] a file was not uploaded', error);
        return { ok: false, message: UPLOAD_COPY.failed };
    } finally {
        clearPickerCache();
    }
}

/** `upload(from)`: the attach picker, then the dataset's files; `busy` while it goes. */
export function useDatasetUpload(source: ViewSource, datasetId: string) {
    const [busy, setBusy] = useState(false);
    const upload = (from: PickSource): Promise<DatasetUploadResult | null> => {
        setBusy(true);
        return pickAndUpload(source, datasetId, from).finally(() => setBusy(false));
    };
    return { upload, busy };
}

const PICK_CHOICES: readonly { name: PickSource; label: string; icon: string }[] = [
    { name: 'photos', label: PICK_PHOTOS, icon: 'photo.on.rectangle' },
    { name: 'camera', label: PICK_CAMERA, icon: 'camera' },
    { name: 'files', label: PICK_FILES, icon: 'folder' },
];

export function FileCell(props: {
    label: string;
    raw: unknown;
    files: Readonly<Record<string, ViewFile>>;
    editable: boolean;
    busy: boolean;
    onAdd: (from: PickSource) => void;
    onRemove: (id: string) => void;
    testID: string;
}) {
    const ids = cellItems(props.raw).map(String);
    return (
        <View className="gap-2" testID={props.testID}>
            {ids.length === 0 ? (
                <Text variant="subheadline" tone="muted">
                    No files
                </Text>
            ) : (
                <View className="gap-1.5">
                    {ids.map((id) => {
                        const file = props.files[id];
                        const name = file?.name ?? 'File not available';
                        return (
                            <View
                                key={id}
                                className="min-h-11 flex-row items-center gap-2 rounded-lg bg-muted px-3"
                                testID={`${props.testID}-${id}`}
                            >
                                <AppSymbol
                                    name={file?.type.startsWith('image/') === true ? 'image' : 'file-text'}
                                    size={16}
                                    color="muted-foreground"
                                />
                                <Text
                                    numberOfLines={1}
                                    className="min-w-0 flex-1"
                                    tone={file === undefined ? 'muted' : 'default'}
                                >
                                    {name}
                                </Text>
                                {props.editable ? (
                                    <Button
                                        label={`Remove ${name}`}
                                        icon="x"
                                        iconOnly
                                        variant="ghost"
                                        disabled={props.busy}
                                        onPress={() => props.onRemove(id)}
                                        testID={`${props.testID}-${id}-remove`}
                                    />
                                ) : null}
                            </View>
                        );
                    })}
                </View>
            )}
            {offersFileAdd(props.editable) ? (
                <ActionMenu
                    trigger="press"
                    label={`Add a file to ${props.label}`}
                    testID={`${props.testID}-add`}
                    disabled={props.busy}
                    request={{
                        title: 'Add a file',
                        actions: PICK_CHOICES.map((c) => ({ name: c.name, label: c.label, icon: c.icon })),
                        onAction: (name) => props.onAdd(name as PickSource),
                    }}
                >
                    <View className="min-h-11 flex-row items-center gap-2 self-start px-1">
                        <AppSymbol name={props.busy ? 'loader-circle' : 'paperclip'} size={16} color="primary" />
                        <Text tone="primary" weight="medium">
                            {props.busy ? 'Uploading…' : 'Add file'}
                        </Text>
                    </View>
                </ActionMenu>
            ) : null}
        </View>
    );
}
