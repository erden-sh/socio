import { useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import type { SignInMethods } from '@socio/shared/auth';
import type { LeaveWorkspaceCheck } from '@socio/shared/leave-workspace';
import { roleLabel } from '@socio/shared/roles';

import {
    addPasskey,
    changePassword,
    deletePasskey,
    leaveWorkspace,
    leaveWorkspaceCheck,
    listPasskeys,
    signOutEverywhere,
    updateName,
    type Passkey,
} from '../../shell/auth-client';
import { CurrentUser } from '../../shell/current-user';

import { DevicesCard } from './DevicesCard';

import { ConfirmDelete } from '@/components/confirm-delete';
import { nativeSelect } from '@/components/form-fields';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

const failed = (e: unknown, fallback: string) => toast.error(e instanceof Error ? e.message : fallback);
// The shared native select (components/form-fields.tsx, CB-258), here too
// for the settings sections that import it from this file.
export { nativeSelect };

/**
 * Settings → Account → Profile (formerly the account dialog): with Better
 * Auth, the name others see, passkeys, the password and signing out
 * everywhere; with mock auth, who is signed in. Each is a card of the page.
 */
export function AccountSections({
    methods,
    onSignedOut,
}: {
    /** Better Auth's sign-in methods; none with mock auth. */
    methods?: SignInMethods;
    onSignedOut: () => void;
}) {
    const user = useContext(CurrentUser);
    if (!methods) {
        return (
            <SettingsCard>
                <section className="grid gap-2" data-slot="account-mock">
                    <h3 className="font-medium">Account</h3>
                    <p className="text-muted-foreground">
                        Signed in as {user?.name}
                        {user ? ` (${roleLabel(user.role)})` : ''} with this machine’s sign-in picker: there is no
                        password or passkey to manage. Switch user from the account menu.
                    </p>
                </section>
            </SettingsCard>
        );
    }
    return (
        <>
            <SettingsCard>
                <Profile />
            </SettingsCard>
            {methods.passkey && (
                <SettingsCard>
                    <Passkeys />
                </SettingsCard>
            )}
            {methods.password && (
                <SettingsCard>
                    <PasswordChange />
                </SettingsCard>
            )}
            <SettingsCard>
                <DevicesCard />
            </SettingsCard>
            <SettingsCard>
                <section className="grid gap-2">
                    <h3 className="font-medium">Sessions</h3>
                    <p className="text-muted-foreground">Signs this account out on every device, this one included.</p>
                    <div>
                        <Button
                            variant="outline"
                            onClick={async () => {
                                try {
                                    await signOutEverywhere();
                                    onSignedOut();
                                } catch (e) {
                                    failed(e, 'Could not sign out everywhere.');
                                }
                            }}
                        >
                            Sign out everywhere
                        </Button>
                    </div>
                </section>
            </SettingsCard>
            <SettingsCard>
                <LeaveWorkspace onLeft={onSignedOut} />
            </SettingsCard>
        </>
    );
}

/**
 * Settings → Account → Profile → Leave workspace (CB-383): the person ends
 * their own membership. What they made stays with the workspace, and
 * admins can hand it to someone else; the last admin and the workspace
 * owner can't.
 */
function LeaveWorkspace({ onLeft }: { onLeft: () => void }) {
    const [check, setCheck] = useState<LeaveWorkspaceCheck>();
    const [confirming, setConfirming] = useState(false);
    useEffect(() => {
        leaveWorkspaceCheck()
            .then(setCheck)
            .catch(() => undefined);
    }, []);
    return (
        <section className="grid gap-2" data-slot="leave-workspace">
            <h3 className="font-medium">Leave workspace</h3>
            <p className="text-muted-foreground">
                Ends your membership: you are signed out on every device and can&apos;t sign in again unless an admin
                brings you back. What you made stays with the workspace, where admins can hand it to someone else.
            </p>
            {check?.refusal && <p className="text-muted-foreground">{check.refusal.message}</p>}
            <div>
                <Button variant="destructive" disabled={!check?.allowed} onClick={() => setConfirming(true)}>
                    Leave workspace
                </Button>
            </div>
            {confirming && (
                <ConfirmDelete
                    title="Leave this workspace?"
                    slot="confirm-leave-workspace"
                    action="Leave"
                    onClose={() => setConfirming(false)}
                    onConfirm={async () => {
                        try {
                            await leaveWorkspace();
                            setConfirming(false);
                            toast.success('You left the workspace');
                            onLeft();
                        } catch (e) {
                            failed(e, 'Could not leave the workspace.');
                            await leaveWorkspaceCheck()
                                .then(setCheck)
                                .catch(() => undefined);
                        }
                    }}
                >
                    You will be signed out everywhere, including the Socio app on your phone, which erases its copy.
                    Your chats, pages and other work stay with the workspace. Only an admin can let you back in.
                </ConfirmDelete>
            )}
        </section>
    );
}

/** One section of a settings page, as a card. */
export function SettingsCard({ children }: { children: ReactNode }) {
    return <Card className="px-6 text-sm">{children}</Card>;
}

function Passkeys() {
    const [passkeys, setPasskeys] = useState<Passkey[]>();
    const [name, setName] = useState('');
    const load = useCallback(
        () =>
            listPasskeys()
                .then(setPasskeys)
                .catch((e) => failed(e, 'Could not load passkeys.')),
        [],
    );
    useEffect(() => void load(), [load]);
    return (
        <section className="grid gap-2">
            <h3 className="font-medium">Passkeys</h3>
            <p className="text-muted-foreground">
                Sign in with your device&apos;s fingerprint, face or PIN instead of a password.
            </p>
            <ul className="grid gap-1" aria-label="Your passkeys">
                {passkeys?.map((passkey) => (
                    <li key={passkey.id} className="flex items-center gap-2">
                        <span className="flex-1">{passkey.name || 'Passkey'}</span>
                        {passkey.createdAt && (
                            <span className="text-muted-foreground">
                                {new Date(passkey.createdAt).toLocaleDateString()}
                            </span>
                        )}
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={async () => {
                                try {
                                    await deletePasskey(passkey.id);
                                    await load();
                                } catch (e) {
                                    failed(e, 'Could not remove the passkey.');
                                }
                            }}
                        >
                            Remove
                        </Button>
                    </li>
                ))}
                {passkeys?.length === 0 && <li className="text-muted-foreground">No passkeys yet.</li>}
            </ul>
            <form
                className="flex gap-2"
                onSubmit={async (e) => {
                    e.preventDefault();
                    try {
                        await addPasskey(name.trim() || 'Passkey');
                        setName('');
                        await load();
                        toast.success('Passkey added');
                    } catch (e) {
                        failed(e, 'Could not add the passkey.');
                    }
                }}
            >
                <Input
                    aria-label="Passkey name"
                    placeholder="Name, e.g. Laptop"
                    value={name}
                    maxLength={60}
                    onChange={(e) => setName(e.target.value)}
                />
                <Button type="submit">Add a passkey</Button>
            </form>
        </section>
    );
}

/** The name others see on conversations, issues and comments. */
function Profile() {
    const user = useContext(CurrentUser);
    const [name, setName] = useState(user?.name ?? '');
    const trimmed = name.trim();
    return (
        <section className="grid gap-2">
            <h3 className="font-medium">Name</h3>
            <form
                className="grid gap-2 sm:grid-cols-[1fr_auto]"
                onSubmit={async (e) => {
                    e.preventDefault();
                    try {
                        await updateName(trimmed);
                        toast.success('Name saved');
                    } catch (e) {
                        failed(e, 'Could not save the name.');
                    }
                }}
            >
                <Input
                    aria-label="Your name"
                    autoComplete="name"
                    required
                    maxLength={80}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                />
                <Button type="submit" disabled={!trimmed || trimmed === user?.name}>
                    Save
                </Button>
            </form>
        </section>
    );
}

function PasswordChange() {
    const [current, setCurrent] = useState('');
    const [next, setNext] = useState('');
    return (
        <section className="grid gap-2">
            <h3 className="font-medium">Password</h3>
            <form
                className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
                onSubmit={async (e) => {
                    e.preventDefault();
                    try {
                        await changePassword(current, next);
                        setCurrent('');
                        setNext('');
                        toast.success('Password changed; other sessions signed out');
                    } catch (e) {
                        failed(e, 'Could not change the password.');
                    }
                }}
            >
                <Input
                    type="password"
                    aria-label="Current password"
                    placeholder="Current password"
                    autoComplete="current-password"
                    required
                    value={current}
                    onChange={(e) => setCurrent(e.target.value)}
                />
                <Input
                    type="password"
                    aria-label="New password"
                    placeholder="New password (10+)"
                    autoComplete="new-password"
                    minLength={10}
                    required
                    value={next}
                    onChange={(e) => setNext(e.target.value)}
                />
                <Button type="submit">Change</Button>
            </form>
        </section>
    );
}
