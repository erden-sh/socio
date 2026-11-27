import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import type { PasswordLink, RosterPerson, SentSignInLink } from '@socio/shared/auth';
import { ROLES } from '@socio/shared/roles';
import type { Role } from '@socio/shared/types';

import { DataGrid, GridFilter, GridSearch, GridToolbar, RowActionsMenu } from '../../../components/data-grid/DataGrid';
import { nativeSelect } from '../../../components/form-fields';
import { api } from '../../../lib/api';
import { PersonReleases } from '../../whats-new/PersonReleases';

import { DeactivateDialog, ReactivateDialog } from './DeactivateDialog';
import { PasswordLinkDialog, type ShownLink } from './InviteDialog';
import {
    ACTIVE_NOW_MS,
    byStatusThenName,
    firstName,
    initials,
    isDemotion,
    matches,
    ownerLock,
    PERSON_STATES,
    personPath,
    stateOf,
    type OwnerLock,
    type PeopleFilter,
    type PersonState,
    usePeopleFormat,
} from './people-format';

import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

const failed = (e: unknown, fallback: string) => toast.error(e instanceof Error ? e.message : fallback);
const path = (id: string, rest = '') => `/accounts/${encodeURIComponent(id)}${rest}`;

const STATE_BADGE: Record<PersonState, string> = {
    active: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400',
    invited: 'border-border bg-transparent text-foreground',
    'invite-expired': 'border-paused-banner-border bg-paused-banner text-paused-banner-foreground',
    deactivated: 'bg-secondary text-muted-foreground',
};

/** The workspace owner's badge (CB-390), beside their name. */
export function OwnerBadge({ person }: { person: { owner?: boolean } }) {
    const { t } = useTranslation(['settings.people']);
    if (!person.owner) {
        return null;
    }
    return (
        <Badge variant="outline" data-slot="owner-badge" title={t('settings.people:owner.title')}>
            {t('settings.people:owner.badge')}
        </Badge>
    );
}

export function StateBadge({ person }: { person: RosterPerson }) {
    const { stateLabel } = usePeopleFormat();
    const state = stateOf(person);
    return (
        <Badge data-state={state} className={STATE_BADGE[state]}>
            {stateLabel(state)}
        </Badge>
    );
}

function LastActive({ person }: { person: RosterPerson }) {
    const { t } = useTranslation(['settings.people']);
    const { lastActive, exactTime, devices } = usePeopleFormat();
    if (!person.lastActiveAt) {
        return <span className="text-muted-foreground">{t('settings.people:lastActive.never')}</span>;
    }
    const at = Date.parse(person.lastActiveAt);
    const now = Date.now() - at < ACTIVE_NOW_MS && person.status === 'active';
    return (
        <span title={exactTime(at)} className="inline-flex flex-wrap items-center gap-x-1">
            <span
                aria-hidden
                className={cn('size-2 rounded-full', now ? 'bg-emerald-500' : 'bg-muted-foreground/40')}
            />
            {lastActive(at)}
            {person.status === 'active' && person.sessions > 0 && (
                <span className="basis-full text-xs text-muted-foreground">{devices(person.sessions)}</span>
            )}
        </span>
    );
}

function SignInMethods({ person }: { person: RosterPerson }) {
    const { signInChips } = usePeopleFormat();
    const chips = signInChips(person);
    if (typeof chips === 'string') {
        return <span className="text-muted-foreground">{chips}</span>;
    }
    return (
        <span className="flex flex-wrap gap-1">
            {chips.map((chip) => (
                <Badge
                    key={chip.label}
                    variant="outline"
                    data-warn={chip.warn || undefined}
                    className={cn(
                        'font-normal',
                        chip.warn && 'border-paused-banner-border bg-paused-banner text-paused-banner-foreground',
                    )}
                >
                    {chip.label}
                </Badge>
            ))}
        </span>
    );
}

function PersonName({ person }: { person: RosterPerson }) {
    return (
        <span className="flex min-w-0 items-center gap-3">
            <Avatar>
                <AvatarFallback className="bg-brand/10 text-xs font-semibold text-primary">
                    {initials(person.name)}
                </AvatarFallback>
            </Avatar>
            <span className="grid min-w-0">
                <span className="flex min-w-0 items-center gap-2">
                    <Link
                        to={personPath(person.id)}
                        className="truncate font-medium hover:underline focus-visible:underline"
                        data-slot="person-link"
                    >
                        {person.name}
                    </Link>
                    <OwnerBadge person={person} />
                </span>
                <span className="truncate text-xs text-muted-foreground">{person.email}</span>
            </span>
        </span>
    );
}

