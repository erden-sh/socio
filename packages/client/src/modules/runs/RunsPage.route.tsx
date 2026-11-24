import { useLoaderData, type LoaderFunctionArgs } from 'react-router';

import { revalidateOn } from '../../lib/page-loader';
import { web } from '../../lib/web-context';

import { RunsPage } from './RunsPage';

/** How many runs the page's first screen carries (the poll lists 200). */
const FIRST_SCREEN = 50;

/**
 * The latest agent turns, for the Turns tab (admins; the gate sends
 * members home). Another tab (`?tab=`, other modules' slots) loads its
 * own data, so nothing is read for it here.
 */
export async function loader({ context, request }: LoaderFunctionArgs) {
    const { services } = web(context);
    const tab = new URL(request.url).searchParams.get('tab');
    if ((tab && tab !== 'turns') || !(await services.user())) {
        return null;
    }
    return services.runs(FIRST_SCREEN);
}
export const shouldRevalidate = revalidateOn({ search: false, polled: true });

export default function RunsRoute() {
    const initial = useLoaderData<typeof loader>();
    return <RunsPage initial={initial ?? undefined} />;
}
