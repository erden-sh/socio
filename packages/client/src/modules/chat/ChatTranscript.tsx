import type { AssistantMessage, Message, ToolCall } from '@ag-ui/core';
import { CircleAlert, PhoneOff } from 'lucide-react';
import { Fragment, useEffect, type ReactNode } from 'react';

import { isApprovalNote } from '@socio/shared/approvals';
import { contentText } from '@socio/shared/chat/content-text';
import { attachmentRefs } from '@socio/shared/media/refs';
import { messageAt, messageAuthor } from '@socio/shared/runs/socio-fields';
import type { TraceTimes } from '@socio/shared/runs/trace-times';
import { splitTurns, turnSteps } from '@socio/shared/runs/turn-steps';
import type { CallReceipt, MessageAuthor } from '@socio/shared/types';
import { voiceReceiptMessagePrefix } from '@socio/shared/voice/voice-receipt';

import { withoutPageLine } from '../pages/page-context';
import { recordRender } from '../settings/performance/recorder';

import { MessageAttachments, type AttachmentPart } from './attachments/MessageAttachments';
import { Markdown } from './ChatMarkdown';
import { MessageActions } from './MessageActions';
import { MessageReactions, ReportTranscript, hasReactions } from './MessageReactions';
import type { ReplyTo } from './quote-reply';
import { SkillChip, useSkillSplit } from './SkillMenu';
import { TurnTrace } from './trace/TurnTrace';
import type { ReactionsApi } from './use-reactions';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// These markers only control rendering; they do not confer trust or permissions.
export function isInternalVoiceReceipt(message: Message): boolean {
    const metadata = message.metadata;
    return (
        message.role === 'user' &&
        (message.id.startsWith(voiceReceiptMessagePrefix) ||
            (!!metadata &&
                typeof metadata === 'object' &&
                'socioSource' in metadata &&
                metadata.socioSource === 'voice_receipt'))
    );
}
/**
 * Prompts the server writes for the Dot, never shown as the user's: voice
 * receipts and the note a turn carrying on after an approval starts with.
 */
export function isInternalNote(message: Message): boolean {
    return isInternalVoiceReceipt(message) || (message.role === 'user' && isApprovalNote(message));
}
function Receipt({ call }: { call: CallReceipt }) {
    return (
        <div className="flex max-w-[85%] flex-wrap items-center gap-[7px] self-end rounded-[12px_12px_4px_12px] bg-[#e5f1ef] px-[13px] py-2.5 text-[10px] text-[#6e9d98] dark:bg-[#252a2a] dark:text-[#7dada8]">
            <PhoneOff size={13} />
            <span>
                {call.status === 'failed'
                    ? 'Call failed'
                    : call.endedAt
                      ? `${Math.round((call.endedAt - call.startedAt) / 1000)}s · Call ended`
                      : 'Call in progress'}
            </span>
            {call.error && (
                <small className="basis-full text-[12px] leading-[1.7] text-[#ab9189] dark:text-[#b59b93]">
                    {call.error}
                </small>
            )}
        </div>
    );
}
/**
 * A message's text and attachment references (CB-54): plain content as
 * it is; for an array, its text parts joined and its references.
 */
export function messageParts(content: unknown): {
    text: string;
    attachments: AttachmentPart[];
} {
    if (typeof content === 'string') {
        return { text: content, attachments: [] };
    }
    if (!Array.isArray(content)) {
        return { text: '', attachments: [] };
    }
    return {
        text: content
            .filter(
                (part): part is { type: 'text'; text: string } =>
                    part?.type === 'text' && typeof part.text === 'string',
            )
            .map((part) => part.text)
            .join('\n'),
        attachments: attachmentRefs(content),
    };
}
export { thoughtLabel } from '@socio/shared/runs/turn-steps';

/**
 * How a message shows (CB-66): a Dot's reply as full-width text, the
 * reader's own message as a bubble on the right, and in a team transcript
 * another person's as a bubble on the left with their name above it.
 */
function kind(message: Message & { author?: MessageAuthor }) {
    if (message.role === 'assistant') {
        return 'assistant';
    }
    const author = messageAuthor(message);
    return author && !author.you ? 'other' : 'user';
}

/*
 * A message's Markdown. The rules have no more weight than the element
 * they style (`:where`), so a part with classes of its own (an issue card,
 * a card stack's list) keeps them.
 */
