import { LoaderCircle } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';

import { Mascot } from '../../locals/Mascot';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Where a chat shows: the chat view's column (`/chats/…`), or the page's
 * side panel (PageConversation), which is narrower and tighter.
 */
export type ChatPlacement = 'column' | 'page';

/**
 * The chat view's reading column (ChatGPT, T3 Code): the transcript's
 * content and the composer share one centered width of 48rem. The header
 * is not in it: it follows the workspace frame (ChatHeader).
 */
export const chatColumn = 'mx-auto w-full max-w-3xl';

/**
 * A chat's box: the header, the transcript (which scrolls) and the
 * composer, one column. A size container, so the header can change its
 * layout when the chat is narrow (a phone, the page panel, or beside the
 * computer pane). When the keyboard leaves little room (a phone in
 * landscape), its edges go to the composer (CB-155).
 */
export function ChatFrame({
    placement = 'column',
    className,
    ...props
}: ComponentProps<'div'> & { placement?: ChatPlacement }) {
    return (
        <div
            data-placement={placement}
            className={cn(
                '@container/chat flex min-w-0 flex-col pb-5.5 max-[700px]:p-4 max-[700px]:pt-2 keyboard-tight:py-1',
                // The panel's heading sits above: the chat takes the rest. The
                // chat view's frame has the page chrome's edges (Issues, CB-91),
                // so its header lines up with theirs.
                placement === 'page'
                    ? 'mx-auto min-h-0 w-full max-w-212.5 flex-1 px-[35px] pt-4.5'
                    : 'h-full px-4 pt-(--page-top) md:px-6',
                className,
            )}
            {...props}
        />
    );
}

/**
 * The chat's header. In the chat view it is one row across the workspace
 * frame, like the module pages' (Issues): the Dot with its name and
 * status at the start, the actions at the end (CB-120, CB-103), whatever
 * the width; only the messages and the composer keep the reading column.
 * When narrow (a phone, beside the computer pane) the model picker is cut
 * short first, and a long name past 45% of the row. In the page panel the
 * Dot is centered and the actions take a row of their own above it
 * instead of covering it. Hidden while typing in a phone's landscape,
 * where the keyboard leaves room for the composer only (CB-155).
 */
export function ChatHeader({
    placement = 'column',
    identity,
    mascotCharacter,
    mascotName,
    mascotState,
    mascotNode,
    title,
    status,
    actions,
}: {
    placement?: ChatPlacement;
    identity: string;
    /** The socio's chosen Local (CB-256). */
    mascotCharacter?: string | null;
    mascotName: string;
    mascotState?: ComponentProps<typeof Mascot>['state'];
    /** When a chat is not tied to one socio, render this instead of a Mascot. */
    mascotNode?: ReactNode;
    title: ReactNode;
    status: ReactNode;
    actions?: ReactNode;
}) {
    return (
        <header
            data-slot="chat-header"
            className={cn(
                'flex shrink-0 items-center keyboard-tight:hidden',
                placement === 'page'
                    ? cn(
                          chatColumn,
                          'relative min-h-23.5 flex-wrap justify-center gap-1.5 p-4.5 pb-5 @max-[47.5rem]/chat:pt-12.5',
                      )
                    : 'w-full gap-2 pb-2 md:pb-3',
            )}
        >
            {mascotNode ?? (
                <Mascot
                    identity={identity}
                    character={mascotCharacter}
                    name={mascotName}
                    small
                    state={mascotState}
                    className={cn('shrink-0', placement === 'page' ? 'size-12.5' : 'size-9')}
                />
            )}
            <div
                className={cn(
                    'flex min-w-0 flex-col leading-[normal]',
                    placement === 'page'
                        ? 'gap-1'
                        : 'gap-0.5 @max-[47.5rem]/chat:max-w-[45%] @max-[47.5rem]/chat:shrink-0',
                )}
            >
                <strong className="truncate text-[14px] font-[550] text-foreground">{title}</strong>
                <span className="truncate text-xs/[normal] text-muted-foreground">{status}</span>
            </div>
            {actions && (
                <div
                    data-slot="chat-header-actions"
                    className={cn(
                        'flex min-w-0 items-center gap-0.5',
                        placement === 'page' ? 'absolute top-0 right-0' : 'ml-auto',
                    )}
                >
                    {actions}
                </div>
            )}
        </header>
    );
}

