import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import type { DatasetChoice, PromotionChoice, PromotionPlan } from '@socio/shared/apps/app-types';

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
const STEPS = ['Review', 'Data', 'Promote'] as const;
const CHOICE_TEXT: Record<DatasetChoice, { title: string; line: string }> = {
    move: {
        title: 'Move it to your workspace',
        line: 'Into a new dataset of yours, out of the socio’s scratch space.',
    },
    share: {
        title: 'Share it with a Space',
        line: 'Its members can read it; the app writes it. Scratch data is moved first.',
    },
    keep: {
        title: 'Keep it where it is',
        line: 'The app uses it there; nothing moves.',
    },
};
/** A company socio's shared dataset (CB-354): its data goes to the workspace, not to you. */
const SHARED_CHOICE_TEXT: Record<DatasetChoice, { title: string; line: string }> = {
    move: {
        title: 'Move it to a workspace dataset',
        line: 'Into a new dataset of the workspace’s, not yours, out of the socio’s shared dataset.',
    },
    share: {
        title: 'Move it and share it with a Space',
        line: 'Into a new workspace dataset its members can read; the app writes it.',
    },
    keep: {
        title: 'Keep it where it is',
        line: 'The app uses the socio’s shared dataset; nothing moves.',
    },
};
const size = (bytes: number) =>
    bytes < 1024
        ? `${bytes} B`
        : bytes < 1048576
          ? `${Math.round(bytes / 1024)} KB`
          : `${(bytes / 1048576).toFixed(1)} MB`;

/**
 * The promotion wizard: what the packaged version is (manifest and
 * files), a choice for each dataset it uses (nothing moves without one),
 * then the review. Promoting here is the owner's own decision; a Dot's
 * `app_promote` goes through an approval instead.
 */
