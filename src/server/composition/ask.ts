/**
 * The "Ask a socio" panel's construction: its layer (`ask/layer.ts`), made once
 * on the modules' connection. The module's hooks read the `Ask` it offers from
 * their services (`ModuleHookServices`, `composition/module-services.ts`), so
 * its routes and turn notes use the service the graph made. The panel reads no
 * configuration, so there is no `AskConfig` to build here.
 *
 * Its step comes after the contract bridges, near the end of
 * `composition/index.ts`'s chain: every tag it yields is built before it,
 * and it registers no listener whose order is behavior. A platform built
 * on its own (tests, scripts) has no graph: its own module services make
 * the same service over the same objects. The panel reads the Board
 * through its own tag (`AskBoard`), provided here over the issues' `Board`.
 */
import { Effect, Layer } from 'effect';

import { AskBoard, AskLive } from '../ask/layer.js';
import { Board } from '../issues/contract.js';

import { LegacyModuleContext } from './base.js';

/** The panel's step of the graph: `Ask`, made once, which the module's hooks read. */
export const askLayers = {
    bridges: Layer.unwrap(
        Effect.gen(function* () {
            const context = yield* LegacyModuleContext;
            return AskLive({ db: context.db }).pipe(
                Layer.provide(
                    Layer.effect(
                        AskBoard,
                        Effect.gen(function* () {
                            return yield* Board;
                        }),
                    ),
                ),
            );
        }),
    ),
};
