import type { DatabaseSync } from 'node:sqlite';

import { transaction } from '@socio/data/open';

/** One app's envelope key epochs (CB-232). */
export interface ActorKeyEpochs {
    epoch: number;
    previousEpoch: number | null;
    rotatedAt: number | null;
}

/**
 * The epoch each app's envelope key is derived under, in `app_actor_keys`
 * (apps 7). An app without a row uses its `createdAt`, so an app that
 * takes a deleted app's address never shares its key. A row is written
 * when the epoch changes: published again, retired (so whatever takes the
 * address next differs), or rotated. Rows are only upserted, never
 * deleted; both runtimes of a deploy read the same epoch (CB-108).
 */
export class SqliteActorKeys {
    constructor(private db: DatabaseSync) {}

    get(appId: string): ActorKeyEpochs | undefined {
        const row = this.db
            .prepare('SELECT epoch, previousEpoch, rotatedAt FROM app_actor_keys WHERE appId=?')
            .get(appId) as { epoch: number; previousEpoch: number | null; rotatedAt: number } | undefined;
        return row
            ? {
                  epoch: Number(row.epoch),
                  previousEpoch: row.previousEpoch === null ? null : Number(row.previousEpoch),
                  rotatedAt: Number(row.rotatedAt),
              }
            : undefined;
    }

    /**
     * A new epoch for an app (`now`, or one past the current when the clock
     * hasn't moved); the one it replaces becomes `previousEpoch`.
     */
    rotate(appId: string, current: number, now: number) {
        const epoch = Math.max(now, current + 1);
        return transaction(this.db, 'rotate app actor key', () => {
            this.db
                .prepare(
                    `INSERT INTO app_actor_keys(appId, epoch, previousEpoch, rotatedAt) VALUES (?, ?, ?, ?)
           ON CONFLICT(appId) DO UPDATE SET epoch=excluded.epoch, previousEpoch=excluded.previousEpoch, rotatedAt=excluded.rotatedAt`,
                )
                .run(appId, epoch, current, now);
            return epoch;
        });
    }
}
