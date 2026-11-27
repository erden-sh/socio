import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import { Trans, useTranslation } from '@socio/i18n/react';
import {
    CLASSIFY_PER_DAY,
    CLASSIFY_THRESHOLD,
    MIN_ANSWERED,
    MIN_GOLDEN,
    type ClassifyEvalReport,
    type ClassifyUse,
    type ClassifyUseView,
} from '@socio/shared/classify';
import { formatNumber, numberFormat } from '@socio/shared/locale';

import { api } from '../../lib/api';
import { SettingsCard } from '../settings/AccountSettings';

import { formatWhen } from './format';
import { useOpsSettings } from './use-ops';

import { PermissionRow } from '@/components/form-fields';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const percent = numberFormat({ style: 'percent', maximumFractionDigits: 0 });
const dollars = numberFormat({
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
});
const share = (value: number | null) => (value === null ? '–' : percent.format(value));

export interface ClassifyUseCardProps {
    use: ClassifyUse;
    title: string;
    /** What the use does, under the title. */
    intro: ReactNode;
    /** The switch's title and help. */
    switchTitle: string;
    switchHelp: ReactNode;
    /** The `data-slot` prefix (`failure-label`: `failure-label-settings`, …). */
    slot: string;
    /** A label's name in the evaluation's table. */
    labelName?: (label: string) => string;
    /** More of the card, below the status (intent's list of labels). */
    extra?: (props: {
        view: ClassifyUseView;
        busy: boolean;
        send: (method: string, path: string, body?: unknown) => Promise<boolean>;
    }) => ReactNode;
}

/**
 * Operations → Settings, one use of the classification seam (CB-198,
 * CB-199): its switch (off by default), threshold and daily cap, an
 * admin's over the server's (`CLASSIFY_<USE>*`); what it costs; the
 * golden set of admins' labels, and evaluating the model against it,
 * which is what lets its labels count.
 */
