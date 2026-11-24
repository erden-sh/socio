import { describe, expect, it } from 'vitest';

import type { PickedFile } from '../../src/sync/attachments';
import {
    createImageProcessor,
    IMAGE_MAX_BYTES,
    IMAGE_MAX_SIDE,
    jpegName,
    needsProcessing,
    PAGE_IMAGE_PROFILE,
    pageImageProblem,
} from '../../src/sync/image-processing';

// The image processor (src/sync/image-processing.ts): HEIC and other
// types a model can't read become JPEG, an image over 10 MB is scaled down
// until it fits, and the model's own types under the limit go as picked. Every
// rendering it doesn't keep is deleted; one it can't render goes as picked.

const MB = 1024 * 1024;
const picked = (fields: Partial<PickedFile> = {}): PickedFile => ({
    uri: 'file:///cache/ImagePicker/a.heic',
    name: 'IMG_0001.HEIC',
    mime: 'image/heic',
    bytes: 3 * MB,
    temporary: true,
    ...fields,
});

/** A renderer whose JPEG's bytes scale with its longest side, from a 6000×4000 photo. */
function fakeRender(bytesAt: (side: number) => number) {
    const renders: { maxSide: number; uri: string }[] = [];
    const removed: string[] = [];
    let serial = 0;
    return {
        renders,
        removed,
        render: async (_uri: string, { maxSide }: { maxSide: number; compress: number }) => {
            const side = Math.min(6000, maxSide);
            const uri = `file:///cache/ImageManipulator/${(serial += 1)}.jpg`;
            renders.push({ maxSide, uri });
            return { uri, width: side, height: Math.round((side * 2) / 3), bytes: bytesAt(side) };
        },
        remove: async (uri: string) => void removed.push(uri),
    };
}

describe('the image processor', () => {
    it('leaves the model’s types under the limit, and any GIF, as they are', async () => {
        expect(needsProcessing({ mime: 'image/jpeg', bytes: 2 * MB })).toBe(false);
        expect(needsProcessing({ mime: 'image/png', bytes: IMAGE_MAX_BYTES })).toBe(false);
        expect(needsProcessing({ mime: 'image/gif', bytes: 20 * MB })).toBe(false);
        expect(needsProcessing({ mime: 'application/pdf', bytes: 20 * MB })).toBe(false);
        expect(needsProcessing({ mime: 'image/heic', bytes: 1 })).toBe(true);
        expect(needsProcessing({ mime: 'image/webp', bytes: IMAGE_MAX_BYTES + 1 })).toBe(true);
        const fake = fakeRender(() => MB);
        const jpeg = picked({ mime: 'image/jpeg', name: 'a.jpg' });
        expect(await createImageProcessor(fake)(jpeg)).toBe(jpeg);
        expect(fake.renders).toEqual([]);
    });

    it('turns HEIC into JPEG at most 4096 on its longest side, a new temporary file', async () => {
        const fake = fakeRender(() => 2 * MB);
        const out = await createImageProcessor(fake)(picked());
        expect(fake.renders).toEqual([{ maxSide: IMAGE_MAX_SIDE, uri: 'file:///cache/ImageManipulator/1.jpg' }]);
        expect(out).toEqual({
            uri: 'file:///cache/ImageManipulator/1.jpg',
            name: 'IMG_0001.jpg',
            mime: 'image/jpeg',
            bytes: 2 * MB,
            temporary: true,
        });
        expect(fake.removed).toEqual([]);
    });

    it('scales down until it fits under 10 MB, deleting each rendering it drops', async () => {
        // 4096 → 18 MB, 2867 → 13 MB, 2007 → 9 MB.
        const fake = fakeRender((side) => Math.round(side * 0.0045 * MB));
        const out = await createImageProcessor(fake)(picked({ mime: 'image/png', name: 'scan.png', bytes: 30 * MB }));
        expect(fake.renders.map((render) => render.maxSide)).toEqual([4096, 2867, 2007]);
        expect(out.bytes).toBeLessThanOrEqual(IMAGE_MAX_BYTES);
        expect(out.uri).toBe(fake.renders[2]?.uri);
        expect(fake.removed).toEqual([fake.renders[0]?.uri, fake.renders[1]?.uri]);
        expect(out.name).toBe('scan.jpg');
    });

    it('hands over the last rendering after five tries, and the picked file when it can’t render', async () => {
        const huge = fakeRender(() => 50 * MB);
        const out = await createImageProcessor(huge)(picked());
        expect(huge.renders).toHaveLength(5);
        expect(huge.removed).toHaveLength(4);
        expect(out.uri).toBe(huge.renders[4]?.uri);

        const errors: unknown[] = [];
        const original = picked();
        const broken = await createImageProcessor({
            render: async () => {
                throw new Error('not an image');
            },
            remove: async () => {},
            onError: (error) => errors.push(error),
        })(original);
        expect(broken).toBe(original);
        expect(errors).toHaveLength(1);
    });

    it('names a converted file after the picked one', () => {
        expect(jpegName('IMG_1.HEIC')).toBe('IMG_1.jpg');
        expect(jpegName('photo')).toBe('photo.jpg');
        expect(jpegName('.heic')).toBe('photo.jpg');
    });
});

