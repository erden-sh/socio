import type { LoaderFunctionArgs } from 'react-router';

import { routeI18n } from '../../i18n/page-i18n';
import { revalidateOn } from '../../lib/page-loader';
import type { RouteHandle } from '../../shell/shell-context';

export const handle: RouteHandle = {
    // oxlint-disable-next-line socio/translate-in-components -- the header's t, passed at each render (CrumbContext)
    crumb: ({ t }) => [{ label: t('plugins:title') }],
};

/**
 * `/plugins`: the catalog and the installed plugins, which the page reads
 * itself. Its loader inlines the route's namespaces (route-namespaces.json);
 * the install dialog's load on demand (plugins.bindings).
 */
export async function loader({ context }: LoaderFunctionArgs) {
    return { i18n: await routeI18n(context, 'plugins') };
}
// The tab, the plugin open and the search are the page's own: no server round trip.
export const shouldRevalidate = revalidateOn({ search: false });

export { PluginsPage as default } from './PluginsPage';