const prose =
    'text-[14px] leading-[1.75] [overflow-wrap:anywhere] [:where(&)_p]:mt-0 [:where(&)_p]:mb-3 [:where(&)_p]:leading-[1.95] [:where(&)_p:last-child]:m-0 [:where(&)_a]:underline [:where(&)_a]:underline-offset-3 [:where(&)_pre]:max-w-full [:where(&)_pre]:overflow-x-auto [:where(&)_pre]:rounded-[8px] [:where(&)_pre]:bg-[#efeff2] [:where(&)_pre]:p-[13px] [:where(&)_pre]:whitespace-pre [:where(&)_pre]:[overflow-wrap:normal] dark:[:where(&)_pre]:bg-[#282829] [:where(&)_blockquote]:mt-0 [:where(&)_blockquote]:mb-2 [:where(&)_blockquote]:border-l-[3px] [:where(&)_blockquote]:border-current/25 [:where(&)_blockquote]:pl-3 [:where(&)_blockquote_p]:mb-0';
const links = '[:where(&)_a]:text-chat-link';
const bodyClass = {
    // A Dot's reply: full-width text, no bubble.
    assistant: cn(
        prose,
        links,
        'max-w-full self-stretch px-[3px] py-1.5 text-[#373737] dark:text-[#dadada] [:where(&)_:is(h1,h2,h3)]:text-[16px] [:where(&)_:is(h1,h2,h3)]:leading-[1.5] [:where(&)_:is(ul,ol)]:pl-4.5',
    ),
    user: cn(
        prose,
        // A border the pending look shows (`pending`), a pixel off the padding
        // so the bubble keeps its size as it changes.
        'max-w-[80%] self-end rounded-[17px_17px_5px_17px] border border-transparent bg-user-bubble px-[15px] py-2.5 text-user-bubble-foreground max-[700px]:px-[13px] max-[700px]:py-[9px] [:where(&)_a]:text-user-bubble-foreground',
        // Pending until the server has it (`MessageDelivery`).
        'transition-colors duration-300 motion-reduce:transition-none',
        'in-data-delivery:border-dashed in-data-delivery:border-user-bubble-pending-border in-data-delivery:bg-user-bubble-pending in-data-delivery:text-foreground in-data-delivery:[:where(&)_a]:text-chat-link',
    ),
    other: cn(
        prose,
        links,
        'max-w-[80%] self-start rounded-[17px_17px_17px_5px] border border-transparent bg-muted px-[15px] py-2.5 text-foreground max-[700px]:px-[13px] max-[700px]:py-[9px]',
    ),
};

/*
 * A message not with the socio yet (CB-154's sending, CB-151's queue, a
 * room's "is reading this"): a dashed outline on a lighter tint of its
 * bubble, its words at full contrast, with the line under it that says
 * where it is. Never faded: faded words fell under 3:1.
 */
const pending = {
    user: 'border-dashed border-user-bubble-pending-border bg-user-bubble-pending text-foreground [:where(&)_a]:text-chat-link',
    other: 'border-dashed border-muted-foreground bg-muted/50',
};

/** The reader's own bubble. */
export const userBubble = bodyClass.user;
/** Another person's bubble (a room's, CB-212). */
export const otherBubble = bodyClass.other;
/** The reader's own message waiting: queued (CB-151) or being read. */
export const pendingUserBubble = cn(userBubble, pending.user);
/** Another person's queued message, for a room admin (CB-215). */
export const pendingOtherBubble = cn(otherBubble, pending.other);

/**
 * Where a message of yours stands until the server has it (CB-154):
 * `sending`, pending (dashed, on a light tint), until its turn starts;
 * `failed`, never taken (the server refused it, or you stopped it), with
 * Retry and Edit under it where its action row goes. The bubble keeps its place and size
 * throughout, so nothing moves when the state changes. A message waiting
 * its turn (CB-151's queue) fits the same look, with a word in the
 * action row.
 */
export type MessageDelivery =
    | { status: 'sending' }
    | {
          status: 'failed';
          /**
           * Undefined while it can't be sent (a turn is running). Focus goes
           * to the composer, as Retry goes.
           */
          onRetry?: () => void;
          /** Takes it back to the composer. */
          onEdit: () => void;
      };

/**
 * The conversation (CB-66), turn by turn (CB-72): the person's message,
 * the Dot's work folded into one line ("Worked for 34s · 5 steps", open
 * while the turn runs), then its reply and any cards that need the reader.
 */
