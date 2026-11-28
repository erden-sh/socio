import type { LoaderFunctionArgs } from 'react-router';

import { routeI18n } from '../../i18n/page-i18n';
import { revalidateOn } from '../../lib/page-loader';
import type { RouteHandle } from '../../shell/shell-context';

export { AppOpenPage as default } from './AppOpenPage';
export const handle: RouteHandle = {
    crumb: ({ t }) => [
        // oxlint-disable-next-line socio/translate-in-components -- the header's t, passed at each render (CrumbContext)
        { label: t('apps.open:crumbs.apps'), to: '/apps' },
        // oxlint-disable-next-line socio/translate-in-components -- the header's t, passed at each render (CrumbContext)
        { label: t('apps.open:crumbs.open') },
    ],
};

/** Its namespaces (route-namespaces.json), inlined with the page; the launch is the page's own. */
export async function loader({ context }: LoaderFunctionArgs) {
    return { i18n: await routeI18n(context, 'apps:open') };
}
export const shouldRevalidate = revalidateOn({ search: false });
