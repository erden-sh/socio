import type { LocalObjectStoreShape } from '../../src/server/storage/contract.js';
import { LocalObjectStore } from '../../src/server/storage/local-store.js';
import { fileMoves } from '../../src/server/storage/services.js';

/**
 * What a `DataSpace` takes of storage: the local disk under
 * its directory, unless a test passes its own, and the file moves.
 */
export const dataSpaceStorage = (dir: string, legacy?: LocalObjectStoreShape) => ({
    legacy: legacy ?? new LocalObjectStore(dir),
    moves: fileMoves,
});
