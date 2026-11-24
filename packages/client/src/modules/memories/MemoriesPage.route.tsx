import { useLoaderData, type LoaderFunctionArgs } from 'react-router';

import { revalidateOn } from '../../lib/page-loader';
import { web } from '../../lib/web-context';

import { MemoriesPage } from './MemoriesPage';

/** The user's own profile, memories and proposals (`/api/memories`). */
export async function loader({ context }: LoaderFunctionArgs) {
    const { services } = web(context);
    if (!(await services.user())) {
        return null;
    }
    return services.memories();
}
export const shouldRevalidate = revalidateOn({ polled: true });

export default function MemoriesRoute() {
    const initial = useLoaderData<typeof loader>();
    return <MemoriesPage initial={initial ?? undefined} />;
}
