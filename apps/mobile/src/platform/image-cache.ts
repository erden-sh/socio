import { File } from 'expo-file-system';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { setFileProtection } from '../../modules/socio-device';
import { workspaceLayout } from '../data';
import { useWorkspaceScope } from '../live';
import { createImageCache, type ImageCache, type ImageKind } from '../sync/image-cache';
import type { WorkspaceScope } from '../sync/scope';

import { storeFiles, storeRoot } from './active-scope';
import { createSizeOf } from './cache-size';
import { fileUri } from './file-system';

// The app's image cache (src/sync/image-cache.ts) for the open workspace: one
// per scope, made when a screen first asks, gone with the scope. Its files are
// the store's file system plus expo-file-system's File for a size and a write.
// `useAttachmentPicture` is what a thumbnail or the viewer asks: the cached
// file as `file://` (shown with expo-image's `cachePolicy: 'memory'`), loading
// it once through the scope's authedFetch when it isn't there yet.

const caches = new WeakMap<WorkspaceScope, ImageCache>();
const sizeOf = createSizeOf();

function cacheOf(scope: WorkspaceScope): ImageCache {
    let cache = caches.get(scope);
    if (cache === undefined) {
        cache = createImageCache({
            fetch: scope.fetch,
            files: {
                list: (path) => storeFiles().list(path),
                remove: async (path) => {
                    const file = new File(fileUri(path));
                    if (file.exists) {
                        file.delete();
                    }
                },
                mkdir: (path) => storeFiles().mkdir(path),
                size: sizeOf,
                write: async (path, bytes) => {
                    const file = new File(fileUri(path));
                    file.create({ overwrite: true });
                    await file.write(bytes);
                },
                move: async (from, to) => {
                    await new File(fileUri(from)).move(new File(fileUri(to)), { overwrite: true });
                },
            },
            layout: workspaceLayout(storeRoot(), scope.workspace.id),
            setFileProtection,
            signal: scope.signal,
            onError: (error) => console.warn('[images]', error),
        });
        caches.set(scope, cache);
    }
    return cache;
}

/** A media embed's picture as a file (the page editor's pictures): from the cache, else loaded once. */
export async function loadEmbedFile(scope: WorkspaceScope, id: string): Promise<string | null> {
    const load = await cacheOf(scope).load(id, 0, 'embed');
    return load.state === 'ready' ? fileUri(load.path) : null;
}

/** What a picture shows: its file, a wait, or nothing to show (gone, or not now). */
export type Picture =
    | { readonly state: 'ready'; readonly uri: string }
    | { readonly state: 'loading' }
    | { readonly state: 'gone' }
    | { readonly state: 'failed' };

/**
 * An attachment's picture (a chat's, or an issue's with `kind` 'issue'): `local` (a copy on the phone, a pending bubble's or
 * the tray's) as it is, else the cached file, loaded once when missing.
 */
export function useAttachmentPicture(id: string, local: string | null = null, kind: ImageKind = 'attachment'): Picture {
    return usePicture(id, local, kind);
}

/** A page's cover: its media embed's picture, through the same cache, loaded once when missing. */
export function useEmbedPicture(id: string): Picture {
    return usePicture(id, null, 'embed');
}

function usePicture(id: string, local: string | null, kind: ImageKind): Picture {
    const scope = useWorkspaceScope();
    const cache = cacheOf(scope);
    const path = useSyncExternalStore(cache.subscribe, () => (local === null ? cache.path(id, 0, kind) : null));
    const [outcome, setOutcome] = useState<{ id: string; state: 'gone' | 'failed' } | null>(null);
    useEffect(() => {
        if (local !== null || path !== null) {
            return undefined;
        }
        let live = true;
        cache
            .load(id, 0, kind)
            .then((load) => {
                if (live && load.state !== 'ready') {
                    setOutcome({ id, state: load.state });
                }
            })
            .catch(() => live && setOutcome({ id, state: 'failed' }));
        return () => {
            live = false;
        };
    }, [cache, id, local, path, kind]);
    if (local !== null) {
        return { state: 'ready', uri: local };
    }
    if (path !== null) {
        return { state: 'ready', uri: fileUri(path) };
    }
    return outcome?.id === id ? { state: outcome.state } : { state: 'loading' };
}
