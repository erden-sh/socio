/**
 * Mini-month side panel adapted from the big-calendar client shell
 * (lramos33/big-calendar, MIT), which keeps a month picker beside the grid.
 * Copyright (c) 2025 Leonardo Ramos.
 */
import { ChevronLeft, ChevronRight } from 'lucide-react';

import type { CalendarTime } from './types';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function MiniMonth({
    anchor,
    today,
    marked,
    time,
    onPick,
}: {
    anchor: number;
    today: string;
    marked: ReadonlySet<string>;
    time: CalendarTime;
    onPick: (utc: number) => void;
}) {
    const keys = time.monthKeys(anchor);
    const selected = new Set(time.weekKeys(anchor));
    const heads = keys.slice(0, 7).map((key) => time.formatWeekday(key).slice(0, 1));
    return (
        <div className="grid gap-2">
            <div className="flex items-center justify-between gap-1">
                <p className="text-sm font-medium">{time.monthTitle(anchor)}</p>
                <div className="flex">
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Previous month"
                        onClick={() => onPick(time.shiftAnchor(anchor, 'month', -1))}
                    >
                        <ChevronLeft />
                    </Button>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Next month"
                        onClick={() => onPick(time.shiftAnchor(anchor, 'month', 1))}
                    >
                        <ChevronRight />
                    </Button>
                </div>
            </div>
            <div className="grid grid-cols-7 text-center text-[10px] font-medium text-muted-foreground">
                {heads.map((label, index) => (
                    <div key={`${label}-${index}`}>{label}</div>
                ))}
            </div>
            <div className="grid grid-cols-7 gap-y-0.5 text-center">
                {keys.map((key) => {
                    const inMonth = time.sameMonth(key, anchor);
                    const isToday = key === today;
                    return (
                        <button
                            key={key}
                            type="button"
                            onClick={() => onPick(time.dayInstant(key))}
                            className={cn(
                                'relative mx-auto flex size-7 items-center justify-center rounded-full text-xs tabular-nums',
                                selected.has(key) && 'bg-accent',
                                !inMonth && 'text-muted-foreground/50',
                                isToday && 'bg-primary text-primary-foreground',
                            )}
                        >
                            {time.dayNumber(key)}
                            {marked.has(key) && (
                                <span
                                    aria-hidden
                                    className={cn(
                                        'absolute bottom-0.5 size-1 rounded-full',
                                        isToday ? 'bg-primary-foreground' : 'bg-primary',
                                    )}
                                />
                            )}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

export function markedDayKeys(starts: readonly number[], time: Pick<CalendarTime, 'dayKey'>) {
    return new Set(starts.map((start) => time.dayKey(start)));
}