export function ChatTranscript({
    messages,
    calls,
    renderTools,
    streamingId,
    dotName,
    times,
    running = false,
    isCard,
    traceExtra,
    reactions,
    delivery,
    speaker,
    after,
    notice,
    reply,
}: {
    /**
     * In a team transcript, user messages carry their `author`, and each
     * message its time (`at`). Tool results (role `tool`) go to their steps.
     */
    messages: Array<Message & { author?: MessageAuthor; at?: number }>;
    calls: CallReceipt[];
    /** The cards of an assistant message: its calls `isCard` picks. */
    renderTools?: (message: AssistantMessage) => ReactNode;
    /** The message the model is still writing, if any. */
    streamingId?: string;
    /** Each reply's heading for screen readers (the header shows it too). */
    dotName?: string;
    /** When things happened (CB-72): message times, how long steps took. */
    times?: TraceTimes;
    /** A turn is running: the last one. */
    running?: boolean;
    /** Calls shown as their own card (approvals, page reviews), not as steps. */
    isCard?: (call: ToolCall) => boolean;
    /** Shown in an open trace, from its turn's calls (the computer's screen). */
    traceExtra?: (calls: ToolCall[]) => ReactNode;
    /** Reactions on the Dot's messages (CB-133); none when not loaded. */
    reactions?: ReactionsApi;
    /** Your messages the server doesn't have yet, by id (CB-154). */
    delivery?: ReadonlyMap<string, MessageDelivery>;
    /**
     * Who wrote each message, above it (a room's avatars and labels,
     * CB-212); in place of a team transcript's name line.
     */
    speaker?: (message: Message & { author?: MessageAuthor }) => ReactNode;
    /**
     * What follows a message, before the next (a room's note that a turn
     * after it was refused or failed, CB-212).
     */
    after?: (message: Message) => ReactNode;
    /**
     * A line shown in a message's place, when it is no one's message (a
     * room's handoff between socios, CB-206); undefined: the message.
     */
    notice?: (message: Message) => ReactNode | undefined;
    /** Reply on the messages that can be quoted (CB-571); none: no Reply anywhere. */
    reply?: ReplyTo;
}) {
    useEffect(() => recordRender('transcript'));
    const ids = new Set(messages.filter((message) => !isInternalNote(message)).map((message) => message.id));
    const results = new Map<string, string>();
    for (const message of messages) {
        if (message.role === 'tool') {
            results.set(message.toolCallId, contentText(message.content));
        }
    }
    const turns = splitTurns(messages);
    return (
        <ReportTranscript.Provider value={{ messages }}>
            {calls
                .filter((call) => !call.anchorMessageId || !ids.has(call.anchorMessageId))
                .map((call) => (
                    <Receipt key={call.id} call={call} />
                ))}
            {turns.map((turn, index) => {
                const live = running && index === turns.length - 1;
                const steps = turnSteps(turn, { results, times, streamingId, isCard });
                // The trace goes before the turn's first message from the Dot.
                const traceAt = turn.findIndex((message) => message.role !== 'user');
                const start = turn[0].role === 'user' ? times?.messages.get(turn[0].id) : undefined;
                return turn.map((message, position) => (
                    <Fragment key={message.id}>
                        {position === traceAt && steps.length > 0 && (
                            <TurnTrace
                                steps={steps}
                                live={live}
                                start={start}
                                extra={traceExtra?.(steps.flatMap((step) => (step.kind === 'tool' ? [step.call] : [])))}
                            />
                        )}
                        {ids.has(message.id) &&
                            (notice?.(message) ?? (
                                <MessageView
                                    message={message}
                                    // Only a reply is written as it shows: your message keeps
                                    // its action row from the start (CB-154).
                                    streaming={message.id === streamingId && message.role !== 'user'}
                                    at={times?.messages.get(message.id) ?? messageAt(message)}
                                    dotName={dotName}
                                    reactions={reactions}
                                    delivery={delivery?.get(message.id)}
                                    speaker={speaker}
                                    reply={reply}
                                />
                            ))}
                        {message.role === 'assistant' &&
                            renderTools &&
                            isCard &&
                            message.toolCalls?.some(isCard) &&
                            renderTools({
                                ...message,
                                toolCalls: message.toolCalls.filter(isCard),
                            })}
                        {calls
                            .filter((call) => call.anchorMessageId === message.id)
                            .map((call) => (
                                <Receipt key={call.id} call={call} />
                            ))}
                        {after?.(message)}
                    </Fragment>
                ));
            })}
        </ReportTranscript.Provider>
    );
}

