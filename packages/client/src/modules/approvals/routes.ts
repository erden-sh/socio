import { layout, route } from '@react-router/dev/routes';

export default layout('modules/approvals/gate.route.tsx', { id: 'module:approvals' }, [
    route('approvals', 'modules/approvals/ApprovalsPage.route.tsx', {
        id: 'approvals',
    }),
    route('approvals/:approvalId', 'modules/approvals/ApprovalRequestPage.route.tsx', { id: 'approvals:request' }),
]);
