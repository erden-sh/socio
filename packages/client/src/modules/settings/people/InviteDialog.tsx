import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import type { Account, PasswordLink } from '@socio/shared/auth';
import type { Role, User } from '@socio/shared/types';

import { nativeSelect } from '../../../components/form-fields';
import { api } from '../../../lib/api';

import { usePeopleFormat } from './people-format';

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

/** A password link just made, and whose it is. */
export type ShownLink = PasswordLink & { email: string };

/** The link to send privately: one use, until it expires. */
export function PasswordLinkPanel({ link }: { link: ShownLink }) {
    const { t } = useTranslation(['settings.people']);
    return (
        <div className="grid gap-1 rounded-md border border-dashed p-2 text-sm" data-slot="password-link">
            <span>
                {t('settings.people:passwordLink.for', {
                    context: link.emailed ? 'emailed' : undefined,
                    email: link.email,
                    until: new Date(link.expiresAt),
                })}
            </span>
            <span className="flex gap-2">
                <Input
                    aria-label={t('settings.people:passwordLink.field')}
                    readOnly
                    value={link.url}
                    onFocus={(e) => e.target.select()}
                />
                <Button
                    variant="outline"
                    onClick={() =>
                        void navigator.clipboard
                            ?.writeText(link.url)
                            .then(() => toast.success(t('settings.people:passwordLink.copied')))
                    }
                >
                    {t('settings.people:passwordLink.copy')}
                </Button>
            </span>
        </div>
    );
}

/** A password link made from a row (Password link, the expired-invite callout's resend). */
export function PasswordLinkDialog({ link, onClose }: { link: ShownLink; onClose: () => void }) {
    const { t } = useTranslation(['settings.people']);
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent data-slot="password-link-dialog">
                <DialogHeader>
                    <DialogTitle>{t('settings.people:passwordLink.title')}</DialogTitle>
                    <DialogDescription>{t('settings.people:passwordLink.description')}</DialogDescription>
                </DialogHeader>
                <PasswordLinkPanel link={link} />
                <DialogFooter>
                    <Button onClick={onClose}>{t('settings.people:passwordLink.done')}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/**
 * Invite people: today's "Add a person" form in a dialog (CB-360). A name,
 * an email, a role and, optionally, an app user without an account to
 * link; the answer is a password link to send them.
 */
export function InviteDialog({
    grantable,
    onClose,
    onAdded,
}: {
    /** The roles this admin may give. */
    grantable: readonly Role[];
    onClose: () => void;
    onAdded: () => void;
}) {
    const { t } = useTranslation(['settings.people']);
    const { roleLabel } = usePeopleFormat();
    const [unlinked, setUnlinked] = useState<User[]>([]);
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [role, setRole] = useState<Role>('member');
    const [userId, setUserId] = useState('');
    const [busy, setBusy] = useState(false);
    const [link, setLink] = useState<ShownLink>();
    useEffect(() => {
        const controller = new AbortController();
        api<{ accounts: Account[]; unlinked: User[] }>('/accounts', 'GET', undefined, controller.signal)
            .then((data) => setUnlinked(data.unlinked ?? []))
            .catch(() => {});
        return () => controller.abort();
    }, []);
    const submit = async (e: FormEvent) => {
        e.preventDefault();
        setBusy(true);
        try {
            const created = await api<{ account: Account; link?: PasswordLink }>('/accounts', 'POST', {
                name,
                email,
                role,
                ...(userId ? { userId } : {}),
            });
            if (created.link) {
                setLink({ ...created.link, email });
            } else {
                toast.success(t('settings.people:invite.added', { name }));
            }
            setUnlinked((list) => list.filter((user) => user.id !== userId));
            setName('');
            setEmail('');
            setUserId('');
            onAdded();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t('settings.people:invite.failed'));
        } finally {
            setBusy(false);
        }
    };
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent data-slot="invite-people">
                <DialogHeader>
                    <DialogTitle>{t('settings.people:invite.title')}</DialogTitle>
                    <DialogDescription>{t('settings.people:invite.description')}</DialogDescription>
                </DialogHeader>
                {link && <PasswordLinkPanel link={link} />}
                <form
                    className="grid gap-2 sm:grid-cols-2"
                    onSubmit={submit}
                    aria-label={t('settings.people:invite.form')}
                >
                    <Input
                        aria-label={t('settings.people:invite.name')}
                        placeholder={t('settings.people:invite.namePlaceholder')}
                        required
                        maxLength={80}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                    />
                    <Input
                        type="email"
                        aria-label={t('settings.people:invite.email')}
                        placeholder={t('settings.people:invite.emailPlaceholder')}
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                    />
                    <select
                        data-slot="native-select"
                        aria-label={t('settings.people:invite.role')}
                        className={nativeSelect}
                        value={role}
                        onChange={(e) => setRole(e.target.value as Role)}
                    >
                        {grantable.map((r) => (
                            <option key={r} value={r}>
                                {roleLabel(r)}
                            </option>
                        ))}
                    </select>
                    <select
                        data-slot="native-select"
                        aria-label={t('settings.people:invite.link')}
                        className={nativeSelect}
                        value={userId}
                        onChange={(e) => setUserId(e.target.value)}
                    >
                        <option value="">{t('settings.people:invite.newUser')}</option>
                        {unlinked.map((user) => (
                            <option key={user.id} value={user.id}>
                                {t('settings.people:invite.existing', { name: user.name, id: user.id })}
                            </option>
                        ))}
                    </select>
                    <DialogFooter className="sm:col-span-2">
                        <Button type="button" variant="outline" onClick={onClose}>
                            {link ? t('settings.people:invite.done') : t('settings.people:invite.cancel')}
                        </Button>
                        <Button type="submit" disabled={busy}>
                            {t('settings.people:invite.submit')}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
