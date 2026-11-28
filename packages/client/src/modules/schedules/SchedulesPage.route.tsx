import { useLoaderData, type LoaderFunctionArgs } from 'react-router';

import { routeI18n } from '../../i18n/page-i18n';
import { revalidateOn } from '../../lib/page-loader';
import { web } from '../../lib/web-context';
import type { RouteHandle } from '../../shell/shell-context';

import { SchedulesPage } from './SchedulesPage';

// schedules.list, which the route inlines.
export const handle: RouteHandle = {
    // oxlint-disable-next-line socio/translate-in-components -- the header's t, passed at each render (CrumbContext)
    crumb: ({ t }) => [{ label: t('schedules.list:title') }],
};

/**
 * The user's own schedules and jobs (what `/api/schedules` returns them),
 * and the route's namespaces (route-namespaces.json), asked for together.
 * A job's versions, runs and logs load when opened, with its words.
 */
export async function loader({ context }: LoaderFunctionArgs) {
    const { services } = web(context);
    const [i18n, schedules] = await Promise.all([
        routeI18n(context, 'schedules'),
        services.user().then((user) => (user ? services.schedules() : null)),
    ]);
    return { i18n, schedules };
}
// `?tab=` only picks what shows.
export const shouldRevalidate = revalidateOn({ search: false, polled: true });

export default function SchedulesRoute() {
    const { schedules } = useLoaderData<typeof loader>();
    return <SchedulesPage initial={schedules ?? undefined} />;
}
