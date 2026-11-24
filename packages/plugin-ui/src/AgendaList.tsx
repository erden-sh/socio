import { Plus } from 'lucide-react';
/**
 * Agenda list adapted from coollabsio/shoutrrr (Apache-2.0),
 * resources/js/components/posts/calendar/agenda-list.tsx.
 * Copyright Shoutrrr contributors. SPDX-License-Identifier: Apache-2.0
 */
import type { PointerEvent } from 'react';

import { eventsOnDay } from './calendar-model';
import type { BadgeVariant, CalendarEvent, CalendarTime } from './types';

import { cn } from '@/lib/utils';

export function AgendaList({
    keys,
    todayKey,
    events,
    variant,
    time,
    draggingId,
    overDay,
    addLabel = 'Add',
    emptyLabel = 'Nothing scheduled',
    onPointerDown,
    onOpen,
    onCreate,
}: {
    keys: string[];
    todayKey: string;
    events: CalendarEvent[];
    variant: BadgeVariant;
    time: CalendarTime;
    draggingId?: string;
    overDay?: string;
    addLabel?: string;
    emptyLabel?: string;
    onPointerDown: (event: PointerEvent<HTMLElement>, item: CalendarEvent) => void;
    onOpen: (item: CalendarEvent) => void;
    onCreate: (day: string) => void;
}) {
    return (
        <ol className="min-h-0 flex-1 overflow-auto py-2">
            {keys.map((key) => {
                const dayEvents = eventsOnDay(events, key, time);
                const today = key === todayKey;
                const past = key < todayKey;
                return (
                    <li key={key} data-day={key} className="flex gap-3 px-2 py-1">
                        <div className="flex w-12 shrink-0 flex-col items-center pt-1">
                            <span
                                className={cn(
                                    'text-[10.5px] font-medium tracking-wider uppercase',
                                    today ? 'text-primary' : 'text-muted-foreground',
                                )}
                            >
                                {time.formatWeekday(key)}
                            </span>
                            <span
                                className={cn(
                                    'mt-0.5 inline-flex size-8 items-center justify-center rounded-full text-[15px] font-semibold tabular-nums',
                                    today && 'bg-primary text-primary-foreground',
                                    past && !today && 'text-muted-foreground',
                                )}
                            >
                                {time.dayNumber(key)}
                            </span>
                        </div>
                        <div
                            className={cn(
                                'min-w-0 flex-1 space-y-1 border-l py-1 pl-3',
                                overDay === key && 'border-primary bg-accent/30',
                            )}
                        >
                            {dayEvents.map((item) => (
                                <AgendaItem
                                    key={item.id}
                                    event={item}
                                    variant={variant}
                                    time={time}
                                    dragging={draggingId === item.id}
                                    onPointerDown={(event) => onPointerDown(event, item)}
                                    onOpen={() => onOpen(item)}
                                />
                            ))}
                            {!past && (
                                <button
                                    type="button"
                                    onClick={() => onCreate(key)}
                                    className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                                >
                                    <Plus className="size-3.5" aria-hidden />
                                    {addLabel}
                                </button>
                            )}
                            {past && dayEvents.length === 0 && (
                                <p className="px-2 py-2 text-[13px] text-muted-foreground/60">{emptyLabel}</p>
                            )}
                        </div>
                    </li>
                );
            })}
        </ol>
    );
}

function AgendaItem({
    event,
    variant,
    time,
    dragging,
    onPointerDown,
    onOpen,
}: {
    event: CalendarEvent;
    variant: BadgeVariant;
    time: CalendarTime;
    dragging: boolean;
    onPointerDown: (pointer: PointerEvent<HTMLElement>) => void;
    onOpen: () => void;
}) {
    return (
        <div
            role="button"
            tabIndex={0}
            data-post={event.id}
            onPointerDown={onPointerDown}
            onKeyDown={(keyEvent) => {
                if (keyEvent.key === 'Enter' || keyEvent.key === ' ') {
                    keyEvent.preventDefault();
                    onOpen();
                }
            }}
            className={cn(
                'flex w-full cursor-grab items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-muted/60 active:cursor-grabbing',
                dragging && 'opacity-40',
            )}
        >
            <span
                aria-hidden
                className="h-7 w-[3px] shrink-0 rounded-full"
                style={{
                    background: variant === 'dot' ? 'var(--border)' : event.color,
                }}
            />
            {variant === 'dot' && (
                <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: event.color }} />
            )}
            <span className="w-16 shrink-0 text-[12px] text-muted-foreground tabular-nums">
                {event.allDay ? 'All day' : time.formatClock(event.start)}
            </span>
            {event.meta && (
                <span className="w-24 shrink-0 truncate text-[12px] text-muted-foreground">{event.meta}</span>
            )}
            <span className="min-w-0 flex-1 truncate text-[13px]">{event.title}</span>
            {event.detail && (
                <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">{event.detail}</span>
            )}
        </div>
    );
}
