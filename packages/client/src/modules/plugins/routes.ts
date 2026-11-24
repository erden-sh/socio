import { layout, route } from '@react-router/dev/routes';

/**
 * The Plugins page (the catalog and installed plugins) is admin-only. An
 * installed plugin's own page is not: its audience may include members, so
 * `/plugins/:id` and everything under it sit outside this gate (in
 * `packages/client/src/routes.ts`), and the page checks the launcher list, which the
 * server filters by audience. An installed plugin's admin page (its
 * settings, who can use it, Uninstall; CB-393) is
 * `/settings/plugins/:id`, inside it: never under the plugin's own
 * address, which is all the plugin's (CB-446).
 */
export default layout('modules/plugins/gate.route.tsx', { id: 'module:plugins' }, [
    route('plugins', 'modules/plugins/PluginsPage.route.tsx', {
        id: 'plugins',
    }),
    route('settings/plugins/:pluginId', 'modules/plugins/PluginManage.route.tsx', {
        id: 'plugins:manage',
    }),
]);
