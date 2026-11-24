import { ChevronLeft, ChevronRight, Plus, Rss } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Calendar, MiniMonth, markedDayKeys, type CalendarEvent } from '@socio/plugin-ui';
import {
    EVENT_STATUS_LABEL,
    addDaysToKey,
    dayStart,
    localStampIn,
    zonedInstant,
    type CalendarEventInput,
    type CalendarEventView,
    type CalendarState,
} from '@socio/shared/calendar';
import { compareText } from '@socio/shared/locale';

import { calendarApi } from './api';
import { EventDialog, type EventSeed } from './EventDialog';
import { FeedDialog } from './FeedDialog';
import { localStamp, rangeLabel, zoneTime } from './time';

import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

type View = 'week' | 'month' | 'agenda';

const VIEWS: { id: View; label: string }[] = [
    { id: 'week', label: 'Week' },
    { id: 'month', label: 'Month' },
    { id: 'agenda', label: 'Agenda' },
];

const ALL = '__all__';

const STATUS_COLOR: Record<CalendarEventView['status'], string> = {
    confirmed: 'var(--chart-1)',
    tentative: 'var(--chart-4)',
    cancelled: 'var(--muted-foreground)',
};

/** A plugin-ui event for a calendar row. */
export function toCalendarEvent(event: CalendarEventView): CalendarEvent {
    const status = event.status === 'confirmed' ? '' : EVENT_STATUS_LABEL[event.status];
    return {
        id: event.id,
        title: event.status === 'cancelled' ? `${event.title} (canceled)` : event.title,
        start: event.startAt,
        end: event.endAt,
        allDay: event.allDay,
        color: STATUS_COLOR[event.status],
        detail: [event.location, status].filter(Boolean).join(' · ') || undefined,
        meta: event.location || undefined,
        hint: [event.title, event.location, status].filter(Boolean).join(' · '),
    };
}

/** Whole days an all-day event spans after its first (0 for one day). */
function extraDays(event: CalendarEventView) {
    const first = Date.parse(`${event.startLocal}T00:00Z`);
    const last = Date.parse(`${event.endLocal.slice(0, 10)}T00:00Z`);
    return Number.isFinite(first) && Number.isFinite(last) ? Math.max(0, Math.round((last - first) / 86_400_000)) : 0;
}

/**
 * The calendar plugin's page (CB-254): week, month and agenda views of the
 * events this person can see, in the calendar's zone. Runs inside Socio,
 * as the signed-in person; the server decides what they may see and change.
 */
