import { layout, route } from '@react-router/dev/routes';

export default layout('modules/dots/gate.route.tsx', { id: 'module:dots' }, [
    route('admin/dots', 'modules/dots/DotsAdmin.route.tsx', { id: 'admin-dots' }),
    route('admin/dots/:dotId', 'modules/dots/DotsAdmin.route.tsx', {
        id: 'admin-dot',
    }),
]);
