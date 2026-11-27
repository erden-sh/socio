import { useTranslation } from '@socio/i18n/react';
import type { Conversation, Dot } from '@socio/shared/types';

import { ConfirmDelete } from '../../components/confirm-delete';
import { onDemand } from '../../i18n/on-demand';

import { newChatDraft, chatDraft } from './chat-drafts';

/** Where a draft is: a chat (by its title), a socio's new-chat box, or a chat no longer listed. */
export type DraftPlace = { kind: 'chat'; title: string } | { kind: 'new-chat'; socio: string } | { kind: 'unknown' };

/** Where each draft is: the chat's title, or the socio's new-chat box. */
export function draftPlaces(
    scopes: readonly string[],
    chats: readonly Conversation[],
    dots: readonly Dot[],
): DraftPlace[] {
    return scopes.map((scope) => {
        const chat = chats.find((item) => chatDraft(item.id) === scope);
        if (chat) {
            return { kind: 'chat', title: chat.title };
        }
        const dot = dots.find((item) => newChatDraft(item.id) === scope);
        return dot ? { kind: 'new-chat', socio: dot.name } : { kind: 'unknown' };
    });
}

/** How many places the warning names before "and N more". */
const PLACES_NAMED = 3;

/**
 * Before signing out with drafts less than a day old (CB-171): how many,
 * and in which chats. Cancel keeps them; Sign out anyway clears them.
 */
function UnsentDraftsWarningBody({
    places,
    onCancel,
    onSignOut,
}: {
    places: readonly DraftPlace[];
    onCancel: () => void;
    onSignOut: () => Promise<void>;
}) {
    const { t } = useTranslation(['chat.drafts']);
    const count = places.length;
    const more = count - PLACES_NAMED;
    const place = (item: DraftPlace) =>
        item.kind === 'chat'
            ? item.title || t('chat.drafts:place.untitled')
            : item.kind === 'new-chat'
              ? t('chat.drafts:place.new-chat', { socio: item.socio })
              : t('chat.drafts:place.unknown');
    const named = places.slice(0, PLACES_NAMED).map(place);
    return (
        <ConfirmDelete
            title={t('chat.drafts:title')}
            slot="unsent-drafts-warning"
            action={t('chat.drafts:sign-out')}
            onClose={onCancel}
            onConfirm={onSignOut}
        >
            {t('chat.drafts:body', {
                count,
                places: more > 0 ? [...named, t('chat.drafts:more', { count: more })] : named,
            })}
        </ConfirmDelete>
    );
}

/** The warning, once its words are in (chat.drafts loads when it opens). */
export const UnsentDraftsWarning = onDemand(['chat.drafts'], UnsentDraftsWarningBody);
