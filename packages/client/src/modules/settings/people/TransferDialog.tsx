import { useEffect, useMemo, useState } from 'react';

import type { AssetKind, AssetTransfer, OwnedKind, PersonAssets, Roster, RosterPerson } from '@socio/shared/auth';
import { compareText } from '@socio/shared/locale';

import { dialogSelect } from '../../../components/form-fields';
import { ApiError, api } from '../../../lib/api';

import { ASSET_INFO, assetCount, firstName, movedWords } from './people-format';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

/** Who a transfer is from. */
export interface TransferPerson {
    id: string;
    name: string;
}

const accountPath = (id: string, rest = '') => `/accounts/${encodeURIComponent(id)}${rest}`;

/**
 * Who can receive a person's assets (CB-360): active people with an app
 * user, never the person themselves. The roster lists people only, so no
 * service account is offered (the server refuses one anyway).
 */
export function useRecipients(personId: string) {
    const [people, setPeople] = useState<RosterPerson[]>();
    const [error, setError] = useState<string>();
    useEffect(() => {
        const controller = new AbortController();
        api<Roster>('/accounts/roster', 'GET', undefined, controller.signal)
            .then((roster) =>
                setPeople(
                    roster.people
                        .filter((p) => p.status === 'active' && !p.deactivated && !!p.userId && p.id !== personId)
                        .sort((a, b) => compareText(a.name, b.name)),
                ),
            )
            .catch((e: unknown) => {
                if (!controller.signal.aborted) {
                    setError(e instanceof Error ? e.message : 'Could not load the people.');
                }
            });
        return () => controller.abort();
    }, [personId]);
    return { people, error };
}

/** The new owner picker: active people only. */
export function RecipientPicker({
    people,
    value,
    onChange,
    label,
    none = 'Choose a person…',
    disabled,
}: {
    people: RosterPerson[] | undefined;
    value: string;
    onChange: (id: string) => void;
    label: string;
    none?: string;
    disabled?: boolean;
}) {
    return (
        <select
            aria-label={label}
            className={dialogSelect}
            value={value}
            disabled={disabled || !people}
            onChange={(e) => onChange(e.target.value)}
        >
            <option value="">{people ? none : 'Loading people…'}</option>
            {people?.map((p) => (
                <option key={p.id} value={p.id}>
                    {p.name} ({p.email})
                </option>
            ))}
        </select>
    );
}

/**
 * What a transfer did, kind by kind, with its notes: running promoted apps
 * restart with the new owner's data token, and say so under Apps.
 */
