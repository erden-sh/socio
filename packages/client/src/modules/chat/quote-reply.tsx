import type { Message } from '@ag-ui/core';
import { Reply, X } from 'lucide-react';
import { useCallback } from 'react';

import {
    type Quote,
    QUOTED_COMMAND_NOTE,
    quotedCommand,
    REMOVE_QUOTE,
    replyAuthor,
    replyingTo,
    splitQuote,
    withQuote,
} from '@socio/shared/chat/quote-reply';
import type { RoomView } from '@socio/shared/rooms/rooms';
import { messageAuthor } from '@socio/shared/runs/socio-fields';
import type { Conversation, MessageAuthor } from '@socio/shared/types';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

// Quote-reply on the web (CB-571): the app's format and rules, from
// @socio/shared/chat/quote-reply, so a message written on either looks the
// same on both. Reply, first in a message's action row, puts a quote of the
// message in front of the chat's or room's draft; the composer shows it as a
// chip over the box, and the box only the words after it.

/** A private chat's composer can't send there: a team topic, or a chat from Telegram. */
export const chatTakesReplies = (thread: Pick<Conversation, 'team' | 'source'>) =>
    !thread.team && thread.source !== 'telegram';

/**
 * Who a quote of `message` names, or null where Reply isn't offered (shared's
 * `replyAuthor`): in a private chat only the socio's replies; in a room the
 * socio's replies by their socio, and every person's message, the reader's
 * own by their name in the room. A reply still being written has none.
 */
export function messageReplyAuthor(
    message: Message & { author?: MessageAuthor },
    text: string,
    context: {
        /** The socio a reply is from: the chat's, or a room message's (`replySocio`). */
        readonly socio: string | null;
        readonly streaming?: boolean;
        /** A room: its view and the reader's id. */
        readonly room?: { readonly view: RoomView | null; readonly me: string };
    },
): string | null {
    if (message.role !== 'user' && message.role !== 'assistant') {
        return null;
    }
    const author = message.role === 'user' ? messageAuthor(message) : undefined;
    return replyAuthor(
        {
            kind: message.role === 'user' ? 'user' : 'reply',
            text,
            streaming: context.streaming,
            ...(context.room && message.role === 'user'
                ? {
                      speaker:
                          author && !author.you ? { kind: 'person', name: author.name } : { kind: 'you', name: 'You' },
                  }
                : {}),
        },
        { socio: context.socio, ...(context.room ? { room: context.room } : {}) },
    );
}

/** What a transcript needs for Reply: who a message's quote names (null: no Reply), and the quote's way to the draft. */
export interface ReplyTo {
    author: (message: Message & { author?: MessageAuthor }, text: string, streaming: boolean) => string | null;
    quote: (author: string, text: string) => void;
}

type SetText = (next: string | ((current: string) => string)) => void;

/**
 * A draft whose text may start with a quote: the quote for the chip, the
 * words after it for the box, a setter for those words that keeps the
 * quote, and the chip's x.
 */
export function useQuotedDraft(text: string, setDraft: SetText) {
    const { quote, rest } = splitQuote(text);
    const setText = useCallback<SetText>(
        (next) =>
            setDraft((current) => {
                const split = splitQuote(current);
                return withQuote(split.quote, typeof next === 'function' ? next(split.rest) : next);
            }),
        [setDraft],
    );
    const removeQuote = useCallback(() => setDraft((current) => splitQuote(current).rest), [setDraft]);
    return { quote, text: rest, setText, removeQuote, command: quotedCommand(quote, rest) };
}

/**
 * The quote over the composer's box: "Replying to <author>", a line of the
 * message, and an x ("Remove quote") that takes it out of the draft. While
 * the words typed start with `/`, a note under it says a command doesn't
 * run in a reply, announced as it appears.
 */
export function QuoteChip({
    quote,
    command,
    onRemove,
}: {
    quote: Quote | null;
    command: boolean;
    onRemove: () => void;
}) {
    return (
        <>
            {quote && (
                <div
                    data-slot="quote-chip"
                    className="mt-1 mb-0.5 flex items-center gap-2 rounded-[14px] bg-muted py-1 pr-1 pl-3 text-xs"
                >
                    <Reply size={14} className="shrink-0 text-muted-foreground" aria-hidden />
                    <div className="min-w-0 flex-1">
                        <p className="m-0 truncate font-medium text-foreground" data-slot="quote-chip-author">
                            {replyingTo(quote.author)}
                        </p>
                        <p className="m-0 truncate text-muted-foreground" data-slot="quote-chip-excerpt">
                            {quote.excerpt}
                        </p>
                    </div>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="shrink-0 text-muted-foreground hover:text-foreground pointer-coarse:size-11"
                        aria-label={REMOVE_QUOTE}
                        onClick={onRemove}
                    >
                        <X />
                    </Button>
                </div>
            )}
            {/* Always there, so a screen reader hears the note as it appears. */}
            <p
                role="status"
                data-slot="quote-command-note"
                className="m-0 px-1 text-[11px]/[1.6] text-muted-foreground empty:hidden"
            >
                {quote && command ? QUOTED_COMMAND_NOTE : ''}
            </p>
        </>
    );
}

/** Reply, first in a message's action row: its quote goes over the composer. */
export function ReplyButton({ onReply }: { onReply: () => void }) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label="Reply"
                    data-message-reply=""
                    onClick={onReply}
                >
                    <Reply />
                </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Reply</TooltipContent>
        </Tooltip>
    );
}
