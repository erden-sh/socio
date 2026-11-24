import { useLoaderData, type LoaderFunctionArgs } from 'react-router';

import { revalidateOn } from '../../lib/page-loader';
import { web } from '../../lib/web-context';

import { DataPage } from './DataPage';

/**
 * The user's datasets, grants per Dot and usage (what `/api/data` returns
 * them, without the file list: Media lists files). The audit tab loads
 * its own when opened.
 */
export async function loader({ context }: LoaderFunctionArgs) {
    const { services } = web(context);
    if (!(await services.user())) {
        return null;
    }
    return services.data();
}
// `?tab=` only picks what shows.
export const shouldRevalidate = revalidateOn({ search: false, polled: true });

export default function DataRoute() {
    const initial = useLoaderData<typeof loader>();
    return <DataPage initial={initial ?? undefined} />;
}
