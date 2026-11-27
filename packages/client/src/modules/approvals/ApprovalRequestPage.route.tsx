import { useLoaderData, type LoaderFunctionArgs } from 'react-router';

import { routeI18n } from '../../i18n/page-i18n';
import { revalidateOn } from '../../lib/page-loader';
import { web } from '../../lib/web-context';
import type { RouteHandle } from '../../shell/shell-context';

import { ApprovalRequestPage } from './ApprovalRequestPage';

// approvals.card, which the route inlines.
export const handle: RouteHandle = {
    crumb: ({ t }) => [
        // oxlint-disable-next-line socio/translate-in-components -- the header's t, passed at each render (CrumbContext)
        { label: t('approvals.card:request.crumb'), to: '/approvals' },
        // oxlint-disable-next-line socio/translate-in-components -- the header's t, passed at each render (CrumbContext)
        { label: t('approvals.card:request.crumb-request') },
    ],
};

/**
 * One of the user's own requests (Telegram notices link here), so the
 * page opens with it, and the route's namespaces (route-namespaces.json),
 * asked for together. The request is null for someone else's or a missing
 * one: the card asks the API and says it isn't found.
 */
export async function loader({ context, params }: LoaderFunctionArgs) {
    const { services } = web(context);
    const [i18n, approval] = await Promise.all([
        routeI18n(context, 'approvals:request'),
        params.approvalId
            ? services.user().then((user) => (user ? services.approval(params.approvalId!) : null))
            : null,
    ]);
    return { i18n, approval };
}
export const shouldRevalidate = revalidateOn({
    params: ['approvalId'],
    polled: true,
});

export default function ApprovalRequestRoute() {
    const { approval } = useLoaderData<typeof loader>();
    return <ApprovalRequestPage initial={approval ?? undefined} />;
}
