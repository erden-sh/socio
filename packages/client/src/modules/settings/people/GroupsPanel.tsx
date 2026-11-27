import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import type { RosterPerson } from '@socio/shared/auth';
import { GROUP_PERMISSIONS, type Group, type GroupPermission } from '@socio/shared/groups';
import { isAdmin } from '@socio/shared/roles';

import { ConfirmDelete } from '../../../components/confirm-delete';
import { nativeSelect } from '../../../components/form-fields';
import { api } from '../../../lib/api';

import { personPath } from './people-format';

import { Badge } from '@/components/ui/badge';
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

const failed = (e: unknown, fallback: string) => toast.error(e instanceof Error ? e.message : fallback);
const groupPath = (id: string) => `/groups/${encodeURIComponent(id)}`;

/** How People names each permission, and what it lets them do. */
const PERMISSION_KEYS = {
    'code:run': {
        label: 'settings.people:groups.permissions.code-run.label',
        detail: 'settings.people:groups.permissions.code-run.detail',
    },
} as const satisfies Record<GroupPermission, { label: string; detail: string }>;

/** The permissions a group gives, as badges; "No permissions" when none. */
export function PermissionBadges({ permissions }: { permissions: readonly GroupPermission[] }) {
    const { t } = useTranslation(['settings.people']);
    if (!permissions.length) {
        return <span className="text-xs text-muted-foreground">{t('settings.people:groups.noPermissions')}</span>;
    }
    return (
        <>
            {permissions.map((permission) => (
                <Badge key={permission} variant="secondary">
                    {t(PERMISSION_KEYS[permission].label)}
                </Badge>
            ))}
        </>
    );
}

/**
 * Create a group, or rename one and choose its permissions: a name and a
 * checkbox per permission ("Run code" is the only one for now).
 */
