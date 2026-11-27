import { useRouteLoaderData, type LoaderFunctionArgs } from 'react-router';

import { routeI18n } from '../../i18n/page-i18n';
import { revalidateOn } from '../../lib/page-loader';

import type { loader as issueLoader } from './IssueKey.route';
import { IssuesPage } from './IssuesPage';

/**
 * Its namespaces (route-namespaces.json: the board's, and an open issue's,
 * which opens over it), inlined with the page. Only that: it runs beside
 * an open issue's loader, never before it, and once a visit, as the words
 * don't change with the issue.
 */
export async function loader({ context }: LoaderFunctionArgs) {
    return { i18n: await routeI18n(context, 'issues') };
}
export const shouldRevalidate = revalidateOn({ search: false });

/** The board; an open issue (the child route) comes with its loader's data. */
export default function IssuesRoute() {
    const issue = useRouteLoaderData<typeof issueLoader>('issues:issue');
    return <IssuesPage openIssue={issue ?? undefined} />;
}
