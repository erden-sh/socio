import { useLoaderData, type LoaderFunctionArgs } from 'react-router';

import { revalidateOn } from '../../lib/page-loader';
import { web } from '../../lib/web-context';
import type { RouteHandle } from '../../shell/shell-context';

import { OperatorPage } from './OperatorPage';

export const handle: RouteHandle = {
    crumb: () => [{ label: 'Settings', to: '/settings' }, { label: 'Platform' }],
};

/**
 * The inference backends and settings (operators; the gate sends everyone
 * else home). The running work changes on its own, and the Domains card
 * and backend tests ask their own: they load in the browser.
 */
export async function loader({ context }: LoaderFunctionArgs) {
    const { services } = web(context);
    if (!(await services.user())) {
        return null;
    }
    return services.inference();
}
export const shouldRevalidate = revalidateOn();

export default function OperatorRoute() {
    const initial = useLoaderData<typeof loader>();
    return <OperatorPage initial={initial ?? undefined} />;
}
