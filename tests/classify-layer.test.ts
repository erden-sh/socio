import { Context, Effect, Layer } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';

import type { Settings } from '@socio/shared/types';

import { ClassifyConfig, Labels, Seam } from '../src/server/classify/contract.js';
import { ClassifyHost, ClassifyLive } from '../src/server/classify/layer.js';
import { classifyParts } from '../src/server/classify/service.js';
import { Inference, type InferenceShape } from '../src/server/inference/contract.js';
import { AccessAudit, RunSource } from '../src/server/operations/contract.js';
import { sqliteSourceReader } from '../src/server/operations/infra/sqlite/source-reader.js';
import { WorkspaceSettings, type WorkspaceSettingsShape } from '../src/server/settings/contract.js';

import { testDatabase } from './helpers/test-database.js';

// The seam's layer: made once from the tags of what it reads, the same seam
// under `Seam`, `Labels` and the module's `ClassifyHost`, and handed to the
// module's hooks. No model is set up, so nothing leaves the machine.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

function layer(settings: Partial<Settings>, config: { classify?: object; operations?: object } = {}) {
    const db = testDatabase();
    cleanup.push(() => db.close());
    const audit = () => async () => {};
    let inferenceReads = 0;
    const inference = {
        shared: async () => {
            inferenceReads++;
            return undefined;
        },
    } as unknown as InferenceShape;
    const deps = Layer.mergeAll(
        Layer.succeed(Inference, inference),
        Layer.succeed(WorkspaceSettings, { settings: () => settings as Settings } as unknown as WorkspaceSettingsShape),
        Layer.succeed(ClassifyConfig, config),
        Layer.succeed(RunSource, sqliteSourceReader(db)),
        Layer.succeed(AccessAudit, { audit }),
    );
    return { db, audit, reads: () => inferenceReads, live: ClassifyLive({ db }).pipe(Layer.provide(deps)) };
}

describe('the classify layer', () => {
    it('offers one seam under Seam, Labels and ClassifyHost, with the access log it was given', async () => {
        const { live, audit } = layer({});
        const built = await Effect.runPromise(Layer.build(live).pipe(Effect.scoped));
        const host = Context.get(built, ClassifyHost);
        expect(Context.get(built, Seam)).toBe(host.service.classifier);
        expect(Context.get(built, Labels)).toBe(host.service.store);
        expect(host.audit.audit).toBe(audit);
    });

    it('reads the settings and config it was given, and the shared backend per call', async () => {
        const { live, reads } = layer(
            { classify: { failures: { threshold: 0.9 } } },
            { classify: { failures: { enabled: true, perDay: 7 } } },
        );
        const view = await Effect.runPromise(
            Effect.gen(function* () {
                const { service } = yield* ClassifyHost;
                return yield* Effect.promise(() => service.view('failures'));
            }).pipe(Effect.provide(live)),
        );
        expect(view).toMatchObject({ enabled: true, perDay: 7, threshold: 0.9, available: false });
        expect(view.defaults).toMatchObject({ enabled: true, perDay: 7 });
        expect(reads()).toBeGreaterThan(0);
    });

    it('hands the module the seam the app’s services hold', async () => {
        const { live } = layer({});
        const host = await Effect.runPromise(
            Effect.gen(function* () {
                return yield* ClassifyHost;
            }).pipe(Effect.provide(live)),
        );
        const services = Context.make(ClassifyHost, host);
        const context = { services: { get: (tag: never) => Context.get(services, tag) } } as never;
        expect(classifyParts(context)).toBe(host);
    });
});
