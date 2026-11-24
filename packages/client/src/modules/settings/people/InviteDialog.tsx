import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import type { Account, PasswordLink } from '@socio/shared/auth';
import { roleLabel } from '@socio/shared/roles';
import type { Role, User } from '@socio/shared/types';

import { nativeSelect } from '../../../components/form-fields';
import { api } from '../../../lib/api';

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
    return (
        <div className="grid gap-1 rounded-md border border-dashed p-2 text-sm" data-slot="password-link">
            <span>
                Password link for {link.email} (one use, until {new Date(link.expiresAt).toLocaleString()})
                {link.emailed ? ', also emailed' : ''}. Send it to them privately:
            </span>
            <span className="flex gap-2">
                <Input aria-label="Password link" readOnly value={link.url} onFocus={(e) => e.target.select()} />
                <Button
                    variant="outline"
                    onClick={() =>
                        void navigator.clipboard?.writeText(link.url).then(() => toast.success('Link copied'))
                    }
                >
                    Copy
                </Button>
            </span>
        </div>
    );
}

/** A password link made from a row (Password link, the expired-invite callout's resend). */
export function PasswordLinkDialog({ link, onClose }: { link: ShownLink; onClose: () => void }) {
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent data-slot="password-link-dialog">
                <DialogHeader>
                    <DialogTitle>Password link</DialogTitle>
                    <DialogDescription>It sets or resets their password. A newer link replaces it.</DialogDescription>
                </DialogHeader>
                <PasswordLinkPanel link={link} />
                <DialogFooter>
                    <Button onClick={onClose}>Done</Button>
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
                toast.success(`${name} added`);
            }
            setUnlinked((list) => list.filter((user) => user.id !== userId));
            setName('');
            setEmail('');
            setUserId('');
            onAdded();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Could not add the account.');
        } finally {
            setBusy(false);
        }
    };
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent data-slot="invite-people">
                <DialogHeader>
                    <DialogTitle>Invite people</DialogTitle>
                    <DialogDescription>
                        Add a person with a role. You get a password link to send them; they set a password and sign in.
                    </DialogDescription>
                </DialogHeader>
                {link && <PasswordLinkPanel link={link} />}
                <form className="grid gap-2 sm:grid-cols-2" onSubmit={submit} aria-label="Add a person">
                    <Input
                        aria-label="New person's name"
                        placeholder="Name"
                        required
                        maxLength={80}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                    />
                    <Input
                        type="email"
                        aria-label="New person's email"
                        placeholder="Email"
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                    />
                    <select
                        data-slot="native-select"
                        aria-label="New person's role"
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
                        aria-label="Existing user to link"
                        className={nativeSelect}
                        value={userId}
                        onChange={(e) => setUserId(e.target.value)}
                    >
                        <option value="">New user</option>
                        {unlinked.map((user) => (
                            <option key={user.id} value={user.id}>
                                Existing: {user.name} ({user.id})
                            </option>
                        ))}
                    </select>
                    <DialogFooter className="sm:col-span-2">
                        <Button type="button" variant="outline" onClick={onClose}>
                            {link ? 'Done' : 'Cancel'}
                        </Button>
                        <Button type="submit" disabled={busy}>
                            Add and make a password link
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
