/**
 * The mini apps' registry, whole, by tag: what its module, routes and
 * tools use (other features use `Apps`, the contract's slice). Moved from
 * `composition/apps.ts` (`LegacyApps`, which re-exports it), so the module
 * can read it from the app's services: `contract.ts` can't name the class.
 */
import { Context } from 'effect';

import type { AppsService } from './service.js';

/** Mini apps, under the graph's `AppsServiceTag` tag (the class): the same object `Apps` offers. */
export class AppsServiceTag extends Context.Service<AppsServiceTag, AppsService>()('socio/apps/AppsService') {}
