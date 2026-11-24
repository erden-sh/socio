import { layout, route } from '@react-router/dev/routes';

export default layout('modules/activity/gate.route.tsx', { id: 'module:activity' }, [
    route('activity', 'modules/activity/ActivityPage.route.tsx', {
        id: 'activity',
    }),
]);
