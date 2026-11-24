import { RefreshCw, ThumbsDown, ThumbsUp, Wrench, type LucideIcon } from 'lucide-react';
import { useState } from 'react';

import { REACTIONS, REACTION_LABELS, type ReactionKind } from '@socio/shared/chat/reactions';

import type { ReactionsApi } from './use-reactions';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const ICONS: Record<ReactionKind, LucideIcon> = {
    up: ThumbsUp,
    down: ThumbsDown,
    retry: RefreshCw,
    'needs-work': Wrench,
};

/**
 * The quick feedback buttons in a Dot message's action row (CB-133): good,
 * bad, try again and needs work. Each is a toggle; the reader's own are
 * highlighted, and a count shows beside a reaction when others can see the
 * chat (a team topic) or more than one person gave it.
 */
export function MessageReactions({ messageId, reactions }: { messageId: string; reactions: ReactionsApi }) {
    const current = reactions.of(messageId);
    // What a screen reader hears after a press ("Needs work added").
    const [said, setSaid] = useState('');
    return (
        <div
            role="group"
            aria-label="React to this reply"
            className="flex items-center gap-0.5"
            data-slot="message-reactions"
        >
            {REACTIONS.map((kind) => {
                const Icon = ICONS[kind];
                const on = current.mine.includes(kind);
                const count = current.counts[kind] ?? 0;
                const shown = count > 0 && (reactions.shared || count > 1);
                const label = REACTION_LABELS[kind];
                return (
                    <Tooltip key={kind}>
                        <TooltipTrigger asChild>
                            <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                className={cn(
                                    'tabular-nums',
                                    on ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
                                )}
                                aria-label={shown ? `${label}, ${count}` : label}
                                aria-pressed={on}
                                data-reaction={kind}
                                onClick={() => {
                                    setSaid(`${label} ${on ? 'removed' : 'added'}`);
                                    reactions.toggle(messageId, kind);
                                }}
                            >
                                <Icon aria-hidden="true" />
                                {shown && <span className="text-[11px]">{count}</span>}
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">{label}</TooltipContent>
                    </Tooltip>
                );
            })}
            {reactions.failed === messageId && (
                <span className="px-1 text-[11px] text-destructive" role="alert">
                    Could not save that
                </span>
            )}
            <span className="sr-only" role="status">
                {reactions.failed === messageId ? '' : said}
            </span>
        </div>
    );
}

/** Whether any reaction is on the message: its row stays in view. */
export const hasReactions = (reactions: ReactionsApi | undefined, id: string) =>
    !!reactions && Object.keys(reactions.of(id).counts).length > 0;
