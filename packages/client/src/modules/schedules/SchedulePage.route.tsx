import { useLoaderData, type LoaderFunctionArgs } from 'react-router';

import { revalidateOn } from '../../lib/page-loader';
import { web } from '../../lib/web-context';
import type { RouteHandle } from '../../shell/shell-context';

import { SchedulePage } from './SchedulePage';

export const handle: RouteHandle = {
    crumb: () => [{ label: 'Schedules', to: '/schedules' }, { label: 'Schedule' }],
};

/**
 * One of the user's own schedules in full (CB-88), so the page opens with
 * it. Null for someone else's or a missing one: the page says so.
 */
export async function loader({ context, params }: LoaderFunctionArgs) {
    const { services } = web(context);
    if (!params.scheduleId || !(await services.user())) {
        return null;
    }
    return services.schedule(params.scheduleId);
}
export const shouldRevalidate = revalidateOn({
    params: ['scheduleId'],
    polled: true,
});

export default function ScheduleRoute() {
    const initial = useLoaderData<typeof loader>();
    return <SchedulePage initial={initial ?? undefined} />;
}
