/**
 * Week time grid and current-time line adapted from lramos33/big-calendar
 * (MIT), src/calendar/components/week-and-day-view/calendar-week-view.tsx
 * and calendar-time-line.tsx, and from coollabsio/shoutrrr (Apache-2.0),
 * resources/js/components/posts/calendar/week-grid.tsx.
 * Copyright (c) 2025 Leonardo Ramos. Shoutrrr contributors, Apache-2.0.
 */
import { useEffect, useRef } from 'react';
import type { PointerEvent } from 'react';

import { HOUR_HEIGHT, allDayOnDay, blockStyle, dropId, groupTimed, timedOnDay } from './calendar-model';
import { EventChip } from './EventChip';
import type { BadgeVariant, CalendarEvent, CalendarTime } from './types';

import { cn } from '@/lib/utils';

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

export interface DropHint {
    day: string;
    hour: number;
    minute: number;
}

export function WeekGrid({
    keys,
    todayKey,
    events,
    now,
    variant,
    time,
    hint,
    draggingId,
    onPointerDown,
    onOpen,
    onCreate,
}: {
    keys: string[];
    todayKey: string;
    events: CalendarEvent[];
    now: number;
    variant: BadgeVariant;
    time: CalendarTime;
    hint: DropHint | null;
    draggingId?: string;
    onPointerDown: (event: PointerEvent<HTMLElement>, item: CalendarEvent) => void;
    onOpen: (item: CalendarEvent) => void;
    onCreate: (day: string, hour: number, minute: number) => void;
}) {
    const scroller = useRef<HTMLDivElement>(null);
    const nowClock = time.clock(now);
    const showNow = keys.includes(todayKey);
    const nowTop = ((nowClock.hour * 60 + nowClock.minute) / (24 * 60)) * 100;

    const span = keys.join('|');
    const allDay = keys.map((key) => allDayOnDay(events, key, time));
    const hasAllDay = allDay.some((list) => list.length > 0);
    useEffect(() => {
        const node = scroller.current?.querySelector('[data-now]');
        node?.scrollIntoView({ block: 'center' });
    }, [span, todayKey]);

    return (
        <div ref={scroller} className="min-h-0 flex-1 overflow-auto">
            <div className="sticky top-0 z-20 grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] border-b bg-background/95 backdrop-blur-sm">
                <div />
                {keys.map((key) => {
                    const today = key === todayKey;
                    return (
                        <div key={key} className="flex flex-col items-center gap-0.5 border-l px-1 py-2">
                            <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                                {time.formatWeekday(key)}
                            </span>
                            <span
                                className={cn(
                                    'inline-flex size-7 items-center justify-center rounded-full text-sm font-semibold tabular-nums',
                                    today && 'bg-primary text-primary-foreground',
                                )}
                            >
                                {time.dayNumber(key)}
                            </span>
                        </div>
                    );
                })}
                {hasAllDay && (
                    <>
                        <div className="flex items-start justify-end border-t pt-1.5 pr-2 text-[10px] font-medium text-muted-foreground">
                            All day
                        </div>
                        {keys.map((key, index) => (
                            <div
                                key={key}
                                data-day={key}
                                className="flex min-w-0 flex-col gap-0.5 border-t border-l p-0.5"
                            >
                                {allDay[index]!.map((item) => (
                                    <EventChip
                                        key={item.id}
                                        event={item}
                                        time={time}
                                        variant={variant}
                                        draggable
                                        dragging={draggingId === item.id}
                                        onPointerDown={(pointer) => onPointerDown(pointer, item)}
                                        onOpen={() => onOpen(item)}
                                    />
                                ))}
                            </div>
                        ))}
                    </>
                )}
            </div>
            <div
                className="relative grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]"
                style={{ height: HOUR_HEIGHT * 24 }}
            >
                <div className="relative">
                    {HOURS.map((hour) => (
                        <div
                            key={hour}
                            className="absolute right-2 -translate-y-1/2 text-[11px] font-medium text-muted-foreground tabular-nums"
                            style={{ top: hour * HOUR_HEIGHT }}
                        >
                            {hour === 0 ? '' : time.hourLabel(hour)}
                        </div>
                    ))}
                </div>
                {keys.map((key) => (
                    <DayColumn
                        key={key}
                        day={key}
                        today={key === todayKey}
                        events={events}
                        variant={variant}
                        time={time}
                        hint={hint?.day === key ? hint : null}
                        draggingId={draggingId}
                        onPointerDown={onPointerDown}
                        onOpen={onOpen}
                        onCreate={onCreate}
                    />
                ))}
                {showNow && (
                    <div
                        data-now
                        aria-hidden
                        className="pointer-events-none absolute right-0 z-30"
                        style={{ top: `${nowTop}%`, left: '3.5rem' }}
                    >
                        <span className="absolute top-0 right-full -translate-y-1/2 pr-1 text-[11px] font-medium text-primary tabular-nums">
                            {time.formatClock(now)}
                        </span>
                        <span className="absolute top-0 left-0 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary" />
                        <span className="absolute top-0 right-0 left-0 border-t border-primary" />
                    </div>
                )}
            </div>
        </div>
    );
}

