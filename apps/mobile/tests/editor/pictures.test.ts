import { describe, expect, it, vi } from 'vitest';

import { toWeb, type ToWebMessage } from '../../src/editor/bridge';
import {
    createEditorPictures,
    EDITOR_PICTURE_AS_IS_BYTES,
    EDITOR_PICTURE_MAX_BYTES,
    EDITOR_PICTURE_MAX_SIDE,
    type EditorPicture,
    pictureFit,
    sniffPictureType,
} from '../../src/editor/pictures';

// The page editor's pictures (src/editor/pictures.ts): the ids the WebView
// asks for, answered from the image cache one at a time, each bounded, and
// the ones the cache can't give said so and asked again once online.

const A = 'cbemb_aaaaaaaaaaaaaaaa';
const B = 'cbemb_bbbbbbbbbbbbbbbb';
const C = 'cbemb_cccccccccccccccc';
const uri = (n: number) => `data:image/png;base64,${'A'.repeat(n * 4)}`;

/** A source whose answers the test settles one by one. */
function deferredSource() {
    const calls: { id: string; resolve: (picture: EditorPicture) => void; reject: (error: unknown) => void }[] = [];
    const source = (id: string) =>
        new Promise<EditorPicture>((resolve, reject) => {
            calls.push({ id, resolve, reject });
        });
    return { calls, source };
}

function setup() {
    const { calls, source } = deferredSource();
    const sent: ToWebMessage[] = [];
    const errors: unknown[] = [];
    const pictures = createEditorPictures({
        source,
        send: (message) => sent.push(toWeb(message)),
        onError: (error) => errors.push(error),
    });
    return { calls, sent, errors, pictures };
}

describe("the page editor's pictures", () => {
    it('gets one picture at a time and sends each in its own message', async () => {
        const { calls, sent, pictures } = setup();
        pictures.want([A, B]);
        pictures.want([A]);
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        expect(calls[0]!.id).toBe(A);
        calls[0]!.resolve({ kind: 'ready', dataUri: uri(3) });
        await vi.waitFor(() => expect(calls).toHaveLength(2));
        expect(sent).toEqual([{ type: 'socio-images', payload: { [A]: uri(3) } }]);
        calls[1]!.resolve({ kind: 'ready', dataUri: uri(5) });
        await vi.waitFor(() => expect(sent).toHaveLength(2));
        expect(sent[1]).toEqual({ type: 'socio-images', payload: { [B]: uri(5) } });
        // Already sent: not got again.
        pictures.want([A, B]);
        await Promise.resolve();
        expect(calls).toHaveLength(2);
    });

    it('says which it can’t give, and asks for them again when back online', async () => {
        const { calls, sent, pictures, errors } = setup();
        pictures.want([A, B]);
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        calls[0]!.resolve({ kind: 'unavailable' });
        await vi.waitFor(() => expect(calls).toHaveLength(2));
        calls[1]!.reject(new Error('offline'));
        await vi.waitFor(() => expect(sent).toHaveLength(2));
        expect(sent).toEqual([
            { type: 'socio-images-unavailable', payload: { ids: [A] } },
            { type: 'socio-images-unavailable', payload: { ids: [B] } },
        ]);
        expect(errors).toHaveLength(1);
        pictures.retry();
        await vi.waitFor(() => expect(calls).toHaveLength(3));
        calls[2]!.resolve({ kind: 'ready', dataUri: uri(1) });
        await vi.waitFor(() => expect(calls).toHaveLength(4));
        expect(sent.at(-1)).toEqual({ type: 'socio-images', payload: { [A]: uri(1) } });
    });

    it('never sends a picture over the bound', async () => {
        const { calls, sent, pictures } = setup();
        pictures.want([A]);
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        const big = `data:image/jpeg;base64,${'A'.repeat(Math.ceil(((EDITOR_PICTURE_MAX_BYTES + 3) * 4) / 3))}`;
        calls[0]!.resolve({ kind: 'ready', dataUri: big });
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0]).toEqual({ type: 'socio-images-unavailable', payload: { ids: [A] } });
    });

    it('drops what a dead WebView asked for, and sends nothing once stopped', async () => {
        const { calls, sent, pictures } = setup();
        pictures.want([A, B]);
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        pictures.reset();
        calls[0]!.resolve({ kind: 'ready', dataUri: uri(1) });
        await Promise.resolve();
        await Promise.resolve();
        // A's answer was for the old WebView; B was never got.
        expect(sent).toEqual([]);
        pictures.want([A]);
        await vi.waitFor(() => expect(calls).toHaveLength(2));
        pictures.stop();
        calls[1]!.resolve({ kind: 'ready', dataUri: uri(1) });
        pictures.want([C]);
        await Promise.resolve();
        await Promise.resolve();
        expect(sent).toEqual([]);
        expect(calls).toHaveLength(2);
    });

    it('tells the kept types by their first bytes', () => {
        const bytes = (...values: number[]) => new Uint8Array(values);
        expect(sniffPictureType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d))).toBe('image/png');
        expect(sniffPictureType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
        expect(sniffPictureType(bytes(0x47, 0x49, 0x46, 0x38, 0x39))).toBe('image/gif');
        expect(sniffPictureType(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50))).toBe('image/webp');
        expect(sniffPictureType(bytes(0x3c, 0x73, 0x76, 0x67))).toBeNull();
    });

    it('sends small pictures as kept and scales the rest down', () => {
        const small = { width: 800, height: 600, bytes: 200_000, type: 'image/jpeg' as const };
        expect(pictureFit(small)).toEqual({ kind: 'as-is' });
        expect(pictureFit({ ...small, bytes: EDITOR_PICTURE_AS_IS_BYTES + 1 })).toEqual({
            kind: 'render',
            resize: null,
            format: 'jpeg',
        });
        expect(pictureFit({ width: 4000, height: 3000, bytes: 900_000, type: 'image/png' })).toEqual({
            kind: 'render',
            resize: { width: EDITOR_PICTURE_MAX_SIDE },
            format: 'png',
        });
        expect(pictureFit({ width: 1000, height: 5000, bytes: 100, type: 'image/gif' })).toEqual({
            kind: 'render',
            resize: { height: EDITOR_PICTURE_MAX_SIDE },
            format: 'jpeg',
        });
    });
});
