import { useState, type FormEvent } from 'react';

import {
    EVENT_STATUSES,
    EVENT_STATUS_LABEL,
    EVENT_LIMITS,
    type CalendarEventInput,
    type CalendarEventView,
    type EventStatus,
    type EventVisibility,
} from '@socio/shared/calendar';

import { ConfirmDelete } from '../../components/confirm-delete';

import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

const VISIBILITY_LABEL: Record<EventVisibility, string> = {
    workspace: 'Everyone with the calendar',
    private: 'Only me',
};

/** What a new event starts with: a day and a time in the calendar's zone. */
export interface EventSeed {
    date: string;
    time: string;
    timeZone: string;
}

interface Draft {
    title: string;
    allDay: boolean;
    startDate: string;
    startTime: string;
    endDate: string;
    endTime: string;
    location: string;
    description: string;
    status: EventStatus;
    visibility: EventVisibility;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** An hour after `HH:mm` on the same day, capped at 23:59. */
function hourAfter(time: string) {
    const [hour = 9, minute = 0] = time.split(':').map(Number);
    const total = Math.min(23 * 60 + 59, hour * 60 + minute + 60);
    return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

function draftOf(event: CalendarEventView | undefined, seed: EventSeed): Draft {
    if (!event) {
        return {
            title: '',
            allDay: false,
            startDate: seed.date,
            startTime: seed.time,
            endDate: seed.date,
            endTime: hourAfter(seed.time),
            location: '',
            description: '',
            status: 'confirmed',
            visibility: 'workspace',
        };
    }
    const [startDate = '', startTime = '09:00'] = event.startLocal.split('T');
    const [endDate = startDate, endTime = hourAfter(startTime)] = event.endLocal.split('T');
    return {
        title: event.title,
        allDay: event.allDay,
        startDate,
        startTime,
        endDate,
        endTime,
        location: event.location,
        description: event.description,
        status: event.status,
        visibility: event.visibility,
    };
}

/** The draft as the server's input, in `timeZone`. */
function inputOf(draft: Draft, timeZone: string): CalendarEventInput {
    return {
        title: draft.title.trim(),
        allDay: draft.allDay,
        start: draft.allDay ? draft.startDate : `${draft.startDate}T${draft.startTime}`,
        end: draft.allDay ? draft.endDate || draft.startDate : `${draft.endDate || draft.startDate}T${draft.endTime}`,
        timeZone,
        location: draft.location.trim(),
        description: draft.description,
        status: draft.status,
        visibility: draft.visibility,
    };
}

/**
 * One event: a new one, or an existing one to read, change or delete. An
 * existing event keeps the zone it was written in; a new one is in the
 * calendar's. Read-only when the person may not change it.
 */
export function EventDialog({
    event,
    seed,
    onClose,
    onSave,
    onDelete,
}: {
    event?: CalendarEventView;
    seed: EventSeed;
    onClose: () => void;
    onSave: (input: CalendarEventInput) => Promise<void>;
    onDelete: () => Promise<void>;
}) {
    const [draft, setDraft] = useState(() => draftOf(event, seed));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const [confirming, setConfirming] = useState(false);
    const readOnly = !!event && !event.canEdit;
    const timeZone = event?.timeZone ?? seed.timeZone;
    const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
        setDraft((current) => ({ ...current, [key]: value }));
    const submit = async (form: FormEvent) => {
        form.preventDefault();
        if (readOnly) {
            return;
        }
        if (!draft.title.trim()) {
            setError('Give the event a title.');
            return;
        }
        setBusy(true);
        setError(undefined);
        try {
            await onSave(inputOf(draft, timeZone));
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Could not save the event.');
        } finally {
            setBusy(false);
        }
    };
    const sourceLink = event?.sourceUrl && /^https:\/\//i.test(event.sourceUrl) ? event.sourceUrl : undefined;
    return (
        <>
            <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
                <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg" data-slot="calendar-event-dialog">
                    <DialogHeader>
                        <DialogTitle>{!event ? 'New event' : readOnly ? event.title : 'Edit event'}</DialogTitle>
                        <DialogDescription>
                            Times in {timeZone}.
                            {event && (
                                <>
                                    {' '}
                                    Created by {event.createdBy.name}
                                    {event.createdVia ? ` (${event.createdVia})` : ''}.
                                </>
                            )}
                        </DialogDescription>
                    </DialogHeader>
                    <form id="calendar-event-form" className="grid gap-3" onSubmit={(form) => void submit(form)}>
                        <fieldset disabled={readOnly || busy} className="grid gap-3">
                            <label className="grid gap-1 text-sm">
                                <span className="font-medium">Title</span>
                                <Input
                                    value={draft.title}
                                    maxLength={EVENT_LIMITS.title}
                                    required
                                    autoFocus={!event}
                                    onChange={(input) => set('title', input.target.value)}
                                />
                            </label>
                            <label className="flex items-center gap-2 text-sm">
                                <Switch checked={draft.allDay} onCheckedChange={(checked) => set('allDay', checked)} />
                                All day
                            </label>
                            <div className="grid gap-3 sm:grid-cols-2">
                                <fieldset className="grid gap-1 text-sm">
                                    <legend className="mb-1 font-medium">Starts</legend>
                                    <div className="flex flex-wrap gap-2">
                                        <Input
                                            type="date"
                                            aria-label="Start date"
                                            className="w-auto min-w-36 flex-1"
                                            value={draft.startDate}
                                            required
                                            onChange={(input) => {
                                                const value = input.target.value;
                                                setDraft((current) => ({
                                                    ...current,
                                                    startDate: value,
                                                    endDate:
                                                        !current.endDate || current.endDate < value
                                                            ? value
                                                            : current.endDate,
                                                }));
                                            }}
                                        />
                                        {!draft.allDay && (
                                            <Input
                                                type="time"
                                                aria-label="Start time"
                                                className="w-auto min-w-28"
                                                value={draft.startTime}
                                                required
                                                onChange={(input) => set('startTime', input.target.value)}
                                            />
                                        )}
                                    </div>
                                </fieldset>
                                <fieldset className="grid gap-1 text-sm">
                                    <legend className="mb-1 font-medium">{draft.allDay ? 'Last day' : 'Ends'}</legend>
                                    <div className="flex flex-wrap gap-2">
                                        <Input
                                            type="date"
                                            aria-label={draft.allDay ? 'Last day' : 'End date'}
                                            className="w-auto min-w-36 flex-1"
                                            value={draft.endDate}
                                            min={draft.startDate}
                                            onChange={(input) => set('endDate', input.target.value)}
                                        />
                                        {!draft.allDay && (
                                            <Input
                                                type="time"
                                                aria-label="End time"
                                                className="w-auto min-w-28"
                                                value={draft.endTime}
                                                required
                                                onChange={(input) => set('endTime', input.target.value)}
                                            />
                                        )}
                                    </div>
                                </fieldset>
                            </div>
                            <label className="grid gap-1 text-sm">
                                <span className="font-medium">Location</span>
                                <Input
                                    value={draft.location}
                                    maxLength={EVENT_LIMITS.location}
                                    placeholder="A room or a place"
                                    onChange={(input) => set('location', input.target.value)}
                                />
                            </label>
                            <div className="grid gap-3 sm:grid-cols-2">
                                <div className="grid min-w-0 gap-1 text-sm">
                                    <span className="font-medium" id="calendar-event-status">
                                        Status
                                    </span>
                                    <Select
                                        value={draft.status}
                                        disabled={readOnly || busy}
                                        onValueChange={(value) => set('status', value as EventStatus)}
                                    >
                                        <SelectTrigger
                                            className="w-full min-w-0"
                                            aria-labelledby="calendar-event-status"
                                        >
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {EVENT_STATUSES.map((status) => (
                                                <SelectItem key={status} value={status}>
                                                    {EVENT_STATUS_LABEL[status]}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="grid min-w-0 gap-1 text-sm">
                                    <span className="font-medium" id="calendar-event-visibility">
                                        Who sees it
                                    </span>
                                    <Select
                                        value={draft.visibility}
                                        disabled={readOnly || busy}
                                        onValueChange={(value) => set('visibility', value as EventVisibility)}
                                    >
                                        <SelectTrigger
                                            className="w-full min-w-0"
                                            aria-labelledby="calendar-event-visibility"
                                        >
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {(['workspace', 'private'] as const).map((value) => (
                                                <SelectItem key={value} value={value}>
                                                    {VISIBILITY_LABEL[value]}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                            </div>
                            <label className="grid gap-1 text-sm">
                                <span className="font-medium">Notes</span>
                                <Textarea
                                    value={draft.description}
                                    maxLength={EVENT_LIMITS.description}
                                    rows={4}
                                    onChange={(input) => set('description', input.target.value)}
                                />
                            </label>
                        </fieldset>
                        {event?.source && (
                            <p className="text-xs text-muted-foreground" data-slot="calendar-event-source">
                                Copied from {event.source}
                                {event.sourceId ? ` (${event.sourceId})` : ''}.
                                {sourceLink && (
                                    <>
                                        {' '}
                                        <a
                                            href={sourceLink}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="underline underline-offset-2"
                                        >
                                            Open the original
                                        </a>
                                        .
                                    </>
                                )}
                            </p>
                        )}
                        {readOnly && (
                            <p className="text-xs text-muted-foreground">
                                Only the person who added it, or an admin, can change it.
                            </p>
                        )}
                        {error && (
                            <p className="text-sm text-destructive" role="alert">
                                {error}
                            </p>
                        )}
                    </form>
                    <DialogFooter className="gap-2 sm:justify-between">
                        {event?.canEdit ? (
                            <Button
                                type="button"
                                variant="ghost"
                                className="text-destructive"
                                disabled={busy}
                                onClick={() => setConfirming(true)}
                            >
                                Delete
                            </Button>
                        ) : (
                            <span />
                        )}
                        <div className="flex flex-wrap justify-end gap-2">
                            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
                                {readOnly ? 'Close' : 'Cancel'}
                            </Button>
                            {!readOnly && (
                                <Button type="submit" form="calendar-event-form" disabled={busy}>
                                    {event ? 'Save' : 'Add event'}
                                </Button>
                            )}
                        </div>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
            {confirming && event && (
                <ConfirmDelete
                    title={`Delete ${event.title}?`}
                    slot="calendar-event-delete"
                    onClose={() => setConfirming(false)}
                    onConfirm={async () => {
                        try {
                            await onDelete();
                        } catch (reason) {
                            setError(reason instanceof Error ? reason.message : 'Could not delete the event.');
                        }
                        setConfirming(false);
                    }}
                >
                    It goes for everyone who can see it. A sync that copied it may add it again.
                </ConfirmDelete>
            )}
        </>
    );
}
