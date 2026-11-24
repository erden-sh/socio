import { useLoaderData, type LoaderFunctionArgs } from 'react-router';

import { revalidateOn } from '../../lib/page-loader';
import { web } from '../../lib/web-context';

import { ApprovalsPage } from './ApprovalsPage';

/**
 * The user's own approvals: what waits for them, policies, guidance,
 * recent decisions and the audit (what `/api/approvals` returns them).
 */
export async function loader({ context }: LoaderFunctionArgs) {
    const { services } = web(context);
    if (!(await services.user())) {
        return null;
    }
    return services.approvals();
}
// `?dot=` only picks the Dot whose policies show.
export const shouldRevalidate = revalidateOn({ search: false, polled: true });

export default function ApprovalsRoute() {
    const initial = useLoaderData<typeof loader>();
    return <ApprovalsPage initial={initial ?? undefined} />;
}