/**
 * An icon-only button of the chat's chrome (header, composer): quiet,
 * light gray, a soft background on hover.
 */
export function ChatIconButton({ className, ...props }: ComponentProps<typeof Button>) {
    return (
        <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
                "size-auto rounded-[9px] p-1.5 text-muted-foreground/75 [&_svg:not([class*='size-'])]:size-auto hover:text-muted-foreground disabled:pointer-events-auto disabled:cursor-not-allowed dark:text-muted-foreground dark:hover:text-foreground",
                className,
            )}
            {...props}
        />
    );
}

/**
 * The transcript's scroll area and its one column of content, followed by
 * the end sentinel (useStickToBottom). No data-slot here: a message's
 * Markdown keeps the legacy resets (lists, headings), which stop there.
 * `relative`: the absolutely positioned bits in messages (screen-reader
 * labels) belong to it, so they scroll with the transcript; outside it,
 * each sat at the end of the whole conversation and stretched the view
 * around the chat, which then scrolled past the composer (CB-102).
 * Nothing in a message widens the column (CB-107): its children may
 * shrink below their content's width, and text breaks anywhere when a
 * word (a URL, a long name) is wider than the column; code blocks and
 * tables scroll inside their own box (ChatTranscript, ChatMarkdown).
 * It is what gives way when the composer grows above a phone's keyboard,
 * down to nothing (CB-155): the composer is never cut off.
 */
export function ChatScroller({
    placement = 'column',
    scroller,
    content,
    end,
    children,
}: {
    placement?: ChatPlacement;
    scroller: ComponentProps<'div'>['ref'];
    content: ComponentProps<'div'>['ref'];
    end: ComponentProps<'div'>['ref'];
    children: ReactNode;
}) {
    return (
        <div
            ref={scroller}
            // A hook for the browser smoke test (not a data-slot, as above).
            data-chat-transcript=""
            className={cn(
                'relative flex min-h-0 flex-1 flex-col overflow-auto [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin]',
                placement === 'page' ? 'p-5' : 'py-[29px] max-[700px]:py-6',
                'keyboard-tight:py-0',
            )}
        >
            <div
                ref={content}
                className={cn(
                    chatColumn,
                    'flex min-w-0 shrink-0 flex-col gap-5.5 [overflow-wrap:anywhere] *:min-w-0 max-[700px]:gap-5',
                )}
            >
                {children}
            </div>
            <div ref={end} className="h-px shrink-0" />
        </div>
    );
}

/**
 * The chat waiting for the server, which is restarting for an update
 * (CB-108): where its error would show, quiet, with a spinner. Also a
 * full steering queue (CB-170), with its own icon.
 */
export function ChatNotice({
    children,
    icon,
    announce = true,
}: {
    children: ReactNode;
    /** In place of the spinner, for a note that waits on the person. */
    icon?: ReactNode;
    /**
     * Said by its own status role (the default); false where a live region
     * that is always there says it instead (a room's, CB-219), so it isn't
     * said twice.
     */
    announce?: boolean;
}) {
    return (
        <div
            role={announce ? 'status' : undefined}
            aria-hidden={announce ? undefined : true}
            data-slot="chat-notice"
            className={cn(
                chatColumn,
                'flex shrink-0 items-center gap-2.5 rounded-lg bg-muted/60 p-3 text-[11px]/[1.8] text-muted-foreground',
            )}
        >
            {icon ?? <LoaderCircle size={14} className="shrink-0 animate-spin motion-reduce:animate-none" />}
            <span className="min-w-0">{children}</span>
        </div>
    );
}

