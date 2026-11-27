import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import type { AssetTransfer, DeactivationImpact } from '@socio/shared/auth';

import { ApiError, api } from '../../../lib/api';
import { onDemand } from '../on-demand';

import {
    ACTIVE_NOW_MS,
    firstName,
    initials,
    ownedKinds,
    serviceAccountPath,
    useAssetWords,
    useImpactWords,
    usePeopleFormat,
} from './people-format';
import { RecipientPicker, TransferDialog, useRecipients } from './TransferDialog';

import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

/** Who the dialogs are about. */
export interface DialogPerson {
    id: string;
    name: string;
}

/** Says what a transfer moved, with what happened to running apps (they restart for the new owner). */
export function useTransferToast() {
    const { t } = useTranslation(['settings.person-dialogs', 'settings.person']);
    return (result: AssetTransfer) => {
        const notes = result.kinds.find((k) => k.kind === 'apps')?.notes ?? [];
        toast.success(
            t('settings.person-dialogs:deactivate.transferred', { from: result.from.name, to: result.to.name }),
            {
                description: notes.length ? notes.join(' ') : undefined,
            },
        );
    };
}

/** How long ago a key was used, for the preview: "used 2 h ago", "never used". */
function useKeyUse() {
    const { t } = useTranslation(['settings.person-dialogs', 'settings.person']);
    const { lastActive } = usePeopleFormat();
    return (at: number | null, now = Date.now()) => {
        if (at === null) {
            return t('settings.person-dialogs:deactivate.keyNever');
        }
        if (now - at < ACTIVE_NOW_MS) {
            return t('settings.person-dialogs:deactivate.keyJustNow');
        }
        return t('settings.person-dialogs:deactivate.keyUsed', { ago: lastActive(at, now, true) });
    };
}

/**
 * Deactivate, with the impact preview (CB-360): the keys they
 * made first, a red warning where one is its service account's last live
 * key, with a link to make it a new one; then what else ends, and what
 * stays theirs, with Transfer… (the transfer dialog, any kinds) and
 * "Transfer everything to … and deactivate": the transfer runs first, and
 * if it fails nothing is deactivated. A refusal (the last admin, or the
 * workspace owner) says why and disables the buttons, which name the person.
 */