/** The actions on a person that exist today (the old row's buttons). */
interface RowActions {
    passwordLink: (person: RosterPerson) => void;
    signInLink: (person: RosterPerson) => void;
    releases: (person: RosterPerson) => void;
    signOut: (person: RosterPerson) => void;
    deactivate: (person: RosterPerson) => void;
    reactivate: (person: RosterPerson) => void;
}

function RowMenu({ person, lock, actions }: { person: RosterPerson; lock?: OwnerLock; actions: RowActions }) {
    const { t } = useTranslation(['settings.people']);
    const { ownerLockTitle, signInLinkWords } = usePeopleFormat();
    const off = person.status === 'deactivated';
    // The owner's account (CB-390): only the owner changes it, and the owner
    // can't deactivate themselves.
    const locked = lock === 'others';
    const signInLink = signInLinkWords(person.signInLinkVia);
    return (
        <RowActionsMenu name={person.name} slot="person-actions" title={lock ? ownerLockTitle(lock) : undefined}>
            <DropdownMenuItem asChild>
                <Link to={personPath(person.id)}>{t('settings.people:actions.open')}</Link>
            </DropdownMenuItem>
            {off ? (
                <DropdownMenuItem disabled={locked} onSelect={() => actions.reactivate(person)}>
                    {t('settings.people:actions.reactivate')}
                </DropdownMenuItem>
            ) : (
                <>
                    <DropdownMenuItem disabled={locked} onSelect={() => actions.passwordLink(person)}>
                        {t('settings.people:actions.passwordLink')}
                    </DropdownMenuItem>
                    {signInLink && (
                        <DropdownMenuItem onSelect={() => actions.signInLink(person)}>
                            {signInLink.action}
                        </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onSelect={() => actions.releases(person)}>
                        {t('settings.people:releases.action')}
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={locked} onSelect={() => actions.signOut(person)}>
                        {t('settings.people:actions.signOutEverywhere')}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                        variant="destructive"
                        disabled={!!lock}
                        onSelect={() => actions.deactivate(person)}
                    >
                        {t('settings.people:actions.deactivate')}
                    </DropdownMenuItem>
                </>
            )}
        </RowActionsMenu>
    );
}

/** A person's role, changed in place; the guards as before. */
export function RolePicker({
    person,
    lock,
    onPick,
}: {
    person: RosterPerson;
    /** The owner's protection (CB-390): their role stays admin. */
    lock?: OwnerLock;
    onPick: (role: Role) => void;
}) {
    const { t } = useTranslation(['settings.people']);
    const { ownerLockTitle, roleLabel } = usePeopleFormat();
    const off = person.status === 'deactivated';
    return (
        <select
            data-slot="native-select"
            aria-label={t('settings.people:role.label', { name: person.name })}
            className={cn(nativeSelect, 'h-8 w-auto')}
            value={person.role}
            disabled={!!lock || off}
            title={
                lock
                    ? ownerLockTitle(lock)
                    : off
                      ? t('settings.people:role.reactivateFirst')
                      : person.adminByRule
                        ? t('settings.people:role.byRule')
                        : undefined
            }
            onChange={(e) => onPick(e.target.value as Role)}
        >
            {ROLES.filter((r) => r === person.role || !(person.adminByRule && r === 'member')).map((r) => (
                <option key={r} value={r}>
                    {roleLabel(r)}
                </option>
            ))}
        </select>
    );
}

/** "Releases Ben Admin has seen": the ⋯ menu's Releases seen. */
export function ReleasesDialog({ person, onClose }: { person: RosterPerson; onClose: () => void }) {
    const { t } = useTranslation(['settings.people']);
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t('settings.people:releases.title', { name: person.name })}</DialogTitle>
                </DialogHeader>
                <PersonReleases userId={person.userId} name={person.name} />
            </DialogContent>
        </Dialog>
    );
}

