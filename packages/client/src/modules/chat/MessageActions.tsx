import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { dateTimeFormat } from '@socio/shared/locale';

import { LocalTime } from '../../lib/local-time';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

/** How long Copy shows its check mark. */
export const COPIED_MS = 2_000;

/**
 * The row under a message (T3 Code's message meta row): shown on hover or
 * focus (the message is the `group/message`), always on touch screens and
 * when `pinned`; a finger gets 44px buttons. Copy, then
 * `children` (a Dot's reactions, CB-133; Edit and Fork later), then the
 * message's time, when known (CB-72).
 */
export function MessageActions({
    text,
    at,
    pinned,
    children,
}: {
    /** The message's Markdown source, as Copy puts it on the clipboard. */
    text: string;
    /** When it was written (ms). */
    at?: number;
    /** Stays in view (a message with reactions), not only on hover or focus. */
    pinned?: boolean;
    children?: ReactNode;
}) {
    return (
        <TooltipProvider delayDuration={300}>
            <div
                className="flex min-h-6 items-center gap-0.5 opacity-0 transition-opacity duration-[120ms] group-focus-within/message:opacity-100 group-hover/message:opacity-100 data-pinned:opacity-100 [@media(hover:none)]:opacity-100 pointer-coarse:[&_:is([data-reaction],[data-state-copy])]:min-h-11 pointer-coarse:[&_:is([data-reaction],[data-state-copy])]:min-w-11"
                data-slot="message-actions"
                data-pinned={pinned ? '' : undefined}
            >
                <CopyButton text={text} />
                {children}
                {at !== undefined && <MessageTime at={at} />}
            </div>
        </TooltipProvider>
    );
}

const shortTime = dateTimeFormat({ hour: 'numeric', minute: '2-digit' });
const shortDate = dateTimeFormat({ month: 'short', day: 'numeric' });
const longDate = dateTimeFormat({
    year: 'numeric',
    month: 'short',
    day: 'numeric',
});
const fullTime = dateTimeFormat({ dateStyle: 'full', timeStyle: 'medium' });

/**
 * A message's time in the action row: "3:04 PM" today, "Oct 15, 3:04 PM"
 * this year, "Oct 15, 2025, 3:04 PM" before.
 */
export function messageTime(at: number, now = Date.now()) {
    const date = new Date(at);
    const today = new Date(now);
    const time = shortTime.format(date);
    if (date.toDateString() === today.toDateString()) {
        return time;
    }
    return `${(date.getFullYear() === today.getFullYear() ? shortDate : longDate).format(date)}, ${time}`;
}
/** The full date in its tooltip: "Friday, October 17, 2026 at 3:04:05 PM". */
export const messageFullTime = (at: number) => fullTime.format(new Date(at));

function MessageTime({ at }: { at: number }) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span
                    className="rounded-[4px] px-1 text-[11px] text-muted-foreground tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    data-slot="message-time"
                    tabIndex={0}
                >
                    <LocalTime value={at} format={(value) => messageTime(value)} />
                </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">{messageFullTime(at)}</TooltipContent>
        </Tooltip>
    );
}

/**
 * Copies the Markdown source; a check mark for two seconds, and "Copied"
 * for screen readers (a polite status next to the button).
 */
export function CopyButton({ text }: { text: string }) {
    const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
    const timer = useRef<number>(undefined);
    useEffect(() => () => window.clearTimeout(timer.current), []);
    const copy = async () => {
        window.clearTimeout(timer.current);
        try {
            await navigator.clipboard.writeText(text);
            setState('copied');
        } catch {
            setState('failed');
        }
        timer.current = window.setTimeout(() => setState('idle'), COPIED_MS);
    };
    const label = state === 'copied' ? 'Copied' : state === 'failed' ? 'Could not copy' : 'Copy';
    return (
        <>
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="text-muted-foreground hover:text-foreground"
                        aria-label="Copy"
                        data-state-copy={state}
                        onClick={() => void copy()}
                    >
                        {state === 'copied' ? <Check /> : <Copy />}
                    </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{label}</TooltipContent>
            </Tooltip>
            <span className="sr-only" role="status">
                {state === 'idle' ? '' : label}
            </span>
        </>
    );
}
