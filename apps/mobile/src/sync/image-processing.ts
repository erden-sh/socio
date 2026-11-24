import { ISSUE_ATTACHMENT_MAX_BYTES } from '@socio/shared/issues/issue-types';
import { COVER_MAX_BYTES, COVER_UPLOAD_TYPES } from '@socio/shared/pages/page-library';

import type { ImageProcessor, PickedFile } from './attachments';

// The image processor attachments run a picked image through: HEIC (and any
// other type a model can't read) becomes JPEG, and an image over the model's
// 10 MB is scaled down until it fits. PNG, JPEG, GIF and WebP under the limit
// go as they are. Uploads to Files add the page image profile (covers and
// pasted images): PNG, JPEG and WebP under the cover's 5 MB go as they are,
// anything else becomes a JPEG under it, and `pageImageProblem` checks the
// result before anything is queued. No React Native:
// src/platform/image-processor.ts binds expo-image-manipulator as `render`,
// and tests/sync runs this under Node with a fake.

/** The image types a model reads (the server's MODEL_IMAGE_TYPES): these go as they are when small enough. */
export const MODEL_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** The longest side a converted image keeps: past this, a phone photo is scaled down first. */
export const IMAGE_MAX_SIDE = 4096;
/** JPEG quality for a converted image. */
export const JPEG_QUALITY = 0.85;
/** The server's image limit for a model (`imageModelMaxBytes`'s default). */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** Each try past the limit keeps this share of the longest side. */
const SHRINK = 0.7;
/** How many times it shrinks before it hands over what it has. */
const MAX_TRIES = 5;

/** One rendering of an image to JPEG: a new temporary file, its size and its bytes. */
export interface RenderedImage {
    readonly uri: string;
    readonly width: number;
    readonly height: number;
    readonly bytes: number;
}

/** What an image must be to go as it is, and the size a rendering must fit. */
export interface ImageProfile {
    /** The types that go as they are under `maxBytes`. */
    readonly keep: ReadonlySet<string>;
    readonly maxBytes: number;
    /** Whether a GIF of a kept type goes as it is at any size (it may move: a rendering keeps one frame). */
    readonly keepGif: boolean;
}

/** A model's image, for an attachment. */
export const MODEL_IMAGE_PROFILE: ImageProfile = { keep: MODEL_IMAGE_TYPES, maxBytes: IMAGE_MAX_BYTES, keepGif: true };

/**
 * An issue's file: the model's types go as they are under the
 * server's 5 MiB (`ISSUE_ATTACHMENT_MAX_BYTES`), HEIC and larger ones become a
 * JPEG under it, and a GIF is never scaled (it may move), so one over 5 MiB is
 * refused at pick time by shared's `acceptFiles`, not by a later 413.
 */
export const ISSUE_IMAGE_PROFILE: ImageProfile = {
    keep: MODEL_IMAGE_TYPES,
    maxBytes: ISSUE_ATTACHMENT_MAX_BYTES,
    keepGif: true,
};

/** A page's image, a cover or a pasted one: the cover's types and 5 MB, which `coverFromFile` enforces. */
export const PAGE_IMAGE_PROFILE: ImageProfile = {
    keep: new Set(COVER_UPLOAD_TYPES),
    maxBytes: COVER_MAX_BYTES,
    keepGif: false,
};

export interface ImageProcessingOptions {
    /** Renders `uri` to JPEG at `compress`, its longest side at most `maxSide`. */
    readonly render: (uri: string, options: { maxSide: number; compress: number }) => Promise<RenderedImage>;
    /** Deletes a rendering it didn't keep. */
    readonly remove: (uri: string) => Promise<void>;
    /** Overrides the profile's size (tests). */
    readonly maxBytes?: number;
    /** The model's by default. */
    readonly profile?: ImageProfile;
    readonly onError?: (error: unknown) => void;
}

/** Whether a picked image goes through the processor, or as it is. */
export function needsProcessing(
    file: Pick<PickedFile, 'mime' | 'bytes'>,
    maxBytes = IMAGE_MAX_BYTES,
    profile: ImageProfile = MODEL_IMAGE_PROFILE,
): boolean {
    if (!file.mime.startsWith('image/')) {
        return false;
    }
    if (!profile.keep.has(file.mime)) {
        return true;
    }
    // A GIF may move: scaling it would keep one frame. The server says if it is too large.
    if (profile.keepGif && file.mime === 'image/gif') {
        return false;
    }
    return file.bytes > maxBytes;
}

/** Why a page's image (after the processor) can't be uploaded, or null: checked before anything is queued. */
export function pageImageProblem(file: Pick<PickedFile, 'mime' | 'bytes'>): 'empty' | 'type' | 'too-large' | null {
    if (file.bytes <= 0) {
        return 'empty';
    }
    if (!PAGE_IMAGE_PROFILE.keep.has(file.mime)) {
        return 'type';
    }
    return file.bytes > PAGE_IMAGE_PROFILE.maxBytes ? 'too-large' : null;
}

/** `photo.HEIC` → `photo.jpg`. */
export function jpegName(name: string): string {
    const stem = name.replace(/\.[A-Za-z0-9]{1,8}$/, '');
    return `${stem || 'photo'}.jpg`;
}

export function createImageProcessor(options: ImageProcessingOptions): ImageProcessor {
    const { render, remove, profile = MODEL_IMAGE_PROFILE, onError = () => {} } = options;
    const maxBytes = options.maxBytes ?? profile.maxBytes;
    return async (file) => {
        if (!needsProcessing(file, maxBytes, profile)) {
            return file;
        }
        let maxSide = IMAGE_MAX_SIDE;
        let rendered: RenderedImage | null = null;
        try {
            for (let tries = 0; tries < MAX_TRIES; tries += 1) {
                const next = await render(file.uri, { maxSide, compress: JPEG_QUALITY });
                if (rendered !== null) {
                    await remove(rendered.uri).catch(onError);
                }
                rendered = next;
                if (next.bytes <= maxBytes) {
                    break;
                }
                maxSide = Math.max(1, Math.round(Math.max(next.width, next.height) * SHRINK));
            }
        } catch (error) {
            // Not an image it can read: it goes as picked, and the server says what it takes.
            onError(error);
            if (rendered !== null) {
                await remove(rendered.uri).catch(onError);
            }
            return file;
        }
        if (rendered === null) {
            return file;
        }
        return {
            uri: rendered.uri,
            name: jpegName(file.name),
            mime: 'image/jpeg',
            bytes: rendered.bytes,
            temporary: true,
        };
    };
}
