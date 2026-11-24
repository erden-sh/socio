import { MessageCircle } from 'lucide-react';

import { MODULE_IDS } from '@socio/shared/modules';
import { roomsOn, shownChats } from '@socio/shared/rooms/room-view';

import { Mascot } from '../../locals/Mascot';
import { RoomsGroup } from '../rooms/RoomsNav';
import type { ClientModule, PaletteCommand } from '../types';

import { ChatIcon, dotPath, DotsGroup, newChatPath, RecentChatsGroup, RECENT_CHATS } from './nav';

/** Chat: the Dots, new chats and conversations. */
export const chatModule: ClientModule = {
    id: MODULE_IDS.chat,
    title: 'Chat',
    description: 'Start a conversation with one of your socios.',
    icon: MessageCircle,
    tone: 'mint',
    order: 10,
    opens: ({ homeDot }) => ({ path: newChatPath(homeDot) }),
    navGroups: [
        { order: 10, component: DotsGroup },
        { order: 30, component: RecentChatsGroup },
        // Rooms (CB-212): only while Settings → Rooms is on.
        { order: 35, component: RoomsGroup },
    ],
    commands: ({ workspace, state }) => [
        ...workspace.dots
            .filter((dot) => !dot.archivedAt)
            .map((dot): PaletteCommand => ({
                id: `dot:${dot.id}`,
                label: `New chat with ${dot.name}`,
                group: 'Socios',
                keywords: [dot.name, 'new', 'chat', 'message'],
                icon: ({ className }) => (
                    <Mascot
                        identity={dot.id}
                        character={dot.character}
                        name={dot.name}
                        small
                        decorative
                        className={className}
                    />
                ),
                run: ({ navigate }) => navigate(newChatPath(dot)),
            })),
        // A Dot's home page (CB-89), by its name: its chats follow, as their
        // hint is its name.
        ...workspace.dots
            .filter((dot) => !dot.archivedAt)
            .map((dot): PaletteCommand => ({
                id: `dot-home:${dot.id}`,
                label: dot.name,
                group: 'Socios',
                keywords: ['home', 'chats', 'goals', 'schedules'],
                icon: ({ className }) => (
                    <Mascot
                        identity={dot.id}
                        character={dot.character}
                        name={dot.name}
                        small
                        decorative
                        className={className}
                    />
                ),
                searchOnly: true,
                run: ({ navigate }) => navigate(dotPath(dot)),
            })),
        ...shownChats(workspace.conversations, state).map((thread, index): PaletteCommand => ({
            id: `chat:${thread.id}`,
            label: thread.title,
            group: thread.kind === 'room' && roomsOn(state) ? 'Rooms' : 'Recent chats',
            hint: workspace.dots.find((dot) => dot.id === thread.dotId)?.name,
            keywords: ['chat', 'conversation'],
            icon: ({ className }) => <ChatIcon thread={thread} className={className} />,
            searchOnly: index >= RECENT_CHATS,
            run: ({ navigate }) => navigate(`/chats/${encodeURIComponent(thread.id)}`),
        })),
    ],
};
