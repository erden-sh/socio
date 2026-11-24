// The media contract: the tags other features will reach `media/` through, the
// service serving `Media` as it is, and its errors. The old paths' re-exports
// are gone.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect, Layer } from 'effect';
import { afterEach, expect, it } from 'vitest';

import * as movedRefs from '@socio/shared/media/refs';

import * as contract from '../src/server/media/contract.js';
import { Media, MediaConfig } from '../src/server/media/contract.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

it('declares its tags under socio/media', () => {
    expect(Media.key).toBe('socio/media/Media');
    expect(MediaConfig.key).toBe('socio/media/MediaConfig');
});

it('serves Media with the platform service as it is', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-media-contract-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const { platform, dispose } = await makeTestRuntime({
        config: { sessionSecret: 'secret-0123456789abcdef-xyz', data: { userDataDir: dir } },
    });
    cleanup.push(dispose);
    const program = Effect.gen(function* () {
        const media = yield* Media;
        return {
            attachment: yield* Effect.promise(() => media.attachment('cbatt_missing')),
            readable: yield* Effect.promise(() => media.readable('u1', 'cbatt_missing')),
            listed: (yield* Effect.promise(() => media.list('u1'))).items,
            cover: media.coverView('cbemb_missing'),
            spaceImages: yield* Effect.promise(() => media.spaceImages('u1', 'space-1')),
        };
    });
    const result = await Effect.runPromise(program.pipe(Effect.provide(Layer.succeed(Media, platform.media))));
    expect(result).toEqual({ attachment: undefined, readable: undefined, listed: [], cover: null, spaceImages: [] });
});

it('re-exports ContentError from its package, the same value', () => {
    expect(contract.ContentError).toBe(movedRefs.ContentError);
});

it('keeps MediaError a plain Error with its status, and ContentError what the run endpoint throws', () => {
    const error = new contract.MediaError('File not found.', 404);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('Error');
    expect(String(error)).toBe('Error: File not found.');
    expect(error.status).toBe(404);
    expect(new contract.MediaError('Invalid request.').status).toBe(400);
    expect(() =>
        movedRefs.checkNewUserContent(
            [{ id: 'm1', role: 'user', content: [{ type: 'image', source: {} }] }],
            new Set(),
        ),
    ).toThrow(contract.ContentError);
});
