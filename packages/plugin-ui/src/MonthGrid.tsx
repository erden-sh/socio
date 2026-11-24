/**
 * Month grid adapted from coollabsio/shoutrrr (Apache-2.0),
 * resources/js/components/posts/calendar/month-grid.tsx, with badge
 * treatment from lramos33/big-calendar (MIT) month-event-badge.tsx.
 */
import { useState, type PointerEvent } from 'react';

import { eventsOnDay } from './calendar-model';
import { EventChip } from './EventChip';
import type { BadgeVariant, CalendarEvent, CalendarTime } from './types';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

const VISIBLE = 3;

export function MonthGrid({
    anchor,
    keys,
    todayKey,
    events,
    variant,
    time,
    draggingId,
    overDay,
    onPointerDown,
    onOpen,
    onCreate,
}: {
    anchor: number;
    keys: string[];
    todayKey: string;
    events: CalendarEvent[];
    variant: BadgeVariant;
    time: CalendarTime;
    draggingId?: string;
    overDay?: string;
    onPointerDown: (event: PointerEvent<HTMLDivElement>, item: CalendarEvent) => void;
    onOpen: (item: CalendarEvent) => void;
    onCreate: (day: string) => void;
}) {
    const heads = keys.slice(0, 7).map((key) => time.formatWeekday(key));
    return (
        <div className="min-h-0 flex-1 overflow-auto">
            <div className="grid grid-cols-7 border-b text-center text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                {heads.map((day) => (
                    <div key={day} className="px-2 py-2">
                        {day}
                    </div>
                ))}
            </div>
            <div className="grid grid-cols-7 border-l">
                {keys.map((key) => {
                    const dayEvents = eventsOnDay(events, key, time);
                    const extra = dayEvents.slice(VISIBLE);
                    const inMonth = time.sameMonth(key, anchor);
                    return (
                        <div
                            key={key}
                            data-day={key}
                            className={cn(
                                'flex min-h-28 flex-col gap-1 border-r border-b p-1.5',
                                !inMonth && 'bg-muted/30 text-muted-foreground',
                                overDay === key && 'bg-accent/40',
                            )}
                            onClick={(event) => {
                                if ((event.target as HTMLElement).closest('[data-post]')) {
                                    return;
                                }
                                onCreate(key);
                            }}
                        >
                            <div className="flex justify-end">
                                <span
                                    className={cn(
                                        'inline-flex size-6 items-center justify-center rounded-full text-xs font-medium tabular-nums',
                                        key === todayKey && 'bg-primary text-primary-foreground',
                                    )}
                                >
                                    {time.dayNumber(key)}
                                </span>
                            </div>
                            {dayEvents.slice(0, VISIBLE).map((item) => (
                                <EventChip
                                    key={item.id}
                                    event={item}
                                    time={time}
                                    variant={variant}
                                    draggable
                                    dragging={draggingId === item.id}
                                    onPointerDown={(event) => {
                                        event.stopPropagation();
                                        onPointerDown(event, item);
                                    }}
                                    onOpen={() => onOpen(item)}
                                />
                            ))}
                            {extra.length > 0 && <MoreEvents day={key} events={extra} time={time} onOpen={onOpen} />}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function MoreEvents({
    day,
    events,
    time,
    onOpen,
}: {
    day: string;
    events: CalendarEvent[];
    time: CalendarTime;
    onOpen: (item: CalendarEvent) => void;
}) {
    const [open, setOpen] = useState(false);
    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    className="px-1 text-left text-[11px] font-medium text-muted-foreground hover:text-foreground"
                    onClick={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    {events.length} more
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="grid w-64 gap-1" onClick={(event) => event.stopPropagation()}>
                <p className="text-xs font-medium text-muted-foreground">{time.formatDayKey(day)}</p>
                {events.map((item) => (
                    <EventChip
                        key={item.id}
                        event={item}
                        time={time}
                        variant="colored"
                        onPointerDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setOpen(false);
                            onOpen(item);
                        }}
                        onOpen={() => onOpen(item)}
                    />
                ))}
            </PopoverContent>
        </Popover>
    );
}