export function PromoteDialog({ appId, onClose, onDone }: { appId: string; onClose: () => void; onDone: () => void }) {
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
            .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Could not load the app.'));
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
                datasets: Object.values(choices).filter((choice) =>
                    plan.datasets.some((dataset) => dataset.ref === choice.ref),
                ),
                env,
            });
            toast.success(result.outcome);
            onDone();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Could not promote it.');
        } finally {
            setBusy(false);
        }
    };
    const describe = (ref: string) => {
        const choice = choices[ref];
        if (!choice) {
            return 'No choice yet';
        }
        const shared = plan?.datasets.find((dataset) => dataset.ref === ref)?.sharedArea;
        const asks = choice.dotReads === false ? '' : ` (${plan?.dotName} can write to it once you approve)`;
        if (choice.choice === 'move') {
            return shared
                ? `Move into the workspace dataset “${choice.name || `${plan?.name} data`}”${asks}`
                : `Move into “${choice.name || `${plan?.name} data`}”${choice.dotReads === false ? '' : ' (the socio keeps read access)'}`;
        }
        if (choice.choice === 'share') {
            const space = spaces.find((item) => item.id === choice.spaceId)?.name ?? '…';
            return shared
                ? `Move into the workspace dataset “${choice.name || `${plan?.name} data`}”, shared with ${space}${asks}`
                : `Share with ${space}`;
        }
        return 'Keep where it is';
    };
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" data-slot="promote-dialog">
                <DialogHeader>
                    <DialogTitle>
                        Promote {plan?.name ?? 'app'}
                        {plan ? ` · version ${plan.version.version}` : ''}
                    </DialogTitle>
                    <DialogDescription>
                        It moves out of {plan?.dotName ?? 'the socio'}’s computer into the workspace app runtime, at the
                        same address, and keeps its data in your data space.
                    </DialogDescription>
                </DialogHeader>
                <ol className="flex gap-2 text-sm" aria-label="Steps">
                    {STEPS.map((name, index) => (
                        <li key={name}>
                            <Badge
                                variant={index === step ? 'default' : 'outline'}
                                aria-current={index === step ? 'step' : undefined}
                            >
                                {index + 1}. {name}
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
                                The workspace app runtime is not set up on this server (APPS_RUNTIME_URL), so it can’t
                                be promoted yet.
                            </p>
                        )}
                        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                            <dt className="text-muted-foreground">Entry</dt>
                            <dd>
                                {manifest.entry} ({manifest.runtime})
                            </dd>
                            <dt className="text-muted-foreground">Files</dt>
                            <dd>
                                {plan.version.files} · {size(plan.version.sizeBytes)}
                            </dd>
                            <dt className="text-muted-foreground">Reaches</dt>
                            <dd>{manifest.egress.length ? manifest.egress.join(', ') : 'Nothing outside Socio'}</dd>
                            {manifest.routes?.length ? (
                                <>
                                    <dt className="text-muted-foreground">Routes</dt>
                                    <dd>{manifest.routes.join(', ')}</dd>
                                </>
                            ) : null}
                            <dt className="text-muted-foreground">Data</dt>
                            <dd>
                                {manifest.datasets.length
                                    ? manifest.datasets.map((dataset) => `${dataset.id} (${dataset.access})`).join(', ')
                                    : 'None'}
                            </dd>
                        </dl>
                        {manifest.description && <p>{manifest.description}</p>}
                        {Object.keys(manifest.env ?? {}).length > 0 && (
                            <fieldset className="grid gap-2">
                                <legend className="font-medium">Settings</legend>
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
                                    No secrets here: the values are stored with the app.
                                </span>
                            </fieldset>
                        )}
                        <details>
                            <summary>Files in this version</summary>
                            <ul className="mt-2 max-h-48 overflow-y-auto font-mono text-xs">
                                {plan.files.map((file) => (
                                    <li key={file.path}>
                                        {file.path} <span className="text-muted-foreground">{size(file.size)}</span>
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
                        {!plan.datasets.length && <p>This version uses no datasets: nothing to decide here.</p>}
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
                                            {dataset.sharedArea
                                                ? 'the socio’s shared dataset'
                                                : dataset.kind === 'scratch'
                                                  ? 'the socio’s scratch dataset'
                                                  : dataset.kind === 'workspace'
                                                    ? 'a workspace dataset'
                                                    : dataset.kind === 'missing'
                                                      ? 'no longer exists'
                                                      : 'your dataset'}{' '}
                                            · {dataset.access}
                                            {dataset.tables?.length
                                                ? ` · tables ${dataset.tables.join(', ')}`
                                                : dataset.tableNames.length
                                                  ? ` · ${dataset.tableNames.length} table(s)`
                                                  : ''}{' '}
                                            · {size(dataset.sizeBytes)}
                                        </span>
                                    </legend>
                                    {dataset.sharedArea && (
                                        <p className="text-muted-foreground" data-slot="promote-shared-note">
                                            Everyone who uses {plan.dotName} sees this data. Moving or sharing it takes
                                            these tables out of the shared dataset into a new workspace dataset, which
                                            belongs to the workspace, not to you, and stays with it. {plan.dotName} asks
                                            to keep writing to it, and can once you approve that request. Keeping it
                                            leaves the app on the shared dataset.
                                        </p>
                                    )}
                                    {!dataset.choices.length && (
                                        <p role="alert" className="text-destructive">
                                            This dataset is gone; ask the socio to package a version without it.
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
                                                {(dataset.sharedArea ? SHARED_CHOICE_TEXT : CHOICE_TEXT)[option].title}
                                                <span className="block text-muted-foreground">
                                                    {
                                                        (dataset.sharedArea ? SHARED_CHOICE_TEXT : CHOICE_TEXT)[option]
                                                            .line
                                                    }
                                                </span>
                                            </span>
                                        </label>
                                    ))}
                                    {choice?.choice === 'share' && (
                                        <select
                                            data-slot="promote-space"
                                            aria-label="Share with"
                                            className={fieldClass}
                                            value={choice.spaceId ?? ''}
                                            onChange={(event) =>
                                                choose(dataset.ref, {
                                                    spaceId: event.target.value || undefined,
                                                })
                                            }
                                        >
                                            <option value="">Choose a Space</option>
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
                                                aria-label="New dataset name"
                                                placeholder={`${plan.name} data`}
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
                                                    ? `${plan.dotName} asks to keep writing to it (you approve)`
                                                    : `${plan.dotName} keeps read access`}
                                            </label>
                                        </div>
                                    )}
                                </fieldset>
                            );
                        })}
                    </div>
                ) : (
                    <div className="grid gap-2 text-sm" data-slot="promote-confirm">
                        <p>
                            Version {plan.version.version} runs in the workspace app runtime at its current address;
                            only you can open it until you share it.
                        </p>
                        <ul className="list-disc pl-5">
                            {plan.datasets.map((dataset) => (
                                <li key={dataset.ref}>
                                    {dataset.name}: {describe(dataset.ref)}
                                </li>
                            ))}
                            <li>
                                Reaches {manifest.egress.length ? manifest.egress.join(', ') : 'nothing outside Socio'}
                            </li>
                        </ul>
                    </div>
                )}
                <DialogFooter>
                    {step > 0 && (
                        <Button variant="outline" onClick={() => setStep(step - 1)}>
                            Back
                        </Button>
                    )}
                    {step < 2 ? (
                        <Button
                            onClick={() => setStep(step + 1)}
                            disabled={!plan || !plan.runtime || (step === 1 && !!missing.length)}
                        >
                            Next
                        </Button>
                    ) : (
                        <Button onClick={() => void promote()} disabled={busy || !!missing.length}>
                            Promote
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
