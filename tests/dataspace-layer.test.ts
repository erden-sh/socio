import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { Effect, Layer } from 'effect';
import { afterEach, expect, it } from 'vitest';

import type { User } from '@socio/shared/types';

import { Approvals } from '../src/server/approvals/contract.js';
import { sqliteApprovals } from '../src/server/approvals/services.js';
import { Data, DataConfig, DataspaceViews } from '../src/server/dataspace/contract.js';
import { dataView, datasetView } from '../src/server/dataspace/data-views.js';
import { DataLive, DataSpaceBoot, DataSpaceInstance } from '../src/server/dataspace/layer.js';
import { DataSpace } from '../src/server/dataspace/space.js';
import {
    RuntimeIdentity,
    type RuntimeIdentityShape,
    type RuntimeOwnershipShape,
} from '../src/server/runtime/contract.js';
import { FileMoves, ObjectStores, StorageConfig } from '../src/server/storage/contract.js';
import { fileMoves, objectStores } from '../src/server/storage/services.js';
import { WorkspaceLive } from '../src/server/workspace/layer.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
    for (const step of cleanup.splice(0).reverse()) {
        step();
    }
});

/** The data space's layer over test stand-ins of the tags it reads. */
function fixture() {
    const workspace = new WorkspaceStore(testDatabase());
    const dir = mkdtempSync(join(tmpdir(), 'cb-dataspace-layer-'));
    cleanup.push(() => {
        workspace.close();
        rmSync(dir, { recursive: true, force: true });
    });
    workspace.recordUser({ id: 'alice', name: 'Alice', role: 'admin' });
    workspace.recordUser({ id: 'bob', name: 'Bob', role: 'member' });
    const attached: DatabaseSync[] = [];
    const deps = Layer.mergeAll(
        WorkspaceLive(workspace),
        Layer.succeed(Approvals, sqliteApprovals(workspace.db)),
        Layer.succeed(RuntimeIdentity, {
            attach: (db: DatabaseSync) => {
                attached.push(db);
                // No shared store: the tokens stay in this process's memory.
                return undefined as unknown as RuntimeOwnershipShape;
            },
        } as unknown as RuntimeIdentityShape),
        Layer.succeed(ObjectStores, objectStores),
        Layer.succeed(FileMoves, fileMoves),
        Layer.succeed(StorageConfig, {}),
        Layer.succeed(DataConfig, { data: { userDataDir: dir, limits: { maxDatasets: 7 } } }),
        Layer.succeed(DataSpaceBoot, {
            db: workspace.db,
            keys: { legacy: 'secret-0123456789abcdef-xyz' },
            overrides: () => ({ queryMaxRows: 42 }),
        }),
    );
    const layer = DataLive.pipe(Layer.provide(deps));
    return { workspace, dir, attached, layer };
}

it('builds one data space, offered as Data, the class and the views', async () => {
    const f = fixture();
    const built = await Effect.runPromise(
        Effect.gen(function* () {
            return { data: yield* Data, instance: yield* DataSpaceInstance, views: yield* DataspaceViews };
        }).pipe(Effect.provide(f.layer)),
    );
    cleanup.push(() => built.instance.close());
    expect(built.instance).toBeInstanceOf(DataSpace);
    expect(built.data).toBe(built.instance);
    expect(built.data.dir).toBe(f.dir);
    // The runtime identity is attached to the boot step's connection.
    expect(f.attached).toEqual([f.workspace.db]);
    // Settings' limits over the config's, over the defaults.
    expect(built.data.limits.maxDatasets).toBe(7);
    expect(built.data.limits.queryMaxRows).toBe(42);
    // Local storage without S3: new files and old rows share the disk.
    expect(built.data.objects.driver).toBe('local');
    expect(built.instance.legacy.root).toBe(f.dir);
});

it('reads the socios through the workspace slices', async () => {
    const f = fixture();
    const data = await Effect.runPromise(
        Effect.gen(function* () {
            return yield* DataSpaceInstance;
        }).pipe(Effect.provide(f.layer)),
    );
    cleanup.push(() => data.close());
    const dot = f.workspace.dots()[0];
    const added = f.workspace.createDot(dot.spaceId, 'Scout', 'Scouts.', false, false);
    // A socio the slices know gets a data token on its computer; an unknown one doesn't.
    const env = data.computerEnv(added.id, 'alice', 'http://socio.test', 60_000);
    expect(env?.secrets).toHaveLength(1);
    expect(data.tokens.resolve(env!.secrets[0])?.dotId).toBe(added.id);
    env!.release?.();
    expect(data.computerEnv('no-such-dot', 'alice', 'http://socio.test', 60_000)).toBeUndefined();
});

it('serves the same views as the plain data views (live/’s deleted copy) over the data space', async () => {
    const f = fixture();
    const { data, views } = await Effect.runPromise(
        Effect.gen(function* () {
            return { data: yield* DataSpaceInstance, views: yield* DataspaceViews };
        }).pipe(Effect.provide(f.layer)),
    );
    cleanup.push(() => data.close());
    await data.putFile({ kind: 'user', userId: 'alice' }, 'notes/a.txt', Buffer.from('hello'));
    const alice = f.workspace.users().find((user) => user.id === 'alice') as User;
    const bob = f.workspace.users().find((user) => user.id === 'bob') as User;
    for (const user of [alice, bob]) {
        expect(views.dataView(user)).toEqual(dataView(data, user));
        expect(views.dataView(user, { files: false })).toEqual(dataView(data, user, { files: false }));
    }
    expect(views.dataView(alice).usage.all).toBeDefined();
    expect(views.dataView(bob).usage.all).toBeUndefined();
    expect(views.dataView(alice, { files: false }).files).toBeUndefined();
    expect(views.datasetView('alice', 'missing')).toBeNull();
    expect(views.datasetView('alice', 'missing')).toEqual(datasetView(data, 'alice', 'missing'));
});