// The page image profile, for covers and pasted images: a cover's
// three types under its 5 MB (COVER_UPLOAD_TYPES, COVER_MAX_BYTES).
describe('the page image profile', () => {
    const page = (fake: ReturnType<typeof fakeRender>) =>
        createImageProcessor({ ...fake, profile: PAGE_IMAGE_PROFILE });

    it('turns a 7 MB HEIC into a JPEG under 5 MB', async () => {
        // 4096 → 7.4 MB, 2867 → 5.2 MB, 2007 → 3.6 MB.
        const fake = fakeRender((side) => Math.round(side * 0.0018 * MB));
        const out = await page(fake)(picked({ bytes: 7 * MB }));
        expect(fake.renders.map((render) => render.maxSide)).toEqual([4096, 2867, 2007]);
        expect(out.mime).toBe('image/jpeg');
        expect(out.bytes).toBeLessThanOrEqual(5 * MB);
        expect(out.name).toBe('IMG_0001.jpg');
        expect(pageImageProblem(out)).toBeNull();
    });

    it('keeps a cover’s types under 5 MB, and renders a GIF or anything larger', async () => {
        const fake = fakeRender(() => MB);
        for (const mime of ['image/png', 'image/jpeg', 'image/webp']) {
            const small = picked({ mime, bytes: 4 * MB });
            expect(await page(fake)(small)).toBe(small);
        }
        expect(fake.renders).toEqual([]);
        expect(needsProcessing({ mime: 'image/webp', bytes: 6 * MB }, 5 * MB, PAGE_IMAGE_PROFILE)).toBe(true);
        expect(needsProcessing({ mime: 'image/gif', bytes: MB }, 5 * MB, PAGE_IMAGE_PROFILE)).toBe(true);
        expect((await page(fake)(picked({ mime: 'image/gif', name: 'a.gif', bytes: MB }))).mime).toBe('image/jpeg');
    });

    it('refuses what still isn’t a cover’s type or size, before anything is queued', () => {
        expect(pageImageProblem({ mime: 'image/heic', bytes: MB })).toBe('type');
        expect(pageImageProblem({ mime: 'image/gif', bytes: MB })).toBe('type');
        expect(pageImageProblem({ mime: 'application/pdf', bytes: MB })).toBe('type');
        expect(pageImageProblem({ mime: 'image/jpeg', bytes: 5 * MB + 1 })).toBe('too-large');
        expect(pageImageProblem({ mime: 'image/png', bytes: 0 })).toBe('empty');
        expect(pageImageProblem({ mime: 'image/webp', bytes: 5 * MB })).toBeNull();
    });
});
