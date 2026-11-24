import { useLoaderData, type LoaderFunctionArgs } from 'react-router';

import { revalidateOn } from '../../lib/page-loader';
import { web } from '../../lib/web-context';
import type { RouteHandle } from '../../shell/shell-context';

import { ApprovalRequestPage } from './ApprovalRequestPage';

export const handle: RouteHandle = {
    crumb: () => [{ label: 'Approvals', to: '/approvals' }, { label: 'Request' }],
};

/**
 * One of the user's own requests (Telegram notices link here), so the
 * page opens with it. Null for someone else's or a missing one: the card
 * asks the API and says it isn't found.
 */
export async function loader({ context, params }: LoaderFunctionArgs) {
    const { services } = web(context);
    if (!params.approvalId || !(await services.user())) {
        return null;
    }
    return services.approval(params.approvalId);
}
export const shouldRevalidate = revalidateOn({
    params: ['approvalId'],
    polled: true,
});

export default function ApprovalRequestRoute() {
    const initial = useLoaderData<typeof loader>();
    return <ApprovalRequestPage initial={initial ?? undefined} />;
}
