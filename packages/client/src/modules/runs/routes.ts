import { layout, route } from '@react-router/dev/routes';

export default layout('modules/runs/gate.route.tsx', { id: 'module:runs' }, [
    route('runs', 'modules/runs/RunsPage.route.tsx', { id: 'runs' }),
]);
