/**
 * The classification seam's layers: they implement `contract.ts`. Only the
 * composition root and tests import this file.
 *
 * The seam is made once, from the tags of what it reads: Operations' stored
 * turns (`RunSource`) and access log (`AccessAudit`, for its routes), the
 * settings (`WorkspaceSettings`), the default shared backend (`Inference`)
 * and its own `ClassifyConfig`. Nothing is started here and nothing is read
 * from the database: labeling and recovery stay the module's hooks
 * (`module.ts`), which run on the seam made here.
 */
import type { DatabaseSync } from 'node:sqlite';

import { Context, Effect, Layer } from 'effect';

import { Inference } from '../inference/contract.js';
import { AccessAudit, RunSource } from '../operations/contract.js';
import { WorkspaceSettings } from '../settings/contract.js';

import { ClassifyConfig, Labels, Seam } from './contract.js';
import { makeClassifyService } from './service.js';
import { ClassifyHost } from './tags.js';

/** The seam and its access log: in `tags.ts` so the module can read them. */
export { ClassifyHost };

/** What the seam is made on: the workspace connection, and the log for operational lines. */
export interface ClassifyBoot {
    db: DatabaseSync;
    log?: (line: string) => void;
}

/** The seam (`ClassifyHost`), made once, with its classifier as `Seam` and its store as `Labels`. */
export const ClassifyLive = (boot: ClassifyBoot) => {
    const Host = Layer.effect(
        ClassifyHost,
        Effect.gen(function* () {
            const inference = yield* Inference;
            const settings = yield* WorkspaceSettings;
            const service = makeClassifyService({
                db: boot.db,
                runs: yield* RunSource,
                settings: () => settings.settings(),
                config: yield* ClassifyConfig,
                inference: () => inference,
                log: boot.log,
            });
            return { service, audit: yield* AccessAudit };
        }),
    );
    const Slices = Layer.effectContext(
        Effect.gen(function* () {
            const { service } = yield* ClassifyHost;
            return Context.make(Seam, service.classifier).pipe(Context.add(Labels, service.store));
        }),
    );
    return Slices.pipe(Layer.provideMerge(Host));
};
