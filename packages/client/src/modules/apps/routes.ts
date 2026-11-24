import { layout, route } from '@react-router/dev/routes';

export default layout('modules/apps/gate.route.tsx', { id: 'module:apps' }, [
    route('apps', 'modules/apps/AppsPage.route.tsx', { id: 'apps' }),
    route('apps/:appId/open', 'modules/apps/AppOpenPage.route.tsx', {
        id: 'apps:open',
    }),
]);
