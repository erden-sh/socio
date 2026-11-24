/**
 * The implementations of storage's tags (`contract.ts`): what the composition
 * provides as `ObjectStores` and `FileMoves` once it builds layers. Nothing
 * here changes how a store is made or a run goes: each method is today's
 * constructor or function.
 */
import type { FileMovesShape, ObjectStoresShape } from './contract.js';
import { LocalObjectStore } from './local-store.js';
import { migrateLocalFiles } from './migrate-local.js';
import { resealFiles } from './reseal.js';
import { S3ObjectStore } from './s3-store.js';

export const objectStores: ObjectStoresShape = {
    local: (root) => new LocalObjectStore(root),
    s3: (settings, options) => new S3ObjectStore(settings, options),
};

export const fileMoves: FileMovesShape = { migrateLocalFiles, resealFiles };
