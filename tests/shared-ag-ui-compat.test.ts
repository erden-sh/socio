// AG-UI 1.0 (deps/ag-ui-1): Socio's attachment parts and its own fields on
// events and messages, written in 1.0's shape and read in every shape a
// stored row or a shipped app build may hold.
import { describe, expect, it } from 'vitest';

import { turnError } from '@socio/foundation/observability/failures';
import { legacyMediaStream, wantsLegacyMedia } from '@socio/shared/media/legacy-media';
import {
    attachmentPart,
    attachmentRef,
    attachmentRefs,
    checkNewUserContent,
    ContentError,
    downgradeAttachmentParts,
    upgradeAttachmentParts,
} from '@socio/shared/media/refs';
import {
    messageAt,
    messageAuthor,
    socioField,
    withoutSocioFields,
    withSocioFields,
} from '@socio/shared/runs/socio-fields';

const ID = 'cbatt_AAAAAAAAAAAAAAAAAAAAAA';

describe('attachment parts', () => {
    it('writes AG-UI 1.0 media parts that refer to the file by id, the name in metadata', () => {
        expect(attachmentPart({ id: ID, mimeType: 'image/png', filename: 'a.png' })).toEqual({
            type: 'image',
            source: { type: 'file', value: ID, provider: 'socio', mimeType: 'image/png' },
            metadata: { filename: 'a.png' },
        });
        expect(attachmentPart({ id: ID, mimeType: 'audio/ogg' }).type).toBe('audio');
        expect(attachmentPart({ id: ID, mimeType: 'video/mp4' }).type).toBe('video');
        expect(attachmentPart({ id: ID, mimeType: 'application/pdf' })).toEqual({
            type: 'document',
            source: { type: 'file', value: ID, provider: 'socio', mimeType: 'application/pdf' },
        });
    });

    it('reads both shapes, and nothing that carries bytes or another provider’s file', () => {
        const ref = { id: ID, mimeType: 'image/png', filename: 'a.png' };
        expect(attachmentRef(attachmentPart(ref))).toEqual(ref);
        expect(attachmentRef({ type: 'binary', ...ref })).toEqual(ref);
        expect(attachmentRef({ type: 'binary', ...ref, data: 'AAAA' })).toBeUndefined();
        expect(attachmentRef({ type: 'binary', ...ref, id: 'local' })).toBeUndefined();
        expect(attachmentRef({ type: 'image', source: { type: 'data', value: 'AAAA', mimeType: 'image/png' } })).toBe(
            undefined,
        );
        expect(
            attachmentRef({ type: 'image', source: { type: 'file', value: ID, provider: 'openai', mimeType: 'x/y' } }),
        ).toBeUndefined();
        expect(attachmentRef({ type: 'text', text: ID })).toBeUndefined();
    });

    it('upgrades the pre-1.0 shape in place, and leaves content without one as it is', () => {
        const ref = { id: ID, mimeType: 'image/png', filename: 'a.png' };
        const text = { type: 'text', text: 'see' };
        expect(upgradeAttachmentParts([text, { type: 'binary', ...ref }])).toEqual([text, attachmentPart(ref)]);
        const modern = [text, attachmentPart(ref)];
        expect(upgradeAttachmentParts(modern)).toBe(modern);
        expect(upgradeAttachmentParts('plain')).toBe('plain');
        expect(attachmentRefs([text, { type: 'binary', ...ref }, attachmentPart(ref)])).toEqual([ref, ref]);
    });

    it('takes either shape in a new message, never inline bytes', () => {
        const ref = { id: ID, mimeType: 'image/png' };
        const message = (part: unknown) => [{ id: 'n', role: 'user', content: [part] }];
        expect(() => checkNewUserContent(message(attachmentPart(ref)), new Set())).not.toThrow();
        expect(() => checkNewUserContent(message({ type: 'binary', ...ref }), new Set())).not.toThrow();
        expect(() =>
            checkNewUserContent(
                message({ type: 'image', source: { type: 'data', value: 'AAAA', mimeType: 'image/png' } }),
                new Set(),
            ),
        ).toThrow(ContentError);
        expect(() =>
            checkNewUserContent(
                message({ type: 'image', source: { type: 'url', value: 'https://example.test/a.png' } }),
                new Set(),
            ),
        ).toThrow(ContentError);
    });
});

