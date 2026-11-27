import { useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
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
    const { t } = useTranslation(['settings.account']);
    const user = useContext(CurrentUser);
    if (!methods) {
        return (
            <SettingsCard>
                <section className="grid gap-2" data-slot="account-mock">
                    <h3 className="font-medium">{t('settings.account:mock.title')}</h3>
                    <p className="text-muted-foreground">
                        {user
                            ? t('settings.account:mock.signedIn', { name: user.name, role: roleLabel(user.role) })
                            : t('settings.account:mock.signedIn', { context: 'nobody', name: '', role: '' })}
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
                    <h3 className="font-medium">{t('settings.account:sessions.title')}</h3>
                    <p className="text-muted-foreground">{t('settings.account:sessions.description')}</p>
                    <div>
                        <Button
                            variant="outline"
                            onClick={async () => {
                                try {
                                    await signOutEverywhere();
                                    onSignedOut();
                                } catch (e) {
                                    failed(e, t('settings.account:sessions.failed'));
                                }
                            }}
                        >
                            {t('settings.account:sessions.signOutEverywhere')}
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
    const { t } = useTranslation(['settings.account']);
    const [check, setCheck] = useState<LeaveWorkspaceCheck>();
    const [confirming, setConfirming] = useState(false);
    useEffect(() => {
        leaveWorkspaceCheck()
            .then(setCheck)
            .catch(() => undefined);
    }, []);
    return (
        <section className="grid gap-2" data-slot="leave-workspace">
            <h3 className="font-medium">{t('settings.account:leave.title')}</h3>
            <p className="text-muted-foreground">{t('settings.account:leave.description')}</p>
            {check?.refusal && <p className="text-muted-foreground">{check.refusal.message}</p>}
            <div>
                <Button variant="destructive" disabled={!check?.allowed} onClick={() => setConfirming(true)}>
                    {t('settings.account:leave.button')}
                </Button>
            </div>
            {confirming && (
                <ConfirmDelete
                    title={t('settings.account:leave.confirmTitle')}
                    slot="confirm-leave-workspace"
                    action={t('settings.account:leave.confirmAction')}
                    onClose={() => setConfirming(false)}
                    onConfirm={async () => {
                        try {
                            await leaveWorkspace();
                            setConfirming(false);
                            toast.success(t('settings.account:leave.left'));
                            onLeft();
                        } catch (e) {
                            failed(e, t('settings.account:leave.failed'));
                            await leaveWorkspaceCheck()
                                .then(setCheck)
                                .catch(() => undefined);
                        }
                    }}
                >
                    {t('settings.account:leave.confirmBody')}
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
    const { t } = useTranslation(['settings.account']);
    const [passkeys, setPasskeys] = useState<Passkey[]>();
    const [name, setName] = useState('');
    const load = useCallback(
        () =>
            listPasskeys()
                .then(setPasskeys)
                .catch((e) => failed(e, t('settings.account:passkeys.loadFailed'))),
        [t],
    );
    useEffect(() => void load(), [load]);
    return (
        <section className="grid gap-2">
            <h3 className="font-medium">{t('settings.account:passkeys.title')}</h3>
            <p className="text-muted-foreground">{t('settings.account:passkeys.description')}</p>
            <ul className="grid gap-1" aria-label={t('settings.account:passkeys.list')}>
                {passkeys?.map((passkey) => (
                    <li key={passkey.id} className="flex items-center gap-2">
                        <span className="flex-1">{passkey.name || t('settings.account:passkeys.unnamed')}</span>
                        {passkey.createdAt && (
                            <span className="text-muted-foreground">
                                {t('settings.account:passkeys.created', { at: new Date(passkey.createdAt) })}
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
                                    failed(e, t('settings.account:passkeys.removeFailed'));
                                }
                            }}
                        >
                            {t('settings.account:passkeys.remove')}
                        </Button>
                    </li>
                ))}
                {passkeys?.length === 0 && (
                    <li className="text-muted-foreground">{t('settings.account:passkeys.empty')}</li>
                )}
            </ul>
            <form
                className="flex gap-2"
                onSubmit={async (e) => {
                    e.preventDefault();
                    try {
                        await addPasskey(name.trim() || t('settings.account:passkeys.unnamed'));
                        setName('');
                        await load();
                        toast.success(t('settings.account:passkeys.added'));
                    } catch (e) {
                        failed(e, t('settings.account:passkeys.addFailed'));
                    }
                }}
            >
                <Input
                    aria-label={t('settings.account:passkeys.nameLabel')}
                    placeholder={t('settings.account:passkeys.namePlaceholder')}
                    value={name}
                    maxLength={60}
                    onChange={(e) => setName(e.target.value)}
                />
                <Button type="submit">{t('settings.account:passkeys.add')}</Button>
            </form>
        </section>
    );
}

/** The name others see on conversations, issues and comments. */
function Profile() {
    const { t } = useTranslation(['settings.account']);
    const user = useContext(CurrentUser);
    const [name, setName] = useState(user?.name ?? '');
    const trimmed = name.trim();
    return (
        <section className="grid gap-2">
            <h3 className="font-medium">{t('settings.account:name.title')}</h3>
            <form
                className="grid gap-2 sm:grid-cols-[1fr_auto]"
                onSubmit={async (e) => {
                    e.preventDefault();
                    try {
                        await updateName(trimmed);
                        toast.success(t('settings.account:name.saved'));
                    } catch (e) {
                        failed(e, t('settings.account:name.failed'));
                    }
                }}
            >
                <Input
                    aria-label={t('settings.account:name.label')}
                    autoComplete="name"
                    required
                    maxLength={80}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                />
                <Button type="submit" disabled={!trimmed || trimmed === user?.name}>
                    {t('settings.account:name.save')}
                </Button>
            </form>
        </section>
    );
}

function PasswordChange() {
    const { t } = useTranslation(['settings.account']);
    const [current, setCurrent] = useState('');
    const [next, setNext] = useState('');
    return (
        <section className="grid gap-2">
            <h3 className="font-medium">{t('settings.account:password.title')}</h3>
            <form
                className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
                onSubmit={async (e) => {
                    e.preventDefault();
                    try {
                        await changePassword(current, next);
                        setCurrent('');
                        setNext('');
                        toast.success(t('settings.account:password.changed'));
                    } catch (e) {
                        failed(e, t('settings.account:password.failed'));
                    }
                }}
            >
                <Input
                    type="password"
                    aria-label={t('settings.account:password.current')}
                    placeholder={t('settings.account:password.current')}
                    autoComplete="current-password"
                    required
                    value={current}
                    onChange={(e) => setCurrent(e.target.value)}
                />
                <Input
                    type="password"
                    aria-label={t('settings.account:password.new')}
                    placeholder={t('settings.account:password.newPlaceholder')}
                    autoComplete="new-password"
                    minLength={10}
                    required
                    value={next}
                    onChange={(e) => setNext(e.target.value)}
                />
                <Button type="submit">{t('settings.account:password.change')}</Button>
            </form>
        </section>
    );
}
