import type { SqlDriver } from '../data/driver';
import type { KeyStore, RandomBytes } from '../data/keys';
import { type FileSystem, storeDirectory } from '../data/layout';
import { type OpenedStore, openStore } from '../data/store';
import type { StorePush } from '../data/wipe';

import { isKeyStoreReadError } from './secure-store';

// Opening the store at launch, before the first frame:
//
// 1. `socio/` is made and kept out of backups, on every launch, before any
//    file goes in it: on iOS the exclusion covers everything under it
//    (socio-device's excludeFromBackup); Android's backup rules already leave
//    it out.
// 2. openStore: the reinstall and restore matrix, the marked wipes, the
//    reconcile (src/data/store.ts).
// 3. On iOS, a key read that fails means the phone hasn't been unlocked since
//    it restarted: wait for protected data, then open again
//    (modules/socio-device/README.md). It doesn't wait first: iOS's check
//    reports the `complete` class, which is off whenever a phone with a
//    passcode is locked, even when the keys (after-first-unlock) can be read.
//    openStore deletes nothing on a read error, so opening again is safe.
//    Android never waits.
//
// The caller hands the registry to the root gate (root-gate.ts) before the
// first frame.

export interface LaunchDeps {
    /** The app's document directory, as a file:// URI. */
    readonly root: string;
    readonly driver: SqlDriver;
    readonly fs: FileSystem;
    readonly keyStore: KeyStore;
    readonly randomBytes: RandomBytes;
    /** Keeps a directory and everything under it out of backups (socio-device's excludeFromBackup). */
    readonly excludeFromBackup: (path: string) => Promise<void>;
    /** iOS: resolves once protected data is available (socio-device). Null where there's nothing to wait for (Android). */
    readonly whenProtectedDataAvailable: (() => Promise<void>) | null;
    /** A monotonic clock in milliseconds, for the timings. */
    readonly clock: () => number;
    /** The native push keys every wipe deletes (src/platform/push.ts). */
    readonly push?: StorePush;
    /** Called as each wipe has deleted a workspace's files (src/platform/app-snapshots.ts). */
    readonly wiped?: () => void;
}

export interface Launched {
    readonly opened: OpenedStore;
    /** How long openStore took, the attempt that worked; the wait for protected data isn't in it. */
    readonly openMs: number;
    /** Whether a key read failed first and launch waited for protected data. */
    readonly waited: boolean;
}

export async function openDeviceStore(deps: LaunchDeps): Promise<Launched> {
    const folder = storeDirectory(deps.root);
    await deps.fs.mkdir(folder);
    await deps.excludeFromBackup(folder);

    const attempt = async () => {
        const started = deps.clock();
        const opened = await openStore(deps);
        return { opened, openMs: deps.clock() - started };
    };
    try {
        return { ...(await attempt()), waited: false };
    } catch (error) {
        if (deps.whenProtectedDataAvailable === null || !isKeyStoreReadError(error)) {
            throw error;
        }
        await deps.whenProtectedDataAvailable();
        return { ...(await attempt()), waited: true };
    }
}
