import type { ClientLoaderFunctionArgs, LoaderFunctionArgs } from 'react-router';

import { routeI18n } from '../../i18n/page-i18n';
import { preloadNamespaces } from '../../i18n/page-instance';
import { revalidateOn } from '../../lib/page-loader';
import type { RouteHandle } from '../../shell/shell-context';

export const handle: RouteHandle = {
    // oxlint-disable-next-line socio/translate-in-components -- the header's t, passed at each render (CrumbContext)
    crumb: ({ t }) => [{ label: t('apps:title') }],
};

/**
 * `/apps`: the person's mini apps, which the page reads itself. Its loader
 * inlines the route's namespaces (route-namespaces.json); its dialogs'
 * (apps.dialogs, and the promotion wizard's apps.promote) load on demand.
 */
export async function loader({ context }: LoaderFunctionArgs) {
    return { i18n: await routeI18n(context, 'apps') };
}

/**
 * A navigation in the browser: the route's words, and at the same time
 * the dialogs' and, for `?promote=`, the wizard's, so they don't wait
 * after the page shows.
 */
export function clientLoader({ request, serverLoader }: ClientLoaderFunctionArgs) {
    void preloadNamespaces(
        new URL(request.url).searchParams.has('promote') ? ['apps.dialogs', 'apps.promote'] : ['apps.dialogs'],
    );
    return serverLoader<typeof loader>();
}
// `?promote=` only opens the wizard: no server round trip.
export const shouldRevalidate = revalidateOn({ search: false });

export { AppsPage as default } from './AppsPage';
