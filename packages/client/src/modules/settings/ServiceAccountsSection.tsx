import { MoreHorizontal } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { roleLabel } from '@socio/shared/roles';
import {
    SERVICE_KEY_DAYS,
    SERVICE_ROLES,
    SERVICE_SCOPE_LABELS,
    SERVICE_SCOPES,
    type CreatedServiceKey,
    type ServiceAccountView,
    type ServiceKeyView,
    type ServiceRole,
    type ServiceScope,
} from '@socio/shared/service-accounts';

import { ConfirmDelete } from '../../components/confirm-delete';
import { nativeSelect } from '../../components/form-fields';
import { api } from '../../lib/api';

import { Badge } from '@/components/ui/badge';
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
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

const failed = (e: unknown, fallback: string) => toast.error(e instanceof Error ? e.message : fallback);
const when = (at: number) => new Date(at).toLocaleDateString();
const accountPath = (id: string, rest = '') => `/service-accounts/${encodeURIComponent(id)}${rest}`;

/** A new key for one account: name, scopes, lifetime; then the key, shown once. */
function NewKeyDialog({
    account,
    onClose,
    onCreated,
}: {
    account: ServiceAccountView;
    onClose: () => void;
    onCreated: () => void;
}) {
    const [name, setName] = useState('');
    const [scopes, setScopes] = useState<ServiceScope[]>(['issues:read']);
    const [days, setDays] = useState<number>(90);
    const [created, setCreated] = useState<CreatedServiceKey>();
    // While the key is being made the dialog stays: its secret is shown only here.
    const [busy, setBusy] = useState(false);
    const submit = (e: FormEvent) => {
        e.preventDefault();
        setBusy(true);
        void api<CreatedServiceKey>(accountPath(account.id, '/keys'), 'POST', { name, scopes, days })
            .then((made) => {
                setCreated(made);
                onCreated();
            })
            .catch((error) => failed(error, 'Could not make the key.'))
            .finally(() => setBusy(false));
    };
    return (
        <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
            <DialogContent data-slot="new-service-key">
                <DialogHeader>
                    <DialogTitle>New key for {account.name}</DialogTitle>
                    <DialogDescription>
                        {created
                            ? 'Copy it now: it isn’t shown again.'
                            : 'Name it after where it runs. It reaches only what its scopes allow.'}
                    </DialogDescription>
                </DialogHeader>
                {created ? (
                    <div className="grid gap-2 text-sm" data-slot="service-key-token">
                        <span>
                            Key “{created.key.name}” for {account.name}. Copy it now: it isn’t shown again.
                        </span>
                        <Input
                            aria-label="New API key"
                            readOnly
                            value={created.token}
                            onFocus={(e) => e.target.select()}
                        />
                        <DialogFooter>
                            <Button
                                variant="outline"
                                onClick={() => {
                                    void navigator.clipboard
                                        ?.writeText(created.token)
                                        .then(() => toast.success('Key copied'));
                                }}
                            >
                                Copy
                            </Button>
                            <Button onClick={onClose}>Done</Button>
                        </DialogFooter>
                    </div>
                ) : (
                    <form className="grid gap-3" aria-label={`New key for ${account.name}`} onSubmit={submit}>
                        <span className="grid gap-2 sm:grid-cols-[1fr_auto]">
                            <Input
                                aria-label="Key name"
                                placeholder="Key name, e.g. where it runs"
                                required
                                maxLength={60}
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                            />
                            <select
                                data-slot="native-select"
                                aria-label="Key lifetime"
                                className={cn(nativeSelect, 'w-32')}
                                value={days}
                                onChange={(e) => setDays(Number(e.target.value))}
                            >
                                {SERVICE_KEY_DAYS.map((value) => (
                                    <option key={value} value={value}>
                                        {value} days
                                    </option>
                                ))}
                            </select>
                        </span>
                        <span className="grid gap-1">
                            {SERVICE_SCOPES.map((scope) => (
                                <label key={scope} className="flex items-center gap-2 text-sm">
                                    <Checkbox
                                        checked={scopes.includes(scope)}
                                        onCheckedChange={(checked) =>
                                            setScopes((current) =>
                                                checked === true
                                                    ? [...current, scope]
                                                    : current.filter((entry) => entry !== scope),
                                            )
                                        }
                                    />
                                    <code className="text-xs">{scope}</code>
                                    <span className="text-muted-foreground">{SERVICE_SCOPE_LABELS[scope]}</span>
                                </label>
                            ))}
                        </span>
                        <DialogFooter>
                            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
                                Cancel
                            </Button>
                            <Button type="submit" disabled={busy || !name.trim() || !scopes.length}>
                                Make key
                            </Button>
                        </DialogFooter>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}

/** Where a key stands: live until it expires or is revoked. */
function keyState(key: ServiceKeyView, now: number) {
    if (key.revokedAt) {
        return `revoked ${when(key.revokedAt)}`;
    }
    return key.expiresAt > now ? `expires ${when(key.expiresAt)}` : `expired ${when(key.expiresAt)}`;
}

/** An account's keys: creator, created, last used and from where, expiry. */
function KeyTable({
    account,
    gone,
    onRevoke,
    onDelete,
}: {
    account: ServiceAccountView;
    gone?: (userId: string) => boolean;
    onRevoke: (key: ServiceKeyView) => void;
    /** A revoked key, removed for good after a confirmation (CB-360). */
    onDelete: (key: ServiceKeyView) => void;
}) {
    const now = Date.now();
    return (
        <Table aria-label={`Keys of ${account.name}`} data-slot="service-keys">
            <TableHeader>
                <TableRow>
                    <TableHead>Key</TableHead>
                    <TableHead>Made by</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Last used</TableHead>
                    <TableHead>Expiry</TableHead>
                    <TableHead>
                        <span className="sr-only">Actions</span>
                    </TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {account.keys.map((key) => {
                    const live = !key.revokedAt && key.expiresAt > now;
                    const creatorGone = live && !!key.createdBy && !!gone?.(key.createdBy);
                    return (
                        <TableRow key={key.id} data-key={key.name} className={cn(!live && 'text-muted-foreground')}>
                            <TableCell className="whitespace-normal">
                                <span className={cn('block', !live && 'line-through')}>
                                    {key.name} <code className="text-xs">cbk_{key.hint}…</code>
                                </span>
                                <span className="text-xs text-muted-foreground">{key.scopes.join(', ')}</span>
                            </TableCell>
                            <TableCell data-slot="key-creator" className="whitespace-normal">
                                {key.createdByName ?? (key.createdBy ? 'Unknown' : '—')}
                                {creatorGone && (
                                    <Badge
                                        variant="outline"
                                        className="ml-1 border-paused-banner-border bg-paused-banner font-normal text-paused-banner-foreground"
                                        title="Whoever made it is deactivated or gone; it still works"
                                    >
                                        creator gone
                                    </Badge>
                                )}
                            </TableCell>
                            <TableCell>{when(key.createdAt)}</TableCell>
                            <TableCell className="whitespace-normal">
                                {key.lastUsedAt ? (
                                    <span title={new Date(key.lastUsedAt).toLocaleString()}>
                                        {new Date(key.lastUsedAt).toLocaleString()}
                                        {key.lastUsedIp && (
                                            <span className="block text-xs text-muted-foreground">
                                                from {key.lastUsedIp}
                                            </span>
                                        )}
                                    </span>
                                ) : (
                                    'never used'
                                )}
                            </TableCell>
                            <TableCell>{keyState(key, now)}</TableCell>
                            <TableCell className="text-right">
                                {live ? (
                                    <Button variant="ghost" size="sm" onClick={() => onRevoke(key)}>
                                        Revoke
                                    </Button>
                                ) : (
                                    key.revokedAt && (
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            aria-label={`Delete ${key.name}`}
                                            onClick={() => onDelete(key)}
                                        >
                                            Delete
                                        </Button>
                                    )
                                )}
                            </TableCell>
                        </TableRow>
                    );
                })}
            </TableBody>
        </Table>
    );
}

/**
 * Admins: service accounts for external agents and scripts (CB-57), the
 * Service accounts tab of People (CB-360). Each has keys with scopes and
 * an expiry; a key is shown once, when it is made (in its dialog).
 * Disabling an account, from its ⋯ menu after a confirmation, revokes its
 * keys and keeps its records. A revoked key can be deleted for good
 * (CB-360); a live one only revoked.
 */
export function ServiceAccountsSection({
    focus,
    gone,
    onCount,
}: {
    /** An account to scroll to and mark (the deactivate preview's link). */
    focus?: string;
    /** Whether a key's creator (an app user id) is deactivated or gone. */
    gone?: (userId: string) => boolean;
    /** How many accounts there are, after each load (the tab's count). */
    onCount?: (count: number) => void;
} = {}) {
    const [accounts, setAccounts] = useState<ServiceAccountView[]>();
    const [keyFor, setKeyFor] = useState<ServiceAccountView>();
    const [disabling, setDisabling] = useState<ServiceAccountView>();
    const [deleting, setDeleting] = useState<{ account: ServiceAccountView; key: ServiceKeyView }>();
    const [name, setName] = useState('');
    const [role, setRole] = useState<ServiceRole>('member');
    const [description, setDescription] = useState('');
    const counted = useRef(onCount);
    counted.current = onCount;
    const load = useCallback(
        () =>
            api<ServiceAccountView[]>('/service-accounts')
                .then((list) => {
                    const all = Array.isArray(list) ? list : [];
                    setAccounts(all);
                    counted.current?.(all.length);
                })
                .catch((e) => failed(e, 'Could not load service accounts.')),
        [],
    );
    useEffect(() => void load(), [load]);
    // The deactivate preview's "Open <account>": into view, once it's there.
    const focused = !!accounts?.some((account) => account.id === focus);
    useEffect(() => {
        if (focus && focused) {
            document
                .querySelector(`[data-account-id="${CSS.escape(focus)}"]`)
                ?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
        }
    }, [focus, focused]);
    const act = async (action: () => Promise<unknown>, fallback: string) => {
        try {
            await action();
            await load();
        } catch (e) {
            failed(e, fallback);
        }
    };
    const add = (e: FormEvent) => {
        e.preventDefault();
        void act(async () => {
            await api('/service-accounts', 'POST', {
                name,
                role,
                ...(description.trim() ? { description } : {}),
            });
            setName('');
            setDescription('');
        }, 'Could not add the service account.');
    };
    return (
        <section className="grid gap-3" data-slot="service-accounts">
            <p className="text-sm text-muted-foreground">
                For external agents and scripts: they use an API key (
                <code className="text-xs">Authorization: Bearer cbk_…</code>), reach only what its scopes allow, and
                never sign in or chat with socios.
            </p>
            <ul className="grid gap-3" aria-label="Service accounts">
                {accounts?.map((account) => (
                    <li
                        key={account.id}
                        className={cn(
                            'grid gap-2 rounded-md border p-3',
                            account.disabledAt && 'opacity-60',
                            account.id === focus && 'ring-2 ring-ring',
                        )}
                        data-account={account.name}
                        data-account-id={account.id}
                    >
                        <span className="flex flex-wrap items-center gap-2">
                            <span className="min-w-0 flex-1">
                                <span className="font-medium">{account.name}</span>{' '}
                                <span className="text-muted-foreground">
                                    {account.disabledAt ? `disabled ${when(account.disabledAt)}` : 'service account'}
                                    {account.description ? ` · ${account.description}` : ''}
                                </span>
                            </span>
                            {account.disabledAt ? (
                                <Badge variant="secondary">{roleLabel(account.role)}</Badge>
                            ) : (
                                <>
                                    <select
                                        data-slot="native-select"
                                        aria-label={`Role of ${account.name}`}
                                        className={cn(nativeSelect, 'h-8 w-28')}
                                        value={account.role}
                                        onChange={(e) =>
                                            void act(
                                                () => api(accountPath(account.id), 'PATCH', { role: e.target.value }),
                                                'Could not change the role.',
                                            )
                                        }
                                    >
                                        {SERVICE_ROLES.map((value) => (
                                            <option key={value} value={value}>
                                                {roleLabel(value)}
                                            </option>
                                        ))}
                                    </select>
                                    <Button variant="outline" size="sm" onClick={() => setKeyFor(account)}>
                                        New key
                                    </Button>
                                    <DropdownMenu modal={false}>
                                        <DropdownMenuTrigger asChild>
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                aria-label={`Actions for ${account.name}`}
                                            >
                                                <MoreHorizontal />
                                            </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                            <DropdownMenuItem
                                                variant="destructive"
                                                onSelect={() => setDisabling(account)}
                                            >
                                                Disable…
                                            </DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </>
                            )}
                        </span>
                        {account.keys.length ? (
                            <KeyTable
                                account={account}
                                gone={gone}
                                onRevoke={(key) =>
                                    void act(
                                        () =>
                                            api(
                                                accountPath(account.id, `/keys/${encodeURIComponent(key.id)}`),
                                                'DELETE',
                                            ),
                                        'Could not revoke the key.',
                                    )
                                }
                                onDelete={(key) => setDeleting({ account, key })}
                            />
                        ) : (
                            <span className="text-sm text-muted-foreground">No keys yet.</span>
                        )}
                    </li>
                ))}
            </ul>
            <form className="grid gap-2 sm:grid-cols-2" onSubmit={add} aria-label="Add a service account">
                <Input
                    aria-label="Service account name"
                    placeholder="Name, e.g. Claude (lead)"
                    required
                    maxLength={60}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                />
                <select
                    data-slot="native-select"
                    aria-label="Service account role"
                    className={nativeSelect}
                    value={role}
                    onChange={(e) => setRole(e.target.value as ServiceRole)}
                >
                    {SERVICE_ROLES.map((value) => (
                        <option key={value} value={value}>
                            {roleLabel(value)}
                        </option>
                    ))}
                </select>
                <Input
                    aria-label="What it is for"
                    placeholder="What it is for (optional)"
                    maxLength={300}
                    className="sm:col-span-2"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                />
                <Button className="sm:col-span-2" disabled={!name.trim()}>
                    Add service account
                </Button>
            </form>
            {keyFor && (
                <NewKeyDialog account={keyFor} onClose={() => setKeyFor(undefined)} onCreated={() => void load()} />
            )}
            {disabling && (
                <ConfirmDelete
                    title={`Disable ${disabling.name}?`}
                    action="Disable"
                    slot="confirm-disable-service-account"
                    onClose={() => setDisabling(undefined)}
                    onConfirm={async () => {
                        const { id } = disabling;
                        await act(() => api(accountPath(id), 'DELETE'), 'Could not disable the account.');
                        setDisabling(undefined);
                    }}
                >
                    Its keys stop working at once; what it filed stays.
                </ConfirmDelete>
            )}
            {deleting && (
                <ConfirmDelete
                    title="Delete this revoked key for good?"
                    slot="confirm-delete-service-key"
                    onClose={() => setDeleting(undefined)}
                    onConfirm={async () => {
                        const { account, key } = deleting;
                        await act(
                            () => api(accountPath(account.id, `/keys/${encodeURIComponent(key.id)}/record`), 'DELETE'),
                            'Could not delete the key.',
                        );
                        setDeleting(undefined);
                    }}
                >
                    {deleting.key.name} (<code className="text-xs">cbk_{deleting.key.hint}…</code>) of{' '}
                    {deleting.account.name}. Its record and last-use history go; the audit keeps who deleted it.
                </ConfirmDelete>
            )}
        </section>
    );
}
