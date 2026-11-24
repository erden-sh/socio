import { useCallback, useEffect, useState, type FormEvent } from 'react';

import type { StepUpChallenge, StepUpMethod, StepUpProof } from '@socio/shared/access-policy';
import type { Account } from '@socio/shared/auth';

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
export function MakeOwnerDialog({
    person,
    onClose,
    onDone,
}: {
    person: { id: string; name: string };
    onClose: () => void;
    /** Done: the page loads again. */
    onDone: () => void;
}) {
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
            .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not start the confirmation.'));
    }, [person.id]);
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
            setError(e instanceof Error ? e.message : 'Could not make them the owner.');
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
                    <DialogTitle>Make {person.name} the workspace owner?</DialogTitle>
                    <DialogDescription>
                        The owner is the one admin other admins can’t demote, deactivate or remove. You stay an admin;{' '}
                        {first} can hand ownership on the same way. Every admin is told.
                    </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 text-sm" data-slot="make-owner-confirm">
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
                            <span className="text-xs text-muted-foreground" data-slot="make-owner-name-mismatch">
                                Type it exactly as shown.
                            </span>
                        )}
                    </label>
                    {waiting && !error && (
                        <p className="text-xs text-muted-foreground" data-slot="make-owner-step-up-waiting">
                            Getting a fresh confirmation…
                        </p>
                    )}
                    <p className="text-xs text-muted-foreground">Then confirm it’s you.</p>
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
                                <Button type="submit" disabled={busy || waiting || !matches || !password}>
                                    Make {first} the owner
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
                                Make {first} the owner with a passkey
                            </Button>
                        </div>
                    )}
                    {methods.includes('confirm') && (
                        <div>
                            <Button
                                disabled={busy || waiting || !matches}
                                onClick={() => void transfer(async (id) => ({ id, confirm: true }))}
                            >
                                Make {first} the owner (development sign-in)
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
                        Cancel
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