function DeactivateDialogBody({
    person,
    onClose,
    onConfirm,
    onTransferred,
}: {
    person: DialogPerson;
    onClose: () => void;
    onConfirm: () => Promise<void>;
    /** Ownership changed here (or may have): the page loads what they own again. */
    onTransferred?: () => void;
}) {
    const { t } = useTranslation(['settings.person-dialogs', 'settings.person']);
    const { assetCount } = useAssetWords();
    const { alsoEnds } = useImpactWords();
    const keyUse = useKeyUse();
    const transferToast = useTransferToast();
    const [impact, setImpact] = useState<DeactivationImpact>();
    const [error, setError] = useState<string>();
    // A failed transfer: shown under the preview, so another new owner can be picked.
    const [actionError, setActionError] = useState<string>();
    const [busy, setBusy] = useState(false);
    const [transferring, setTransferring] = useState(false);
    const [to, setTo] = useState('');
    const { people } = useRecipients(person.id);
    const loadImpact = useCallback(
        (signal?: AbortSignal) =>
            api<DeactivationImpact>(
                `/accounts/${encodeURIComponent(person.id)}/deactivation-impact`,
                'GET',
                undefined,
                signal,
            )
                .then(setImpact)
                .catch((e: unknown) => {
                    if (!signal?.aborted) {
                        setError(e instanceof Error ? e.message : t('settings.person-dialogs:deactivate.impactFailed'));
                    }
                }),
        [person.id, t],
    );
    useEffect(() => {
        const controller = new AbortController();
        void loadImpact(controller.signal);
        return () => controller.abort();
    }, [loadImpact]);
    const first = firstName(person.name);
    // Older servers list apps only.
    const owned = impact ? ownedKinds(impact.owned ?? { apps: impact.appsOwned }) : [];
    const recipient = people?.find((p) => p.id === to);
    const deactivate = async (handTo?: string) => {
        setBusy(true);
        setActionError(undefined);
        try {
            // Transfer first: a deactivation that fails afterwards leaves the
            // work with someone active, never the other way round.
            if (handTo) {
                let moved: AssetTransfer;
                try {
                    moved = await api<AssetTransfer>(`/accounts/${encodeURIComponent(person.id)}/transfer`, 'POST', {
                        to: handTo,
                    });
                } catch (e) {
                    // The server answered: it refused, and its transaction moved
                    // nothing. Otherwise the answer was lost and it may have moved.
                    const refused = e instanceof ApiError && (e.status < 500 || e.status === 503);
                    const why = e instanceof Error ? e.message : t('settings.person-dialogs:deactivate.unknownError');
                    if (refused) {
                        setActionError(t('settings.person-dialogs:deactivate.transferRefused', { first, why }));
                    } else {
                        setActionError(t('settings.person-dialogs:deactivate.transferLost', { first, why }));
                        void loadImpact();
                        onTransferred?.();
                    }
                    return;
                }
                transferToast(moved);
                onTransferred?.();
            }
            await onConfirm();
        } finally {
            setBusy(false);
        }
    };
    if (transferring) {
        return (
            <TransferDialog
                person={person}
                onTransferred={() => onTransferred?.()}
                onClose={() => {
                    setTransferring(false);
                    setImpact(undefined);
                    void loadImpact();
                }}
            />
        );
    }
    const ends = impact ? alsoEnds(impact, first) : [];
    const orphaned = impact?.keys.filter((key) => key.lastLiveKey) ?? [];
    // Each account once, for the "make a new key" links.
    const orphanedAccounts = [...new Map(orphaned.map((key) => [key.accountId, key.account])).entries()];
    return (
        <AlertDialog open onOpenChange={(open) => !open && !busy && onClose()}>
            <AlertDialogContent data-slot="confirm-deactivate" className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
                <AlertDialogHeader>
                    <AlertDialogTitle>
                        {t('settings.person-dialogs:deactivate.title', { name: person.name })}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                        {t('settings.person-dialogs:deactivate.description', { first })}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                {error ? (
                    <p className="text-sm text-destructive" role="alert">
                        {error}
                    </p>
                ) : !impact ? (
                    <Skeleton className="h-24" data-slot="impact-loading" />
                ) : (
                    <div className="grid gap-4 text-sm" data-slot="deactivation-impact">
                        {impact.refusal && (
                            <p
                                role="alert"
                                data-slot="impact-refusal"
                                className="rounded-md border border-paused-banner-border bg-paused-banner px-3 py-2 text-paused-banner-foreground"
                            >
                                {impact.refusal}
                            </p>
                        )}
                        {impact.keys.length > 0 && (
                            <section
                                aria-label={t('settings.person-dialogs:deactivate.keysSection')}
                                data-slot="impact-keys"
                                className="grid gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive"
                            >
                                <p>
                                    <strong>
                                        {t('settings.person-dialogs:deactivate.keysStop', {
                                            count: impact.keys.length,
                                        })}
                                    </strong>{' '}
                                    {t('settings.person-dialogs:deactivate.keysMade', {
                                        count: impact.keys.length,
                                        first,
                                    })}
                                </p>
                                <ul className="grid divide-y divide-destructive/15">
                                    {impact.keys.map((key) => (
                                        <li
                                            key={key.keyId}
                                            data-key={key.name}
                                            className="flex flex-wrap items-center gap-2 py-2 first:pt-0 last:pb-0"
                                        >
                                            <span
                                                aria-hidden
                                                className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background text-xs font-semibold text-foreground/70"
                                            >
                                                {initials(key.account)}
                                            </span>
                                            <span className="min-w-0 flex-1">
                                                {key.account} / {key.name}{' '}
                                                <span className="text-xs opacity-80">{keyUse(key.lastUsedAt)}</span>
                                            </span>
                                            {key.lastLiveKey ? (
                                                <Badge
                                                    data-slot="last-live-key"
                                                    className="border-destructive/40 bg-background text-destructive"
                                                >
                                                    {t('settings.person-dialogs:deactivate.lastKey', {
                                                        account: key.account,
                                                    })}
                                                </Badge>
                                            ) : (
                                                <span className="text-xs">
                                                    {t('settings.person-dialogs:deactivate.otherKey', {
                                                        account: key.account,
                                                    })}
                                                </span>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                                {orphanedAccounts.map(([accountId, account]) => (
                                    <p key={accountId} className="text-xs">
                                        {t('settings.person-dialogs:deactivate.newKey', { account })}{' '}
                                        <Link
                                            to={serviceAccountPath(accountId)}
                                            className="underline underline-offset-2"
                                            onClick={onClose}
                                        >
                                            {t('settings.person-dialogs:deactivate.openAccount', { account })}
                                        </Link>
                                    </p>
                                ))}
                            </section>
                        )}
                        {ends.length > 0 && (
                            <section
                                aria-label={t('settings.person-dialogs:deactivate.alsoEnds')}
                                className="grid gap-1"
                            >
                                <h3 className="font-medium">{t('settings.person-dialogs:deactivate.alsoEnds')}</h3>
                                <ul className="grid divide-y">
                                    {ends.map((line) => (
                                        <li key={line.what} className="flex flex-wrap justify-between gap-2 py-2">
                                            <span>{line.what}</span>
                                            <span className="text-muted-foreground">{line.outcome}</span>
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        )}
                        {owned.length > 0 && (
                            <section
                                aria-label={t('settings.person-dialogs:deactivate.stays', { first })}
                                className="grid gap-1"
                                data-slot="impact-owned"
                            >
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <h3 className="font-medium">
                                        {t('settings.person-dialogs:deactivate.stays', { first })}
                                    </h3>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={busy}
                                        onClick={() => setTransferring(true)}
                                    >
                                        {t('settings.person-dialogs:deactivate.transfer')}
                                    </Button>
                                </div>
                                <ul className="grid divide-y">
                                    {owned.map(({ kind, count }) => (
                                        <li key={kind} className="flex flex-wrap justify-between gap-2 py-2">
                                            <span>
                                                {t('settings.person-dialogs:deactivate.theyOwn', {
                                                    what: assetCount(kind, count),
                                                })}
                                            </span>
                                            <span className="text-muted-foreground">
                                                {recipient
                                                    ? t('settings.person-dialogs:deactivate.movesTo', {
                                                          name: firstName(recipient.name),
                                                      })
                                                    : t('settings.person-dialogs:deactivate.kept')}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                                <div
                                    className="grid gap-2 rounded-md border bg-muted/30 p-3"
                                    data-slot="deactivate-transfer"
                                >
                                    <label className="grid gap-1">
                                        <span className="font-medium">
                                            {t('settings.person-dialogs:deactivate.handTo')}
                                        </span>
                                        <RecipientPicker
                                            people={people}
                                            value={to}
                                            onChange={setTo}
                                            label={t('settings.person-dialogs:deactivate.handTo')}
                                            none={t('settings.person-dialogs:deactivate.handToNobody')}
                                            disabled={busy || !!impact.refusal}
                                        />
                                    </label>
                                    {recipient && (
                                        <ol className="list-decimal pl-5 text-xs" data-slot="deactivate-transfer-order">
                                            <li>
                                                {t('settings.person-dialogs:deactivate.step1', {
                                                    first,
                                                    name: recipient.name,
                                                })}
                                            </li>
                                            <li>{t('settings.person-dialogs:deactivate.step2', { first })}</li>
                                            <li>{t('settings.person-dialogs:deactivate.step3', { first })}</li>
                                        </ol>
                                    )}
                                </div>
                            </section>
                        )}
                        {!impact.keys.length && !ends.length && !owned.length && !impact.refusal && (
                            <p className="text-muted-foreground">
                                {t('settings.person-dialogs:deactivate.nothingElse')}
                            </p>
                        )}
                    </div>
                )}
                {actionError && (
                    <p className="text-sm text-destructive" role="alert" data-slot="deactivate-action-error">
                        {actionError}
                    </p>
                )}
                <AlertDialogFooter className="flex-wrap">
                    <AlertDialogCancel disabled={busy}>{t('settings.person:cancel')}</AlertDialogCancel>
                    <Button
                        variant={recipient ? 'outline' : 'destructive'}
                        disabled={busy || !impact || !!impact.refusal}
                        onClick={() => void deactivate()}
                    >
                        {t('settings.person-dialogs:deactivate.confirm', {
                            context: owned.length > 0 && recipient ? 'only' : undefined,
                            first,
                        })}
                    </Button>
                    {owned.length > 0 && (
                        <Button
                            variant="destructive"
                            data-slot="transfer-and-deactivate"
                            disabled={busy || !impact || !!impact.refusal || !recipient}
                            onClick={() => void deactivate(to)}
                        >
                            {recipient
                                ? t('settings.person-dialogs:deactivate.transferAndDeactivate', {
                                      name: firstName(recipient.name),
                                  })
                                : t('settings.person-dialogs:deactivate.transferAndDeactivatePick')}
                        </Button>
                    )}
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}

/**
 * Reactivate: they can sign in again, and what the deactivation ended
 * stays ended.
 */
function ReactivateDialogBody({
    person,
    onClose,
    onConfirm,
}: {
    person: DialogPerson;
    onClose: () => void;
    onConfirm: () => Promise<void>;
}) {
    const { t } = useTranslation(['settings.person-dialogs', 'settings.person']);
    const [busy, setBusy] = useState(false);
    const first = firstName(person.name);
    return (
        <AlertDialog open onOpenChange={(open) => !open && !busy && onClose()}>
            <AlertDialogContent data-slot="confirm-reactivate">
                <AlertDialogHeader>
                    <AlertDialogTitle>
                        {t('settings.person-dialogs:reactivate.title', { name: person.name })}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                        {t('settings.person-dialogs:reactivate.description', { first })}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel disabled={busy}>{t('settings.person:cancel')}</AlertDialogCancel>
                    <Button
                        disabled={busy}
                        onClick={async () => {
                            setBusy(true);
                            try {
                                await onConfirm();
                            } finally {
                                setBusy(false);
                            }
                        }}
                    >
                        {t('settings.person-dialogs:reactivate.confirm', { first })}
                    </Button>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}

/** Its words load when it opens (`settings.person-dialogs`, in no route's entry). */
export const DeactivateDialog = onDemand(['settings.person-dialogs', 'settings.person'], DeactivateDialogBody);

/** Its words load when it opens (`settings.person-dialogs`, in no route's entry). */
export const ReactivateDialog = onDemand(['settings.person-dialogs', 'settings.person'], ReactivateDialogBody);
