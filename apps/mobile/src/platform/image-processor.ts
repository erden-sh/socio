import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import {
    createImageProcessor,
    type ImageProcessingOptions,
    ISSUE_IMAGE_PROFILE,
    PAGE_IMAGE_PROFILE,
} from '../sync/image-processing';

import { createSizeOf } from './cache-size';

// The image processor attachments run each picked image through
// (src/sync/image-processing.ts has the rules): expo-image-manipulator renders
// HEIC and other types to JPEG, scaled down until it fits the model's 10 MB.
// Its output is a new file in the cache, which attachments.ts deletes once
// the copy in `attachments/` is durable. `processPageImage` is the same with
// the page image profile: a cover's types, under its 5 MB.
// `processIssueImage` is the issue profile: an issue file under 5 MiB.

const sizeOf = createSizeOf();

const render: ImageProcessingOptions['render'] = async (uri, { maxSide, compress }) => {
    const context = ImageManipulator.manipulate(uri);
    try {
        let image = await context.renderAsync();
        if (Math.max(image.width, image.height) > maxSide) {
            const wide = image.width >= image.height;
            image.release();
            context.resize(wide ? { width: maxSide } : { height: maxSide });
            image = await context.renderAsync();
        }
        try {
            const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress });
            return { uri: saved.uri, width: saved.width, height: saved.height, bytes: await sizeOf(saved.uri) };
        } finally {
            image.release();
        }
    } finally {
        context.release();
    }
};

const remove: ImageProcessingOptions['remove'] = async (uri) => {
    const file = new File(uri);
    if (file.exists) {
        file.delete();
    }
};

export const processImage = createImageProcessor({
    render,
    remove,
    onError: (error) => console.warn('[attachments] the image was not converted', error),
});

export const processPageImage = createImageProcessor({
    render,
    remove,
    profile: PAGE_IMAGE_PROFILE,
    onError: (error) => console.warn('[uploads] the image was not converted', error),
});

export const processIssueImage = createImageProcessor({
    render,
    remove,
    profile: ISSUE_IMAGE_PROFILE,
    onError: (error) => console.warn('[issues] the image was not converted', error),
});
