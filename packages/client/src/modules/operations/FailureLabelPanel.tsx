import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';

import { Trans, useTranslation } from '@socio/i18n/react';
import { FAILURE_LABELS, type FailureLabel, type FailureLabelView } from '@socio/shared/classify';

import { onDemand } from '../../i18n/on-demand';
import { api } from '../../lib/api';

import { formatWhen } from './format';

import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * What a failure's rule says about who labeled it, if anyone did: shown as
 * `operations.failure-label:by` with this as its context.
 */
export function labeledBy(rule: string): 'admin' | 'model' | null {
    if (rule === 'label:admin') {
        return 'admin';
    }
    if (rule.startsWith('label:')) {
        return 'model';
    }
    return null;
}

/**
 * Reliability's relabel panel (CB-198), in an Unclassified or labeled
 * failure's row: the error text the model reads (scrubbed, cut to 300
 * characters), its suggestion, the label in force, and an admin's label,
 * which counts at the store's next cycle and joins the golden set the
 * model is evaluated against. Opening it is on the access log. Its words
 * load when a failure's row opens (operations.failure-label).
 */
export const FailureLabelPanel = onDemand(['operations.failure-label', 'operations.reliability'], LabelPanel);

function LabelPanel({ runId, level, timeZone }: { runId: string; level: 'turn' | 'tool'; timeZone: string }) {
    const { t } = useTranslation(['operations.failure-label', 'operations.reliability']);
    const [view, setView] = useState<FailureLabelView>();
    const [choice, setChoice] = useState<FailureLabel | ''>('');
    const [busy, setBusy] = useState(false);
    // A server's message, or `true` for "Could not load its label." (said at render).
    const [error, setError] = useState<string | boolean>('');
    const textId = useId();
    const path = `/classify/failures/${encodeURIComponent(runId)}`;
    useEffect(() => {
        const controller = new AbortController();
        api<FailureLabelView>(`${path}?level=${level}&via=reliability`, 'GET', undefined, controller.signal)
            .then((next) => {
                if (controller.signal.aborted) {
                    return;
                }
                setView(next);
                setChoice(next.label?.label ?? next.suggestion?.label ?? '');
            })
            .catch((e: unknown) => {
                if (!controller.signal.aborted) {
                    setError(e instanceof Error ? e.message : true);
                }
            });
        return () => controller.abort();
    }, [path, level]);

    const save = async () => {
        if (!choice) {
            return;
        }
        setBusy(true);
        setError('');
        try {
            setView(
                await api<FailureLabelView>(`${path}/label`, 'PUT', {
                    level,
                    label: choice,
                }),
            );
            toast.success(t('operations.failure-label:saved'));
        } catch (e) {
            setError(e instanceof Error ? e.message : t('operations.failure-label:save-failed'));
        } finally {
            setBusy(false);
        }
    };

    if (!view) {
        return error ? (
            <p role="alert" className="m-0 text-sm text-destructive">
                {error === true ? t('operations.failure-label:load-failed') : error}
            </p>
        ) : (
            <Skeleton className="h-24 w-full" />
        );
    }
    const name = (label: FailureLabel) => t(`operations.reliability:category.${label}`);
    return (
        <section
            aria-label={t('operations.failure-label:name')}
            data-slot="ops-failure-label"
            className="grid gap-2 text-sm"
        >
            <p className="m-0 text-muted-foreground">
                <Trans
                    t={t}
                    i18nKey="operations.failure-label:subject"
                    context={view.level === 'tool' ? (view.tool ? 'tool' : 'tool-call') : undefined}
                    values={{
                        tool: view.tool ?? '',
                        category: view.rulesCategory ? name(view.rulesCategory as FailureLabel) : '–',
                        rule: view.rule,
                    }}
                    components={{ code: <span className="font-mono text-xs" /> }}
                />
            </p>
            <div className="grid gap-1">
                <span id={textId} className="text-xs text-muted-foreground">
                    {t('operations.failure-label:input')}
                </span>
                <p
                    aria-labelledby={textId}
                    className="m-0 rounded-md border bg-background p-2 font-mono text-xs break-words whitespace-pre-wrap"
                >
                    {view.input || t('operations.failure-label:no-input')}
                </p>
            </div>
            {view.suggestion && (
                <p className="m-0" data-slot="ops-failure-suggestion">
                    <Trans
                        t={t}
                        i18nKey="operations.failure-label:suggests"
                        context={view.suggestion.applied ? undefined : 'only'}
                        values={{ category: name(view.suggestion.label), confidence: view.suggestion.confidence }}
                        components={{ strong: <span className="font-medium" /> }}
                    />
                </p>
            )}
            {view.label && (
                <p className="m-0" data-slot="ops-failure-label-in-force">
                    <Trans
                        t={t}
                        i18nKey="operations.failure-label:in-force"
                        context={
                            view.label.source !== 'admin' ? 'model' : view.label.by === null ? 'an-admin' : undefined
                        }
                        values={{
                            category: name(view.label.label),
                            name: view.label.by ?? '',
                            when: formatWhen(view.label.at, timeZone),
                        }}
                        components={{ strong: <span className="font-medium" /> }}
                    />
                </p>
            )}
            {view.labelable ? (
                <div className="flex flex-wrap items-center gap-2">
                    <Select value={choice} onValueChange={(value) => setChoice(value as FailureLabel)}>
                        <SelectTrigger size="sm" aria-label={t('operations.failure-label:name')} className="w-64">
                            <SelectValue placeholder={t('operations.failure-label:choose')} />
                        </SelectTrigger>
                        <SelectContent>
                            {FAILURE_LABELS.map((label) => (
                                <SelectItem key={label} value={label} title={t(`operations.reliability:hint.${label}`)}>
                                    {name(label)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Button type="button" size="sm" disabled={busy || !choice} onClick={() => void save()}>
                        {t('operations.failure-label:save')}
                    </Button>
                    <span className="text-xs text-muted-foreground">{t('operations.failure-label:counts')}</span>
                </div>
            ) : (
                <p className="m-0 text-muted-foreground">{t('operations.failure-label:rules-only')}</p>
            )}
            {error && (
                <p role="alert" className="m-0 text-destructive">
                    {error}
                </p>
            )}
        </section>
    );
}
