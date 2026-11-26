// AG-UI 1.0 (deps/ag-ui-1): Socio's attachment parts and its own fields on
// events and messages, written in 1.0's shape only and read in every shape a
// stored row may hold.
import { describe, expect, it } from 'vitest';

import { turnError } from '@socio/foundation/observability/failures';
import {
    attachmentPart,
    attachmentRef,
    attachmentRefs,
    checkNewUserContent,
    ContentError,
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

    it('takes the 1.0 part in a new message, never the pre-1.0 reference or inline bytes', () => {
        const ref = { id: ID, mimeType: 'image/png' };
        const message = (part: unknown) => [{ id: 'n', role: 'user', content: [part] }];
        expect(() => checkNewUserContent(message(attachmentPart(ref)), new Set())).not.toThrow();
        expect(() => checkNewUserContent(message({ type: 'binary', ...ref }), new Set())).toThrow(/out of date/);
        // A stored message keeps whatever shape it was stored in.
        expect(() => checkNewUserContent(message({ type: 'binary', ...ref }), new Set(['n']))).not.toThrow();
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
    it('writes them in metadata only', () => {
        const author = { name: 'Ada', you: false };
        expect(withSocioFields({ id: 'm', metadata: { socioSender: 'ada' } }, { author, at: 5 })).toEqual({
            id: 'm',
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

    it('puts a failed turn’s operator detail in both places, server-side only: the runner takes it off', () => {
        expect(turnError('model_rejected', new Error('400 no vision'))).toMatchObject({
            code: 'model_rejected',
            errorDetail: '400 no vision',
            metadata: { errorDetail: '400 no vision' },
        });
        expect(turnError('model_rejected')).not.toHaveProperty('metadata');
    });
});
