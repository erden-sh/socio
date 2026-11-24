/**
 * Month and agenda chips adapted from coollabsio/shoutrrr (Apache-2.0),
 * resources/js/components/posts/calendar/post-chip.tsx.
 * Copyright Shoutrrr contributors. SPDX-License-Identifier: Apache-2.0
 *
 * Badge variants (colored fill vs dot) follow lramos33/big-calendar (MIT),
 * src/calendar/components/month-view/month-event-badge.tsx.
 * Copyright (c) 2025 Leonardo Ramos.
 */
import type { PointerEvent } from 'react';

import type { BadgeVariant, CalendarEvent, CalendarTime } from './types';

import { cn } from '@/lib/utils';

export function EventChip({
    event,
    time,
    variant,
    draggable,
    dragging,
    onPointerDown,
    onOpen,
    className,
}: {
    event: CalendarEvent;
    time: CalendarTime;
    variant: BadgeVariant;
    draggable?: boolean;
    dragging?: boolean;
    onPointerDown?: (pointer: PointerEvent<HTMLDivElement>) => void;
    onOpen?: () => void;
    className?: string;
}) {
    const when = event.allDay ? '' : time.formatClock(event.start);
    return (
        <div
            role="button"
            tabIndex={0}
            data-post={event.id}
            title={event.hint ?? (when ? `${when} · ${event.title}` : event.title)}
            onPointerDown={onPointerDown}
            onKeyDown={(keyEvent) => {
                if (keyEvent.key === 'Enter' || keyEvent.key === ' ') {
                    keyEvent.preventDefault();
                    onOpen?.();
                }
            }}
            className={cn(
                'relative flex h-5 min-w-0 items-center gap-1 truncate rounded-sm pr-1.5 pl-2 text-[10.5px] font-medium tabular-nums',
                'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
                dragging && 'opacity-40',
                variant === 'dot' && 'bg-muted text-foreground',
                className,
            )}
            style={
                variant === 'colored'
                    ? {
                          background: `color-mix(in oklab, ${event.color} 18%, var(--card))`,
                          color: 'var(--foreground)',
                      }
                    : undefined
            }
        >
            <span
                aria-hidden
                className={cn('absolute inset-y-0.5 left-0 w-0.5 rounded-full', variant === 'dot' && 'hidden')}
                style={{ background: event.color }}
            />
            {variant === 'dot' && (
                <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: event.color }} />
            )}
            {when && <span className="shrink-0 opacity-70">{when}</span>}
            <span className="truncate">{event.title}</span>
        </div>
    );
}