export function ClassifyUseCard({
    use,
    title,
    intro,
    switchTitle,
    switchHelp,
    slot,
    labelName = (label) => label,
    extra,
}: ClassifyUseCardProps) {
    const { t } = useTranslation(['operations.labeling']);
    const PATH = `/classify/uses/${use}`;
    const { timeZone } = useOpsSettings();
    const [view, setView] = useState<ClassifyUseView>();
    const [enabled, setEnabled] = useState(false);
    const [threshold, setThreshold] = useState('');
    const [perDay, setPerDay] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const loaded = useCallback((next: ClassifyUseView) => {
        setView(next);
        setEnabled(next.enabled);
        setThreshold(String(Math.round(next.threshold * 100)));
        setPerDay(String(next.perDay));
    }, []);
    const evaluating = !!view?.evaluating;
    useEffect(() => {
        const controller = new AbortController();
        const load = () =>
            api<ClassifyUseView>(PATH, 'GET', undefined, controller.signal)
                .then((next) => {
                    if (controller.signal.aborted) {
                        return;
                    }
                    // While it evaluates, only the status changes.
                    if (evaluating) {
                        setView(next);
                    } else {
                        loaded(next);
                    }
                })
                .catch((e: unknown) => {
                    if (!controller.signal.aborted) {
                        setError(e instanceof Error ? e.message : t('operations.labeling:load-failed'));
                    }
                });
        void load();
        const timer = evaluating ? setInterval(() => void load(), 3000) : undefined;
        return () => {
            controller.abort();
            if (timer) {
                clearInterval(timer);
            }
        };
    }, [loaded, evaluating, PATH, t]);

    const percent = Number(threshold);
    const cap = Number(perDay);
    const valid =
        /^\d+$/.test(threshold) &&
        percent >= CLASSIFY_THRESHOLD.min * 100 &&
        percent <= CLASSIFY_THRESHOLD.max * 100 &&
        /^\d+$/.test(perDay) &&
        cap >= CLASSIFY_PER_DAY.min &&
        cap <= CLASSIFY_PER_DAY.max;

    const send = async (method: string, path: string, body?: unknown) => {
        setBusy(true);
        setError('');
        try {
            loaded(await api<ClassifyUseView>(path, method, body));
            return true;
        } catch (e) {
            setError(e instanceof Error ? e.message : t('operations.labeling:save-failed'));
            return false;
        } finally {
            setBusy(false);
        }
    };

    const pass = view?.versionPassed;
    const golden = view ? t('operations.labeling:card.golden-count', { count: view.golden }) : '';
    const goldenLine =
        view && view.golden < MIN_GOLDEN
            ? t('operations.labeling:card.golden-needs', { golden, min: MIN_GOLDEN })
            : golden;
    const calls = view
        ? t('operations.labeling:card.calls', {
              calls: view.callsToday,
              perDay: view.perDay,
              evaluating: view.evalCallsToday,
              tokens: view.tokensToday,
              cost:
                  view.costToday === null ? t('operations.labeling:card.cost-unknown') : dollars.format(view.costToday),
          })
        : '';
    const dayLine =
        view?.unknownCostCalls && view.costToday !== null
            ? t('operations.labeling:card.no-cost', { text: calls, count: view.unknownCostCalls })
            : calls;
    return (
        <SettingsCard>
            <form
                className="grid gap-4"
                data-slot={`${slot}-settings`}
                onSubmit={async (event) => {
                    event.preventDefault();
                    if (!valid) {
                        return;
                    }
                    if (
                        await send('PUT', PATH, {
                            enabled,
                            threshold: percent / 100,
                            perDay: cap,
                        })
                    ) {
                        toast.success(t('operations.labeling:saved'));
                    }
                }}
            >
                <div className="grid gap-1">
                    <h3 className="font-medium">{title}</h3>
                    <p className="text-muted-foreground">{intro}</p>
                </div>
                <PermissionRow
                    title={switchTitle}
                    checked={enabled}
                    disabled={!view || busy}
                    onCheckedChange={setEnabled}
                >
                    {switchHelp}
                </PermissionRow>
                <div className="flex flex-wrap gap-4">
                    <label className="grid gap-1.5">
                        <span className="font-medium">{t('operations.labeling:card.threshold')}</span>
                        <Input
                            inputMode="numeric"
                            className="w-32"
                            value={threshold}
                            disabled={!view}
                            aria-invalid={!!threshold && !valid}
                            onChange={(event) => setThreshold(event.target.value.trim())}
                        />
                    </label>
                    <label className="grid gap-1.5">
                        <span className="font-medium">{t('operations.labeling:card.per-day')}</span>
                        <Input
                            inputMode="numeric"
                            className="w-32"
                            value={perDay}
                            disabled={!view}
                            aria-invalid={!!perDay && !valid}
                            onChange={(event) => setPerDay(event.target.value.trim())}
                        />
                    </label>
                </div>
                <p className="m-0 text-muted-foreground">
                    {t('operations.labeling:card.limits', {
                        min: CLASSIFY_THRESHOLD.min * 100,
                        max: CLASSIFY_THRESHOLD.max * 100,
                        defaults: view
                            ? t('operations.labeling:card.defaults_known', {
                                  threshold: view.defaults.threshold,
                                  count: view.defaults.perDay,
                              })
                            : t('operations.labeling:card.defaults'),
                    })}
                </p>
                {error && (
                    <p className="rounded-lg bg-destructive/10 p-3 text-destructive" role="alert">
                        {error}
                    </p>
                )}
                <div className="flex flex-wrap gap-2">
                    <Button type="submit" disabled={busy || !view || !valid}>
                        {t('operations.labeling:save')}
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        disabled={busy || !view}
                        onClick={() =>
                            void send('PUT', PATH, {
                                enabled: null,
                                threshold: null,
                                perDay: null,
                            })
                        }
                    >
                        {t('operations.labeling:card.reset')}
                    </Button>
                </div>
            </form>

            {view && (
                <section
                    aria-label={t('operations.labeling:card.status')}
                    className="mt-6 grid gap-3 border-t pt-4"
                    data-slot={`${slot}-status`}
                >
                    <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                        <dt className="text-muted-foreground">{t('operations.labeling:card.model')}</dt>
                        <dd className="m-0 min-w-0 break-words">
                            {view.available ? view.version : t('operations.labeling:card.no-model')}
                        </dd>
                        <dt className="text-muted-foreground">{t('operations.labeling:card.its-labels')}</dt>
                        <dd className="m-0" data-slot={`${slot}-pass`}>
                            {pass ? t('operations.labeling:card.passed') : t('operations.labeling:card.not-passed')}
                        </dd>
                        <dt className="text-muted-foreground">{t('operations.labeling:card.golden')}</dt>
                        <dd className="m-0">{goldenLine}</dd>
                        <dt className="text-muted-foreground">{t('operations.labeling:card.day')}</dt>
                        <dd className="m-0">{dayLine}</dd>
                    </dl>
                    <div className="flex flex-wrap items-center gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            disabled={busy || evaluating || !view.available || view.golden < MIN_GOLDEN}
                            onClick={() => void send('POST', `${PATH}/evaluate`)}
                        >
                            {evaluating
                                ? t('operations.labeling:card.evaluating')
                                : t('operations.labeling:card.evaluate')}
                        </Button>
                        <span className="text-xs text-muted-foreground">
                            {t('operations.labeling:card.evaluate-help')}
                        </span>
                    </div>
                    {view.lastEval && (
                        <EvalSummary report={view.lastEval} timeZone={timeZone} slot={slot} labelName={labelName} />
                    )}
                </section>
            )}
            {view && extra?.({ view, busy, send })}
        </SettingsCard>
    );
}