function DayColumn({
    day,
    today,
    events,
    variant,
    time,
    hint,
    draggingId,
    onPointerDown,
    onOpen,
    onCreate,
}: {
    day: string;
    today: boolean;
    events: CalendarEvent[];
    variant: BadgeVariant;
    time: CalendarTime;
    hint: DropHint | null;
    draggingId?: string;
    onPointerDown: (event: PointerEvent<HTMLElement>, item: CalendarEvent) => void;
    onOpen: (item: CalendarEvent) => void;
    onCreate: (day: string, hour: number, minute: number) => void;
}) {
    const groups = groupTimed(timedOnDay(events, day, time));
    const hintTop = hint ? ((hint.hour * 60 + hint.minute) / (24 * 60)) * 100 : 0;
    return (
        <div
            data-day={day}
            data-column
            className={cn('relative border-l', today && 'bg-primary/5', hint && 'bg-accent/30')}
            onClick={(event) => {
                if ((event.target as HTMLElement).closest('[data-post]')) {
                    return;
                }
                const rect = event.currentTarget.getBoundingClientRect();
                const ratio = (event.clientY - rect.top) / rect.height;
                const minutes = Math.max(0, Math.min(24 * 60 - 15, ratio * 24 * 60));
                const snapped = Math.floor(minutes / 15) * 15;
                onCreate(day, Math.floor(snapped / 60), snapped % 60);
            }}
        >
            {HOURS.map((hour) => (
                <div
                    key={hour}
                    className="absolute inset-x-0 border-t border-border/70"
                    style={{ top: hour * HOUR_HEIGHT }}
                />
            ))}
            {hint && (
                <div
                    aria-hidden
                    data-drop={dropId(day, hint.hour, hint.minute)}
                    className="pointer-events-none absolute right-1 left-1 z-20 flex items-center"
                    style={{ top: `${hintTop}%` }}
                >
                    <span className="rounded bg-primary px-1 py-0.5 text-[10px] font-semibold text-primary-foreground tabular-nums">
                        {time.formatSlot(hint.hour, hint.minute)}
                    </span>
                    <span className="h-0.5 flex-1 rounded-full bg-primary" />
                </div>
            )}
            {groups.map((group, groupIndex) =>
                group.map((item) => (
                    <WeekBlock
                        key={item.event.id}
                        event={item.event}
                        style={blockStyle(item.startMin, groupIndex, groups.length, item.endMin - item.startMin)}
                        variant={variant}
                        time={time}
                        dragging={draggingId === item.event.id}
                        onPointerDown={onPointerDown}
                        onOpen={onOpen}
                    />
                )),
            )}
        </div>
    );
}

function WeekBlock({
    event,
    style,
    variant,
    time,
    dragging,
    onPointerDown,
    onOpen,
}: {
    event: CalendarEvent;
    style: { top: string; height: string; width: string; left: string };
    variant: BadgeVariant;
    time: CalendarTime;
    dragging: boolean;
    onPointerDown: (pointer: PointerEvent<HTMLElement>, item: CalendarEvent) => void;
    onOpen: (item: CalendarEvent) => void;
}) {
    const when =
        event.end === undefined
            ? time.formatClock(event.start)
            : `${time.formatClock(event.start)} – ${time.formatClock(event.end)}`;
    const title = event.meta ? `${when} · ${event.meta}` : (event.hint ?? when);
    return (
        <div
            role="button"
            tabIndex={0}
            data-post={event.id}
            title={title}
            onPointerDown={(pointer) => onPointerDown(pointer, event)}
            onClick={(pointer) => pointer.stopPropagation()}
            onKeyDown={(keyEvent) => {
                if (keyEvent.key === 'Enter' || keyEvent.key === ' ') {
                    keyEvent.preventDefault();
                    onOpen(event);
                }
            }}
            className={cn(
                'absolute z-10 overflow-hidden rounded-md border px-1.5 py-1 text-left shadow-sm',
                'cursor-grab focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:cursor-grabbing',
                dragging && 'opacity-40',
                variant === 'dot' && 'border-border bg-card text-card-foreground',
            )}
            style={{
                ...style,
                ...(variant === 'colored'
                    ? {
                          background: `color-mix(in oklab, ${event.color} 24%, var(--card))`,
                          borderColor: event.color,
                          color: 'var(--foreground)',
                      }
                    : undefined),
            }}
        >
            <p className="flex items-center gap-1 truncate text-[11px] font-semibold">
                {variant === 'dot' && (
                    <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: event.color }} />
                )}
                <span className="truncate">{event.title}</span>
            </p>
            <p className="truncate text-[10px] opacity-75 tabular-nums">
                {when}
                {event.detail ? ` · ${event.detail}` : ''}
            </p>
        </div>
    );
}
