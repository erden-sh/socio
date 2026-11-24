import { useLoaderData, type LoaderFunctionArgs } from 'react-router';

import { revalidateOn } from '../../lib/page-loader';
import { web } from '../../lib/web-context';

import { SchedulesPage } from './SchedulesPage';

/**
 * The user's own schedules and jobs (what `/api/schedules` returns them).
 * A job's versions, runs and logs load when opened.
 */
export async function loader({ context }: LoaderFunctionArgs) {
    const { services } = web(context);
    if (!(await services.user())) {
        return null;
    }
    return services.schedules();
}
// `?tab=` only picks what shows.
export const shouldRevalidate = revalidateOn({ search: false, polled: true });

export default function SchedulesRoute() {
    const initial = useLoaderData<typeof loader>();
    return <SchedulesPage initial={initial ?? undefined} />;
}
