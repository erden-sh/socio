import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import type { PromotionChoice, PromotionPlan } from '@socio/shared/apps/app-types';

import { onDemand } from '../../i18n/on-demand';
import { api } from '../../lib/api';
import { useShell } from '../../shell/shell-context';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

const fieldClass = 'h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs dark:bg-input/30';
/** The wizard's steps; their names are apps.promote's (`steps.<id>`). */
const STEPS = ['review', 'data', 'promote'] as const;

/**
 * The promotion wizard: what the packaged version is (manifest and
 * files), a choice for each dataset it uses (nothing moves without one),
 * then the review. Promoting here is the owner's own decision; a Dot's
 * `app_promote` goes through an approval instead. Its words load on
 * demand (apps.promote).
 */
function PromoteWizard({ appId, onClose, onDone }: { appId: string; onClose: () => void; onDone: () => void }) {
    const { t } = useTranslation(['apps.promote']);
    // The latest t, for callbacks and effects that shouldn't run again when the language changes.
    const latestT = useRef(t);
    latestT.current = t;
    const shell = useShell();
    const [plan, setPlan] = useState<PromotionPlan>();
    const [error, setError] = useState<string>();
    const [step, setStep] = useState(0);
    const [choices, setChoices] = useState<Record<string, PromotionChoice>>({});
    const [env, setEnv] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        let cancelled = false;
        api<PromotionPlan>(`/apps/${encodeURIComponent(appId)}/promotion`)
            .then((loaded) => !cancelled && setPlan(loaded))
            .catch(
                (e) =>
                    !cancelled &&
                    setError(e instanceof Error ? e.message : latestT.current('apps.promote:load-failed')),
            );
        return () => {
            cancelled = true;
        };
    }, [appId]);
    const spaces = shell.workspace.spaces;
    const missing = useMemo(
        () =>
            (plan?.datasets ?? []).filter((dataset) => {
                const choice = choices[dataset.ref];
                return (
                    !choice ||
                    (choice.choice === 'share' && !choice.spaceId) ||
                    !dataset.choices.includes(choice.choice)
                );
            }),
        [plan, choices],
    );
    const choose = (ref: string, patch: Partial<PromotionChoice>) =>
        setChoices((current) => ({
            ...current,
            [ref]: { ...(current[ref] ?? { ref, choice: 'keep' }), ...patch, ref },
        }));
    const manifest = plan?.version.manifest;
    const promote = async () => {
        if (!plan) {
            return;
        }
        setBusy(true);
        try {
            const result = await api<{ outcome: string }>(`/apps/${encodeURIComponent(appId)}/promote`, 'POST', {
                version: plan.version.version,
                datasets: Object.values(choices)
                    .filter((choice) => plan.datasets.some((dataset) => dataset.ref === choice.ref))
                    .map((choice) => ({ ...choice, name: newName(choice) })),
                env,
            });
            toast.success(result.outcome);
            onDone();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : t('apps.promote:failed'));
        } finally {
            setBusy(false);
        }
    };
    /**
     * The name a moved dataset gets: the one typed, or the suggestion the
     * field and the review show, in the reader's language (the server's own
     * default is English). Too long a suggestion is left to the server's.
     */
    const suggested = t('apps.promote:default-name', { name: plan?.name ?? '' });
    const newName = (choice: PromotionChoice) =>
        choice.name?.trim() ||
        (choice.choice !== 'keep' &&
        plan?.datasets.some((dataset) => dataset.ref === choice.ref && dataset.kind === 'scratch') &&
        suggested.length <= 80
            ? suggested
            : choice.name);
    const describe = (ref: string) => {
        const choice = choices[ref];
        if (!choice) {
            return t('apps.promote:describe.none');
        }
        const shared = plan?.datasets.find((dataset) => dataset.ref === ref)?.sharedArea;
        const name = newName(choice) || suggested;
        // The socio asks to write to a moved shared dataset, or keeps reading a moved scratch one.
        const context = choice.dotReads === false ? undefined : shared ? 'asks' : 'reads';
        const socio = plan?.dotName ?? '';
        if (choice.choice === 'move') {
            return shared
                ? t('apps.promote:describe.move-shared', { name, socio, context })
                : t('apps.promote:describe.move', { name, context });
        }
        if (choice.choice === 'share') {
            const space = spaces.find((item) => item.id === choice.spaceId)?.name ?? '…';
            return shared
                ? t('apps.promote:describe.share-shared', { name, socio, space, context })
                : t('apps.promote:describe.share', { space });
        }
        return t('apps.promote:describe.keep');
    };
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" data-slot="promote-dialog">
                <DialogHeader>
                    <DialogTitle>
                        {plan
                            ? t('apps.promote:title', { name: plan.name, version: plan.version.version })
                            : t('apps.promote:title-loading')}
                    </DialogTitle>
                    <DialogDescription>
                        {plan
                            ? t('apps.promote:description', { socio: plan.dotName })
                            : t('apps.promote:description-loading')}
                    </DialogDescription>
                </DialogHeader>
                <ol className="flex gap-2 text-sm" aria-label={t('apps.promote:steps.label')}>
                    {STEPS.map((name, index) => (
                        <li key={name}>
                            <Badge
                                variant={index === step ? 'default' : 'outline'}
                                aria-current={index === step ? 'step' : undefined}
                            >
                                {t('apps.promote:steps.step', {
                                    number: index + 1,
                                    name: t(`apps.promote:steps.${name}`),
                                })}
                            </Badge>
                        </li>
                    ))}
                </ol>
                {error ? (
                    <p role="alert" className="text-sm text-destructive">
                        {error}
                    </p>
                ) : !plan || !manifest ? (
                    <Skeleton className="h-40" />
                ) : step === 0 ? (
                    <div className="grid gap-3 text-sm" data-slot="promote-review">
                        {!plan.runtime && (
                            <p role="alert" className="text-destructive">
                                {t('apps.promote:review.no-runtime')}
                            </p>
                        )}
                        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                            <dt className="text-muted-foreground">{t('apps.promote:review.entry')}</dt>
                            <dd>
                                {manifest.entry} ({manifest.runtime})
                            </dd>
                            <dt className="text-muted-foreground">{t('apps.promote:review.files')}</dt>
                            <dd>
                                {t('apps.promote:review.files-value', {
                                    files: plan.version.files,
                                    size: plan.version.sizeBytes,
                                })}
                            </dd>
                            <dt className="text-muted-foreground">{t('apps.promote:review.reaches')}</dt>
                            <dd>
                                {manifest.egress.length
                                    ? manifest.egress.join(', ')
                                    : t('apps.promote:review.reaches-nothing')}
                            </dd>
                            {manifest.routes?.length ? (
                                <>
                                    <dt className="text-muted-foreground">{t('apps.promote:review.routes')}</dt>
                                    <dd>{manifest.routes.join(', ')}</dd>
                                </>
                            ) : null}
                            <dt className="text-muted-foreground">{t('apps.promote:review.data')}</dt>
                            <dd>
                                {manifest.datasets.length
                                    ? manifest.datasets.map((dataset) => `${dataset.id} (${dataset.access})`).join(', ')
                                    : t('apps.promote:review.data-none')}
                            </dd>
                        </dl>
                        {manifest.description && <p>{manifest.description}</p>}
                        {Object.keys(manifest.env ?? {}).length > 0 && (
                            <fieldset className="grid gap-2">
                                <legend className="font-medium">{t('apps.promote:review.settings')}</legend>
                                {Object.entries(manifest.env ?? {}).map(([name, what]) => (
                                    <label key={name} className="grid gap-1">
                                        <span>
                                            <code>{name}</code> <span className="text-muted-foreground">{what}</span>
                                        </span>
                                        <input
                                            className={fieldClass}
                                            data-slot="promote-env"
                                            name={name}
                                            value={env[name] ?? ''}
                                            maxLength={300}
                                            onChange={(event) => setEnv({ ...env, [name]: event.target.value })}
                                        />
                                    </label>
                                ))}
                                <span className="text-xs text-muted-foreground">
                                    {t('apps.promote:review.no-secrets')}
                                </span>
                            </fieldset>
                        )}
                        <details>
                            <summary>{t('apps.promote:review.file-list')}</summary>
                            <ul className="mt-2 max-h-48 overflow-y-auto font-mono text-xs">
                                {plan.files.map((file) => (
                                    <li key={file.path}>
                                        {file.path}{' '}
                                        <span className="text-muted-foreground">
                                            {t('apps.promote:size', { size: file.size })}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </details>
                        {plan.version.changes.length > 0 && (
                            <p className="text-muted-foreground">{plan.version.changes.join(' · ')}</p>
                        )}
                    </div>
                ) : step === 1 ? (
                    <div className="grid gap-4 text-sm" data-slot="promote-data">
                        {!plan.datasets.length && <p>{t('apps.promote:data.none')}</p>}
                        {plan.datasets.map((dataset) => {
                            const choice = choices[dataset.ref];
                            return (
                                <fieldset
                                    key={dataset.ref}
                                    className="grid gap-2 rounded-lg border p-3"
                                    data-slot="promote-dataset"
                                >
                                    <legend className="px-1 font-medium">
                                        {dataset.name}{' '}
                                        <span className="font-normal text-muted-foreground">
                                            {[
                                                dataset.sharedArea
                                                    ? t('apps.promote:data.kind.shared')
                                                    : dataset.kind === 'scratch'
                                                      ? t('apps.promote:data.kind.scratch')
                                                      : dataset.kind === 'workspace'
                                                        ? t('apps.promote:data.kind.workspace')
                                                        : dataset.kind === 'missing'
                                                          ? t('apps.promote:data.kind.missing')
                                                          : t('apps.promote:data.kind.yours'),
                                                dataset.access,
                                                dataset.tables?.length
                                                    ? t('apps.promote:data.tables', { tables: dataset.tables })
                                                    : dataset.tableNames.length
                                                      ? t('apps.promote:data.table-count', {
                                                            count: dataset.tableNames.length,
                                                        })
                                                      : '',
                                                t('apps.promote:size', { size: dataset.sizeBytes }),
                                            ]
                                                .filter(Boolean)
                                                .join(' · ')}
                                        </span>
                                    </legend>
                                    {dataset.sharedArea && (
                                        <p className="text-muted-foreground" data-slot="promote-shared-note">
                                            {t('apps.promote:data.shared-note', { socio: plan.dotName })}
                                        </p>
                                    )}
                                    {!dataset.choices.length && (
                                        <p role="alert" className="text-destructive">
                                            {t('apps.promote:data.gone')}
                                        </p>
                                    )}
                                    {dataset.choices.map((option) => (
                                        <label key={option} className="flex items-start gap-2">
                                            <input
                                                type="radio"
                                                name={`choice-${dataset.ref}`}
                                                value={option}
                                                checked={choice?.choice === option}
                                                onChange={() => choose(dataset.ref, { choice: option })}
                                            />
                                            <span>
                                                {dataset.sharedArea
                                                    ? t(`apps.promote:shared-choices.${option}.title`)
                                                    : t(`apps.promote:choices.${option}.title`)}
                                                <span className="block text-muted-foreground">
                                                    {dataset.sharedArea
                                                        ? t(`apps.promote:shared-choices.${option}.line`)
                                                        : t(`apps.promote:choices.${option}.line`)}
                                                </span>
                                            </span>
                                        </label>
                                    ))}
                                    {choice?.choice === 'share' && (
                                        <select
                                            data-slot="promote-space"
                                            aria-label={t('apps.promote:data.share-with')}
                                            className={fieldClass}
                                            value={choice.spaceId ?? ''}
                                            onChange={(event) =>
                                                choose(dataset.ref, {
                                                    spaceId: event.target.value || undefined,
                                                })
                                            }
                                        >
                                            <option value="">{t('apps.promote:data.choose-space')}</option>
                                            {spaces.map((space) => (
                                                <option key={space.id} value={space.id}>
                                                    {space.name}
                                                </option>
                                            ))}
                                        </select>
                                    )}
                                    {dataset.kind === 'scratch' && choice && choice.choice !== 'keep' && (
                                        <div className="grid gap-2">
                                            <input
                                                className={fieldClass}
                                                aria-label={t('apps.promote:data.new-name')}
                                                placeholder={t('apps.promote:default-name', { name: plan.name })}
                                                maxLength={80}
                                                value={choice.name ?? ''}
                                                onChange={(event) => choose(dataset.ref, { name: event.target.value })}
                                            />
                                            <label className="flex items-center gap-2">
                                                <input
                                                    type="checkbox"
                                                    checked={choice.dotReads !== false}
                                                    onChange={(event) =>
                                                        choose(dataset.ref, {
                                                            dotReads: event.target.checked,
                                                        })
                                                    }
                                                />
                                                {dataset.sharedArea
                                                    ? t('apps.promote:data.socio-asks', { socio: plan.dotName })
                                                    : t('apps.promote:data.socio-reads', { socio: plan.dotName })}
                                            </label>
                                        </div>
                                    )}
                                </fieldset>
                            );
                        })}
                    </div>
                ) : (
                    <div className="grid gap-2 text-sm" data-slot="promote-confirm">
                        <p>{t('apps.promote:confirm.intro', { version: plan.version.version })}</p>
                        <ul className="list-disc pl-5">
                            {plan.datasets.map((dataset) => (
                                <li key={dataset.ref}>
                                    {t('apps.promote:confirm.dataset', {
                                        name: dataset.name,
                                        choice: describe(dataset.ref),
                                    })}
                                </li>
                            ))}
                            <li>
                                {manifest.egress.length
                                    ? t('apps.promote:confirm.reaches', { hosts: manifest.egress.join(', ') })
                                    : t('apps.promote:confirm.reaches-nothing')}
                            </li>
                        </ul>
                    </div>
                )}
                <DialogFooter>
                    {step > 0 && (
                        <Button variant="outline" onClick={() => setStep(step - 1)}>
                            {t('apps.promote:back')}
                        </Button>
                    )}
                    {step < 2 ? (
                        <Button
                            onClick={() => setStep(step + 1)}
                            disabled={!plan || !plan.runtime || (step === 1 && !!missing.length)}
                        >
                            {t('apps.promote:next')}
                        </Button>
                    ) : (
                        <Button onClick={() => void promote()} disabled={busy || !!missing.length}>
                            {t('apps.promote:promote')}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** The promotion wizard (`PromoteWizard`), once its words are in. */
export const PromoteDialog = onDemand(['apps.promote'], PromoteWizard);