/** A user message's bubble, or a Dot's reply, with its action row. */
function MessageView({
    message,
    streaming,
    at,
    dotName,
    reactions,
    delivery,
    speaker,
    reply,
}: {
    message: Message & { author?: MessageAuthor };
    streaming: boolean;
    at?: number;
    dotName?: string;
    reactions?: ReactionsApi;
    delivery?: MessageDelivery;
    speaker?: (message: Message & { author?: MessageAuthor }) => ReactNode;
    reply?: ReplyTo;
}) {
    const parts = messageParts(message.content);
    const { attachments } = parts;
    // Older page chats' messages start with their page, which the banner
    // shows already (CB-158): never in the bubble.
    const text = message.role === 'user' ? withoutPageLine(parts.text) : parts.text;
    // A skill the person invoked shows as a chip (CB-143); one that starts
    // with a quote-reply's quote is never a command (`invokedSkill`).
    const invoked = useSkillSplit(message.role === 'user' ? text : '');
    // Who a quote of it names, where it can be quoted (CB-571).
    const replyAuthor = reply && !delivery ? reply.author(message, text, streaming) : null;
    if (message.role !== 'user' && message.role !== 'assistant') {
        return null;
    }
    if (!text.trim() && !attachments.length) {
        return null;
    }
    return (
        <div
            className={cn(
                'group/message flex min-w-0 flex-col gap-0.5',
                kind(message) === 'user' ? 'items-end' : 'items-start',
            )}
            // Not a data-slot: the legacy resets (lists, headings)
            // stop at data-slot elements.
            data-chat-message={kind(message)}
            // What a link to the turn scrolls to (`#message-<id>`).
            data-message-id={message.id}
            data-delivery={delivery?.status}
        >
            {message.role === 'assistant' && dotName && <h2 className="sr-only">{dotName}</h2>}
            {speaker
                ? speaker(message)
                : kind(message) === 'other' && (
                      <span className="px-1 text-[12px] font-medium text-muted-foreground" data-chat-author>
                          {messageAuthor(message)!.name}
                      </span>
                  )}
            <div className={bodyClass[kind(message)]} data-chat-body={kind(message)}>
                {invoked ? (
                    <>
                        <SkillChip name={invoked.skill.name} className={invoked.rest ? 'mb-1' : undefined} />
                        {invoked.rest && (
                            <Markdown onBubble={kind(message) === 'user' && !delivery}>
                                {withoutPageLine(invoked.rest)}
                            </Markdown>
                        )}
                    </>
                ) : (
                    text.trim() && (
                        <Markdown
                            reply={message.role === 'assistant'}
                            // Pending, it is dark words on a light tint (`pending`).
                            onBubble={kind(message) === 'user' && !delivery}
                        >
                            {text}
                        </Markdown>
                    )
                )}
                <MessageAttachments parts={attachments} />
            </div>
            {delivery && (
                // Said once, as it fails (CB-154).
                <span className="sr-only" aria-live="polite">
                    {delivery.status === 'failed' ? `Your message “${excerpt(text)}” wasn’t sent.` : ''}
                </span>
            )}
            {delivery?.status === 'failed' ? (
                <NotSent delivery={delivery} excerpt={excerpt(text)} />
            ) : (
                /* Not while the Dot is still writing it (T3 Code). */
                text.trim() &&
                !streaming && (
                    <MessageActions
                        text={text}
                        at={at}
                        pinned={message.role === 'assistant' && hasReactions(reactions, message.id)}
                        onReply={replyAuthor === null ? undefined : () => reply?.quote(replyAuthor, text)}
                    >
                        {message.role === 'assistant' && reactions && (
                            <MessageReactions messageId={message.id} reactions={reactions} />
                        )}
                    </MessageActions>
                )
            )}
        </div>
    );
}

/** A message's start, for a screen reader: “Please file this…”. */
function excerpt(text: string) {
    const line = text.replace(/\s+/g, ' ').trim();
    return line.length > 40 ? `${line.slice(0, 39)}…` : line;
}

/**
 * In the action row's place under a message the server never took
 * (CB-154): as tall, so the bubble doesn't move; a finger gets 40px
 * buttons, as there.
 */
function NotSent({
    delivery,
    excerpt,
}: {
    delivery: Extract<MessageDelivery, { status: 'failed' }>;
    /** The message's start, in the buttons' names. */
    excerpt: string;
}) {
    const action =
        'h-6 px-1.5 text-[11px] font-medium text-foreground pointer-coarse:min-h-10 aria-disabled:cursor-not-allowed aria-disabled:opacity-50';
    const { onRetry } = delivery;
    return (
        <div className="flex min-h-6 items-center gap-0.5 text-[11px] text-destructive" data-slot="message-not-sent">
            <CircleAlert size={13} className="mr-1 shrink-0" aria-hidden />
            <span className="mr-1">Not sent</span>
            <Button
                type="button"
                variant="ghost"
                size="xs"
                className={action}
                aria-label={`Retry “${excerpt}”`}
                // Focusable, and says why, while it can't be sent.
                aria-disabled={!onRetry || undefined}
                title={onRetry ? undefined : 'You can retry once the reply is done'}
                onClick={onRetry}
            >
                Retry
            </Button>
            <Button
                type="button"
                variant="ghost"
                size="xs"
                className={action}
                aria-label={`Edit “${excerpt}”`}
                onClick={delivery.onEdit}
            >
                Edit
            </Button>
        </div>
    );
}
