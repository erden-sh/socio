/**
 * The live layers: they implement `contract.ts`'s `Counters` over the
 * workspace's change counters (`change-counters.ts`). Only the composition root
 * (`composition/live.ts`) and tests import this file.
 *
 * The polled views' functions left here (`views/state.ts`,
 * `view-versions.ts`) stay plain functions of their callers' contract
 * slices; each feature's own views are behind its `<X>Views` tag, and
 * live's copies of them are gone.
 */
import { Layer } from 'effect';

import { Counters, type CountersShape } from './contract.js';

/**
 * `Counters` over `counters` (the workspace's `ChangeCounters`, made with
 * its store). Built once every module's tables exist, so it first installs
 * their change triggers (`sync`), as the last step of the graph
 * (`composition/index.ts`) always has; the same counters are then offered as they are.
 */
export const CountersLive = (counters: CountersShape) =>
    Layer.sync(Counters, () => {
        counters.sync();
        return Counters.of(counters);
    });
