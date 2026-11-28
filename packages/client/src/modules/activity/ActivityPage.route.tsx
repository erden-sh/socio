import type { LoaderFunctionArgs } from 'react-router';

import { routeI18n } from '../../i18n/page-i18n';
import { revalidateOn } from '../../lib/page-loader';
import type { RouteHandle } from '../../shell/shell-context';

// activity, which the route inlines.
export const handle: RouteHandle = {
    // oxlint-disable-next-line socio/translate-in-components -- the header's t, passed at each render (CrumbContext)
    crumb: ({ t }) => [{ label: t('activity:crumb') }],
};

/**
 * `/activity`: the page's data is the shell's (its tasks); this route's
 * loader inlines its words (route-namespaces.json).
 */
export async function loader({ context }: LoaderFunctionArgs) {
    return { i18n: await routeI18n(context, 'activity') };
}
export const shouldRevalidate = revalidateOn({ search: false });

export { ActivityPage as default } from './ActivityPage';
