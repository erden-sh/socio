import * as Clipboard from 'expo-clipboard';
import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator } from 'expo-image-manipulator';

import { cleanDataUri, dataUriBytes, type PastedImage } from '../editor/paste-image';
import type { PickedFile } from '../sync/attachments';

import { fileUri } from './file-system';

// The phone's half of pasting a picture into a page
// (src/editor/paste-image.ts has the rules): the clipboard through
// expo-clipboard, the picture's bytes into a temporary file the upload copies
// and then deletes, and its size read back from the uploaded copy.
//
// - `clipboardHasImage` is `hasImageAsync`: no "Allow Paste" prompt on iOS,
//   and on Android only the clip's description (no "pasted from your
//   clipboard" toast). It only turns Paste image on.
// - `readClipboardImage` is `getImageAsync`, run only on Paste image's tap:
//   iOS may ask "Allow Paste" then, Android shows its clipboard toast.

/** The folder of pasted pictures waiting for the upload's copy, under the cache. */
const PASTED_FOLDER = 'PastedImages';

export const clipboardHasImage = (): Promise<boolean> => Clipboard.hasImageAsync();

/** Calls `listener` when the clipboard changes (Android and iOS, while the app is in front). */
export function onClipboardChange(listener: () => void): () => void {
    const subscription = Clipboard.addClipboardListener(() => listener());
    return () => subscription.remove();
}

/** The clipboard's image as a PNG data URI, or null with none. */
export async function readClipboardImage(): Promise<PastedImage | null> {
    const image = await Clipboard.getImageAsync({ format: 'png' });
    if (image === null || !image.data.startsWith('data:image/')) {
        return null;
    }
    return { mimeType: image.data.slice('data:'.length, image.data.indexOf(';')), dataUri: cleanDataUri(image.data) };
}

/** The picture's bytes in a new temporary file, as the upload takes a picked one. */
export async function writePastedImage(image: PastedImage, name: string): Promise<PickedFile> {
    const folder = new Directory(Paths.cache, PASTED_FOLDER);
    if (!folder.exists) {
        folder.create({ intermediates: true, idempotent: true });
    }
    const file = new File(folder, name);
    if (file.exists) {
        file.delete();
    }
    // Async in expo-file-system 58: the size is read only once it is written.
    await file.write(image.dataUri.slice(image.dataUri.indexOf(',') + 1), { encoding: 'base64' });
    const written = new File(folder, name).size;
    return {
        uri: file.uri,
        name,
        mime: image.mimeType,
        bytes: typeof written === 'number' && written > 0 ? written : dataUriBytes(image.dataUri),
        temporary: true,
    };
}

/** The picture's size in pixels (expo-image-manipulator decodes it), or null. */
export async function measureImage(path: string): Promise<{ width: number; height: number } | null> {
    const context = ImageManipulator.manipulate(fileUri(path));
    try {
        const image = await context.renderAsync();
        try {
            return { width: image.width, height: image.height };
        } finally {
            image.release();
        }
    } catch {
        return null;
    } finally {
        context.release();
    }
}