export function CalendarPage() {
    const [state, setState] = useState<CalendarState>();
    const [error, setError] = useState<string>();
    const [notice, setNotice] = useState<string>();
    const [view, setView] = useState<View>('week');
    const [anchor, setAnchor] = useState<number>();
    const [location, setLocation] = useState(ALL);
    const [showCancelled, setShowCancelled] = useState(false);
    const [editing, setEditing] = useState<{ event?: CalendarEventView; seed: EventSeed } | undefined>();
    const [feedOpen, setFeedOpen] = useState(false);
    const [timeZone, setTimeZone] = useState<string>();

    // Phones start on the agenda; the week grid needs room.
    useEffect(() => {
        if (window.matchMedia?.('(max-width: 639px)').matches) {
            setView('agenda');
        }
    }, []);

    const time = useMemo(() => zoneTime(timeZone ?? 'UTC'), [timeZone]);
    const at = anchor ?? state?.now ?? 0;
    const keys = useMemo(() => (view === 'month' ? time.monthKeys(at) : time.weekKeys(at)), [time, view, at]);
    const first = keys[0];
    const last = keys[keys.length - 1];

    const load = useCallback(
        async (signal?: AbortSignal) => {
            // Before the first answer the zone is unknown: ask for a wide window
            // around now, and narrow it once the calendar says where it is.
            const now = Date.now();
            const zone = timeZone ?? 'UTC';
            const from = anchor === undefined || !first ? now - 40 * 86_400_000 : dayStart(first, zone);
            const to = anchor === undefined || !last ? now + 40 * 86_400_000 : dayStart(addDaysToKey(last, 1), zone);
            try {
                const next = await calendarApi.state(from, to, signal);
                setState(next);
                setTimeZone(next.timeZone);
                setAnchor((current) => current ?? next.now);
                setError(undefined);
            } catch (reason) {
                if (signal?.aborted) {
                    return;
                }
                setError(reason instanceof Error ? reason.message : 'The calendar could not be loaded.');
            }
        },
        [anchor, first, last, timeZone],
    );

    useEffect(() => {
        const controller = new AbortController();
        void load(controller.signal);
        return () => controller.abort();
    }, [load]);

    const locations = useMemo(() => {
        const found = new Set<string>();
        for (const event of state?.events ?? []) {
            if (event.location) {
                found.add(event.location);
            }
        }
        return [...found].sort(compareText);
    }, [state]);
    const visible = useMemo(
        () =>
            (state?.events ?? []).filter(
                (event) =>
                    (showCancelled || event.status !== 'cancelled') &&
                    (location === ALL || event.location === location),
            ),
        [state, showCancelled, location],
    );
    const events = useMemo(() => visible.map(toCalendarEvent), [visible]);
    const byId = useMemo(() => new Map((state?.events ?? []).map((event) => [event.id, event])), [state]);

    if (!state || !timeZone) {
        return (
            <main
                className="flex min-h-0 w-full flex-1 flex-col gap-3 p-4"
                data-slot="calendar-plugin"
                aria-busy={!error}
            >
                {error ? (
                    <p className="text-sm text-destructive" role="alert">
                        {error}
                    </p>
                ) : (
                    <>
                        <Skeleton className="h-10 w-64" />
                        <Skeleton className="min-h-80 flex-1" />
                    </>
                )}
            </main>
        );
    }

    const nav = view === 'month' ? 'month' : 'week';
    const today = time.dayKey(state.now);
    const title = view === 'month' ? time.monthTitle(at) : rangeLabel(keys);
    const startNew = (day: string, hour: number, minute: number) => {
        if (!state.canWrite) {
            return;
        }
        setEditing({
            seed: {
                date: day,
                time: localStamp(day, hour, minute).slice(11),
                timeZone: state.timeZone,
            },
        });
    };
    const reload = async (message?: string) => {
        await load();
        if (message) {
            setNotice(message);
        }
    };
    const save = async (input: CalendarEventInput) => {
        const current = editing?.event;
        if (current) {
            await calendarApi.update(current.id, input);
            setEditing(undefined);
            await reload('Event saved.');
        } else {
            const { outcome } = await calendarApi.create(input);
            setEditing(undefined);
            await reload(outcome === 'updated' ? 'That event was already here; it was updated.' : 'Event added.');
        }
    };
    const move = async (item: CalendarEvent, day: string, hour?: number, minute?: number) => {
        const event = byId.get(item.id);
        if (!event?.canEdit) {
            if (event) {
                setError('Only the person who added it, or an admin, can move it.');
            }
            return;
        }
        let patch: Partial<CalendarEventInput>;
        if (event.allDay) {
            if (day === event.startLocal) {
                return;
            }
            patch = {
                allDay: true,
                start: day,
                end: addDaysToKey(day, extraDays(event)),
                timeZone: event.timeZone,
            };
        } else {
            const clock = hour === undefined ? time.clock(event.startAt) : { hour, minute: minute ?? 0 };
            const [year, month, date] = day.split('-').map(Number);
            // The new start in the calendar's zone, then written in the event's.
            const startAt = zonedInstant(year!, month!, date!, clock.hour, clock.minute, state.timeZone);
            if (startAt === event.startAt) {
                return;
            }
            const endAt = startAt + (event.endAt - event.startAt);
            patch = {
                allDay: false,
                start: localStampIn(startAt, event.timeZone),
                end: localStampIn(endAt, event.timeZone),
                timeZone: event.timeZone,
            };
        }
        try {
            await calendarApi.update(event.id, patch);
            await reload(`Moved to ${time.formatDayKey(day)}.`);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Could not move it.');
        }
    };

    return (
        <main className="flex min-h-0 w-full flex-1 overflow-hidden" data-slot="calendar-plugin">
            <aside className="hidden w-64 shrink-0 flex-col gap-4 border-r p-3 lg:flex">
                <MiniMonth
                    anchor={at}
                    today={today}
                    marked={markedDayKeys(
                        visible.map((event) => event.startAt),
                        time,
                    )}
                    time={time}
                    onPick={setAnchor}
                />
                <p className="text-xs leading-relaxed text-muted-foreground">
                    Times are {state.timeZone}. Drag an event to another day or time.
                    {state.canWrite ? ' Click an empty slot to add one.' : ''}
                </p>
            </aside>
            <div className="flex min-w-0 flex-1 flex-col">
                <header className="flex shrink-0 flex-col gap-3 border-b px-3 py-3 sm:px-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-2">
                            <div className="flex items-center gap-1">
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="icon-sm"
                                    aria-label={nav === 'week' ? 'Previous week' : 'Previous month'}
                                    onClick={() => setAnchor(time.shiftAnchor(at, nav, -1))}
                                >
                                    <ChevronLeft />
                                </Button>
                                <Button type="button" variant="ghost" size="sm" onClick={() => setAnchor(Date.now())}>
                                    Today
                                </Button>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="icon-sm"
                                    aria-label={nav === 'week' ? 'Next week' : 'Next month'}
                                    onClick={() => setAnchor(time.shiftAnchor(at, nav, 1))}
                                >
                                    <ChevronRight />
                                </Button>
                            </div>
                            <div className="min-w-0">
                                <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
                                <p className="text-xs text-muted-foreground">Times in {state.timeZone}</p>
                            </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            <Tabs value={view} onValueChange={(value) => setView(value as View)}>
                                <TabsList aria-label="Calendar views">
                                    {VIEWS.map((item) => (
                                        <TabsTrigger key={item.id} value={item.id}>
                                            {item.label}
                                        </TabsTrigger>
                                    ))}
                                </TabsList>
                            </Tabs>
                            {state.canWrite && (
                                <Button type="button" size="sm" onClick={() => startNew(time.dayKey(at), 9, 0)}>
                                    <Plus /> New event
                                </Button>
                            )}
                            <Button type="button" variant="outline" size="sm" onClick={() => setFeedOpen(true)}>
                                <Rss /> Subscribe
                            </Button>
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                        <Select value={location} onValueChange={setLocation}>
                            <SelectTrigger className="w-52 max-w-full" aria-label="Location">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={ALL}>All locations</SelectItem>
                                {locations.map((item) => (
                                    <SelectItem key={item} value={item}>
                                        {item}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <label className="flex items-center gap-2 text-sm">
                            <Switch checked={showCancelled} onCheckedChange={setShowCancelled} />
                            Show cancelled
                        </label>
                    </div>
                </header>
                {notice && (
                    <p className="px-4 pt-2 text-sm text-muted-foreground" aria-live="polite">
                        {notice}
                    </p>
                )}
                {error && (
                    <p className="px-4 pt-2 text-sm text-destructive" role="alert">
                        {error}
                    </p>
                )}
                {state.events.length === 0 && (
                    <p className="px-4 pt-3 text-sm text-muted-foreground">
                        Nothing here in these dates.
                        {state.canWrite
                            ? ' Click a time slot or New event to add one; socios and connected agents can add events too.'
                            : ''}
                    </p>
                )}
                <Calendar
                    view={view}
                    anchor={at}
                    todayKey={today}
                    keys={keys}
                    events={events}
                    now={Date.now()}
                    variant="colored"
                    time={time}
                    addLabel="Add event"
                    emptyLabel="Nothing scheduled"
                    onOpen={(item) => {
                        const event = byId.get(item.id);
                        if (event) {
                            setEditing({
                                event,
                                seed: {
                                    date: event.startLocal.slice(0, 10),
                                    time: '09:00',
                                    timeZone: state.timeZone,
                                },
                            });
                        }
                    }}
                    onMove={(item, day, hour, minute) => void move(item, day, hour, minute)}
                    onCreate={startNew}
                />
            </div>
            {editing && (
                <EventDialog
                    event={editing.event}
                    seed={editing.seed}
                    onClose={() => setEditing(undefined)}
                    onSave={save}
                    onDelete={async () => {
                        if (!editing.event) {
                            return;
                        }
                        await calendarApi.remove(editing.event.id);
                        setEditing(undefined);
                        await reload('Event deleted.');
                    }}
                />
            )}
            {feedOpen && (
                <FeedDialog
                    feed={state.feed}
                    onClose={() => setFeedOpen(false)}
                    onCreate={async () => {
                        const { url } = await calendarApi.createFeed();
                        await load();
                        return url;
                    }}
                    onRemove={async () => {
                        await calendarApi.removeFeed();
                        await load();
                    }}
                />
            )}
        </main>
    );
}
