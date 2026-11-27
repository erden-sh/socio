import { chatDraft } from '../sync/chat-drafts';

// Quote-reply (CB-571): the quote's format, its escaping and who it names live
// in @socio/shared/chat/quote-reply, which the web uses too, so a message
// written on either looks the same on both. The app's draft also carries the
// quote in its text (the prefix and its blank line), so it survives leaving
// the chat and a relaunch with no change to the drafts' payload (still
// version 1: an older build shows the blockquote as text in its box), an Edit
// of a waiting message brings it back as a quote, and the send's existing
// `enqueueFromDraft` takes it with the rest. Here: the draft a Reply writes
// to. No React Native here: tests/chat runs it under Node.

export {
    excerptOf,
    inertQuoteText,
    plainOf,
    QUOTE_EXCERPT_MAX,
    QUOTED_COMMAND_NOTE,
    type Quote,
    quotedCommand,
    quotedDraft,
    quoteOf,
    quoting,
    REMOVE_QUOTE,
    replyAuthor,
    replyingTo,
    spokenMessage,
    splitQuote,
    withQuote,
} from '@socio/shared/chat/quote-reply';

/**
 * The draft a Reply writes to, or null where the chat has no box: a Telegram chat's or a team
 * topic's has a read-only line instead (though `sendableChatId` still names it), as does a
 * read-only room.
 */
export function replyBox(composer: {
    readonly sendTo: string | null;
    readonly roomId: string | null;
    readonly readOnly: string | null;
}): string | null {
    if (composer.readOnly !== null) {
        return null;
    }
    const target = composer.sendTo ?? composer.roomId;
    return target === null ? null : chatDraft(target);
}
