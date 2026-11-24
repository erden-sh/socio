/**
 * The data space's layers: they implement `contract.ts` (`Data`,
 * `DataspaceViews`) from other features' tags. Only the composition root and
 * tests import this file.
 */
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { Context, Effect, Layer } from 'effect';

import type { StorageSettings } from '@socio/data/storage/settings';
import type { DataKeyring } from '@socio/foundation/keys/secret-box';

import { Approvals, type ApprovalsShape } from '../approvals/contract.js';
import { RuntimeIdentity, type RuntimeIdentityShape } from '../runtime/contract.js';
import {
    FileMoves,
    ObjectStores,
    StorageConfig,
    type FileMovesShape,
    type ObjectStoresShape,
} from '../storage/contract.js';
import { Audit, Conversations, People, Socios, Spaces } from '../workspace/contract.js';

import { Data, DataConfig, DataspaceViews, type DataLimits, type DataSettings } from './contract.js';
import { dataspaceViews } from './data-views.js';
import { DataSpace, type DataSpaceOptions } from './space.js';
import { DataSpaceInstance } from './tags.js';

/**
 * What the boot step hands the data space, which no feature's tag offers:
 * the connection it shares with the workspace, the data keyring files are
 * sealed with, and the limits an admin saved in Settings (CB-108), read on
 * every use.
 */
export interface DataSpaceBootShape {
    readonly db: DatabaseSync;
    readonly keys: DataKeyring;
    readonly overrides: () => Partial<DataLimits>;
}

export class DataSpaceBoot extends Context.Service<DataSpaceBoot, DataSpaceBootShape>()(
    'socio/dataspace/DataSpaceBoot',
) {}

/** The data space as the class: in `tags.ts` so the module can read it. */
export { DataSpaceInstance };

/** Everything the data space is made of, from the tags or a platform built on its own. */
export interface DataSpaceParts extends DataSpaceBootShape {
    readonly approvals: ApprovalsShape;
    readonly workspace: DataSpaceOptions['workspace'];
    readonly runtime: Pick<RuntimeIdentityShape, 'attach'>;
    readonly stores: ObjectStoresShape;
    readonly moves: FileMovesShape;
    /** `DataConfig`'s settings (`dataSettingsFromEnv`). */
    readonly data?: DataSettings;
    /** `StorageConfig`'s settings (where files' bytes go). */
    readonly storage?: StorageSettings;
}

/**
 * The users' data spaces: datasets, files, grants, scoped tokens. Made as
 * the server has always made it; it registers its approval
 * handlers, so it is made at the same step.
 */
export function makeDataSpace(parts: DataSpaceParts): DataSpace {
    const { data, storage } = parts;
    const userDataDir = data?.userDataDir ?? join(tmpdir(), `company-brain-userdata-${process.pid}-${randomUUID()}`);
    // Files' sealed bytes: S3 when configured (CB-54), else the local disk,
    // which also keeps rows not yet moved.
    const legacy = parts.stores.local(userDataDir);
    return new DataSpace(parts.db, {
        // Data tokens any of the app's runtimes accepts while their issuer
        // lives (CB-108).
        runtime: parts.runtime.attach(parts.db),
        dir: userDataDir,
        objects: storage?.s3 ? parts.stores.s3(storage.s3) : legacy,
        legacy,
        moves: parts.moves,
        tenantId: storage?.tenantId,
        limits: data?.limits,
        overrides: parts.overrides,
        tokenTtlMs: data?.tokenTtlMs,
        // Analytical tables' process (CB-369): forked when first used.
        analyticsMode: data?.analyticsMode ?? 'child',
        secret: parts.keys,
        approvals: parts.approvals,
        workspace: parts.workspace,
    });
}

/** The data space, from the boot step's parts and the tags of the features it reads. */
export const DataSpaceLive = Layer.effect(
    DataSpaceInstance,
    Effect.gen(function* () {
        const boot = yield* DataSpaceBoot;
        const people = yield* People;
        const spaces = yield* Spaces;
        const socios = yield* Socios;
        const conversations = yield* Conversations;
        const audit = yield* Audit;
        return makeDataSpace({
            ...boot,
            approvals: yield* Approvals,
            workspace: {
                dot: (id) => socios.dot(id),
                dots: () => socios.dots(),
                users: () => people.users(),
                spaces: () => spaces.spaces(),
                readsSpace: (userId, spaceId) => spaces.readsSpace(userId, spaceId),
                editsSpace: (userId, spaceId) => spaces.editsSpace(userId, spaceId),
                usedDot: (userId, dotId) => conversations.usedDot(userId, dotId),
                // Data API tokens: their maker deactivated, and their lines.
                deactivated: (userId) => people.isDeactivated(userId),
                audit: (line) => audit.audit(line),
            },
            runtime: yield* RuntimeIdentity,
            stores: yield* ObjectStores,
            moves: yield* FileMoves,
            data: (yield* DataConfig).data,
            storage: (yield* StorageConfig).settings,
        });
    }),
);

/** The data views over the data space (`DataspaceViews`). */
export const DataspaceViewsLive = Layer.effect(
    DataspaceViews,
    Effect.gen(function* () {
        return dataspaceViews(yield* DataSpaceInstance);
    }),
);

/**
 * `Data` and `DataspaceViews`, over the one data space, which it also
 * offers as the class (`DataSpaceInstance`).
 */
export const DataLive = Layer.effect(
    Data,
    Effect.gen(function* () {
        return yield* DataSpaceInstance;
    }),
).pipe(Layer.provideMerge(DataspaceViewsLive), Layer.provideMerge(DataSpaceLive));
