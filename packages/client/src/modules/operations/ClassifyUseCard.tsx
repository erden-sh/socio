import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import {
    CLASSIFY_PER_DAY,
    CLASSIFY_THRESHOLD,
    MIN_ANSWERED,
    MIN_GOLDEN,
    type ClassifyEvalReport,
    type ClassifyUse,
    type ClassifyUseView,
} from '@socio/shared/classify';
import { formatNumber } from '@socio/shared/locale';

import { api } from '../../lib/api';
import { SettingsCard } from '../settings/AccountSettings';

import { formatWhen } from './format';
import { useOpsSettings } from './use-ops';

import { PermissionRow } from '@/components/form-fields';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const share = (value: number | null) => (value === null ? '–' : `${Math.round(value * 100)}%`);

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
                        setError(e instanceof Error ? e.message : 'Could not load these settings.');
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
    }, [loaded, evaluating, PATH]);

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
            setError(e instanceof Error ? e.message : 'Could not save.');
            return false;
        } finally {
            setBusy(false);
        }
    };

    const pass = view?.versionPassed;
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
                        toast.success('Settings saved');
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
                        <span className="font-medium">Threshold, percent</span>
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
                        <span className="font-medium">Most calls a day</span>
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
                    The threshold is how sure the model must be for a label to count, and how often it must be right,
                    when that sure, in an evaluation. From {CLASSIFY_THRESHOLD.min * 100} to{' '}
                    {CLASSIFY_THRESHOLD.max * 100}. The server’s are{' '}
                    {view
                        ? `${Math.round(view.defaults.threshold * 100)}% and ${formatNumber(view.defaults.perDay)} calls`
                        : '…'}
                    ; 0 calls asks about none.
                </p>
                {error && (
                    <p className="rounded-lg bg-destructive/10 p-3 text-destructive" role="alert">
                        {error}
                    </p>
                )}
                <div className="flex flex-wrap gap-2">
                    <Button type="submit" disabled={busy || !view || !valid}>
                        Save
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
                        Use the server’s
                    </Button>
                </div>
            </form>

            {view && (
                <section
                    aria-label="Model and evaluation"
                    className="mt-6 grid gap-3 border-t pt-4"
                    data-slot={`${slot}-status`}
                >
                    <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                        <dt className="text-muted-foreground">Model</dt>
                        <dd className="m-0 min-w-0 break-words">
                            {view.available ? view.version : 'None: set up a default shared model first.'}
                        </dd>
                        <dt className="text-muted-foreground">Its labels</dt>
                        <dd className="m-0" data-slot={`${slot}-pass`}>
                            {pass
                                ? 'Count: this version passed an evaluation.'
                                : 'Suggestions only, until this version passes an evaluation.'}
                        </dd>
                        <dt className="text-muted-foreground">Golden set</dt>
                        <dd className="m-0">
                            {formatNumber(view.golden)} admin labels
                            {view.golden < MIN_GOLDEN ? ` (an evaluation needs ${MIN_GOLDEN})` : ''}
                        </dd>
                        <dt className="text-muted-foreground">Last 24 hours</dt>
                        <dd className="m-0">
                            {formatNumber(view.callsToday)} of {formatNumber(view.perDay)} calls,{' '}
                            {formatNumber(view.evalCallsToday)} evaluating · {formatNumber(view.tokensToday)} tokens ·{' '}
                            {view.costToday === null ? 'cost not reported' : `$${view.costToday.toFixed(4)}`}
                            {view.unknownCostCalls && view.costToday !== null
                                ? ` (${formatNumber(view.unknownCostCalls)} calls without a cost)`
                                : ''}
                        </dd>
                    </dl>
                    <div className="flex flex-wrap items-center gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            disabled={busy || evaluating || !view.available || view.golden < MIN_GOLDEN}
                            onClick={() => void send('POST', `${PATH}/evaluate`)}
                        >
                            {evaluating ? 'Evaluating…' : 'Evaluate'}
                        </Button>
                        <span className="text-xs text-muted-foreground">
                            Asks the model about every golden label: one call each.
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
    const verdict =
        report.status === 'running'
            ? 'Running…'
            : report.status === 'failed'
              ? `Failed: ${report.error ?? 'unknown'}`
              : report.passed
                ? 'Passed'
                : report.answered < MIN_ANSWERED
                  ? `Did not pass: it was sure of ${report.answered}, fewer than ${MIN_ANSWERED}`
                  : `Did not pass: ${share(report.precision)} right, under ${share(report.threshold)}`;
    return (
        <div className="grid gap-2" data-slot={`${slot}-eval`}>
            <p className="m-0 text-sm">
                <span className="font-medium">Last evaluation</span>, {formatWhen(report.startedAt, timeZone)}, of{' '}
                {report.version}: {verdict}. {formatNumber(report.golden)} labels, {formatNumber(report.answered)}{' '}
                answered, {share(report.precision)} of those right, {share(report.accuracy)} right overall.
            </p>
            {report.status === 'done' && (
                <Table aria-label="Per label">
                    <TableHeader>
                        <TableRow>
                            <TableHead>Label</TableHead>
                            <TableHead className="text-right">Admin labels</TableHead>
                            <TableHead className="text-right">Model said</TableHead>
                            <TableHead className="text-right">Precision</TableHead>
                            <TableHead className="text-right">Recall</TableHead>
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
