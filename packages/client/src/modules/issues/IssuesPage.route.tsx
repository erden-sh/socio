import { useRouteLoaderData } from 'react-router';

import type { loader as issueLoader } from './IssueKey.route';
import { IssuesPage } from './IssuesPage';

/** The board; an open issue (the child route) comes with its loader's data. */
export default function IssuesRoute() {
    const issue = useRouteLoaderData<typeof issueLoader>('issues:issue');
    return <IssuesPage openIssue={issue ?? undefined} />;
}
