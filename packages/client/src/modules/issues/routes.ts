import { index, layout, route } from '@react-router/dev/routes';

// The board stays mounted while `/issues/CB-12` opens one issue.
export default layout('modules/issues/gate.route.tsx', { id: 'module:issues' }, [
    route('issues', 'modules/issues/IssuesPage.route.tsx', { id: 'issues' }, [
        index('views/Empty.route.tsx', { id: 'issues:index' }),
        route(':issueKey', 'modules/issues/IssueKey.route.tsx', {
            id: 'issues:issue',
        }),
    ]),
]);
