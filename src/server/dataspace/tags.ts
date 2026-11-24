/**
 * The data space, whole, by tag: what its module and routes use (other
 * features use `Data`, the contract's slice). Moved from `layer.ts` so
 * the module can read it from the app's services: only entry files import
 * a `layer.ts`, and `contract.ts` can't name the class. `layer.ts` builds
 * it.
 */
import { Context } from 'effect';

import type { DataSpace } from './space.js';

/**
 * The data space as the class, for what still takes it whole: the HTTP
 * edge, the module, and the builders of other features that take
 * `DataSpace` (the composition's `LegacyData`). The same object `Data`
 * offers.
 */
export class DataSpaceInstance extends Context.Service<DataSpaceInstance, DataSpace>()(
    'socio/dataspace/DataSpaceInstance',
) {}
