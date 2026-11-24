/** A record on the calendar. The plugin maps its own rows onto this. */
export type CalendarEvent = {
    id: string;
    /** Primary text on the chip. */
    title: string;
    /** UTC milliseconds. */
    start: number;
    /**
     * UTC milliseconds, exclusive. Optional: without it an event is a point
     * in time (a `BLOCK_MINUTES` block on the week grid, on its start day).
     * With it, the week block is as tall as the event, and the event shows
     * on every day it covers in the month and agenda views.
     */
    end?: number;
    /** A whole-day event: the week grid's all-day row, and no clock time. */
    allDay?: boolean;
    /** CSS color for the badge fill or dot. */
    color: string;
    /** Tooltip. The chip uses this when it is set. */
    hint?: string;
    /** Short status line on the week block and the agenda row. */
    detail?: string;
    /** Secondary column on the agenda, such as an account. */
    meta?: string;
};

/** Colored fills, or a neutral chip with a colored dot. */
export type BadgeVariant = 'colored' | 'dot';

/**
 * Zone and labels. A plugin supplies these so the calendar stays free of
 * one product's timezone. The social planner passes America/New_York.
 */
export type CalendarTime = {
    dayKey: (utc: number) => string;
    weekKeys: (anchor: number) => string[];
    monthKeys: (anchor: number) => string[];
    shiftAnchor: (anchor: number, unit: 'week' | 'month', delta: -1 | 1) => number;
    clock: (utc: number) => { hour: number; minute: number };
    formatWeekday: (dayKey: string) => string;
    formatDayKey: (dayKey: string) => string;
    dayNumber: (dayKey: string) => number;
    sameMonth: (dayKey: string, anchor: number) => boolean;
    monthTitle: (anchor: number) => string;
    hourLabel: (hour: number) => string;
    formatClock: (utc: number) => string;
    /** Label for a 15-minute slot, such as `9:30 AM`. */
    formatSlot: (hour: number, minute: number) => string;
    /** UTC milliseconds for a day key. The mini month calls this on a click. */
    dayInstant: (dayKey: string) => number;
};

/** One row in the avatar filter. `id` is the value the plugin stores. */
export type FilterAccount = {
    id: string;
    label: string;
    color: string;
    initial: string;
};