/** A role change that takes something away asks first, saying what it ends. */
export function DemoteDialog({
    person,
    to,
    onClose,
    onConfirm,
}: {
    person: RosterPerson;
    to: Role;
    onClose: () => void;
    onConfirm: () => void;
}) {
    const { t } = useTranslation(['settings.people']);
    return (
        <AlertDialog open onOpenChange={(open) => !open && onClose()}>
            <AlertDialogContent data-slot="confirm-role">
                <AlertDialogHeader>
                    <AlertDialogTitle>
                        {t('settings.people:demote.title', { context: to, name: person.name })}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                        {t('settings.people:demote.loses', { first: firstName(person.name) })}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>{t('settings.people:demote.cancel')}</AlertDialogCancel>
                    <Button variant="destructive" onClick={onConfirm}>
                        {t('settings.people:demote.confirm', { context: to })}
                    </Button>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}

/**
 * Settings → People, the People tab (CB-360): everyone who
 * signs in, active by name, then invited, then deactivated (grayed), with
 * search and filters, a callout for invites that expired unused, and each
 * row's actions in its ⋯ menu. A table on wide screens, a card per person
 * on a phone. Admins manage every account but the workspace owner's,
 * which only the owner changes (CB-390; the server enforces it too); a
 * role change that takes something away asks first. `me` is the
 * signed-in app user id.
 */
export function PeopleList({
    people,
    me,
    reload,
}: {
    people: RosterPerson[] | undefined;
    me: string | undefined;
    reload: () => Promise<void>;
}) {
    const { t } = useTranslation(['settings.people']);
    const { reachSummary, roleLabel, signInLinkWords, stateLabel } = usePeopleFormat();
    const [filter, setFilter] = useState<PeopleFilter>({ query: '', role: '', state: '' });
    const [link, setLink] = useState<ShownLink>();
    const [releasesOf, setReleasesOf] = useState<RosterPerson>();
    const [deactivating, setDeactivating] = useState<RosterPerson>();
    const [reactivating, setReactivating] = useState<RosterPerson>();
    const [demoting, setDemoting] = useState<{ person: RosterPerson; to: Role }>();
    const act = async (action: () => Promise<unknown>, fallback: string) => {
        try {
            await action();
            await reload();
        } catch (e) {
            failed(e, fallback);
        }
    };
    const setRole = (person: RosterPerson, role: Role) =>
        act(() => api(path(person.id), 'PATCH', { role }), t('settings.people:role.changeFailed'));
    const pickRole = (person: RosterPerson, role: Role) => {
        if (role === person.role) {
            return;
        }
        if (isDemotion(person.role, role)) {
            setDemoting({ person, to: role });
            return;
        }
        void setRole(person, role);
    };
    const passwordLink = (person: RosterPerson) =>
        void act(async () => {
            const made = await api<PasswordLink>(path(person.id, '/password-link'), 'POST', {});
            setLink({ ...made, email: person.email });
        }, t('settings.people:actions.passwordLinkFailed'));
    const actions: RowActions = {
        passwordLink,
        signInLink: (person) =>
            void act(async () => {
                await api<SentSignInLink>(path(person.id, '/sign-in-link'), 'POST', {});
                const sent = signInLinkWords(person.signInLinkVia)?.sent(person.name);
                if (sent) {
                    toast.success(sent);
                }
            }, t('settings.people:signInLink.failed')),
        releases: setReleasesOf,
        signOut: (person) =>
            void act(async () => {
                await api(path(person.id, '/sessions'), 'DELETE');
                toast.success(t('settings.people:actions.signedOut', { name: person.name }));
            }, t('settings.people:actions.signOutFailed')),
        deactivate: setDeactivating,
        reactivate: setReactivating,
    };
    const sorted = [...(people ?? [])].sort(byStatusThenName);
    const shown = sorted.filter((person) => matches(person, filter));
    const expired = sorted.filter((person) => stateOf(person) === 'invite-expired');
    const lockOf = (person: RosterPerson) => ownerLock(person, me);
    return (
        <div className="grid gap-3" data-slot="people-list">
            <GridToolbar label={t('settings.people:list.toolbar')}>
                <GridSearch
                    label={t('settings.people:list.search')}
                    value={filter.query}
                    onChange={(query) => setFilter({ ...filter, query })}
                />
                <GridFilter
                    label={t('settings.people:list.roleFilter')}
                    any={t('settings.people:list.roleAny')}
                    value={filter.role}
                    options={ROLES.map((r) => ({ value: r, label: roleLabel(r) }))}
                    onChange={(role) => setFilter({ ...filter, role })}
                />
                <GridFilter
                    label={t('settings.people:list.statusFilter')}
                    any={t('settings.people:list.statusAny')}
                    value={filter.state}
                    options={PERSON_STATES.map((state: PersonState) => ({ value: state, label: stateLabel(state) }))}
                    onChange={(state) => setFilter({ ...filter, state })}
                />
            </GridToolbar>
            {expired.length > 0 && (
                <div
                    role="status"
                    data-slot="expired-invites"
                    className="grid gap-1 rounded-md border border-paused-banner-border bg-paused-banner px-3 py-2 text-xs text-paused-banner-foreground"
                >
                    <span>{t('settings.people:list.expired', { count: expired.length })}</span>
                    <span className="flex flex-wrap gap-x-3 gap-y-1">
                        {expired.map((person) => (
                            <span key={person.id}>
                                {person.name} ·{' '}
                                <button
                                    type="button"
                                    className="border-0 bg-transparent p-0 font-medium text-inherit underline underline-offset-2 shadow-none"
                                    disabled={lockOf(person) === 'others'}
                                    onClick={() => passwordLink(person)}
                                >
                                    {t('settings.people:actions.passwordLink')}
                                </button>
                            </span>
                        ))}
                    </span>
                </div>
            )}
            {!people ? (
                <p className="text-muted-foreground">{t('settings.people:list.loading')}</p>
            ) : !shown.length ? (
                <p className="text-muted-foreground" data-slot="people-empty">
                    {people.length ? t('settings.people:list.noMatch') : t('settings.people:list.empty')}
                </p>
            ) : (
                <DataGrid
                    label={t('settings.people:list.label')}
                    tableSlot="people-table"
                    cardsSlot="people-cards"
                    rows={shown}
                    rowKey={(person) => person.id}
                    rowProps={(person) => ({ 'data-person': person.email })}
                    dimmed={(person) => person.status === 'deactivated'}
                    columns={[
                        {
                            id: 'person',
                            header: t('settings.people:list.columns.person'),
                            className: 'max-w-72 min-w-52',
                            cell: (person) => <PersonName person={person} />,
                        },
                        {
                            id: 'role',
                            header: t('settings.people:list.columns.role'),
                            cell: (person) => (
                                <RolePicker
                                    person={person}
                                    lock={lockOf(person)}
                                    onPick={(role) => pickRole(person, role)}
                                />
                            ),
                        },
                        {
                            id: 'status',
                            header: t('settings.people:list.columns.status'),
                            cell: (person) => <StateBadge person={person} />,
                        },
                        {
                            id: 'last-active',
                            header: t('settings.people:list.columns.lastActive'),
                            className: 'whitespace-normal',
                            cell: (person) => <LastActive person={person} />,
                        },
                        {
                            id: 'sign-in',
                            header: t('settings.people:list.columns.signIn'),
                            className: 'whitespace-normal',
                            cell: (person) => <SignInMethods person={person} />,
                        },
                        {
                            id: 'reach',
                            header: t('settings.people:list.columns.reach'),
                            className: 'max-w-48 text-xs whitespace-normal text-muted-foreground',
                            cell: reachSummary,
                        },
                    ]}
                    actions={(person) => <RowMenu person={person} lock={lockOf(person)} actions={actions} />}
                    card={(person) => ({
                        head: <PersonName person={person} />,
                        body: (
                            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-11 text-sm">
                                <RolePicker
                                    person={person}
                                    lock={lockOf(person)}
                                    onPick={(role) => pickRole(person, role)}
                                />
                                <StateBadge person={person} />
                                <span className="text-xs">
                                    <LastActive person={person} />
                                </span>
                            </span>
                        ),
                    })}
                />
            )}
            {link && <PasswordLinkDialog link={link} onClose={() => setLink(undefined)} />}
            {releasesOf && <ReleasesDialog person={releasesOf} onClose={() => setReleasesOf(undefined)} />}
            {demoting && (
                <DemoteDialog
                    person={demoting.person}
                    to={demoting.to}
                    onClose={() => setDemoting(undefined)}
                    onConfirm={() => {
                        const { person, to } = demoting;
                        setDemoting(undefined);
                        void setRole(person, to);
                    }}
                />
            )}
            {deactivating && (
                <DeactivateDialog
                    person={deactivating}
                    onClose={() => setDeactivating(undefined)}
                    // What they own moved (or may have): the roster's counts change.
                    onTransferred={() => void reload()}
                    onConfirm={async () => {
                        const { id, name } = deactivating;
                        await act(async () => {
                            await api(path(id, '/deactivate'), 'POST', {});
                            toast.success(t('settings.people:actions.deactivated', { name }));
                        }, t('settings.people:actions.deactivateFailed'));
                        setDeactivating(undefined);
                    }}
                />
            )}
            {reactivating && (
                <ReactivateDialog
                    person={reactivating}
                    onClose={() => setReactivating(undefined)}
                    onConfirm={async () => {
                        const { id, name } = reactivating;
                        await act(async () => {
                            await api(path(id, '/reactivate'), 'POST', {});
                            toast.success(t('settings.people:actions.reactivated', { name }));
                        }, t('settings.people:actions.reactivateFailed'));
                        setReactivating(undefined);
                    }}
                />
            )}
        </div>
    );
}
