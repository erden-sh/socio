import { useId, useRef, useState } from 'react';

import {
    REPORT_CONFIRMATION,
    REPORT_NOTE_MAX,
    REPORT_REASONS,
    fillReportText,
    reportNoteLength,
    type ReportReason,
} from '@socio/shared/chat/reply-reports';
import { formatNumber } from '@socio/shared/locale';

import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/**
 * The confirmation before a thumbs-down goes to Ingenio as an AI reply
 * report (CB-382, docs/specs/REPLY-REPORTS.md §2): what goes and what
 * stays, the line about another person's message when the server said so,
 * a reason (required) and an optional note of at most `REPORT_NOTE_MAX`
 * code points after trimming. Cancel sends nothing.
 */
export function ReportDialog({
    socio,
    byOther,
    onConfirm,
    onCancel,
}: {
    /** The socio whose reply it is. */
    socio: string;
    /** The other person's name, when their message goes too (`promptByOther`). */
    byOther?: string;
    onConfirm: (choice: { reason: ReportReason; note?: string }) => void;
    onCancel: () => void;
}) {
    const [reason, setReason] = useState<ReportReason>();
    const [note, setNote] = useState('');
    const first = useRef<HTMLInputElement>(null);
    const id = useId();
    const length = reportNoteLength(note);
    const over = length > REPORT_NOTE_MAX;
    const trimmed = note.trim();
    return (
        <AlertDialog open onOpenChange={(open) => !open && onCancel()}>
            <AlertDialogContent
                data-slot="report-dialog"
                className="max-h-[90dvh] overflow-y-auto"
                onOpenAutoFocus={(event) => {
                    event.preventDefault();
                    first.current?.focus();
                }}
            >
                <AlertDialogHeader>
                    <AlertDialogTitle>{REPORT_CONFIRMATION.title}</AlertDialogTitle>
                    <AlertDialogDescription asChild>
                        <div className="grid gap-2">
                            <p>{fillReportText(REPORT_CONFIRMATION.body, { socio })}</p>
                            {byOther !== undefined && (
                                <p data-slot="report-by-other" className="font-medium text-foreground">
                                    {fillReportText(REPORT_CONFIRMATION.byOther, { author: byOther })}
                                </p>
                            )}
                        </div>
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <fieldset className="grid gap-2 text-sm" data-slot="report-reasons">
                    <legend className="mb-2 font-medium">Reason</legend>
                    {REPORT_REASONS.map((option, index) => (
                        <label
                            key={option.id}
                            className={cn(
                                'flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
                                reason === option.id && 'border-primary/60 bg-accent/60',
                            )}
                        >
                            <input
                                ref={index === 0 ? first : undefined}
                                type="radio"
                                name={`${id}-reason`}
                                value={option.id}
                                className="size-4 flex-none accent-primary"
                                checked={reason === option.id}
                                onChange={() => setReason(option.id)}
                            />
                            {option.label}
                        </label>
                    ))}
                </fieldset>
                <div className="grid gap-1 text-sm">
                    <label htmlFor={`${id}-note`} className="font-medium">
                        Note (optional)
                    </label>
                    <Textarea
                        id={`${id}-note`}
                        value={note}
                        onChange={(event) => setNote(event.target.value)}
                        aria-invalid={over}
                        aria-describedby={`${id}-count`}
                        rows={3}
                    />
                    <p
                        id={`${id}-count`}
                        data-slot="report-note-count"
                        className={cn('text-xs tabular-nums', over ? 'text-destructive' : 'text-muted-foreground')}
                    >
                        {formatNumber(length)} / {formatNumber(REPORT_NOTE_MAX)}
                    </p>
                    {over && (
                        <p role="alert" data-slot="report-note-over" className="text-xs text-destructive">
                            The note is {formatNumber(length - REPORT_NOTE_MAX)}{' '}
                            {length - REPORT_NOTE_MAX === 1 ? 'character' : 'characters'} too long.
                        </p>
                    )}
                </div>
                <AlertDialogFooter>
                    <AlertDialogCancel>{REPORT_CONFIRMATION.cancel}</AlertDialogCancel>
                    <Button
                        variant="destructive"
                        data-slot="report-confirm"
                        disabled={!reason || over}
                        onClick={() => reason && onConfirm(trimmed ? { reason, note: trimmed } : { reason })}
                    >
                        {REPORT_CONFIRMATION.confirm}
                    </Button>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}

/**
 * The warning before removing a thumbs-down whose report went (§5):
 * removing it doesn't recall the report. Confirm goes on with the change.
 */
export function RemoveSharedDialog({
    action,
    onConfirm,
    onCancel,
}: {
    /** What the confirm button does ("Remove thumbs-down", "Switch to thumbs-up"). */
    action: string;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    return (
        <AlertDialog open onOpenChange={(open) => !open && onCancel()}>
            <AlertDialogContent data-slot="remove-shared-dialog">
                <AlertDialogHeader>
                    <AlertDialogTitle>Remove your thumbs-down?</AlertDialogTitle>
                    <AlertDialogDescription>
                        Your report on this reply went to Ingenio. {REPORT_CONFIRMATION.removeShared}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <Button data-slot="remove-shared-confirm" onClick={onConfirm}>
                        {action}
                    </Button>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
