import { useParams, type ClientLoaderFunctionArgs, type LoaderFunctionArgs } from 'react-router';

import { routeI18n } from '../../i18n/page-i18n';
import { preloadNamespaces } from '../../i18n/page-instance';
import { revalidateOn } from '../../lib/page-loader';
import type { RouteHandle } from '../../shell/shell-context';

import { INSTALLED_PATH } from './plugin-rows';
import { PluginManagePage } from './PluginManagePage';

// An installed plugin's admin page (CB-393): Plugins › Plugin name.
export const handle: RouteHandle = {
    crumb: ({ workspace, params, t }) => [
        // oxlint-disable-next-line socio/translate-in-components -- the header's t, passed at each render (CrumbContext)
        { label: t('plugins:title'), to: INSTALLED_PATH },
        {
            label:
                workspace.plugins?.find((item) => item.id === params.pluginId)?.name ??
                // oxlint-disable-next-line socio/translate-in-components -- the header's t, passed at each render (CrumbContext)
                t('plugins:crumb-fallback'),
        },
    ],
};

/**
 * Its namespaces (route-namespaces.json), inlined with the page, which
 * reads the plugin itself; once a visit, as they don't change with the
 * plugin.
 */
export async function loader({ context }: LoaderFunctionArgs) {
    return { i18n: await routeI18n(context, 'plugins:manage') };
}

/**
 * A navigation in the browser: the route's words, and at the same time
 * those of its dialogs (Update, Uninstall: plugins.dialogs), which load on
 * demand, so a click doesn't wait for them.
 */
export function clientLoader({ serverLoader }: ClientLoaderFunctionArgs) {
    void preloadNamespaces(['plugins.dialogs']);
    return serverLoader<typeof loader>();
}
export const shouldRevalidate = revalidateOn({ search: false });

export default function PluginManageRoute() {
    const { pluginId = '' } = useParams();
    // Keyed by id: another plugin's page starts fresh.
    return <PluginManagePage key={pluginId} id={pluginId} />;
}
