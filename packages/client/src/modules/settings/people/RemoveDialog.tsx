import { useCallback, useEffect, useState, type FormEvent } from 'react';

import type { StepUpChallenge, StepUpMethod, StepUpProof } from '@socio/shared/access-policy';
import type { PersonPurgePlan, PersonPurgeResult } from '@socio/shared/auth';

import { ApiError, api } from '../../../lib/api';
import { importOrReload } from '../../../shell/chunk-reload';

import { blockerOf, byteSize, firstName, plural } from './people-format';

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
import { Skeleton } from '@/components/ui/skeleton';

const purgePath = (id: string, rest = '') => `/accounts/${encodeURIComponent(id)}/purge${rest}`;

/** The dry run: blockers (each explained), what goes, and what stays as history. */
function DryRun({
    plan,
    onTransfer,
    onDeactivate,
}: {
    plan: PersonPurgePlan;
    onTransfer: () => void;
    onDeactivate: () => void;
}) {
    // Each "do this first" once, on the first blocker it answers.
    const offered = new Set<string>();
    const all = plan.refusals.map(blockerOf).map((blocker) => {
        if (!blocker.action || offered.has(blocker.action)) {
            return { ...blocker, action: undefined };
        }
        offered.add(blocker.action);
        return blocker;
    });
    // "They still own ..." says it in words: the planner's record-by-record
    // lines for the same things fold under it.
    const summarized = all.some((blocker) => /still own/i.test(blocker.text));
    const records = summarized ? all.filter((blocker) => /is under a listed/i.test(blocker.text)) : [];
    const blockers = all.filter((blocker) => !records.includes(blocker));
    const targets = Object.entries(plan.targets).filter(([, n]) => n > 0);
    return (
        <div className="grid gap-4 text-sm" data-slot="remove-dry-run">
            {blockers.length > 0 && (
                <section
                    aria-label="What blocks it"
                    data-slot="remove-blockers"
                    className="grid gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3"
                >
                    <h3 className="font-medium text-destructive">What blocks it</h3>
                    <ul className="grid gap-2">
                        {blockers.map((blocker) => (
                            <li key={blocker.text} className="grid gap-1" data-slot="remove-blocker">
                                <span className="text-destructive">{blocker.text}</span>
                                {blocker.help && <span className="text-xs text-muted-foreground">{blocker.help}</span>}
                                {/still own/i.test(blocker.text) && records.length > 0 && (
                                    <details className="text-xs text-muted-foreground" data-slot="remove-owned-records">
                                        <summary className="cursor-pointer">
                                            {plural(records.length, 'record')} the planner lists for this
                                        </summary>
                                        <ul className="mt-1 grid gap-1 break-all">
                                            {records.map((record) => (
                                                <li key={record.text}>{record.text}</li>
                                            ))}
                                        </ul>
                                    </details>
                                )}
                                {blocker.action === 'transfer' && (
                                    <Button variant="outline" size="sm" className="w-fit" onClick={onTransfer}>
                                        Transfer first…
                                    </Button>
                                )}
                                {blocker.action === 'deactivate' && (
                                    <Button variant="outline" size="sm" className="w-fit" onClick={onDeactivate}>
                                        Deactivate first…
                                    </Button>
                                )}
                            </li>
                        ))}
                    </ul>
                </section>
            )}
            <section aria-label="What goes" data-slot="remove-goes" className="grid gap-1">
                <h3 className="font-medium">What goes</h3>
                <ul className="grid divide-y">
                    {targets.map(([kind, n]) => (
                        <li key={kind} className="flex justify-between gap-2 py-1.5">
                            <span>{kind.replace(/_/g, ' ')}</span>
                            <span className="text-muted-foreground">{n}</span>
                        </li>
                    ))}
                    <li className="flex justify-between gap-2 py-1.5">
                        <span>Rows, across {plural(plan.tables.length, 'table')}</span>
                        <span className="text-muted-foreground">{plan.tables.reduce((a, t) => a + t.rows, 0)}</span>
                    </li>
                    {plan.files.count > 0 && (
                        <li className="flex justify-between gap-2 py-1.5">
                            <span>{plural(plan.files.count, 'file')}</span>
                            <span className="text-muted-foreground">{byteSize(plan.files.bytes)}</span>
                        </li>
                    )}
                    {plan.objects.count > 0 && (
                        <li className="flex justify-between gap-2 py-1.5">
                            <span>{plural(plan.objects.count, 'stored object')}</span>
                            <span className="text-muted-foreground">{byteSize(plan.objects.bytes)}</span>
                        </li>
                    )}
                </ul>
            </section>
            {plan.kept.length > 0 && (
                <section aria-label="Stays as history" data-slot="remove-kept" className="grid gap-1">
                    <h3 className="font-medium">Stays as history</h3>
                    <p className="text-xs text-muted-foreground">
                        These records stay and still name them by an id that no longer resolves to a person.
                    </p>
                    <ul className="grid divide-y">
                        {plan.kept.map((k) => (
                            <li key={`${k.table}.${k.column}`} className="flex justify-between gap-2 py-1.5">
                                <span>
                                    <code className="text-xs">
                                        {k.table}.{k.column}
                                    </code>
                                </span>
                                <span className="text-muted-foreground">{plural(k.rows, 'row')}</span>
                            </li>
                        ))}
                    </ul>
                </section>
            )}
        </div>
    );
}

