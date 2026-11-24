/**
 * Calendar shell. Drag-and-drop between days and 15-minute slots follows
 * the drop targets in lramos33/big-calendar (MIT) (`droppable-time-block`,
 * `droppable-day-cell`) without pulling in react-dnd.
 * Copyright (c) 2025 Leonardo Ramos.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { AgendaList } from './AgendaList';
import { slotFromY } from './calendar-model';
import { EventChip } from './EventChip';
import { MonthGrid } from './MonthGrid';
import type { BadgeVariant, CalendarEvent, CalendarTime } from './types';
import { WeekGrid, type DropHint } from './WeekGrid';

export function Calendar({
    view,
    anchor,
    todayKey,
    keys,
    events,
    now,
    variant,
    time,
    addLabel,
    emptyLabel,
    onOpen,
    onMove,
    onCreate,
}: {
    view: 'week' | 'month' | 'agenda';
    anchor: number;
    todayKey: string;
    keys: string[];
    events: CalendarEvent[];
    now: number;
    variant: BadgeVariant;
    time: CalendarTime;
    addLabel?: string;
    emptyLabel?: string;
    onOpen: (event: CalendarEvent) => void;
    onMove: (event: CalendarEvent, day: string, hour?: number, minute?: number) => void;
    onCreate: (day: string, hour: number, minute: number) => void;
}) {
    const drag = useRef<{
        id: string;
        x: number;
        y: number;
        moved: boolean;
        label: string;
        color: string;
    } | null>(null);
    const [ghost, setGhost] = useState<{
        x: number;
        y: number;
        label: string;
        color: string;
    } | null>(null);
    const [hint, setHint] = useState<DropHint | null>(null);
    const [overDay, setOverDay] = useState<string>();
    const [draggingId, setDraggingId] = useState<string>();

    useEffect(() => {
        const move = (event: PointerEvent) => {
            const current = drag.current;
            if (!current) {
                return;
            }
            const distance = Math.hypot(event.clientX - current.x, event.clientY - current.y);
            if (!current.moved && distance < 5) {
                return;
            }
            current.moved = true;
            setDraggingId(current.id);
            setGhost({
                x: event.clientX,
                y: event.clientY,
                label: current.label,
                color: current.color,
            });
            const hit = document.elementFromPoint(event.clientX, event.clientY);
            const column = hit?.closest('[data-column]');
            const day = hit?.closest('[data-day]')?.getAttribute('data-day') ?? undefined;
            setOverDay(day);
            if (column instanceof HTMLElement && day) {
                const slot = slotFromY(event.clientY, column.getBoundingClientRect());
                setHint({ day, hour: slot.hour, minute: slot.minute });
            } else {
                setHint(null);
            }
        };
        const up = (event: PointerEvent) => {
            const current = drag.current;
            if (!current) {
                return;
            }
            drag.current = null;
            const moved = current.moved;
            setGhost(null);
            setHint(null);
            setOverDay(undefined);
            setDraggingId(undefined);
            const item = events.find((row) => row.id === current.id);
            if (!item) {
                return;
            }
            if (moved) {
                const swallow = (click: MouseEvent) => {
                    click.preventDefault();
                    click.stopPropagation();
                    window.removeEventListener('click', swallow, true);
                };
                window.addEventListener('click', swallow, true);
                setTimeout(() => window.removeEventListener('click', swallow, true), 0);
            }
            if (!moved) {
                onOpen(item);
                return;
            }
            const hit = document.elementFromPoint(event.clientX, event.clientY);
            const column = hit?.closest('[data-column]');
            const day = hit?.closest('[data-day]')?.getAttribute('data-day');
            if (!day) {
                return;
            }
            if (column instanceof HTMLElement) {
                const slot = slotFromY(event.clientY, column.getBoundingClientRect());
                onMove(item, day, slot.hour, slot.minute);
            } else {
                onMove(item, day);
            }
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        return () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
        };
    }, [events, onMove, onOpen]);

    const begin = (event: ReactPointerEvent<HTMLElement>, item: CalendarEvent) => {
        if (event.button !== 0) {
            return;
        }
        drag.current = {
            id: item.id,
            x: event.clientX,
            y: event.clientY,
            moved: false,
            label: item.title,
            color: item.color,
        };
    };

    return (
        <div
            className={
                ghost
                    ? 'flex min-h-0 flex-1 flex-col [&_[data-post]]:pointer-events-none'
                    : 'flex min-h-0 flex-1 flex-col'
            }
        >
            {view === 'week' && (
                <WeekGrid
                    keys={keys}
                    todayKey={todayKey}
                    events={events}
                    now={now}
                    variant={variant}
                    time={time}
                    hint={hint}
                    draggingId={draggingId}
                    onPointerDown={begin}
                    onOpen={onOpen}
                    onCreate={onCreate}
                />
            )}
            {view === 'month' && (
                <MonthGrid
                    anchor={anchor}
                    keys={keys}
                    todayKey={todayKey}
                    events={events}
                    variant={variant}
                    time={time}
                    draggingId={draggingId}
                    overDay={overDay}
                    onPointerDown={begin}
                    onOpen={onOpen}
                    onCreate={(day) => onCreate(day, 9, 30)}
                />
            )}
            {view === 'agenda' && (
                <AgendaList
                    keys={keys}
                    todayKey={todayKey}
                    events={events}
                    variant={variant}
                    time={time}
                    draggingId={draggingId}
                    overDay={overDay}
                    addLabel={addLabel}
                    emptyLabel={emptyLabel}
                    onPointerDown={begin}
                    onOpen={onOpen}
                    onCreate={(day) => onCreate(day, 9, 30)}
                />
            )}
            {ghost && (
                <div className="pointer-events-none fixed z-50 w-52" style={{ left: ghost.x + 12, top: ghost.y + 12 }}>
                    <EventChip
                        event={{
                            id: 'ghost',
                            title: ghost.label,
                            start: now,
                            color: ghost.color,
                            hint: `${time.formatClock(now)} · ${ghost.label}`,
                        }}
                        time={time}
                        variant={variant}
                        className="h-7 shadow-lg"
                    />
                </div>
            )}
        </div>
    );
}
