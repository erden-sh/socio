import { MoreHorizontal } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { Trans, useTranslation } from '@socio/i18n/react';
import { roleLabel } from '@socio/shared/roles';
import {
    SERVICE_KEY_DAYS,
    SERVICE_ROLES,
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
/** Each scope's description (the scope itself is an identifier, shown as is). */
const SCOPE_KEYS = {
    'issues:read': 'settings.service-accounts:scopes.issuesRead',
    'issues:write': 'settings.service-accounts:scopes.issuesWrite',
    'pages:read': 'settings.service-accounts:scopes.pagesRead',
} as const satisfies Record<ServiceScope, string>;
/** How a key's value starts (`cbk_…`): an identifier, not copy. */
const KEY_PREFIX = 'cbk_';
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
    const { t } = useTranslation(['settings.service-accounts']);
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
            .catch((error) => failed(error, t('settings.service-accounts:errors.make')))
            .finally(() => setBusy(false));
    };
    return (
        <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
            <DialogContent data-slot="new-service-key">
                <DialogHeader>
                    <DialogTitle>{t('settings.service-accounts:newKey.title', { name: account.name })}</DialogTitle>
                    <DialogDescription>
                        {created
                            ? t('settings.service-accounts:newKey.copyNow')
                            : t('settings.service-accounts:newKey.description')}
                    </DialogDescription>
                </DialogHeader>
                {created ? (
                    <div className="grid gap-2 text-sm" data-slot="service-key-token">
                        <span>
                            {t('settings.service-accounts:newKey.created', {
                                key: created.key.name,
                                account: account.name,
                            })}
                        </span>
                        <Input
                            aria-label={t('settings.service-accounts:newKey.token')}
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
                                        .then(() => toast.success(t('settings.service-accounts:newKey.copied')));
                                }}
                            >
                                {t('settings.service-accounts:newKey.copy')}
                            </Button>
                            <Button onClick={onClose}>{t('settings.service-accounts:newKey.done')}</Button>
                        </DialogFooter>
                    </div>
                ) : (
                    <form
                        className="grid gap-3"
                        aria-label={t('settings.service-accounts:newKey.title', { name: account.name })}
                        onSubmit={submit}
                    >
                        <span className="grid gap-2 sm:grid-cols-[1fr_auto]">
                            <Input
                                aria-label={t('settings.service-accounts:newKey.name')}
                                placeholder={t('settings.service-accounts:newKey.namePlaceholder')}
                                required
                                maxLength={60}
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                            />
                            <select
                                data-slot="native-select"
                                aria-label={t('settings.service-accounts:newKey.lifetime')}
                                className={cn(nativeSelect, 'w-32')}
                                value={days}
                                onChange={(e) => setDays(Number(e.target.value))}
                            >
                                {SERVICE_KEY_DAYS.map((value) => (
                                    <option key={value} value={value}>
                                        {t('settings.service-accounts:newKey.days', { count: value })}
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
                                    <span className="text-muted-foreground">{t(SCOPE_KEYS[scope])}</span>
                                </label>
                            ))}
                        </span>
                        <DialogFooter>
                            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
                                {t('settings.service-accounts:newKey.cancel')}
                            </Button>
                            <Button type="submit" disabled={busy || !name.trim() || !scopes.length}>
                                {t('settings.service-accounts:newKey.submit')}
                            </Button>
                        </DialogFooter>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
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
    const { t } = useTranslation(['settings.service-accounts']);
    /** Where a key stands: live until it expires or is revoked. */
    const keyState = (key: ServiceKeyView, now: number) => {
        if (key.revokedAt) {
            return t('settings.service-accounts:keys.revoked', { at: new Date(key.revokedAt) });
        }
        return key.expiresAt > now
            ? t('settings.service-accounts:keys.expires', { at: new Date(key.expiresAt) })
            : t('settings.service-accounts:keys.expired', { at: new Date(key.expiresAt) });
    };
    const now = Date.now();
    return (
        <Table aria-label={t('settings.service-accounts:keys.label', { name: account.name })} data-slot="service-keys">
            <TableHeader>
                <TableRow>
                    <TableHead>{t('settings.service-accounts:keys.key')}</TableHead>
                    <TableHead>{t('settings.service-accounts:keys.madeBy')}</TableHead>
                    <TableHead>{t('settings.service-accounts:keys.created')}</TableHead>
                    <TableHead>{t('settings.service-accounts:keys.lastUsed')}</TableHead>
                    <TableHead>{t('settings.service-accounts:keys.expiry')}</TableHead>
                    <TableHead>
                        <span className="sr-only">{t('settings.service-accounts:keys.actions')}</span>
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
                                    {key.name}{' '}
                                    <code className="text-xs">
                                        {KEY_PREFIX}
                                        {key.hint}…
                                    </code>
                                </span>
                                <span className="text-xs text-muted-foreground">{key.scopes.join(', ')}</span>
                            </TableCell>
                            <TableCell data-slot="key-creator" className="whitespace-normal">
                                {key.createdByName ??
                                    (key.createdBy ? t('settings.service-accounts:keys.unknownMaker') : '—')}
                                {creatorGone && (
                                    <Badge
                                        variant="outline"
                                        className="ml-1 border-paused-banner-border bg-paused-banner font-normal text-paused-banner-foreground"
                                        title={t('settings.service-accounts:keys.creatorGoneHint')}
                                    >
                                        {t('settings.service-accounts:keys.creatorGone')}
                                    </Badge>
                                )}
                            </TableCell>
                            <TableCell>
                                {t('settings.service-accounts:keys.date', { at: new Date(key.createdAt) })}
                            </TableCell>
                            <TableCell className="whitespace-normal">
                                {key.lastUsedAt ? (
                                    <span
                                        title={t('settings.service-accounts:keys.usedAt', {
                                            at: new Date(key.lastUsedAt),
                                        })}
                                    >
                                        {t('settings.service-accounts:keys.usedAt', { at: new Date(key.lastUsedAt) })}
                                        {key.lastUsedIp && (
                                            <span className="block text-xs text-muted-foreground">
                                                {t('settings.service-accounts:keys.usedFrom', { ip: key.lastUsedIp })}
                                            </span>
                                        )}
                                    </span>
                                ) : (
                                    t('settings.service-accounts:keys.neverUsed')
                                )}
                            </TableCell>
                            <TableCell>{keyState(key, now)}</TableCell>
                            <TableCell className="text-right">
                                {live ? (
                                    <Button variant="ghost" size="sm" onClick={() => onRevoke(key)}>
                                        {t('settings.service-accounts:keys.revoke')}
                                    </Button>
                                ) : (
                                    key.revokedAt && (
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            aria-label={t('settings.service-accounts:keys.deleteLabel', {
                                                name: key.name,
                                            })}
                                            onClick={() => onDelete(key)}
                                        >
                                            {t('settings.service-accounts:keys.delete')}
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
    const { t } = useTranslation(['settings.service-accounts']);
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
                .catch((e) => failed(e, t('settings.service-accounts:errors.load'))),
        [t],
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
        }, t('settings.service-accounts:errors.add'));
    };
    return (
        <section className="grid gap-3" data-slot="service-accounts">
            <p className="text-sm text-muted-foreground">
                <Trans
                    t={t}
                    i18nKey="settings.service-accounts:intro"
                    values={{ header: `Authorization: Bearer ${KEY_PREFIX}…` }}
                    components={{ code: <code className="text-xs" /> }}
                />
            </p>
            <ul className="grid gap-3" aria-label={t('settings.service-accounts:list.label')}>
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
                                    {account.disabledAt
                                        ? t('settings.service-accounts:list.disabled', {
                                              at: new Date(account.disabledAt),
                                          })
                                        : t('settings.service-accounts:list.kind')}
                                    {account.description ? ` · ${account.description}` : ''}
                                </span>
                            </span>
                            {account.disabledAt ? (
                                <Badge variant="secondary">{roleLabel(account.role)}</Badge>
                            ) : (
                                <>
                                    <select
                                        data-slot="native-select"
                                        aria-label={t('settings.service-accounts:list.role', { name: account.name })}
                                        className={cn(nativeSelect, 'h-8 w-28')}
                                        value={account.role}
                                        onChange={(e) =>
                                            void act(
                                                () => api(accountPath(account.id), 'PATCH', { role: e.target.value }),
                                                t('settings.service-accounts:errors.role'),
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
                                        {t('settings.service-accounts:list.newKey')}
                                    </Button>
                                    <DropdownMenu modal={false}>
                                        <DropdownMenuTrigger asChild>
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                aria-label={t('settings.service-accounts:list.actions', {
                                                    name: account.name,
                                                })}
                                            >
                                                <MoreHorizontal />
                                            </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                            <DropdownMenuItem
                                                variant="destructive"
                                                onSelect={() => setDisabling(account)}
                                            >
                                                {t('settings.service-accounts:list.disable')}
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
                                        t('settings.service-accounts:errors.revoke'),
                                    )
                                }
                                onDelete={(key) => setDeleting({ account, key })}
                            />
                        ) : (
                            <span className="text-sm text-muted-foreground">
                                {t('settings.service-accounts:list.noKeys')}
                            </span>
                        )}
                    </li>
                ))}
            </ul>
            <form
                className="grid gap-2 sm:grid-cols-2"
                onSubmit={add}
                aria-label={t('settings.service-accounts:add.label')}
            >
                <Input
                    aria-label={t('settings.service-accounts:add.name')}
                    placeholder={t('settings.service-accounts:add.namePlaceholder')}
                    required
                    maxLength={60}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                />
                <select
                    data-slot="native-select"
                    aria-label={t('settings.service-accounts:add.role')}
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
                    aria-label={t('settings.service-accounts:add.purpose')}
                    placeholder={t('settings.service-accounts:add.purposePlaceholder')}
                    maxLength={300}
                    className="sm:col-span-2"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                />
                <Button className="sm:col-span-2" disabled={!name.trim()}>
                    {t('settings.service-accounts:add.submit')}
                </Button>
            </form>
            {keyFor && (
                <NewKeyDialog account={keyFor} onClose={() => setKeyFor(undefined)} onCreated={() => void load()} />
            )}
            {disabling && (
                <ConfirmDelete
                    title={t('settings.service-accounts:disable.title', { name: disabling.name })}
                    action={t('settings.service-accounts:disable.action')}
                    slot="confirm-disable-service-account"
                    onClose={() => setDisabling(undefined)}
                    onConfirm={async () => {
                        const { id } = disabling;
                        await act(() => api(accountPath(id), 'DELETE'), t('settings.service-accounts:errors.disable'));
                        setDisabling(undefined);
                    }}
                >
                    {t('settings.service-accounts:disable.body')}
                </ConfirmDelete>
            )}
            {deleting && (
                <ConfirmDelete
                    title={t('settings.service-accounts:deleteKey.title')}
                    slot="confirm-delete-service-key"
                    onClose={() => setDeleting(undefined)}
                    onConfirm={async () => {
                        const { account, key } = deleting;
                        await act(
                            () => api(accountPath(account.id, `/keys/${encodeURIComponent(key.id)}/record`), 'DELETE'),
                            t('settings.service-accounts:errors.delete'),
                        );
                        setDeleting(undefined);
                    }}
                >
                    <Trans
                        t={t}
                        i18nKey="settings.service-accounts:deleteKey.body"
                        values={{
                            key: deleting.key.name,
                            prefix: `${KEY_PREFIX}${deleting.key.hint}…`,
                            account: deleting.account.name,
                        }}
                        components={{ code: <code className="text-xs" /> }}
                    />
                </ConfirmDelete>
            )}
        </section>
    );
}
