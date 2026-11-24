import { useState } from 'react';

import type { ScheduleView } from '@socio/shared/schedule-types';

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

/**
 * Cancel a schedule only after typing its title exactly (CB-392). A
 * canceled schedule won't run again and can't be resumed, so the
 * confirmation names it — the same "type the name to confirm" treatment
 * the People grid's destructive actions use. Used by both the Schedules
 * list's row menu and the schedule's own details page.
 */
export function CancelScheduleDialog({
    schedule,
    onClose,
    onConfirm,
}: {
    schedule: Pick<ScheduleView, 'title'>;
    onClose: () => void;
    onConfirm: () => Promise<void>;
}) {
    const [typed, setTyped] = useState('');
    const [busy, setBusy] = useState(false);
    const matches = typed === schedule.title;
    return (
        <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
            <DialogContent data-slot="schedule-cancel-confirm">
                <DialogHeader>
                    <DialogTitle>Cancel “{schedule.title}”?</DialogTitle>
                    <DialogDescription>
                        A canceled schedule won’t run again and can’t be resumed. Its goal stays, but its progress stops
                        here. Type the title exactly to confirm.
                    </DialogDescription>
                </DialogHeader>
                <label className="grid gap-1 text-sm">
                    <span>
                        Type <strong className="select-all">{schedule.title}</strong> to confirm
                    </span>
                    <Input
                        aria-label="Schedule title"
                        value={typed}
                        onChange={(e) => setTyped(e.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                        autoFocus
                    />
                    {typed && !matches && (
                        <span className="text-xs text-muted-foreground" data-slot="cancel-name-mismatch">
                            Type it exactly as shown.
                        </span>
                    )}
                </label>
                <DialogFooter>
                    <Button variant="ghost" disabled={busy} onClick={onClose}>
                        Keep it
                    </Button>
                    <Button
                        variant="destructive"
                        disabled={busy || !matches}
                        onClick={async () => {
                            setBusy(true);
                            try {
                                await onConfirm();
                            } finally {
                                setBusy(false);
                            }
                        }}
                    >
                        Cancel schedule
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
