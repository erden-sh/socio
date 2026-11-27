import type { LoaderFunctionArgs } from 'react-router';

import { issueNumber } from '@socio/shared/issues/issue-board';
import { issueKey } from '@socio/shared/issues/issue-types';

import { revalidateOn } from '../../lib/page-loader';
import { web } from '../../lib/web-context';
import type { RouteHandle } from '../../shell/shell-context';

// `/issues/CB-12`: Issues › CB-12 in the header (issues, which the board,
// the parent route, inlines). The board stays mounted and opens the issue
// from the URL.
export const handle: RouteHandle = {
    crumb: ({ params, t }) => {
        const number = issueNumber(params.issueKey);
        return [
            // oxlint-disable-next-line socio/translate-in-components -- the header's t, passed at each render (CrumbContext)
            { label: t('issues:crumb'), to: '/issues' },
            // oxlint-disable-next-line socio/translate-in-components -- the header's t, passed at each render (CrumbContext)
            { label: number ? issueKey(number) : t('issues:not-found') },
        ];
    },
};

/**
 * The open issue with its comments, attachments and history (what
 * `/api/issues/:number` returns), so the dialog opens with it. The board
 * itself stays a client fetch: every issue is far over the loader
 * budget. Null signed out or when
 * there is no such issue; the dialog then asks the API, as before.
 */
export async function loader({ context, params }: LoaderFunctionArgs) {
    const { services } = web(context);
    const number = issueNumber(params.issueKey);
    if (!number || !(await services.user())) {
        return null;
    }
    return services.issue(number);
}
export const shouldRevalidate = revalidateOn({
    params: ['issueKey'],
    polled: true,
});

export default function IssueKey() {
    return null;
}
