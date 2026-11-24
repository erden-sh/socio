import { useState, useSyncExternalStore } from 'react';

import type { Conversation } from '@socio/shared/types';

import { outboxStateStore } from '../chat/composer';
import { type NotSaved, notSaved, withChatWrites } from '../chat/long-press';
import { useCollections, useLiveQuery, useWorkspaceScope } from '../live';
import { chatsQuery } from '../shell/queries';
import { CHAT_MANAGE_VIEWS } from '../sync/chat-manage';
import { overlaysOf } from '../sync/outbox-overlay';
import { ROOM_READ_VIEW } from '../sync/room-send';

// The scope's chats with this device's renames, archives and deletes laid
// over (`withChatWrites`): what the chat list, Home, Search and the
// chat's header show, so each shows at once, offline too, until the server
// has it (or refuses it, and the row goes back: the chat list says so, with
// Retry and Discard, `useChatWrites`'s `refused`). A room's read mark
// clears its unread count the same way.

/** The writes laid over the chat rows: renames, archives and deletes, and rooms' read marks. */
const CHAT_LIST_VIEWS = [...CHAT_MANAGE_VIEWS, ROOM_READ_VIEW];

export function useShownChats(): Conversation[] {
    return useChatWrites().chats;
}

/** The shown chats, and the renames, archives and deletes the server refused (`notSaved`), named as it has them. */
export function useChatWrites(): { chats: Conversation[]; refused: NotSaved[] } {
    const collections = useCollections();
    const { outbox } = useWorkspaceScope();
    const { data: chats } = useLiveQuery({ query: chatsQuery(collections) });
    const [store] = useState(() => outboxStateStore(outbox));
    const writes = useSyncExternalStore(store.subscribe, store.get);
    const overlays = overlaysOf({ rows: writes.rows, unsent: writes.unsent, kinds: CHAT_LIST_VIEWS, scope: outbox });
    return { chats: withChatWrites(chats, overlays), refused: notSaved(overlays, { chats }) };
}
