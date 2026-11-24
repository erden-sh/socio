import { layout, route } from '@react-router/dev/routes';

export default layout('modules/chat/gate.route.tsx', { id: 'module:chat' }, [
    // A Dot's home page (CB-89); a new chat with it is under it.
    route('dots/:dotId', 'modules/chat/DotHome.route.tsx', {
        id: 'chat:dot-home',
    }),
    route('dots/:dotId/new', 'modules/chat/DotChat.route.tsx', {
        id: 'chat:dot',
    }),
    // Its Soul, every version (CB-179).
    route('dots/:dotId/soul', 'modules/chat/SoulPage.route.tsx', {
        id: 'chat:dot-soul',
    }),
    route('chats/:threadId', 'modules/chat/ChatThread.route.tsx', {
        id: 'chat:thread',
    }),
]);
