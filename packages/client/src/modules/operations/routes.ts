import { layout, route } from '@react-router/dev/routes';

export default layout('modules/operations/gate.route.tsx', { id: 'module:operations' }, [
    route('operations', 'modules/operations/Operations.route.tsx', {
        id: 'operations',
    }),
    route('operations/:section', 'modules/operations/Operations.route.tsx', {
        id: 'operations:section',
    }),
    route('operations/chats/:threadId', 'modules/operations/Transcript.route.tsx', { id: 'operations:chat' }),
]);
