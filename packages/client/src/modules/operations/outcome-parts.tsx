import { useTranslation } from '@socio/i18n/react';
import { formatNumber } from '@socio/shared/locale';
import { OPS_OUTCOMES, type OpsOutcome } from '@socio/shared/operations/operations-activity';
import { intentName, type OpsIntentRow } from '@socio/shared/operations/operations-themes';

import { formatShare } from './activity-parts';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

/** Each outcome's mark: done in the good status color, abandoned in the critical one. */
export const OUTCOME_MARK: Record<OpsOutcome, string> = {
    completed: 'bg-emerald-600 dark:bg-emerald-500',
    answered: 'bg-muted-foreground/40',
    abandoned: 'bg-destructive',
};

/** A row's outcomes as one thin bar, with its shares as its name. */
export function OutcomeBar({ row }: { row: Record<OpsOutcome, number> & { sessions: number } }) {
    const { t } = useTranslation(['operations', 'operations.dashboard']);
    const total = OPS_OUTCOMES.reduce((sum, id) => sum + row[id], 0);
    return (
        <div
            role="img"
            aria-label={OPS_OUTCOMES.map((id) =>
                t('operations.dashboard:outcomes.share', {
                    outcome: t(`operations.dashboard:outcomes.${id}`),
                    share: formatShare(total ? row[id] / total : null),
                }),
            ).join(', ')}
            className="flex h-2 min-w-24 gap-0.5 overflow-hidden rounded-full bg-muted"
        >
            {total > 0 &&
                OPS_OUTCOMES.map((id) =>
                    row[id] ? (
                        <span
                            key={id}
                            className={cn('h-full', OUTCOME_MARK[id])}
                            style={{ width: `${(row[id] / total) * 100}%` }}
                        />
                    ) : null,
                )}
        </div>
    );
}

/** The outcome legend under a card's bars. */
export function OutcomeLegend() {
    const { t } = useTranslation(['operations', 'operations.dashboard']);
    return (
        <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-xs text-muted-foreground">
            {OPS_OUTCOMES.map((id) => (
                <li key={id} className="flex items-center gap-1.5">
                    <span aria-hidden className={cn('size-2 rounded-full', OUTCOME_MARK[id])} />
                    {t(`operations.dashboard:outcomes.${id}`)}
                </li>
            ))}
        </ul>
    );
}

/** Sessions by intent with how they ended: Value's card and Themes'. */
export function IntentTable({ rows, slot = 'ops-intents' }: { rows: OpsIntentRow[]; slot?: string }) {
    const { t } = useTranslation(['operations', 'operations.dashboard']);
    return (
        <div className="grid gap-3" data-slot={slot}>
            <Table aria-label={t('operations.dashboard:intents.label')}>
                <TableHeader>
                    <TableRow>
                        <TableHead>{t('operations.dashboard:intents.intent')}</TableHead>
                        <TableHead className="text-right">{t('operations.dashboard:intents.sessions')}</TableHead>
                        <TableHead className="text-right">{t('operations.dashboard:intents.people')}</TableHead>
                        <TableHead className="text-right">{t('operations.dashboard:intents.completed')}</TableHead>
                        <TableHead className="text-right">{t('operations.dashboard:intents.abandoned')}</TableHead>
                        <TableHead className="w-40">{t('operations.dashboard:intents.outcomes')}</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {rows.map((row) => (
                        <TableRow key={row.intent ?? ''} data-intent={row.intent ?? ''}>
                            <TableCell className={cn('font-medium', row.intent === null && 'text-muted-foreground')}>
                                {row.intent === null ? t('operations.dashboard:intents.none') : intentName(row.intent)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{formatNumber(row.sessions)}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatNumber(row.people)}</TableCell>
                            <TableCell className="text-right tabular-nums">
                                {formatShare(row.sessions ? row.completed / row.sessions : null)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                                {formatShare(row.sessions ? row.abandoned / row.sessions : null)}
                            </TableCell>
                            <TableCell>
                                <OutcomeBar row={row} />
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
            <OutcomeLegend />
        </div>
    );
}
