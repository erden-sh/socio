import { useLoaderData, type LoaderFunctionArgs } from 'react-router';

import { revalidateOn } from '../../lib/page-loader';
import { web } from '../../lib/web-context';
import type { RouteHandle } from '../../shell/shell-context';

import { DatasetPage } from './DatasetPage';

export const handle: RouteHandle = {
    crumb: () => [{ label: 'Data', to: '/data' }, { label: 'Dataset' }],
};

/**
 * One dataset the user may see, with its tables' schema and sizes. Its
 * rows, queries and audit stay in the browser (they are asked for with
 * their own limits). Null for one that isn't theirs or is gone.
 */
export async function loader({ context, params }: LoaderFunctionArgs) {
    const { services } = web(context);
    if (!params.datasetId || !(await services.user())) {
        return null;
    }
    return services.dataset(params.datasetId);
}
export const shouldRevalidate = revalidateOn({ params: ['datasetId'] });

export default function DatasetRoute() {
    const initial = useLoaderData<typeof loader>();
    return <DatasetPage initial={initial} />;
}
