import { ArrowLeft, MoreHorizontal } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
    Link,
    Navigate,
    redirect,
    useNavigate,
    useParams,
    useSearchParams,
    type LoaderFunctionArgs,
} from 'react-router';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import type { Account, AssetKind, PasswordLink, SentSignInLink } from '@socio/shared/auth';
import type { PersonDetail } from '@socio/shared/people';
import type { Role } from '@socio/shared/types';

import { routeI18n } from '../../../i18n/page-i18n';
import { ApiError, api } from '../../../lib/api';
import { revalidateOn } from '../../../lib/page-loader';
import { web } from '../../../lib/web-context';
import { useShell, type RouteHandle } from '../../../shell/shell-context';
import { SettingsCard } from '../AccountSettings';
import { PERSON_CRUMB, sectionCrumb, SETTINGS_CRUMB } from '../crumbs';
import { allowed, findSection, SETTINGS_HOME, settingsAccess, settingsPath } from '../sections';
import { SettingsLayout, useSettingsAccess } from '../SettingsLayout';

import { DeactivateDialog, ReactivateDialog } from './DeactivateDialog';
import { PasswordLinkDialog, type ShownLink } from './InviteDialog';
import { MakeOwnerDialog } from './MakeOwnerDialog';
import { firstName, initials, isDemotion, ownerLock, usePeopleFormat } from './people-format';
import { DemoteDialog, OwnerBadge, ReleasesDialog, RolePicker, StateBadge } from './PeopleList';
import { AccessTab, ActivityTab, OwnsTab, SignInTab, type Run } from './PersonTabs';
import { RemoveDialog } from './RemoveDialog';
import { TransferDialog } from './TransferDialog';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const people = findSection('people')!;

export const handle: RouteHandle = {
    crumb: () => [
        { label: SETTINGS_CRUMB, to: '/settings' },
        { label: sectionCrumb('people'), to: settingsPath('people') },
        { label: PERSON_CRUMB },
    ],
};

/** `/settings/people/:id`: admins only, as People. */
export async function loader({ context }: LoaderFunctionArgs) {
    const { services } = web(context);
    const i18n = await routeI18n(context, 'settings:person');
    if (!(await services.user())) {
        return { i18n };
    }
    const workspace = await services.workspace();
    if (workspace && !allowed(people.item, settingsAccess(workspace, false))) {
        throw redirect(SETTINGS_HOME);
    }
    return { i18n };
}
export const shouldRevalidate = revalidateOn({ params: ['id'] });

/** The person page's tabs, by their `?tab=`. */
export const PERSON_TABS = ['access', 'sign-in', 'owns', 'activity'] as const;
export type PersonTab = (typeof PERSON_TABS)[number];
const TAB_KEYS = {
    access: 'settings.person:tabs.access',
    'sign-in': 'settings.person:tabs.sign-in',
    owns: 'settings.person:tabs.owns',
    activity: 'settings.person:tabs.activity',
} as const satisfies Record<PersonTab, string>;

/** What loading the person gave: them, or why not (403, 404). */
type Loaded = { detail: PersonDetail } | { status: number; message: string };

const failed = (e: unknown, fallback: string) => toast.error(e instanceof Error ? e.message : fallback);
const path = (id: string, rest = '') => `/accounts/${encodeURIComponent(id)}${rest}`;

