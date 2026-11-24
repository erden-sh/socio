import { AGENT_SCOPE_LABELS } from '@socio/shared/agent-grants';
import { parsePluginScope, pluginScopeLabel } from '@socio/shared/plugins/plugins';

/**
 * A connected agent's scope in plain words: the built-in list, then the
 * labels the server sent (a plugin's own scopes, named after the plugin),
 * then words made from a per-plugin scope's id (`plugins:calendar:write`).
 */
export function scopeLabel(scope: string, labels?: Readonly<Record<string, string>>) {
    const known = AGENT_SCOPE_LABELS[scope] ?? labels?.[scope];
    if (known) {
        return known;
    }
    const plugin = parsePluginScope(scope);
    return plugin ? pluginScopeLabel(plugin.id, plugin.access) : scope;
}
