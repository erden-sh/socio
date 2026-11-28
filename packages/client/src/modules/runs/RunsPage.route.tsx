import { useLoaderData, type LoaderFunctionArgs } from 'react-router';

import { routeI18n } from '../../i18n/page-i18n';
import { revalidateOn } from '../../lib/page-loader';
import { web } from '../../lib/web-context';
import type { RouteHandle } from '../../shell/shell-context';

import { RunsPage } from './RunsPage';

// runs, which the route inlines.
export const handle: RouteHandle = {
    // oxlint-disable-next-line socio/translate-in-components -- the header's t, passed at each render (CrumbContext)
    crumb: ({ t }) => [{ label: t('runs:title') }],
};

/** How many runs the page's first screen carries (the poll lists 200). */
const FIRST_SCREEN = 50;

/**
 * The latest agent turns, for the Turns tab (admins; the gate sends
 * members home), and the route's namespaces (route-namespaces.json),
 * asked for together. Another tab (`?tab=`, other modules' slots) loads
 * its own data, so no runs are read for it here.
 */
export async function loader({ context, request }: LoaderFunctionArgs) {
    const { services } = web(context);
    const tab = new URL(request.url).searchParams.get('tab');
    const [i18n, runs] = await Promise.all([
        routeI18n(context, 'runs'),
        tab && tab !== 'turns' ? null : services.user().then((user) => (user ? services.runs(FIRST_SCREEN) : null)),
    ]);
    return { i18n, runs };
}
export const shouldRevalidate = revalidateOn({ search: false, polled: true });

export default function RunsRoute() {
    const { runs } = useLoaderData<typeof loader>();
    return <RunsPage initial={runs ?? undefined} />;
}