/** A problem with the chat (it could not connect, a turn failed). */
export function ChatError({
    children,
    action,
    onAction,
}: {
    children: ReactNode;
    action?: string;
    onAction?: () => void;
}) {
    return (
        <div
            role="alert"
            data-slot="chat-error"
            className={cn(
                chatColumn,
                'flex shrink-0 items-center justify-between gap-2.5 rounded-lg bg-destructive/10 p-3 text-[11px]/[1.8] text-destructive',
            )}
        >
            {children}
            {action && (
                <Button
                    type="button"
                    variant="outline"
                    className="h-auto rounded-[9px] px-[9px] py-[5px] text-[10px]/[1.8] font-normal whitespace-normal text-destructive shadow-none hover:text-destructive"
                    onClick={onAction}
                >
                    {action}
                </Button>
            )}
        </div>
    );
}

/**
 * The composer's text box: borderless inside the composer's box, 16 px on
 * phones (iOS zooms into anything smaller, CB-96) and 14 px above. It
 * grows with its text (useFitComposer) to 40% of the visible height on a
 * phone, half of it on wider screens, then scrolls, fading at the top
 * while lines are hidden above (CB-97). Tighter when the keyboard leaves
 * little room, so a line and the buttons fit (CB-155).
 */
export const composerText =
    'field-sizing-fixed max-h-[calc(var(--app-height,100dvh)*0.4)] min-h-[43px] resize-none overflow-y-auto [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin] data-scrolled:[mask-image:linear-gradient(to_bottom,transparent,black_1.5rem)] md:max-h-[calc(var(--app-height,100dvh)*0.5)] rounded-none border-0 bg-transparent px-1 py-[11px] text-base/[1.65] text-foreground shadow-none placeholder:text-muted-foreground/70 focus-visible:ring-0 md:text-sm/[1.65] dark:bg-transparent keyboard-tight:max-h-[calc(var(--app-height,100dvh)*0.4)] keyboard-tight:min-h-0 keyboard-tight:py-1';

/**
 * The round send (or stop) button at the end of a composer. Its 44 px
 * target stays usable beside the tools and the busy turn’s queue action.
 */
export function SendButton({ className, type = 'button', ...props }: ComponentProps<typeof Button>) {
    return (
        <Button
            type={type}
            size="icon"
            className={cn(
                "size-11 min-w-11 shrink-0 rounded-full bg-foreground p-0 text-background hover:bg-foreground/90 disabled:pointer-events-auto disabled:cursor-not-allowed disabled:opacity-90 [&_svg:not([class*='size-'])]:size-auto",
                className,
            )}
            {...props}
        />
    );
}

/**
 * Shared by socio and page chats: a full-width text box, then a compact
 * action row. Reading and keyboard order stay text, tools, send; the
 * actions never take space away from the draft. Tools retain 44 px targets
 * without extra gaps between them. A very narrow panel can wrap the send
 * group while keeping its buttons together and aligned to the end.
 */
export function ComposerRow({
    tools,
    text,
    send,
    className,
}: {
    tools: ReactNode;
    text: ReactNode;
    send: ReactNode;
    className?: string;
}) {
    return (
        <div data-slot="composer-row" className={cn('flex min-w-0 flex-col gap-1', className)}>
            <div data-slot="composer-text" className="flex min-w-0 w-full">
                {text}
            </div>
            <div data-slot="composer-toolbar" className="flex min-w-0 flex-wrap items-center gap-1">
                <div
                    data-slot="composer-tools"
                    role="group"
                    aria-label="Message actions"
                    className="flex shrink-0 items-center gap-0 [&_button]:size-11 [&_button]:p-0"
                >
                    {tools}
                </div>
                <div data-slot="composer-send" className="ml-auto flex shrink-0 items-center">
                    {send}
                </div>
            </div>
        </div>
    );
}

/** The line under the composer (or in its place, read-only). */
export function ChatNote({ children }: { children: ReactNode }) {
    return (
        <div
            data-slot="chat-note"
            className="mt-0.5 text-center text-[11px]/[normal] text-muted-foreground max-[700px]:leading-[1.7]"
        >
            {children}
        </div>
    );
}