function GroupDialog({ group, onClose, onSaved }: { group?: Group; onClose: () => void; onSaved: () => void }) {
    const { t } = useTranslation(['settings.people']);
    const [name, setName] = useState(group?.name ?? '');
    const [permissions, setPermissions] = useState<GroupPermission[]>(group?.permissions ?? ['code:run']);
    const [busy, setBusy] = useState(false);
    const submit = async (e: FormEvent) => {
        e.preventDefault();
        setBusy(true);
        try {
            if (group) {
                await api<Group>(groupPath(group.id), 'PATCH', { name, permissions });
                toast.success(t('settings.people:groups.dialog.saved'));
            } else {
                await api<Group>('/groups', 'POST', { name, permissions });
                toast.success(t('settings.people:groups.dialog.created', { name: name.trim() }));
            }
            onSaved();
            onClose();
        } catch (error) {
            failed(error, t('settings.people:groups.dialog.saveFailed'));
        } finally {
            setBusy(false);
        }
    };
    return (
        <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
            <DialogContent data-slot="group-dialog">
                <DialogHeader>
                    <DialogTitle>
                        {group
                            ? t('settings.people:groups.dialog.editTitle', { name: group.name })
                            : t('settings.people:groups.dialog.newTitle')}
                    </DialogTitle>
                    <DialogDescription>{t('settings.people:groups.dialog.description')}</DialogDescription>
                </DialogHeader>
                <form
                    className="grid gap-3"
                    onSubmit={submit}
                    aria-label={
                        group ? t('settings.people:groups.dialog.editForm') : t('settings.people:groups.dialog.newForm')
                    }
                >
                    <Input
                        aria-label={t('settings.people:groups.dialog.name')}
                        placeholder={t('settings.people:groups.dialog.namePlaceholder')}
                        required
                        maxLength={60}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                    />
                    <fieldset className="grid gap-2">
                        <legend className="font-medium">{t('settings.people:groups.dialog.permissions')}</legend>
                        {GROUP_PERMISSIONS.map((permission) => (
                            <label key={permission} className="flex items-start gap-2">
                                <input
                                    type="checkbox"
                                    className="mt-0.5 size-4 shrink-0"
                                    checked={permissions.includes(permission)}
                                    onChange={(e) =>
                                        setPermissions(
                                            e.target.checked
                                                ? [...permissions, permission]
                                                : permissions.filter((entry) => entry !== permission),
                                        )
                                    }
                                />
                                <span className="grid">
                                    {t(PERMISSION_KEYS[permission].label)}
                                    <span className="text-xs text-muted-foreground">
                                        {t(PERMISSION_KEYS[permission].detail)}
                                    </span>
                                </span>
                            </label>
                        ))}
                    </fieldset>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
                            {t('settings.people:groups.dialog.cancel')}
                        </Button>
                        <Button type="submit" disabled={busy || !name.trim()}>
                            {group
                                ? t('settings.people:groups.dialog.save')
                                : t('settings.people:groups.dialog.create')}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** One group: its permissions, its people, and the admin's controls. */
function GroupCard({
    group,
    people,
    onEdit,
    onDelete,
    onChanged,
}: {
    group: Group;
    people: RosterPerson[] | undefined;
    onEdit: () => void;
    onDelete: () => void;
    onChanged: () => void;
}) {
    const { t } = useTranslation(['settings.people']);
    const [adding, setAdding] = useState('');
    const [busy, setBusy] = useState(false);
    const inGroup = new Set(group.members.map((member) => member.accountId));
    const addable = (people ?? []).filter((person) => !inGroup.has(person.id) && person.status !== 'deactivated');
    const change = async (accountId: string, add: boolean) => {
        setBusy(true);
        try {
            await api<Group>(`${groupPath(group.id)}/members/${encodeURIComponent(accountId)}`, add ? 'PUT' : 'DELETE');
            if (add) {
                setAdding('');
            }
            onChanged();
        } catch (error) {
            failed(
                error,
                add ? t('settings.people:groups.card.addFailed') : t('settings.people:groups.card.removeFailed'),
            );
        } finally {
            setBusy(false);
        }
    };
    return (
        <section
            className="grid content-start gap-2 rounded-lg border p-4"
            data-slot="group"
            aria-label={t('settings.people:groups.card.label', { name: group.name })}
        >
            <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex flex-wrap items-center gap-2">
                    <h4 className="font-medium">{group.name}</h4>
                    <PermissionBadges permissions={group.permissions} />
                </span>
                <span className="flex gap-1">
                    <Button variant="ghost" size="sm" onClick={onEdit}>
                        {t('settings.people:groups.card.edit')}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={onDelete}>
                        {t('settings.people:groups.card.delete')}
                    </Button>
                </span>
            </div>
            {group.members.length ? (
                <ul aria-label={t('settings.people:groups.card.members', { name: group.name })}>
                    {group.members.map((member) => (
                        <li
                            key={member.accountId}
                            className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t py-2 first:border-t-0"
                            data-slot="group-member"
                        >
                            <span className="min-w-0 flex-1">
                                <Link to={personPath(member.accountId)} className="underline-offset-2 hover:underline">
                                    {member.name}
                                </Link>{' '}
                                <span className="text-xs text-muted-foreground">
                                    {member.email}
                                    {member.deactivated ? t('settings.people:groups.card.deactivated') : ''}
                                </span>
                            </span>
                            <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy}
                                onClick={() => void change(member.accountId, false)}
                            >
                                {t('settings.people:groups.card.remove')}
                            </Button>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="text-muted-foreground">{t('settings.people:groups.card.nobody')}</p>
            )}
            <form
                className="flex flex-wrap gap-2"
                aria-label={t('settings.people:groups.card.addForm', { name: group.name })}
                onSubmit={(e) => {
                    e.preventDefault();
                    if (adding) {
                        void change(adding, true);
                    }
                }}
            >
                <select
                    data-slot="native-select"
                    aria-label={t('settings.people:groups.card.addSelect', { name: group.name })}
                    className={nativeSelect}
                    value={adding}
                    onChange={(e) => setAdding(e.target.value)}
                >
                    <option value="">{t('settings.people:groups.card.choose')}</option>
                    {addable.map((person) => (
                        <option key={person.id} value={person.id}>
                            {t('settings.people:groups.card.option', {
                                context: isAdmin(person) ? 'admin' : undefined,
                                name: person.name,
                                email: person.email,
                            })}
                        </option>
                    ))}
                </select>
                <Button type="submit" variant="outline" disabled={busy || !adding}>
                    {t('settings.people:groups.card.add')}
                </Button>
            </form>
        </section>
    );
}

/**
 * Settings → People → Groups (CB-376): admins make groups, choose what
 * each may do ("Run code" for now) and who is in it. Admins have every
 * permission without a group.
 */
export function GroupsPanel({
    people,
    onCount,
}: {
    people: RosterPerson[] | undefined;
    onCount?: (n: number) => void;
}) {
    const { t } = useTranslation(['settings.people']);
    const [groups, setGroups] = useState<Group[]>();
    const [editing, setEditing] = useState<Group | 'new'>();
    const [deleting, setDeleting] = useState<Group>();
    const load = useCallback(async () => {
        try {
            const list = (await api<{ groups: Group[] }>('/groups')).groups;
            setGroups(list);
            onCount?.(list.length);
        } catch (e) {
            failed(e, t('settings.people:groups.loadFailed'));
        }
    }, [onCount, t]);
    useEffect(() => {
        void load();
    }, [load]);
    return (
        <div className="grid gap-3" data-slot="groups-panel">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <p className="text-muted-foreground">{t('settings.people:groups.intro')}</p>
                <Button onClick={() => setEditing('new')}>{t('settings.people:groups.new')}</Button>
            </div>
            {groups === undefined ? null : groups.length ? (
                groups.map((group) => (
                    <GroupCard
                        key={group.id}
                        group={group}
                        people={people}
                        onEdit={() => setEditing(group)}
                        onDelete={() => setDeleting(group)}
                        onChanged={() => void load()}
                    />
                ))
            ) : (
                <p className="text-muted-foreground" data-slot="no-groups">
                    {t('settings.people:groups.empty')}
                </p>
            )}
            {editing && (
                <GroupDialog
                    group={editing === 'new' ? undefined : editing}
                    onClose={() => setEditing(undefined)}
                    onSaved={() => void load()}
                />
            )}
            {deleting && (
                <ConfirmDelete
                    title={t('settings.people:groups.delete.title', { name: deleting.name })}
                    slot="delete-group"
                    onClose={() => setDeleting(undefined)}
                    onConfirm={async () => {
                        try {
                            await api(groupPath(deleting.id), 'DELETE');
                            toast.success(t('settings.people:groups.delete.deleted', { name: deleting.name }));
                            setDeleting(undefined);
                            await load();
                        } catch (error) {
                            failed(error, t('settings.people:groups.delete.failed'));
                        }
                    }}
                >
                    {deleting.members.length
                        ? t('settings.people:groups.delete.loses', { count: deleting.members.length })
                        : t('settings.people:groups.delete.nobody')}
                </ConfirmDelete>
            )}
        </div>
    );
}
