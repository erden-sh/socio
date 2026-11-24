import type { Conversation, Dot } from '@socio/shared/types';

import { ConfirmDelete } from '../../components/confirm-delete';

import { newChatDraft, chatDraft } from './chat-drafts';

/** Where each draft is, by name: the chat's title, or the socio's new-chat box. */
export function draftPlaces(scopes: readonly string[], chats: readonly Conversation[], dots: readonly Dot[]): string[] {
    return scopes.map((scope) => {
        const chat = chats.find((item) => chatDraft(item.id) === scope);
        if (chat) {
            return chat.title || 'Untitled chat';
        }
        const dot = dots.find((item) => newChatDraft(item.id) === scope);
        return dot ? `a new chat with ${dot.name}` : 'a chat';
    });
}

/** How many places the warning names before "and N more". */
const PLACES_NAMED = 3;

/**
 * Before signing out with drafts less than a day old (CB-171): how many,
 * and in which chats. Cancel keeps them; Sign out anyway clears them.
 */
export function UnsentDraftsWarning({
    places,
    onCancel,
    onSignOut,
}: {
    places: string[];
    onCancel: () => void;
    onSignOut: () => Promise<void>;
}) {
    const count = places.length;
    const named = places.slice(0, PLACES_NAMED).join(', ');
    const more = count - PLACES_NAMED;
    return (
        <ConfirmDelete
            title="Sign out with unsent drafts?"
            slot="unsent-drafts-warning"
            action="Sign out anyway"
            onClose={onCancel}
            onConfirm={onSignOut}
        >
            You have {count === 1 ? '1 unsent draft' : `${count} unsent drafts`}, from the last day, in{' '}
            {more > 0 ? `${named}, and ${more} more` : named}. Signing out clears {count === 1 ? 'it' : 'them'}.
        </ConfirmDelete>
    );
}
