import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { Trans, useTranslation } from '@socio/i18n/react';
import type { StepUpChallenge, StepUpMethod, StepUpProof } from '@socio/shared/access-policy';
import type { Account } from '@socio/shared/auth';

import { onDemand } from '../../../i18n/on-demand';
import { api } from '../../../lib/api';
import { importOrReload } from '../../../shell/chunk-reload';

import { firstName } from './people-format';

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

const ownerPath = (id: string, rest = '') => `/accounts/${encodeURIComponent(id)}/owner${rest}`;

/**
 * Make owner (CB-390): the workspace owner hands ownership to another
 * active admin, in person. Their name typed exactly and the owner's step-up
 * (as Remove permanently); the previous owner stays an admin, and every
 * admin is told.
 */
function MakeOwnerDialogBody({
    person,
    onClose,
    onDone,
}: {
    person: { id: string; name: string };
    onClose: () => void;
    /** Done: the page loads again. */
    onDone: () => void;
}) {
    const { t } = useTranslation(['settings.person-dialogs', 'settings.person']);
    const [typed, setTyped] = useState('');
    const [challenge, setChallenge] = useState<StepUpChallenge>();
    // The proofs the last challenge offered: kept, disabled, while a new one comes.
    const [methods, setMethods] = useState<StepUpMethod[]>([]);
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    // Each challenge works once and is bound to this person and name.
    const challengeAgain = useCallback(() => {
        setChallenge(undefined);
        return api<StepUpChallenge>(ownerPath(person.id, '/step-up'), 'POST', {})
            .then((next) => {
                setChallenge(next);
                setMethods(next.methods);
                if (next.reason) {
                    setError(next.reason);
                }
            })
            .catch((e: unknown) =>
                setError(e instanceof Error ? e.message : t('settings.person-dialogs:confirm.startFailed')),
            );
    }, [person.id, t]);
    useEffect(() => {
        void challengeAgain();
    }, [challengeAgain]);
    const matches = typed === person.name;
    const transfer = async (proof: (id: string) => Promise<StepUpProof>) => {
        if (!challenge || !matches) {
            return;
        }
        setBusy(true);
        setError(undefined);
        try {
            await api<Account>(ownerPath(person.id), 'POST', {
                confirmName: typed,
                stepUp: await proof(challenge.id),
            });
            onDone();
        } catch (e) {
            setError(e instanceof Error ? e.message : t('settings.person-dialogs:makeOwner.failed'));
            // The server spends a challenge before it applies: every retry needs a new one.
            void challengeAgain();
        } finally {
            setBusy(false);
        }
    };
    const withPassword = (e: FormEvent) => {
        e.preventDefault();
        void transfer(async (id) => ({ id, password }));
    };
    const withPasskey = () =>
        void transfer(async (id) => {
            const { startAuthentication } = await importOrReload(() => import('@simplewebauthn/browser'));
            const response = await startAuthentication({ optionsJSON: challenge!.passkey as never });
            return { id, passkey: response as unknown as Record<string, unknown> };
        });
    const waiting = !challenge;
    const first = firstName(person.name);
    return (
        <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
            <DialogContent data-slot="make-owner-dialog" className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>{t('settings.person-dialogs:makeOwner.title', { name: person.name })}</DialogTitle>
                    <DialogDescription>
                        {t('settings.person-dialogs:makeOwner.description', { first })}
                    </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 text-sm" data-slot="make-owner-confirm">
                    <label className="grid gap-1">
                        <span>
                            <Trans
                                t={t}
                                i18nKey="settings.person-dialogs:confirm.typeName"
                                values={{ name: person.name }}
                                components={{ strong: <strong className="select-all" /> }}
                            />
                        </span>
                        <Input
                            aria-label={t('settings.person-dialogs:confirm.nameField')}
                            value={typed}
                            onChange={(e) => setTyped(e.target.value)}
                            autoComplete="off"
                            spellCheck={false}
                            autoFocus
                        />
                        {typed && !matches && (
                            <span className="text-xs text-muted-foreground" data-slot="make-owner-name-mismatch">
                                {t('settings.person-dialogs:confirm.mismatch')}
                            </span>
                        )}
                    </label>
                    {waiting && !error && (
                        <p className="text-xs text-muted-foreground" data-slot="make-owner-step-up-waiting">
                            {t('settings.person-dialogs:confirm.waiting')}
                        </p>
                    )}
                    <p className="text-xs text-muted-foreground">{t('settings.person-dialogs:makeOwner.stepUp')}</p>
                    {methods.includes('password') && (
                        <form
                            className="grid gap-2"
                            onSubmit={withPassword}
                            aria-label={t('settings.person-dialogs:confirm.passwordForm')}
                        >
                            <label className="grid gap-1">
                                {t('settings.person-dialogs:confirm.password')}
                                <Input
                                    type="password"
                                    autoComplete="current-password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                />
                            </label>
                            <div>
                                <Button type="submit" disabled={busy || waiting || !matches || !password}>
                                    {t('settings.person-dialogs:makeOwner.withPassword', { first })}
                                </Button>
                            </div>
                        </form>
                    )}
                    {methods.includes('passkey') && (
                        <div>
                            <Button
                                variant={methods.includes('password') ? 'outline' : 'default'}
                                disabled={busy || waiting || !matches}
                                onClick={withPasskey}
                            >
                                {t('settings.person-dialogs:makeOwner.withPasskey', { first })}
                            </Button>
                        </div>
                    )}
                    {methods.includes('confirm') && (
                        <div>
                            <Button
                                disabled={busy || waiting || !matches}
                                onClick={() => void transfer(async (id) => ({ id, confirm: true }))}
                            >
                                {t('settings.person-dialogs:makeOwner.withConfirm', { first })}
                            </Button>
                        </div>
                    )}
                </div>
                {error && (
                    <p className="text-sm text-destructive" role="alert" data-slot="make-owner-error">
                        {error}
                    </p>
                )}
                <DialogFooter>
                    <Button variant="ghost" disabled={busy} onClick={onClose}>
                        {t('settings.person:cancel')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** Its words load when it opens (`settings.person-dialogs`, in no route's entry). */
export const MakeOwnerDialog = onDemand(['settings.person-dialogs', 'settings.person'], MakeOwnerDialogBody);
