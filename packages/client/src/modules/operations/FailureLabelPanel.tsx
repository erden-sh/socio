import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';

import { FAILURE_LABELS, type FailureLabel, type FailureLabelView } from '@socio/shared/classify';
import { FAILURE_CATEGORY_HINTS, FAILURE_CATEGORY_LABELS } from '@socio/shared/failure-taxonomy';

import { api } from '../../lib/api';

import { formatWhen } from './format';

import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

/** What a failure's rule says about who labeled it, if anyone did. */
export function labelledBy(rule: string) {
    if (rule === 'label:admin') {
        return 'Labeled by an admin';
    }
    if (rule.startsWith('label:')) {
        return 'Labeled by the model';
    }
    return null;
}

/**
 * Reliability's relabel panel (CB-198), in an Unclassified or labeled
 * failure's row: the error text the model reads (scrubbed, cut to 300
 * characters), its suggestion, the label in force, and an admin's label,
 * which counts at the store's next cycle and joins the golden set the
 * model is evaluated against. Opening it is on the access log.
 */
export function FailureLabelPanel({
    runId,
    level,
    timeZone,
}: {
    runId: string;
    level: 'turn' | 'tool';
    timeZone: string;
}) {
    const [view, setView] = useState<FailureLabelView>();
    const [choice, setChoice] = useState<FailureLabel | ''>('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
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
                    setError(e instanceof Error ? e.message : 'Could not load its label.');
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
            toast.success('Label saved. Reliability counts it within a minute.');
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not save the label.');
        } finally {
            setBusy(false);
        }
    };

    if (!view) {
        return error ? (
            <p role="alert" className="m-0 text-sm text-destructive">
                {error}
            </p>
        ) : (
            <Skeleton className="h-24 w-full" />
        );
    }
    const name = (label: FailureLabel) => FAILURE_CATEGORY_LABELS[label];
    return (
        <section aria-label="Label" data-slot="ops-failure-label" className="grid gap-2 text-sm">
            <p className="m-0 text-muted-foreground">
                {view.level === 'tool' ? `${view.tool ?? 'Tool call'}: ` : 'Turn: '}
                the rules say {view.rulesCategory ? name(view.rulesCategory as FailureLabel) : '–'} (
                <span className="font-mono text-xs">{view.rule}</span>)
            </p>
            <div className="grid gap-1">
                <span id={textId} className="text-xs text-muted-foreground">
                    What the model reads, scrubbed of contact details and secrets
                </span>
                <p
                    aria-labelledby={textId}
                    className="m-0 rounded-md border bg-background p-2 font-mono text-xs break-words whitespace-pre-wrap"
                >
                    {view.input || 'No error text was recorded.'}
                </p>
            </div>
            {view.suggestion && (
                <p className="m-0" data-slot="ops-failure-suggestion">
                    The model suggests <span className="font-medium">{name(view.suggestion.label)}</span>,{' '}
                    {Math.round(view.suggestion.confidence * 100)}% sure
                    {view.suggestion.applied
                        ? '; it counts.'
                        : '; a suggestion only: it wasn’t sure enough, or its version hasn’t passed an evaluation.'}
                </p>
            )}
            {view.label && (
                <p className="m-0" data-slot="ops-failure-label-in-force">
                    Labelled <span className="font-medium">{name(view.label.label)}</span> by{' '}
                    {view.label.source === 'admin' ? (view.label.by ?? 'an admin') : 'the model'},{' '}
                    {formatWhen(view.label.at, timeZone)}.
                </p>
            )}
            {view.labelable ? (
                <div className="flex flex-wrap items-center gap-2">
                    <Select value={choice} onValueChange={(value) => setChoice(value as FailureLabel)}>
                        <SelectTrigger size="sm" aria-label="Label" className="w-64">
                            <SelectValue placeholder="Choose a category" />
                        </SelectTrigger>
                        <SelectContent>
                            {FAILURE_LABELS.map((label) => (
                                <SelectItem key={label} value={label} title={FAILURE_CATEGORY_HINTS[label]}>
                                    {name(label)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Button type="button" size="sm" disabled={busy || !choice} onClick={() => void save()}>
                        Save label
                    </Button>
                    <span className="text-xs text-muted-foreground">
                        Your label counts within a minute and joins the golden set.
                    </span>
                </div>
            ) : (
                <p className="m-0 text-muted-foreground">
                    The rules sort this one; labels apply only to Unclassified failures.
                </p>
            )}
            {error && (
                <p role="alert" className="m-0 text-destructive">
                    {error}
                </p>
            )}
        </section>
    );
}
