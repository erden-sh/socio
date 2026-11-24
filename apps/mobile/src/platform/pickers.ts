import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';

import { pickedDocuments, pickedImages, type PickSource } from '../chat/attachment-tray';
import type { PickedFile } from '../sync/attachments';

import { createSizeOf } from './cache-size';

// The three pickers of the composer's attach menu:
// - **Photos:** the system photo picker (PHPicker on iOS, the Photo Picker on
//   Android), which asks for no access to the library: `photosPermission`
//   is off in app.config.ts and expo-media-library is banned.
// - **Camera:** asks for the camera first (the purpose string in
//   app.config.ts), then the system camera. No microphone: photos only.
// - **Files:** the system document picker, copied into the cache (no iCloud
//   container: a Personal Team can't sign one).
// Each hands back its own temporary copies; attachments.ts deletes each once
// ours is durable, and `clearPickerCache` then deletes the folders the pickers
// and the image processor leave in the cache, so nothing of a workspace stays
// outside its folder (the sign-out listing).
// A pasted image is expo-paste-input's own file in the temporary or
// cache folder's root, which `clearPickerCache` doesn't reach: `removePasted`
// deletes each.

export type PickResult =
    | { readonly kind: 'picked'; readonly files: readonly PickedFile[] }
    | { readonly kind: 'cancelled' }
    | { readonly kind: 'denied' };

export const sizeOf = createSizeOf();

/** Opens a picker; `max` is how many more files the tray takes. */
export async function pick(source: PickSource, max: number): Promise<PickResult> {
    if (source === 'files') {
        const result = await DocumentPicker.getDocumentAsync({
            type: '*/*',
            multiple: max > 1,
            copyToCacheDirectory: true,
        });
        if (result.canceled) {
            return { kind: 'cancelled' };
        }
        return { kind: 'picked', files: await pickedDocuments(result.assets.slice(0, max), sizeOf) };
    }
    const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 1, exif: false };
    let result: ImagePicker.ImagePickerResult;
    if (source === 'camera') {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
            return { kind: 'denied' };
        }
        result = await ImagePicker.launchCameraAsync(options);
    } else {
        result = await ImagePicker.launchImageLibraryAsync({
            ...options,
            allowsMultipleSelection: max > 1,
            selectionLimit: Math.max(1, max),
            orderedSelection: true,
        });
    }
    if (result.canceled) {
        return { kind: 'cancelled' };
    }
    return { kind: 'picked', files: await pickedImages(result.assets.slice(0, max), sizeOf, new Date()) };
}

/**
 * Deletes a file expo-paste-input wrote for a paste (`pasteImages` calls it for
 * each, once it is copied or refused). Only `file://` URIs; one already gone is fine.
 */
export async function removePasted(uri: string): Promise<void> {
    if (!uri.startsWith('file://')) {
        return;
    }
    const file = new File(uri);
    if (file.exists) {
        file.delete();
    }
}

/** The cache folders the pickers and expo-image-manipulator write their temporary files into. */
export const PICKER_CACHE_FOLDERS = ['ImagePicker', 'DocumentPicker', 'ImageManipulator'] as const;

/** Deletes the pickers' cache folders: call it only once their files have been copied (or refused). */
export function clearPickerCache(): void {
    for (const name of PICKER_CACHE_FOLDERS) {
        try {
            const folder = new Directory(Paths.cache, name);
            if (folder.exists) {
                folder.delete();
            }
        } catch (error) {
            console.warn('[attachments] a picker folder was not deleted', error);
        }
    }
}
