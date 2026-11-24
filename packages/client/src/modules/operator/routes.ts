import { layout, route } from '@react-router/dev/routes';

export default layout('modules/operator/gate.route.tsx', { id: 'module:operator' }, [
    route('settings/operator', 'modules/operator/OperatorPage.route.tsx', {
        id: 'operator',
    }),
    route('settings/operator/backends/:backendId', 'modules/operator/BackendEditor.route.tsx', {
        id: 'operator-backend',
    }),
]);