export function TransferResult({ result }: { result: AssetTransfer }) {
    return (
        <div className="grid gap-3 text-sm" data-slot="transfer-result">
            <ul className="grid divide-y" aria-label="What moved">
                {result.kinds.map((k) => (
                    <li key={k.kind} data-kind={k.kind} data-slot="transfer-result-kind" className="grid gap-0.5 py-2">
                        <span className="flex flex-wrap justify-between gap-2">
                            <span className="font-medium">{ASSET_INFO[k.kind].title}</span>
                            <span className="text-muted-foreground">{movedWords(k.moved)}</span>
                        </span>
                        {k.notes.map((note) => (
                            <span key={note} className="text-xs text-muted-foreground">
                                {note}
                            </span>
                        ))}
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** The kinds with anything in them: what a transfer offers. */
const nonEmpty = (kinds: OwnedKind[]) => kinds.filter((k) => k.count > 0);

/**
 * Transfer ownership (CB-360): pick the new owner (active people only),
 * see every kind they own with its count, all ticked by default; unticking
 * any warns that kinds moved apart can stay linked across the two people.
 * Confirming moves them in one transaction, then shows what moved, kind by
 * kind.
 *
 * `only` opens it with just those kinds ticked (a kind's own Transfer).
 */
export function TransferDialog({
    person,
    only,
    onClose,
    onTransferred,
}: {
    person: TransferPerson;
    only?: AssetKind[];
    onClose: () => void;
    /** Ownership changed, or may have (a lost answer): no result then. */
    onTransferred?: (result?: AssetTransfer) => void;
}) {
    const [assets, setAssets] = useState<PersonAssets>();
    const [error, setError] = useState<string>();
    const [to, setTo] = useState('');
    const [unticked, setUnticked] = useState<Set<AssetKind>>(new Set());
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<AssetTransfer>();
    const { people, error: peopleError } = useRecipients(person.id);
    useEffect(() => {
        const controller = new AbortController();
        api<PersonAssets>(accountPath(person.id, '/assets'), 'GET', undefined, controller.signal)
            .then((loaded) => {
                setAssets(loaded);
                if (only) {
                    setUnticked(new Set(loaded.kinds.map((k) => k.kind).filter((kind) => !only.includes(kind))));
                }
            })
            .catch((e: unknown) => {
                if (!controller.signal.aborted) {
                    setError(e instanceof Error ? e.message : 'Could not load what they own.');
                }
            });
        return () => controller.abort();
        // `only` is read once, when the dialog opens.
        // oxlint-disable-next-line react-hooks/exhaustive-deps
    }, [person.id]);
    const first = firstName(person.name);
    const kinds = useMemo(() => nonEmpty(assets?.kinds ?? []), [assets]);
    // Apps take the data space with them (the server adds it): shown ticked, fixed.
    const ticked = (kind: AssetKind) =>
        !unticked.has(kind) || (kind === 'data' && kinds.some((k) => k.kind === 'apps') && !unticked.has('apps'));
    const chosen = kinds.filter((k) => ticked(k.kind)).map((k) => k.kind);
    const partial = chosen.length > 0 && chosen.length < kinds.length;
    const recipient = people?.find((p) => p.id === to);
    const toggle = (kind: AssetKind, on: boolean) =>
        setUnticked((now) => {
            const next = new Set(now);
            if (on) {
                next.delete(kind);
            } else {
                next.add(kind);
            }
            return next;
        });
    const confirm = async () => {
        setBusy(true);
        setError(undefined);
        try {
            // Everything: no list, so whatever they own by now moves too.
            const done = await api<AssetTransfer>(
                accountPath(person.id, '/transfer'),
                'POST',
                partial ? { to, kinds: chosen } : { to },
            );
            setResult(done);
            onTransferred?.(done);
        } catch (e) {
            const why = e instanceof Error ? e.message : 'Could not transfer.';
            // The server answered: it refused, and its transaction moved nothing.
            if (e instanceof ApiError && (e.status < 500 || e.status === 503)) {
                setError(why);
                return;
            }
            // The answer was lost: it may have moved. Read what they own
            // again, and have the new owner chosen again, before a retry.
            setError(
                `Couldn’t confirm the transfer finished (${why}). What ${firstName(person.name)} owns now is loaded again: check it before you try again.`,
            );
            setAssets(undefined);
            setTo('');
            onTransferred?.();
            try {
                setAssets(await api<PersonAssets>(accountPath(person.id, '/assets')));
            } catch {
                // The error above stands; the dialog shows no kinds to move.
            }
        } finally {
            setBusy(false);
        }
    };
    return (
        <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
            <DialogContent data-slot="transfer-dialog" className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle>
                        {result ? `Moved to ${result.to.name}` : `Transfer what ${person.name} owns`}
                    </DialogTitle>
                    <DialogDescription>
                        {result
                            ? `What ${first} owned of these kinds is ${firstName(result.to.name)}’s now. Both people’s activity records it.`
                            : `The company owns its people’s work: hand it to another active person. Secrets ${first} holds personally (subscription logins, OAuth tokens) never move.`}
                    </DialogDescription>
                </DialogHeader>
                {result ? (
                    <TransferResult result={result} />
                ) : !assets && !error ? (
                    <Skeleton className="h-32" data-slot="transfer-loading" />
                ) : assets && !kinds.length ? (
                    <p className="text-sm text-muted-foreground" data-slot="transfer-nothing">
                        {first} owns nothing to transfer.
                    </p>
                ) : assets ? (
                    <div className="grid gap-4 text-sm">
                        <label className="grid gap-1">
                            <span className="font-medium">New owner</span>
                            <RecipientPicker people={people} value={to} onChange={setTo} label="New owner" />
                            {peopleError && <span className="text-xs text-destructive">{peopleError}</span>}
                            {people && !people.length && (
                                <span className="text-xs text-muted-foreground">
                                    Nobody else is active to receive it.
                                </span>
                            )}
                        </label>
                        <fieldset className="grid gap-1" data-slot="transfer-kinds">
                            <legend className="mb-1 font-medium">What moves</legend>
                            {kinds.map((k) => {
                                const fixed =
                                    k.kind === 'data' && kinds.some((o) => o.kind === 'apps') && ticked('apps');
                                const id = `transfer-kind-${k.kind}`;
                                return (
                                    <div
                                        key={k.kind}
                                        className="flex items-start gap-2 border-t py-2 first-of-type:border-t-0"
                                        data-slot="transfer-kind"
                                        data-kind={k.kind}
                                    >
                                        <Checkbox
                                            id={id}
                                            className="mt-0.5"
                                            checked={ticked(k.kind)}
                                            disabled={fixed || busy}
                                            onCheckedChange={(on) => toggle(k.kind, on === true)}
                                            aria-label={ASSET_INFO[k.kind].title}
                                        />
                                        <label htmlFor={id} className="grid min-w-0 flex-1 gap-0.5">
                                            <span className="flex flex-wrap justify-between gap-2">
                                                <span>{ASSET_INFO[k.kind].title}</span>
                                                <span className="text-muted-foreground">
                                                    {assetCount(k.kind, k.count)}
                                                </span>
                                            </span>
                                            <span className="text-xs text-muted-foreground">
                                                {fixed ? 'Moves with the apps. ' : ''}
                                                {ASSET_INFO[k.kind].what}
                                            </span>
                                        </label>
                                    </div>
                                );
                            })}
                        </fieldset>
                        {partial && (
                            <p
                                role="alert"
                                data-slot="transfer-partial-warning"
                                className="rounded-md border border-paused-banner-border bg-paused-banner px-3 py-2 text-paused-banner-foreground"
                            >
                                <strong>Only some kinds move.</strong> What stays with {first} can still be linked to
                                what moves: a schedule can move while the socio it runs as stays theirs, or an app while
                                a Space it posts to doesn’t. Transfer everything unless you mean to split it.
                            </p>
                        )}
                    </div>
                ) : null}
                {error && (
                    <p className="text-sm text-destructive" role="alert" data-slot="transfer-error">
                        {error}
                    </p>
                )}
                <DialogFooter>
                    {result ? (
                        <Button onClick={onClose}>Done</Button>
                    ) : (
                        <>
                            <Button variant="ghost" disabled={busy} onClick={onClose}>
                                Cancel
                            </Button>
                            <Button disabled={busy || !recipient || !chosen.length} onClick={() => void confirm()}>
                                {busy
                                    ? 'Transferring…'
                                    : recipient
                                      ? `${partial ? 'Transfer these' : 'Transfer everything'} to ${firstName(recipient.name)}`
                                      : 'Transfer'}
                            </Button>
                        </>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
