/**
 * The plugin service, whole, by tag: what its module and routes use
 * (other features use `Plugins`, the contract's slice). Moved from
 * `composition/plugins.ts` (`LegacyPlugins`, which re-exports it), so the
 * module can read it from the app's services: `contract.ts` can't name the
 * class.
 */
import { Context } from 'effect';

import type { PluginService } from './service.js';

/** Workspace plugins, under the graph's `PluginServiceTag` tag (the class). */
export class PluginServiceTag extends Context.Service<PluginServiceTag, PluginService>()(
    'socio/plugins/PluginService',
) {}
