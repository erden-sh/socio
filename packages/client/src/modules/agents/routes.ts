import { layout, route } from '@react-router/dev/routes';

export default layout('modules/agents/gate.route.tsx', { id: 'module:connected-agents' }, [
    route('admin/agents', 'modules/agents/AgentsAdmin.route.tsx', {
        id: 'admin-agents',
    }),
]);
