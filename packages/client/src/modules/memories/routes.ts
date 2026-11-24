import { layout, route } from '@react-router/dev/routes';

export default layout('modules/memories/gate.route.tsx', { id: 'module:memories' }, [
    route('memories', 'modules/memories/MemoriesPage.route.tsx', {
        id: 'memories',
    }),
]);
