/**
 * Service plugins' datasets (CB-451: workspace datasets bound to each
 * plugin's needs), wired between the plugins and the data space here, in
 * the composition root, so neither feature imports the other: the data
 * space learns which needs each installed plugin declares
 * (`usePluginDatasets`), and the plugins have the data space bind them on
 * install and enable, show and change the bindings, unbind them on
 * uninstall and end the plugin's data tokens on disable and uninstall
 * (`useDatasets`).
 */
import type { DataSpaceShape } from '../dataspace/contract.js';
import type { PluginService } from '../plugins/service.js';

/** Binds one plugin service to one data space, both ways. */
export function bindPluginDatasets(plugins: PluginService, data: DataSpaceShape) {
    data.usePluginDatasets({
        // The installed row as the database has it now (every runtime agrees).
        declared: (pluginId) => {
            const row = plugins.current(pluginId);
            return row && row.mode === 'service' ? (row.manifest.datasets ?? []) : undefined;
        },
        name: (pluginId) => plugins.current(pluginId)?.manifest.name,
    });
    plugins.useDatasets({
        ensure: (pluginId, datasets, options) => data.ensurePluginDatasets(pluginId, datasets, options),
        check: (pluginId, datasets, choices) => data.checkPluginDatasets(pluginId, datasets, choices),
        adopted: (pluginId, datasets) => data.adoptPluginRetention(pluginId, datasets),
        revokeTokens: (pluginId) => data.revokePluginTokens(pluginId),
        unbind: (pluginId, by) => data.unbindPlugin(pluginId, by),
        plan: (pluginId, datasets, installed) => data.pluginBindingPlan(pluginId, datasets, installed),
        bind: (pluginId, datasets, need, choice, by) => data.bindPluginNeed(pluginId, datasets, need, choice, by),
    });
}