/**
 * Remove permanently (CB-360): admins (CB-390), never on the workspace
 * owner. First the purge's dry run (what goes, what stays as history, what
 * blocks it), then their name typed exactly and the admin's step-up (as
 * Settings → Access), then the result with the backup's location.
 */
export function RemoveDialog({
    person,
    onClose,
    onTransfer,
    onDeactivate,
    onRemoved,
}: {
    person: { id: string; name: string };
    onClose: () => void;
    /** "Transfer first": the transfer dialog, for owned assets that block it. */
    onTransfer: () => void;
    /** "Deactivate first": the deactivate dialog. */
    onDeactivate: () => void;
    /** Done: back to the People list. */
    onRemoved: () => void;
}) {
    const [step, setStep] = useState<'plan' | 'confirm'>('plan');
    const [plan, setPlan] = useState<PersonPurgePlan>();
    const [result, setResult] = useState<PersonPurgeResult>();
    const [error, setError] = useState<string>();
    const [typed, setTyped] = useState('');
    const [challenge, setChallenge] = useState<StepUpChallenge>();
    // The proofs the last challenge offered: kept, disabled, while a new one comes.
    const [methods, setMethods] = useState<StepUpMethod[]>([]);
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        const controller = new AbortController();
        api<PersonPurgePlan>(purgePath(person.id), 'POST', { apply: false }, controller.signal)
            .then(setPlan)
            .catch((e: unknown) => {
                if (!controller.signal.aborted) {
                    setError(e instanceof Error ? e.message : 'Could not plan the removal.');
                }
            });
        return () => controller.abort();
    }, [person.id]);
    // Each challenge works once and is bound to this person and name.
    // The one in hand is dropped first: nothing can send a spent one.
    const challengeAgain = useCallback(() => {
        setChallenge(undefined);
        return api<StepUpChallenge>(purgePath(person.id, '/step-up'), 'POST', {})
            .then((next) => {
                setChallenge(next);
                setMethods(next.methods);
                if (next.reason) {
                    setError(next.reason);
                }
            })
            .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not start the confirmation.'));
    }, [person.id]);
    useEffect(() => {
        if (step === 'confirm') {
            void challengeAgain();
        }
    }, [step, challengeAgain]);
    const matches = typed === person.name;
    const remove = async (proof: (id: string) => Promise<StepUpProof>) => {
        if (!challenge || !matches) {
            return;
        }
        setBusy(true);
        setError(undefined);
        try {
            const done = await api<PersonPurgeResult>(purgePath(person.id), 'POST', {
                apply: true,
                confirmName: typed,
                stepUp: await proof(challenge.id),
            });
            setResult(done);
        } catch (e) {
            const message = e instanceof Error ? e.message : 'Could not remove them.';
            setError(message);
            // The server spends a challenge before it applies: every retry needs a new one.
            void challengeAgain();
            // A 409 is a refusal or a failed apply: what blocks it may have changed.
            if (e instanceof ApiError && e.status === 409) {
                try {
                    const next = await api<PersonPurgePlan>(purgePath(person.id), 'POST', { apply: false });
                    setPlan(next);
                    if (next.refusals.length) {
                        setStep('plan');
                    }
                } catch {
                    // Keep the plan shown; the error above says what failed.
                }
                setError(message);
            }
        } finally {
            setBusy(false);
        }
    };
    const withPassword = (e: FormEvent) => {
        e.preventDefault();
        void remove(async (id) => ({ id, password }));
    };
    const withPasskey = () =>
        void remove(async (id) => {
            const { startAuthentication } = await importOrReload(() => import('@simplewebauthn/browser'));
            const response = await startAuthentication({ optionsJSON: challenge!.passkey as never });
            return { id, passkey: response as unknown as Record<string, unknown> };
        });
    const waiting = !challenge;
    const first = firstName(person.name);
    const blocked = !plan || plan.refusals.length > 0;
    return (
        <Dialog open onOpenChange={(open) => !open && !busy && (result ? onRemoved() : onClose())}>
            <DialogContent data-slot="remove-dialog" className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle>
                        {result ? `${person.name} is removed` : `Remove ${person.name} permanently?`}
                    </DialogTitle>
                    <DialogDescription>
                        {result
                            ? 'Their records are gone. A backup was made first.'
                            : 'This deletes them and what is only theirs for good, after a backup. It can’t be undone in the app. Deactivating is the reversible choice.'}
                    </DialogDescription>
                </DialogHeader>
                {result ? (
                    <div className="grid gap-2 text-sm" data-slot="remove-result">
                        <p>
                            {plural(result.rows, 'row')} deleted across {plural(result.tables.length, 'table')}.
                        </p>
                        {result.backup && (
                            <p data-slot="remove-backup">
                                Backed up first to <code className="text-xs break-all">{result.backup}</code>
                            </p>
                        )}
                        {'error' in result.cleanup ? (
                            <p role="alert" className="text-destructive" data-slot="remove-cleanup-error">
                                Removing their files didn’t finish: {result.cleanup.error} Run{' '}
                                <code className="text-xs break-all">pnpm run purge --resume {result.backup}</code> on
                                the server to finish it.
                            </p>
                        ) : (
                            <p className="text-muted-foreground">
                                {plural(result.cleanup.files, 'file')} and{' '}
                                {plural(result.cleanup.objects, 'stored object')} removed (
                                {byteSize(result.cleanup.bytes)}).
                            </p>
                        )}
                    </div>
                ) : !plan ? (
                    error ? null : (
                        <Skeleton className="h-32" data-slot="remove-loading" />
                    )
                ) : step === 'plan' ? (
                    <DryRun plan={plan} onTransfer={onTransfer} onDeactivate={onDeactivate} />
                ) : (
                    <div className="grid gap-4 text-sm" data-slot="remove-confirm">
                        <label className="grid gap-1">
                            <span>
                                Type <strong className="select-all">{person.name}</strong> to confirm
                            </span>
                            <Input
                                aria-label="Their name"
                                value={typed}
                                onChange={(e) => setTyped(e.target.value)}
                                autoComplete="off"
                                spellCheck={false}
                                autoFocus
                            />
                            {typed && !matches && (
                                <span className="text-xs text-muted-foreground" data-slot="remove-name-mismatch">
                                    Type it exactly as shown.
                                </span>
                            )}
                        </label>
                        {waiting && (
                            <p className="text-xs text-muted-foreground" data-slot="remove-step-up-waiting">
                                Getting a fresh confirmation…
                            </p>
                        )}
                        <p className="text-xs text-muted-foreground">
                            Then confirm it’s you. Every admin can see the removal in the audit log.
                        </p>
                        {methods.includes('password') && (
                            <form className="grid gap-2" onSubmit={withPassword} aria-label="Confirm with password">
                                <label className="grid gap-1">
                                    Your password
                                    <Input
                                        type="password"
                                        autoComplete="current-password"
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                    />
                                </label>
                                <div>
                                    <Button
                                        type="submit"
                                        variant="destructive"
                                        disabled={busy || waiting || !matches || !password}
                                    >
                                        Remove {first} permanently
                                    </Button>
                                </div>
                            </form>
                        )}
                        {methods.includes('passkey') && (
                            <div>
                                <Button
                                    variant={methods.includes('password') ? 'outline' : 'destructive'}
                                    disabled={busy || waiting || !matches}
                                    onClick={withPasskey}
                                >
                                    Remove {first} with a passkey
                                </Button>
                            </div>
                        )}
                        {methods.includes('confirm') && (
                            <div>
                                <Button
                                    variant="destructive"
                                    disabled={busy || waiting || !matches}
                                    onClick={() => void remove(async (id) => ({ id, confirm: true }))}
                                >
                                    Remove {first} permanently (development sign-in)
                                </Button>
                            </div>
                        )}
                    </div>
                )}
                {error && (
                    <p className="text-sm text-destructive" role="alert" data-slot="remove-error">
                        {error}
                    </p>
                )}
                <DialogFooter>
                    {result ? (
                        <Button onClick={onRemoved}>Back to People</Button>
                    ) : (
                        <>
                            <Button variant="ghost" disabled={busy} onClick={onClose}>
                                Cancel
                            </Button>
                            {step === 'plan' && (
                                <Button variant="destructive" disabled={blocked} onClick={() => setStep('confirm')}>
                                    Continue
                                </Button>
                            )}
                        </>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