describe('Socio’s own fields', () => {
    it('writes them in metadata and, for the app builds already shipped, at the top level', () => {
        const author = { name: 'Ada', you: false };
        expect(withSocioFields({ id: 'm', metadata: { socioSender: 'ada' } }, { author, at: 5 })).toEqual({
            id: 'm',
            author,
            at: 5,
            metadata: { socioSender: 'ada', author, at: 5 },
        });
        const plain = { id: 'm' };
        expect(withSocioFields(plain, { author: undefined })).toBe(plain);
    });

    it('reads metadata first, then the top level a server from before 1.0 wrote', () => {
        expect(socioField({ errorDetail: 'top', metadata: { errorDetail: 'meta' } }, 'errorDetail')).toBe('meta');
        expect(socioField({ errorDetail: 'top' }, 'errorDetail')).toBe('top');
        expect(socioField({ errorDetail: 'top', metadata: { other: 1 } }, 'errorDetail')).toBe('top');
        expect(
            messageAuthor({ author: { name: 'Old', you: false }, metadata: { author: { name: 'New', you: true } } }),
        ).toEqual({ name: 'New', you: true });
        expect(messageAuthor({ author: { name: 'Old', you: false } })).toEqual({ name: 'Old', you: false });
        expect(messageAt({ at: 1, metadata: { at: 2 } })).toBe(2);
        expect(messageAt({ at: 1 })).toBe(1);
        expect(messageAt({})).toBeUndefined();
    });

    it('takes them off in both places', () => {
        expect(
            withoutSocioFields({ type: 'RUN_ERROR', errorDetail: 'x', metadata: { errorDetail: 'x' } }, [
                'errorDetail',
            ]),
        ).toEqual({ type: 'RUN_ERROR' });
        expect(
            withoutSocioFields({ type: 'RUN_ERROR', metadata: { errorDetail: 'x', kept: 1 } }, ['errorDetail']),
        ).toEqual({ type: 'RUN_ERROR', metadata: { kept: 1 } });
        const bare = { type: 'RUN_ERROR' };
        expect(withoutSocioFields(bare, ['errorDetail'])).toBe(bare);
    });

    it('puts a failed turn’s operator detail in both places, which the runner takes off', () => {
        expect(turnError('model_rejected', new Error('400 no vision'))).toMatchObject({
            code: 'model_rejected',
            errorDetail: '400 no vision',
            metadata: { errorDetail: '400 no vision' },
        });
        expect(turnError('model_rejected')).not.toHaveProperty('metadata');
    });
});

describe('responses for the app builds already shipped (COMPAT(ag-ui-1.0))', () => {
    const ref = { id: ID, mimeType: 'image/png', filename: 'a.png' };

    it('downgrades Socio’s attachment parts at any depth, and nothing else', () => {
        const other = { type: 'image', source: { type: 'data', value: 'AAAA', mimeType: 'image/png' } };
        const body = {
            runs: [{ messages: [{ id: 'u', content: [{ type: 'text', text: 'x' }, attachmentPart(ref), other] }] }],
        };
        expect(downgradeAttachmentParts(body)).toEqual({
            runs: [
                { messages: [{ id: 'u', content: [{ type: 'text', text: 'x' }, { type: 'binary', ...ref }, other] }] },
            ],
        });
        const plain = { runs: [{ messages: [{ id: 'u', content: 'hi' }] }] };
        expect(downgradeAttachmentParts(plain)).toBe(plain);
    });

    it('tells the clients apart by X-Socio-Reads', () => {
        expect(wantsLegacyMedia(new Headers())).toBe(true);
        expect(wantsLegacyMedia(new Headers({ 'X-Socio-Reads': 'ag-ui-media' }))).toBe(false);
        expect(wantsLegacyMedia(new Headers({ 'X-Socio-Reads': 'other, AG-UI-Media' }))).toBe(false);
        expect(wantsLegacyMedia(new Headers({ 'X-Socio-Reads': 'other' }))).toBe(true);
    });

    it('rewrites a server-sent stream frame by frame, however its chunks split', async () => {
        const event = { type: 'RUN_STARTED', input: { messages: [{ id: 'u', content: [attachmentPart(ref)] }] } };
        const text = `: keep-alive\n\nevent: cursor\nid: 3\ndata: {"seq":3}\n\ndata: ${JSON.stringify(event)}\n\n`;
        const bytes = new TextEncoder().encode(text);
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                // Split mid-frame and mid-character boundary alike.
                for (let at = 0; at < bytes.length; at += 7) {
                    controller.enqueue(bytes.slice(at, at + 7));
                }
                controller.close();
            },
        });
        const out = await legacyMediaStream(
            new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
        ).text();
        const downgraded = { ...event, input: { messages: [{ id: 'u', content: [{ type: 'binary', ...ref }] }] } };
        expect(out).toBe(
            `: keep-alive\n\nevent: cursor\nid: 3\ndata: {"seq":3}\n\ndata: ${JSON.stringify(downgraded)}\n\n`,
        );
        const json = Response.json({ a: 1 });
        expect(legacyMediaStream(json)).toBe(json);
    });
});