function EvalSummary({
    report,
    timeZone,
    slot,
    labelName,
}: {
    report: ClassifyEvalReport;
    timeZone: string;
    slot: string;
    labelName: (label: string) => string;
}) {
    const { t } = useTranslation(['operations.labeling']);
    const verdict =
        report.status === 'running'
            ? t('operations.labeling:eval.running')
            : report.status === 'failed'
              ? t('operations.labeling:eval.failed', { error: report.error ?? t('operations.labeling:eval.unknown') })
              : report.passed
                ? t('operations.labeling:eval.passed')
                : report.answered < MIN_ANSWERED
                  ? t('operations.labeling:eval.few-answered', { answered: report.answered, min: MIN_ANSWERED })
                  : t('operations.labeling:eval.imprecise', {
                        precision: share(report.precision),
                        threshold: share(report.threshold),
                    });
    return (
        <div className="grid gap-2" data-slot={`${slot}-eval`}>
            <p className="m-0 text-sm">
                <Trans
                    t={t}
                    i18nKey="operations.labeling:eval.summary"
                    values={{
                        when: formatWhen(report.startedAt, timeZone),
                        version: report.version,
                        verdict,
                        golden: report.golden,
                        answered: report.answered,
                        precision: share(report.precision),
                        accuracy: share(report.accuracy),
                    }}
                    components={{ strong: <span className="font-medium" /> }}
                />
            </p>
            {report.status === 'done' && (
                <Table aria-label={t('operations.labeling:eval.per-label')}>
                    <TableHeader>
                        <TableRow>
                            <TableHead>{t('operations.labeling:eval.label')}</TableHead>
                            <TableHead className="text-right">{t('operations.labeling:eval.admin-labels')}</TableHead>
                            <TableHead className="text-right">{t('operations.labeling:eval.model-said')}</TableHead>
                            <TableHead className="text-right">{t('operations.labeling:eval.precision')}</TableHead>
                            <TableHead className="text-right">{t('operations.labeling:eval.recall')}</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {report.labels.map((score) => (
                            <TableRow key={score.label}>
                                <TableCell>{labelName(score.label)}</TableCell>
                                <TableCell className="text-right tabular-nums">{formatNumber(score.support)}</TableCell>
                                <TableCell className="text-right tabular-nums">
                                    {formatNumber(score.predicted)}
                                </TableCell>
                                <TableCell className="text-right tabular-nums">{share(score.precision)}</TableCell>
                                <TableCell className="text-right tabular-nums">{share(score.recall)}</TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            )}
        </div>
    );
}
