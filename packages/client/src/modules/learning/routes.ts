import { layout, route } from '@react-router/dev/routes';

export default layout('modules/learning/gate.route.tsx', { id: 'module:learning' }, [
    route('learning', 'modules/learning/LearningPage.route.tsx', {
        id: 'learning',
    }),
]);
