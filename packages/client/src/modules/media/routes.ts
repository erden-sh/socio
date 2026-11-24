import { layout, route } from '@react-router/dev/routes';

export default layout('modules/media/gate.route.tsx', { id: 'module:media' }, [
    route('media', 'modules/media/MediaPage.route.tsx', { id: 'media' }),
]);
