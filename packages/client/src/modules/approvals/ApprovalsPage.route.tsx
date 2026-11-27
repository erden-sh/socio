import { useLoaderData, type LoaderFunctionArgs } from 'react-router';

import { routeI18n } from '../../i18n/page-i18n';
import { revalidateOn } from '../../lib/page-loader';
import { web } from '../../lib/web-context';

import { ApprovalsPage } from './ApprovalsPage';

/**
 * The user's own approvals: what waits for them, policies, guidance,
 * recent decisions and the audit (what `/api/approvals` returns them),
 * and the route's namespaces (route-namespaces.json), asked for together.
 */
export async function loader({ context }: LoaderFunctionArgs) {
    const { services } = web(context);
    const [i18n, approvals] = await Promise.all([
        routeI18n(context, 'approvals'),
        services.user().then((user) => (user ? services.approvals() : null)),
    ]);
    return { i18n, approvals };
}
// `?dot=` only picks the Dot whose policies show.
export const shouldRevalidate = revalidateOn({ search: false, polled: true });

export default function ApprovalsRoute() {
    const { approvals } = useLoaderData<typeof loader>();
    return <ApprovalsPage initial={approvals ?? undefined} />;
}
