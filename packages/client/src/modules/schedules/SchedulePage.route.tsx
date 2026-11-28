import { useLoaderData, type LoaderFunctionArgs } from 'react-router';

import { routeI18n } from '../../i18n/page-i18n';
import { revalidateOn } from '../../lib/page-loader';
import { web } from '../../lib/web-context';
import type { RouteHandle } from '../../shell/shell-context';

import { SchedulePage } from './SchedulePage';

// schedules, which the route inlines.
export const handle: RouteHandle = {
    crumb: ({ t }) => [
        // oxlint-disable-next-line socio/translate-in-components -- the header's t, passed at each render (CrumbContext)
        { label: t('schedules:crumb'), to: '/schedules' },
        // oxlint-disable-next-line socio/translate-in-components -- the header's t, passed at each render (CrumbContext)
        { label: t('schedules:crumb-schedule') },
    ],
};

/**
 * One of the user's own schedules in full (CB-88), so the page opens with
 * it, and the route's namespaces (route-namespaces.json), asked for
 * together. The schedule is null for someone else's or a missing one: the
 * page says so.
 */
export async function loader({ context, params }: LoaderFunctionArgs) {
    const { services } = web(context);
    const [i18n, schedule] = await Promise.all([
        routeI18n(context, 'schedules:schedule'),
        params.scheduleId
            ? services.user().then((user) => (user ? services.schedule(params.scheduleId!) : null))
            : null,
    ]);
    return { i18n, schedule };
}
export const shouldRevalidate = revalidateOn({
    params: ['scheduleId'],
    polled: true,
});

export default function ScheduleRoute() {
    const { schedule } = useLoaderData<typeof loader>();
    return <SchedulePage initial={schedule ?? undefined} />;
}
