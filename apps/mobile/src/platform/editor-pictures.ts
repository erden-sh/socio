import { File, FileMode } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import { EDITOR_PICTURE_MAX_BYTES, type EditorPictureSource, pictureFit, sniffPictureType } from '../editor/pictures';
import type { WorkspaceScope } from '../sync/scope';

import { loadEmbedFile } from './image-cache';

// The page editor's pictures (src/editor/pictures.ts has the rules): each
// from the workspace's image cache (authedFetch, never the WebView), then
// sent as it is kept when it is small, else rendered again by
// expo-image-manipulator to fit EDITOR_PICTURE_MAX_SIDE (PNG stays PNG for
// its alpha, the rest JPEG at 0.8, and JPEG again if a PNG is still too
// large). The rendering's file is deleted at once; only the data URI stays.

const COMPRESS = 0.8;

const removeQuietly = (uri: string) => {
    try {
        const file = new File(uri);
        if (file.exists) {
            file.delete();
        }
    } catch {
        // The picker cache's sweep takes it later.
    }
};

/** The file's first bytes, for its type: never the whole picture. */
async function readHead(file: File): Promise<Uint8Array> {
    const handle = file.open(FileMode.ReadOnly);
    try {
        return await handle.readBytes(16);
    } finally {
        handle.close();
    }
}

export function editorPictureSource(scope: WorkspaceScope): EditorPictureSource {
    return async (id) => {
        const uri = await loadEmbedFile(scope, id);
        if (uri === null) {
            return { kind: 'unavailable' };
        }
        const file = new File(uri);
        const bytes = file.size;
        const type = sniffPictureType(await readHead(file));
        const context = ImageManipulator.manipulate(uri);
        try {
            let image = await context.renderAsync();
            const fit = pictureFit({ width: image.width, height: image.height, bytes, type });
            if (fit.kind === 'as-is' && type !== null) {
                image.release();
                return { kind: 'ready', dataUri: `data:${type};base64,${await file.base64()}` };
            }
            if (fit.kind === 'render' && fit.resize !== null) {
                image.release();
                context.resize(fit.resize);
                image = await context.renderAsync();
            }
            try {
                const formats =
                    fit.kind === 'render' && fit.format === 'png' ? (['png', 'jpeg'] as const) : (['jpeg'] as const);
                for (const format of formats) {
                    const saved = await image.saveAsync({
                        format: format === 'png' ? SaveFormat.PNG : SaveFormat.JPEG,
                        compress: COMPRESS,
                        base64: true,
                    });
                    removeQuietly(saved.uri);
                    const base64 = saved.base64 ?? '';
                    if (base64 !== '' && (base64.length * 3) / 4 <= EDITOR_PICTURE_MAX_BYTES) {
                        return { kind: 'ready', dataUri: `data:image/${format};base64,${base64}` };
                    }
                }
                return { kind: 'unavailable' };
            } finally {
                image.release();
            }
        } finally {
            context.release();
        }
    };
}