/** One stat tile: a label, the number in words, and a line under it. */
function Tile({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
    return (
        <div className="grid min-w-0 content-start gap-0.5 rounded-lg border p-3" data-slot="person-tile">
            <span className="text-xs text-muted-foreground">{label}</span>
            <span className="text-base font-semibold break-words sm:text-lg">{value}</span>
            {note && <span className="text-xs break-words text-muted-foreground">{note}</span>}
        </div>
    );
}

/**
 * A person's page (CB-360): who they are, their role and sign-in actions;
 * four tiles (last active, devices, Spaces, what acts for them); the
 * Access, Sign-in & devices, Owns and Activity tabs, with Transfer on
 * Owns; and Deactivate or Reactivate at the foot, with Remove permanently
 * beside it (and in the ⋯ menu) for admins. The workspace owner's account
 * (CB-390) is changed only by the owner: other admins see it, with its
 * actions off; the owner sees "Make owner" on another active admin's
 * page.
 */
export default function PersonPageRoute() {
    const { t } = useTranslation(['settings.person', 'settings.people', 'settings']);
    const {
        devices: deviceCount,
        deviceLabel,
        exactTime,
        lastActive,
        ownerLockTitle,
        shortDate,
        signInLinkWords,
    } = usePeopleFormat();
    const { id = '' } = useParams();
    const access = useSettingsAccess();
    const { workspace } = useShell();
    const me = workspace.user.id;
    const [params, setParams] = useSearchParams();
    const tabParam = params.get('tab') as PersonTab | null;
    const tab: PersonTab = tabParam && PERSON_TABS.includes(tabParam) ? tabParam : 'access';
    const [loaded, setLoaded] = useState<Loaded>();
    const [link, setLink] = useState<ShownLink>();
    const [releases, setReleases] = useState(false);
    const [demoting, setDemoting] = useState<Role>();
    const [lifecycle, setLifecycle] = useState<'deactivate' | 'reactivate' | 'remove' | 'owner'>();
    // Whether I am the workspace owner (CB-390): only then "Make owner".
    const [iOwn, setIOwn] = useState(false);
    // The transfer dialog, with the kinds it opens ticked (undefined: all).
    const [transfer, setTransfer] = useState<{ only?: AssetKind[] }>();
    // Bumped after a transfer: the Owns tab loads again.
    const [owned, setOwned] = useState(0);
    const navigate = useNavigate();
    // The person on screen now: a load or an action's refresh that answers
    // after a navigation to someone else is dropped.
    const shown = useRef(id);
    shown.current = id;
    const load = useCallback(
        async (signal?: AbortSignal) => {
            try {
                const detail = await api<PersonDetail>(path(id), 'GET', undefined, signal);
                if (shown.current === id) {
                    setLoaded({ detail });
                }
            } catch (e) {
                if (!signal?.aborted && shown.current === id) {
                    setLoaded({
                        status: e instanceof ApiError ? e.status : 0,
                        message: e instanceof Error ? e.message : t('settings.person:page.loadFailed'),
                    });
                }
            }
        },
        [id, t],
    );
    useEffect(() => {
        if (!access.signIn) {
            return;
        }
        const controller = new AbortController();
        api<{ accounts?: Account[] }>('/accounts', 'GET', undefined, controller.signal)
            .then((list) => setIOwn(!!list?.accounts?.some((account) => account.owner && account.userId === me)))
            .catch(() => setIOwn(false));
        return () => controller.abort();
    }, [access.signIn, me]);
    useEffect(() => {
        if (!access.signIn) {
            return;
        }
        const controller = new AbortController();
        setLoaded(undefined);
        void load(controller.signal);
        return () => controller.abort();
    }, [load, access.signIn]);
    const run: Run = useCallback(
        async (work, fallback, done) => {
            try {
                await work();
                if (done) {
                    toast.success(done);
                }
            } catch (e) {
                failed(e, fallback);
            }
            await load();
        },
        [load],
    );
    if (!allowed(people.item, access)) {
        return <Navigate to={SETTINGS_HOME} replace />;
    }
    const back = (
        <Link
            to={settingsPath('people')}
            className="inline-flex w-fit items-center gap-1 text-muted-foreground hover:text-foreground"
        >
            <ArrowLeft className="size-4" /> {t('settings:sections.people')}
        </Link>
    );
    const message = (text: string, slot: string, retry = false) => (
        <div className="grid justify-items-start gap-2" data-slot={slot}>
            <p className="text-muted-foreground">{text}</p>
            {retry && (
                <Button variant="outline" size="sm" onClick={() => void load()}>
                    {t('settings.person:page.tryAgain')}
                </Button>
            )}
        </div>
    );
    let body: ReactNode;
    if (!access.signIn) {
        body = message(t('settings.person:page.needsSignIn'), 'person-needs-sign-in');
    } else if (!loaded) {
        body = message(t('settings.person:page.loading'), 'person-loading');
    } else if ('status' in loaded) {
        body =
            loaded.status === 403
                ? message(loaded.message, 'person-forbidden')
                : loaded.status === 404
                  ? message(t('settings.person:page.notFound'), 'person-not-found')
                  : message(loaded.message, 'person-error', true);
    } else {
        const { detail } = loaded;
        const { person, signIn } = detail;
        const first = firstName(person.name);
        const off = person.status === 'deactivated';
        // The workspace owner's account (CB-390): only the owner changes it,
        // and the owner stays an active admin. The server refuses it too.
        const lock = ownerLock(person, me);
        const locked = lock === 'others';
        // Admins remove people for good; never themselves or the owner.
        const removable = !!person.userId && person.userId !== me && !person.owner;
        // The owner hands ownership to another active admin.
        const ownable =
            iOwn && !off && person.role === 'admin' && !person.owner && !!person.userId && person.userId !== me;
        const setRole = (role: Role) =>
            run(() => api(path(person.id), 'PATCH', { role }), t('settings.people:role.changeFailed'));
        const passwordLink = () =>
            void run(async () => {
                const made = await api<PasswordLink>(path(person.id, '/password-link'), 'POST', {});
                setLink({ ...made, email: person.email });
            }, t('settings.people:actions.passwordLinkFailed'));
        const spaces = detail.access?.spaces ?? [];
        const editorOf = spaces.filter((space) => space.level === 'editor').length;
        const socios = detail.access?.socioGrants.length ?? 0;
        const agents = detail.access?.connectedAgents.length ?? 0;
        const signInLink = off ? null : signInLinkWords(person.signInLinkVia);
        const devices = [...new Set(signIn.sessions.map((session) => deviceLabel(session.userAgent)))];
        body = (
            <div className="grid gap-4" data-person={person.email} key={person.id}>
                <header className="flex flex-wrap items-start gap-3" data-slot="person-header">
                    <Avatar className="size-12">
                        <AvatarFallback className="bg-brand/10 text-base font-semibold text-primary">
                            {initials(person.name)}
                        </AvatarFallback>
                    </Avatar>
                    <div className="grid min-w-0 flex-1 gap-0.5">
                        <h3 className="flex flex-wrap items-center gap-2 text-lg font-medium">
                            {person.name}
                            <OwnerBadge person={person} />
                            <StateBadge person={person} />
                        </h3>
                        <p className="text-muted-foreground">
                            <span className="break-all">{person.email}</span>
                            <span className="whitespace-nowrap">
                                {' '}
                                {t('settings.person:page.joined', { date: shortDate(person.createdAt) })}
                            </span>
                        </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2" data-slot="person-actions">
                        <RolePicker
                            person={person}
                            lock={lock}
                            onPick={(role) => {
                                if (role === person.role) {
                                    return;
                                }
                                if (isDemotion(person.role, role)) {
                                    setDemoting(role);
                                } else {
                                    void setRole(role);
                                }
                            }}
                        />
                        {!off && (
                            <>
                                <Button variant="outline" size="sm" disabled={locked} onClick={passwordLink}>
                                    {t('settings.people:actions.passwordLink')}
                                </Button>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={locked}
                                    onClick={() =>
                                        void run(
                                            () => api(path(person.id, '/sessions'), 'DELETE'),
                                            t('settings.people:actions.signOutFailed'),
                                            t('settings.people:actions.signedOut', { name: person.name }),
                                        )
                                    }
                                >
                                    {t('settings.people:actions.signOutEverywhere')}
                                </Button>
                            </>
                        )}
                        <DropdownMenu modal={false}>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    variant="outline"
                                    size="icon-sm"
                                    aria-label={t('settings.person:page.more', { name: person.name })}
                                >
                                    <MoreHorizontal />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" data-slot="person-more">
                                {signInLink && (
                                    <DropdownMenuItem
                                        onSelect={() =>
                                            void run(
                                                () => api<SentSignInLink>(path(person.id, '/sign-in-link'), 'POST', {}),
                                                t('settings.people:signInLink.failed'),
                                                signInLink.sent(person.name),
                                            )
                                        }
                                    >
                                        {signInLink.action}
                                    </DropdownMenuItem>
                                )}
                                <DropdownMenuItem disabled={!person.userId} onSelect={() => setReleases(true)}>
                                    {t('settings.people:releases.action')}
                                </DropdownMenuItem>
                                {ownable && (
                                    <DropdownMenuItem onSelect={() => setLifecycle('owner')}>
                                        {t('settings.person:page.makeOwner')}
                                    </DropdownMenuItem>
                                )}
                                {removable && (
                                    <DropdownMenuItem
                                        className="text-destructive"
                                        onSelect={() => setLifecycle('remove')}
                                    >
                                        {t('settings.person:page.removePermanently')}
                                    </DropdownMenuItem>
                                )}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                </header>
                <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" data-slot="person-tiles">
                    <Tile
                        label={t('settings.person:tiles.lastActive')}
                        value={
                            person.lastActiveAt
                                ? lastActive(Date.parse(person.lastActiveAt))
                                : t('settings.people:lastActive.never')
                        }
                        note={person.lastActiveAt && exactTime(person.lastActiveAt)}
                    />
                    <Tile
                        label={t('settings.person:tiles.signedInOn')}
                        value={deviceCount(signIn.sessions.length)}
                        note={
                            devices.join(', ') ||
                            (off ? t('settings.person:tiles.deactivated') : t('settings.person:tiles.nowhere'))
                        }
                    />
                    <Tile
                        label={t('settings.person:tiles.canReach')}
                        value={detail.access ? t('settings.people:reach.spaces', { count: spaces.length }) : '—'}
                        note={editorOf ? t('settings.person:tiles.asEditor', { count: editorOf }) : undefined}
                    />
                    <Tile
                        label={t('settings.person:tiles.actsForThem')}
                        value={
                            detail.access
                                ? t('settings.person:tiles.actsForThemValue', {
                                      socios: t('settings.people:reach.socios', { count: socios }),
                                      agents: t('settings.people:reach.agents', { count: agents }),
                                  })
                                : '—'
                        }
                        note={t('settings.person:tiles.delegated')}
                    />
                </div>
                <Tabs
                    value={tab}
                    onValueChange={(value) =>
                        setParams(value === 'access' ? {} : { tab: value }, { replace: true, preventScrollReset: true })
                    }
                >
                    <TabsList className="max-w-full overflow-x-auto">
                        {PERSON_TABS.map((value) => (
                            <TabsTrigger key={value} value={value}>
                                {t(TAB_KEYS[value])}
                            </TabsTrigger>
                        ))}
                    </TabsList>
                    <TabsContent value="access" className="pt-2">
                        <AccessTab detail={detail} spaces={workspace.spaces} locked={false} run={run} />
                    </TabsContent>
                    <TabsContent value="sign-in" className="pt-2">
                        <SignInTab
                            detail={detail}
                            locked={locked}
                            run={run}
                            onPasswordLink={passwordLink}
                            onChanged={() => void load()}
                        />
                    </TabsContent>
                    <TabsContent value="owns" className="pt-2">
                        <OwnsTab
                            detail={detail}
                            version={owned}
                            onTransfer={locked ? undefined : (only) => setTransfer({ only })}
                        />
                    </TabsContent>
                    <TabsContent value="activity" className="pt-2">
                        <ActivityTab accountId={person.id} />
                    </TabsContent>
                </Tabs>
                <footer
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
                    data-slot="person-footer"
                >
                    <div className="grid min-w-0 flex-1 gap-0.5">
                        <span className="font-medium">
                            {t('settings.person:footer.title', { context: off ? 'deactivated' : undefined, first })}
                        </span>
                        <span className="text-xs text-muted-foreground">
                            {t('settings.person:footer.description', { context: off ? 'deactivated' : undefined })}
                        </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2" data-slot="person-lifecycle-actions">
                        {removable && (
                            <Button variant="ghost" className="text-destructive" onClick={() => setLifecycle('remove')}>
                                {t('settings.person:page.removePermanently')}
                            </Button>
                        )}
                        <Button
                            variant="outline"
                            className={off ? undefined : 'text-destructive'}
                            disabled={!!lock}
                            title={lock ? ownerLockTitle(lock) : undefined}
                            onClick={() => setLifecycle(off ? 'reactivate' : 'deactivate')}
                        >
                            {off ? t('settings.people:actions.reactivate') : t('settings.people:actions.deactivate')}
                        </Button>
                    </div>
                </footer>
                {link && <PasswordLinkDialog link={link} onClose={() => setLink(undefined)} />}
                {releases && <ReleasesDialog person={person} onClose={() => setReleases(false)} />}
                {demoting && (
                    <DemoteDialog
                        person={person}
                        to={demoting}
                        onClose={() => setDemoting(undefined)}
                        onConfirm={() => {
                            const to = demoting;
                            setDemoting(undefined);
                            void setRole(to);
                        }}
                    />
                )}
                {lifecycle === 'deactivate' && (
                    <DeactivateDialog
                        person={person}
                        onClose={() => setLifecycle(undefined)}
                        onTransferred={() => {
                            setOwned((n) => n + 1);
                            void load();
                        }}
                        onConfirm={async () => {
                            await run(
                                () => api(path(person.id, '/deactivate'), 'POST', {}),
                                t('settings.people:actions.deactivateFailed'),
                                t('settings.people:actions.deactivated', { name: person.name }),
                            );
                            setLifecycle(undefined);
                        }}
                    />
                )}
                {lifecycle === 'owner' && (
                    <MakeOwnerDialog
                        person={person}
                        onClose={() => setLifecycle(undefined)}
                        onDone={() => {
                            setLifecycle(undefined);
                            setIOwn(false);
                            toast.success(t('settings.person:page.nowOwner', { name: person.name }));
                            void load();
                        }}
                    />
                )}
                {lifecycle === 'remove' && (
                    <RemoveDialog
                        person={person}
                        onClose={() => setLifecycle(undefined)}
                        onTransfer={() => {
                            setLifecycle(undefined);
                            setTransfer({});
                        }}
                        onDeactivate={() => setLifecycle('deactivate')}
                        onRemoved={() => navigate(settingsPath('people'))}
                    />
                )}
                {transfer && (
                    <TransferDialog
                        person={person}
                        only={transfer.only}
                        onClose={() => setTransfer(undefined)}
                        onTransferred={() => {
                            setOwned((n) => n + 1);
                            void load();
                        }}
                    />
                )}
                {lifecycle === 'reactivate' && (
                    <ReactivateDialog
                        person={person}
                        onClose={() => setLifecycle(undefined)}
                        onConfirm={async () => {
                            await run(
                                () => api(path(person.id, '/reactivate'), 'POST', {}),
                                t('settings.people:actions.reactivateFailed'),
                                t('settings.people:actions.reactivated', { name: person.name }),
                            );
                            setLifecycle(undefined);
                        }}
                    />
                )}
            </div>
        );
    }
    return (
        <SettingsLayout group={people.group}>
            <SettingsCard>
                <section className="grid gap-4" data-slot="person-page">
                    {back}
                    {body}
                </section>
            </SettingsCard>
        </SettingsLayout>
    );
}
