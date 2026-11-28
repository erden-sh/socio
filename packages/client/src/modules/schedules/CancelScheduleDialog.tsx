import { useState } from 'react';

import { Trans, useTranslation } from '@socio/i18n/react';
import type { ScheduleView } from '@socio/shared/schedule-types';

import { onDemand } from '../../i18n/on-demand';

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
 * list's row menu and the schedule's own details page. Its words
 * (`schedules.dialogs`) load on demand when it opens.
 */
function CancelScheduleDialogView({
    schedule,
    onClose,
    onConfirm,
}: {
    schedule: Pick<ScheduleView, 'title'>;
    onClose: () => void;
    onConfirm: () => Promise<void>;
}) {
    const { t } = useTranslation(['schedules.dialogs']);
    const [typed, setTyped] = useState('');
    const [busy, setBusy] = useState(false);
    const matches = typed === schedule.title;
    return (
        <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
            <DialogContent data-slot="schedule-cancel-confirm">
                <DialogHeader>
                    <DialogTitle>{t('schedules.dialogs:cancel.title', { title: schedule.title })}</DialogTitle>
                    <DialogDescription>{t('schedules.dialogs:cancel.description')}</DialogDescription>
                </DialogHeader>
                <label className="grid gap-1 text-sm">
                    <span>
                        <Trans
                            t={t}
                            i18nKey="schedules.dialogs:cancel.type"
                            values={{ title: schedule.title }}
                            components={{ title: <strong className="select-all" /> }}
                        />
                    </span>
                    <Input
                        aria-label={t('schedules.dialogs:cancel.label')}
                        value={typed}
                        onChange={(e) => setTyped(e.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                        autoFocus
                    />
                    {typed && !matches && (
                        <span className="text-xs text-muted-foreground" data-slot="cancel-name-mismatch">
                            {t('schedules.dialogs:cancel.mismatch')}
                        </span>
                    )}
                </label>
                <DialogFooter>
                    <Button variant="ghost" disabled={busy} onClick={onClose}>
                        {t('schedules.dialogs:cancel.keep')}
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
                        {t('schedules.dialogs:cancel.confirm')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export const CancelScheduleDialog = onDemand(['schedules.dialogs'], CancelScheduleDialogView);
