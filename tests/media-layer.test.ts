// Media's service is built by its layer from the tags it reads (its ports
// `MediaData` and `MediaWorkspace`, which the composition provides from `Data`
// and the workspace's `Spaces`, `Socios` and `Conversations`, and
// `MediaConfig`), and offered as `Media` and `MediaViews`; the server's graph
// builds it there, with `MediaConfig` from the supplied startup config, and
// `Platform` holds the same object.
import { Context, Effect, Layer, ManagedRuntime } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import { LegacyMedia, MediaPortsLive } from '../src/server/composition/media.js';
import { Data, type DataSpaceShape } from '../src/server/dataspace/contract.js';
import { Media, MediaConfig, MediaViews } from '../src/server/media/contract.js';
import { MediaLive } from '../src/server/media/layer.js';
import { MediaService } from '../src/server/media/service.js';
import { Conversations, Socios, Spaces } from '../src/server/workspace/contract.js';
import { WorkspaceLive } from '../src/server/workspace/layer.js';

import { LocalAgentRunner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testAuth } from './helpers/test-auth.js';
import { testDatabase } from './helpers/test-database.js';
import { startWithTestPlatform } from './helpers/test-platform.js';

const MB = 1048576;

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

function workspace() {
    const store = new WorkspaceStore(testDatabase());
    cleanup.push(() => store.close());
    return store;
}

/** A data space that only records the listeners the service registers. */
function fakeData() {
    const registered: string[] = [];
    const data = {
        useConversationReads: () => registered.push('conversation reads'),
        onFileDeleted: () => registered.push('file deleted'),
    } as unknown as DataSpaceShape;
    return { data, registered };
}

it('builds one service from the tags it reads, and offers it as Media and MediaViews', async () => {
    const ws = workspace();
    const { data, registered } = fakeData();
    const runtime = ManagedRuntime.make(
        MediaLive(ws.db).pipe(
            Layer.provide(
                Layer.provideMerge(
                    MediaPortsLive,
                    Layer.mergeAll(
                        Layer.succeed(Data, data),
                        Layer.succeed(MediaConfig, { media: { imageModelMaxBytes: 5 * MB } }),
                        WorkspaceLive(ws),
                    ),
                ),
            ),
        ),
    );
    cleanup.push(() => runtime.dispose());
    const context = await runtime.context();
    const media = Context.get(context, Media);
    expect(media).toBeInstanceOf(MediaService);
    expect((media as MediaService).imageModelMaxBytes).toBe(5 * MB);
    expect((media as MediaService).data).toBe(data);
    // Its two data space listeners, once, in the constructor's order.
    expect(registered).toEqual(['conversation reads', 'file deleted']);

    const listing = { items: [], folders: [], usage: { files: 0, bytes: 0 } } as never;
    const list = vi.spyOn(media, 'list').mockResolvedValue(listing);
    const views = Context.get(context, MediaViews);
    await expect(views.mediaView('u1', { folder: 'Media/', limit: 5 })).resolves.toBe(listing);
    expect(list).toHaveBeenCalledWith('u1', { folder: 'Media/', limit: 5 });
});

it('reads the workspace through its slices, at the moment of use', async () => {
    const ws = workspace();
    const { data } = fakeData();
    const thread = vi.fn(() => undefined);
    const runtime = ManagedRuntime.make(
        MediaLive(ws.db).pipe(
            Layer.provide(
                Layer.provideMerge(
                    MediaPortsLive,
                    Layer.mergeAll(
                        Layer.succeed(Data, data),
                        Layer.succeed(MediaConfig, {}),
                        Layer.succeed(Spaces, ws.slices.spaces),
                        Layer.succeed(Socios, ws.slices.socios),
                        Layer.succeed(Conversations, { ...ws.slices.conversations, thread } as never),
                    ),
                ),
            ),
        ),
    );
    cleanup.push(() => runtime.dispose());
    const media = (await runtime.runPromise(
        Effect.gen(function* () {
            return yield* Media;
        }),
    )) as MediaService;
    // No settings: the default limit for images sent to the model.
    expect(media.imageModelMaxBytes).toBe(10 * MB);
    // An attachment for a conversation asks Conversations for it.
    await expect(
        media.upload('u1', {
            name: 'a.txt',
            bytes: new Uint8Array([104, 105]),
            purpose: 'attachment',
            threadId: 'thread-x',
        }),
    ).rejects.toThrow('Conversation not found.');
    expect(thread).toHaveBeenCalledWith('thread-x');
});

it("the server's graph builds media from its layer: Platform, Media and MediaViews share the service", async () => {
    // The supplied config wins over the environment (moving environment parsing here is a later change).
    vi.stubEnv('MEDIA_IMAGE_MODEL_MAX_MB', '7');
    const ws = workspace();
    const store = new Store(testDatabase());
    cleanup.push(() => store.close());
    const { runtime, platform } = await startWithTestPlatform({
        db: ws.db,
        store,
        workspace: ws,
        config: {
            baseUrl: '',
            apiKey: '',
            model: '',
            voiceName: 'marin',
            runtimeUrl: '',
            appOrigin: 'https://app.example.invalid',
            media: { imageModelMaxBytes: 3 * MB },
        },
        runner: new LocalAgentRunner(testDatabase()),
        auth: testAuth(),
        modules: [],
    });
    cleanup.push(async () => {
        await platform.stop();
        await runtime.dispose();
    });
    const { media, legacy, views, config } = await runtime.runPromise(
        Effect.gen(function* () {
            return {
                media: yield* Media,
                legacy: yield* LegacyMedia,
                views: yield* MediaViews,
                config: yield* MediaConfig,
            };
        }),
    );
    expect(media).toBe(platform.media);
    expect(legacy).toBe(platform.media);
    expect(config).toEqual({ media: { imageModelMaxBytes: 3 * MB } });
    expect(platform.media.imageModelMaxBytes).toBe(3 * MB);
    expect(platform.media.data).toBe(platform.data);
    const listing = await views.mediaView('u1', {});
    expect(listing.items).toEqual([]);
});
