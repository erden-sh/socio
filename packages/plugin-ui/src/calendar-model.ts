/**
 * Overlap grouping and time-block geometry adapted from
 * lramos33/big-calendar (MIT), src/calendar/helpers.ts
 * (`groupEvents`, `getEventBlockStyle`).
 * Copyright (c) 2025 Leonardo Ramos.
 */
import type { CalendarEvent, CalendarTime } from './types';

/** How tall a point-in-time event reads on the week grid. */
export const BLOCK_MINUTES = 45;
export const HOUR_HEIGHT = 80;
export const DAY_MINUTES = 24 * 60;

/** The shortest block a timed event with an `end` gets on the week grid. */
export const MIN_BLOCK_MINUTES = 15;

export type TimedItem = {
    id: string;
    startMin: number;
    /** Minutes after midnight the block ends, clipped at the day's end. */
    endMin: number;
    event: CalendarEvent;
};

/** The day keys an event's first and last moments fall on. */
export function eventSpan(event: CalendarEvent, time: Pick<CalendarTime, 'dayKey'>) {
    const first = time.dayKey(event.start);
    const last = event.end !== undefined && event.end > event.start ? time.dayKey(event.end - 1) : first;
    return { first, last: last < first ? first : last };
}

/** Whether an event covers the day `key` (its start day, or any day it spans). */
export function coversDay(event: CalendarEvent, key: string, time: Pick<CalendarTime, 'dayKey'>) {
    const { first, last } = eventSpan(event, time);
    return first <= key && key <= last;
}

/** Events on a day: all-day ones first, then by start. */
export function eventsOnDay(events: CalendarEvent[], key: string, time: Pick<CalendarTime, 'dayKey'>) {
    return events
        .filter((event) => coversDay(event, key, time))
        .sort((a, b) => Number(Boolean(b.allDay)) - Number(Boolean(a.allDay)) || a.start - b.start);
}

/** All-day events that cover a day, for the week grid's all-day row. */
export function allDayOnDay(events: CalendarEvent[], key: string, time: Pick<CalendarTime, 'dayKey'>) {
    return eventsOnDay(events, key, time).filter((event) => event.allDay);
}

/**
 * Timed events that start on a day, as blocks: an event without `end`
 * is `BLOCK_MINUTES` tall; one with `end` as long as it lasts (at least
 * `MIN_BLOCK_MINUTES`), clipped at midnight.
 */
export function timedOnDay(events: CalendarEvent[], key: string, time: CalendarTime): TimedItem[] {
    return events
        .filter((event) => !event.allDay && time.dayKey(event.start) === key)
        .sort((a, b) => a.start - b.start)
        .map((event) => {
            const { hour, minute } = time.clock(event.start);
            const startMin = hour * 60 + minute;
            const length =
                event.end === undefined
                    ? BLOCK_MINUTES
                    : Math.max(MIN_BLOCK_MINUTES, (event.end - event.start) / 60_000);
            return {
                id: event.id,
                startMin,
                endMin: Math.min(DAY_MINUTES, startMin + length),
                event,
            };
        });
}

/**
 * Columns of events that overlap. An event joins the first column whose
 * last block has already ended.
 */
export function groupTimed<T extends { startMin: number; endMin?: number }>(events: T[]) {
    const groups: T[][] = [];
    for (const event of events) {
        let placed = false;
        for (const group of groups) {
            const last = group[group.length - 1];
            if (last && event.startMin >= (last.endMin ?? last.startMin + BLOCK_MINUTES)) {
                group.push(event);
                placed = true;
                break;
            }
        }
        if (!placed) {
            groups.push([event]);
        }
    }
    return groups;
}

export function blockStyle(startMin: number, groupIndex: number, groupSize: number, minutes = BLOCK_MINUTES) {
    const top = (startMin / DAY_MINUTES) * 100;
    const height = (minutes / DAY_MINUTES) * 100;
    const width = 100 / groupSize;
    const left = groupIndex * width;
    return {
        top: `${top}%`,
        height: `${height}%`,
        width: `${width}%`,
        left: `${left}%`,
    };
}

/** Snap a Y position inside a day column to a 15-minute slot. */
export function slotFromY(clientY: number, rect: DOMRect) {
    const ratio = rect.height === 0 ? 0 : (clientY - rect.top) / rect.height;
    const minutes = Math.max(0, Math.min(DAY_MINUTES - 15, ratio * DAY_MINUTES));
    const snapped = Math.floor(minutes / 15) * 15;
    return { hour: Math.floor(snapped / 60), minute: snapped % 60 };
}

export function dropId(day: string, hour?: number, minute?: number) {
    return hour === undefined ? day : `${day}|${hour}|${minute ?? 0}`;
}
