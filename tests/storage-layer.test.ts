// Storage's layer offers the object stores' makers and the file moves as they
// are, and the composition's step adds `StorageConfig` from the startup
// configuration, not the environment.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context, Effect, Layer } from 'effect';
import { afterEach, expect, it } from 'vitest';

import { LegacyConfig } from '../src/server/composition/base.js';
import type { PlatformConfig } from '../src/server/composition/config.js';
import { storageLayers } from '../src/server/composition/storage.js';
import { FileMoves, ObjectStores, StorageConfig } from '../src/server/storage/contract.js';
import { StorageLive } from '../src/server/storage/layer.js';
import { LocalObjectStore } from '../src/server/storage/local-store.js';
import { migrateLocalFiles } from '../src/server/storage/migrate-local.js';
import { resealFiles } from '../src/server/storage/reseal.js';
import { S3ObjectStore } from '../src/server/storage/s3-store.js';
import { fileMoves, objectStores } from '../src/server/storage/services.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
    for (const fn of cleanup.splice(0).reverse()) {
        fn();
    }
});

const s3 = { endpoint: 'http://127.0.0.1:1', bucket: 'b', region: 'r', accessKeyId: 'a', secretAccessKey: 's' };

it('offers ObjectStores and FileMoves, needing nothing', async () => {
    const context = await Effect.runPromise(Layer.build(StorageLive).pipe(Effect.scoped));
    const stores = Context.get(context, ObjectStores);
    expect(stores).toBe(objectStores);
    expect(Context.get(context, FileMoves)).toBe(fileMoves);
    expect(fileMoves.migrateLocalFiles).toBe(migrateLocalFiles);
    expect(fileMoves.resealFiles).toBe(resealFiles);

    const dir = mkdtempSync(join(tmpdir(), 'cb-storage-layer-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const local = stores.local(dir);
    expect(local).toBeInstanceOf(LocalObjectStore);
    expect(local.root).toBe(dir);
    expect(stores.s3(s3, { retries: 0 })).toBeInstanceOf(S3ObjectStore);
});

it("builds StorageConfig from the supplied config's storage settings", async () => {
    const settings = { driver: 'local' as const, tenantId: 'acme' };
    const supplied = (storage?: unknown) => Layer.succeed(LegacyConfig, { storage } as unknown as PlatformConfig);

    const withSettings = await Effect.runPromise(
        Layer.build(storageLayers.bridges.pipe(Layer.provide(supplied(settings)))).pipe(Effect.scoped),
    );
    expect(Context.get(withSettings, StorageConfig)).toEqual({ settings });
    expect(Context.get(withSettings, ObjectStores)).toBe(objectStores);
    expect(Context.get(withSettings, FileMoves)).toBe(fileMoves);

    const without = await Effect.runPromise(
        Layer.build(storageLayers.bridges.pipe(Layer.provide(supplied()))).pipe(Effect.scoped),
    );
    expect(Context.get(without, StorageConfig).settings).toBeUndefined();
});
