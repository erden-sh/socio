import { Directory, File, Paths } from 'expo-file-system';
import { getContentUriAsync, moveAsync } from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

import { previewFile, saveFile, setFileProtection } from '../../modules/socio-device';
import { workspaceLayout } from '../data';
import { useWorkspaceScope } from '../live';
import { type FileBytes, type MediaFileView, TEXT_PREVIEW_BYTES } from '../shell/media';
import { createFileCache, type FileCache } from '../sync/file-cache';
import type { WorkspaceScope } from '../sync/scope';

import { storeFiles, storeRoot } from './active-scope';
import { createSizeOf } from './cache-size';
import { fileUri } from './file-system';

// The Media file page's files (CB-558; src/sync/file-cache.ts) for the open
// workspace: one cache per scope, made when a page first asks, gone with the
// scope. A file's bytes come through the scope's authedFetch into the
// workspace's `files/`, and everything the page does with them starts from
// that copy: the text preview reads it, the system's preview shows it (Quick
// Look on iOS, the app the person picks on Android, through socio-device), the
// share sheet takes it (expo-sharing) and the save panel copies it. Nothing
// here opens a browser.

const caches = new WeakMap<WorkspaceScope, FileCache>();
const sizeOf = createSizeOf();

function cacheOf(scope: WorkspaceScope): FileCache {
    let cache = caches.get(scope);
    if (cache === undefined) {
        cache = createFileCache({
            fetch: scope.fetch,
            files: {
                list: (path) => storeFiles().list(path),
                remove: async (path) => {
                    const uri = fileUri(path);
                    const info = Paths.info(uri);
                    if (!info.exists) {
                        return;
                    }
                    if (info.isDirectory) {
                        new Directory(uri).delete();
                    } else {
                        new File(uri).delete();
                    }
                },
                mkdir: (path) => storeFiles().mkdir(path),
                size: sizeOf,
                write: async (path, bytes) => {
                    const file = new File(fileUri(path));
                    file.create({ overwrite: true });
                    await file.write(bytes);
                },
                move: (from, to) => moveAsync({ from: fileUri(from), to: fileUri(to) }),
            },
            layout: workspaceLayout(storeRoot(), scope.workspace.id),
            setFileProtection,
            signal: scope.signal,
            onError: (error) => console.warn('[media] file cache', error),
        });
        caches.set(scope, cache);
    }
    return cache;
}

/**
 * The file's bytes on the phone: its copy from the cache, else downloaded once through the
 * workspace's session. `attempt` asks again after a failure (Try again).
 */
export function useFileBytes(view: Pick<MediaFileView, 'cacheKey' | 'url' | 'name' | 'size'>, attempt = 0): FileBytes {
    const scope = useWorkspaceScope();
    const cache = cacheOf(scope);
    const { cacheKey, url, name, size } = view;
    const [found, setFound] = useState<{ key: string; bytes: FileBytes } | null>(null);
    const key = `${cacheKey}#${attempt}`;
    useEffect(() => {
        let live = true;
        cache
            .load({ key: cacheKey, url, name, ...(size >= 0 ? { size } : {}) })
            .then((load) => {
                if (live) {
                    setFound({
                        key,
                        bytes: load.state === 'ready' ? { state: 'ready', uri: fileUri(load.path) } : load,
                    });
                }
            })
            .catch(() => live && setFound({ key, bytes: { state: 'failed' } }));
        return () => {
            live = false;
        };
    }, [cache, cacheKey, url, name, size, key]);
    return found?.key === key ? found.bytes : { state: 'loading' };
}

/** A text file's first 256 KB, as the web's TextPreview shows it, and whether there is more. */
export interface TextPreview {
    readonly text: string;
    readonly more: boolean;
}

/** Reads the start of a downloaded text file: only its first 256 KB leave the disk. */
export async function readTextPreview(uri: string): Promise<TextPreview> {
    const file = new File(uri);
    const size = file.size ?? 0;
    const handle = file.open();
    try {
        const bytes = await handle.readBytes(Math.min(size, TEXT_PREVIEW_BYTES));
        return { text: new TextDecoder().decode(bytes), more: size > TEXT_PREVIEW_BYTES };
    } finally {
        handle.close();
    }
}

/** The start of a downloaded text file, read once per copy: null while it loads, `failed` when it can't be read. */
export function useTextPreview(uri: string | null): TextPreview | 'failed' | null {
    const [read, setRead] = useState<{ uri: string; preview: TextPreview | 'failed' } | null>(null);
    useEffect(() => {
        if (uri === null) {
            return undefined;
        }
        let live = true;
        readTextPreview(uri)
            .then((preview) => live && setRead({ uri, preview }))
            .catch((error: unknown) => {
                console.warn('[media] the text preview did not load', error);
                if (live) {
                    setRead({ uri, preview: 'failed' });
                }
            });
        return () => {
            live = false;
        };
    }, [uri]);
    return uri !== null && read?.uri === uri ? read.preview : null;
}

export type OpenOutcome = 'shown' | 'no-app' | 'unavailable';

/** The system's preview of a downloaded file: Quick Look on iOS, the app the person picks on Android. */
export async function openFilePreview(uri: string, mimeType: string, name: string): Promise<OpenOutcome> {
    try {
        const contentUri = Platform.OS === 'android' ? await getContentUriAsync(uri) : null;
        return await previewFile(uri, mimeType, name, contentUri);
    } catch (error) {
        console.warn('[media] the preview did not open', error);
        return 'unavailable';
    }
}

export type ShareFileOutcome = 'shared' | 'unavailable';

/** The system's share sheet with a downloaded file; resolves once the sheet is closed. */
export async function shareFile(uri: string, mimeType: string, title: string): Promise<ShareFileOutcome> {
    try {
        if (!(await Sharing.isAvailableAsync())) {
            return 'unavailable';
        }
        await Sharing.shareAsync(uri, {
            ...(mimeType === '' || mimeType === 'application/octet-stream' ? {} : { mimeType }),
            dialogTitle: title,
        });
        return 'shared';
    } catch (error) {
        console.warn('[media] the share sheet did not open', error);
        return 'unavailable';
    }
}

export type SaveOutcome = 'saved' | 'cancelled' | 'failed' | 'unavailable';

/** The system's save panel with a copy of a downloaded file: where the person picks, under its name. */
export async function saveFileCopy(uri: string, mimeType: string, name: string): Promise<SaveOutcome> {
    try {
        return await saveFile(uri, mimeType, name);
    } catch (error) {
        console.warn('[media] the file was not saved', error);
        return 'failed';
    }
}
