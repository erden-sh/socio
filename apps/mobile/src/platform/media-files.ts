import { useFocusEffect } from '@react-navigation/native';
import { File } from 'expo-file-system';
import { getContentUriAsync } from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';

import { previewFile, saveFile, setFileProtection } from '../../modules/socio-device';
import { workspaceLayout } from '../data';
import { useWorkspaceScope } from '../live';
import { type FileBytes, type MediaFileView, TEXT_PREVIEW_BYTES } from '../shell/media';
import { createFileCache, type FileCache, type FileLoad } from '../sync/file-cache';
import type { WorkspaceScope } from '../sync/scope';

import { storeFiles, storeRoot } from './active-scope';
import { createSizeOf } from './cache-size';
import { createFileCacheFiles } from './file-cache-files';
import { fileUri } from './file-system';

// The Media file page's files (CB-558; src/sync/file-cache.ts) for the open
// workspace: one cache per scope, made when a page first asks, gone with the
// scope. A file's bytes come through the scope's authedFetch into the
// workspace's `files/`, and everything the page does with them starts from
// that copy: the text preview reads it, the system's preview shows it (Quick
// Look on iOS, the app the person picks on Android, through socio-device), the
// share sheet takes it (expo-sharing) and the save panel copies it. Nothing
// here opens a browser.
// - A page checks its copy with the server once as it opens (a file can be
//   replaced under its id), holds it out of the eviction while it is open,
//   and looks again each time it regains focus and before each action, so a
//   copy deleted all the same is downloaded again rather than handed on.

const caches = new WeakMap<WorkspaceScope, FileCache>();
const sizeOf = createSizeOf();

function cacheOf(scope: WorkspaceScope): FileCache {
    let cache = caches.get(scope);
    if (cache === undefined) {
        cache = createFileCache({
            fetch: scope.fetch,
            files: createFileCacheFiles(storeFiles(), sizeOf),
            layout: workspaceLayout(storeRoot(), scope.workspace.id),
            setFileProtection,
            signal: scope.signal,
            onError: (error) => console.warn('[media] file cache', error),
        });
        caches.set(scope, cache);
    }
    return cache;
}

const bytesOf = (load: FileLoad): FileBytes =>
    load.state === 'ready' ? { state: 'ready', uri: fileUri(load.path) } : load;

/** The page's copy of the file, and a way to look at it again before handing it on. */
export interface FileBytesHandle {
    readonly bytes: FileBytes;
    /** Checks the copy is still there (downloading it again when it isn't) and answers what the page now has. */
    recheck(): Promise<FileBytes>;
}

/**
 * The file's bytes on the phone: its copy from the cache, checked with the server as the page opens,
 * else downloaded once through the workspace's session. `attempt` asks again after a failure (Try
 * again). The copy is held while the page is open and looked at again whenever it regains focus.
 */
export function useFileBytes(
    view: Pick<MediaFileView, 'cacheKey' | 'url' | 'name' | 'size'>,
    attempt = 0,
): FileBytesHandle {
    const scope = useWorkspaceScope();
    const cache = cacheOf(scope);
    const { cacheKey, url, name, size } = view;
    // A copy the server confirmed before the page opened is checked again (once: then it is newer).
    const [opened] = useState(() => Date.now());
    const [found, setFound] = useState<{ key: string; bytes: FileBytes } | null>(null);
    const key = `${cacheKey}#${attempt}`;
    const load = useCallback(
        () =>
            cache
                .load({ key: cacheKey, url, name, ...(size >= 0 ? { size } : {}) }, { checkedSince: opened })
                .then(bytesOf, (): FileBytes => ({ state: 'failed' })),
        [cache, cacheKey, url, name, size, opened],
    );
    useEffect(() => cache.hold(cacheKey), [cache, cacheKey]);
    useEffect(() => {
        let live = true;
        void load().then((bytes) => live && setFound({ key, bytes }));
        return () => {
            live = false;
        };
    }, [load, key]);
    // Back on the page (another tab, the image viewer): its copy may have gone meanwhile.
    useFocusEffect(
        useCallback(() => {
            let live = true;
            void load().then((bytes) => live && setFound((was) => (was?.key === key ? { key, bytes } : was)));
            return () => {
                live = false;
            };
        }, [load, key]),
    );
    const recheck = async () => {
        const bytes = await load();
        setFound({ key, bytes });
        return bytes;
    };
    return { bytes: found?.key === key ? found.bytes : { state: 'loading' }, recheck };
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

export type ShareFileOutcome = 'shared' | 'unavailable' | 'failed';

/** The system's share sheet with a downloaded file; resolves once the sheet is closed. `unavailable`: no share sheet. */
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
        return 'failed';
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
