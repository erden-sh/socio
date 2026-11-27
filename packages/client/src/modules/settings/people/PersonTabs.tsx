import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';

import { useTranslation } from '@socio/i18n/react';
import type { AssetKind, OwnedKind, PersonAssets } from '@socio/shared/auth';
import type { PersonDetail, PersonTrail, PersonTrailLine, PersonTrailSource } from '@socio/shared/people';
import { isAdmin } from '@socio/shared/roles';
import type { Space } from '@socio/shared/types';

import { ConfirmDelete } from '../../../components/confirm-delete';
import { nativeSelect } from '../../../components/form-fields';
import { api } from '../../../lib/api';
import { DevicesCard } from '../DevicesCard';
import { settingsPath } from '../sections';

import { PermissionBadges } from './GroupsPanel';
import { firstName, serviceAccountPath, useAssetWords, usePeopleFormat, useProviderLabel } from './people-format';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Runs a change, then loads the person again; a failure is a toast. */
export type Run = (work: () => Promise<unknown>, fallback: string, done?: string) => Promise<void>;

/** Settings → People → Groups (CB-376). */
const GROUPS_PATH = `${settingsPath('people')}?tab=groups`;

const spacePeople = (spaceId: string, userId: string) =>
    `/spaces/${encodeURIComponent(spaceId)}/people/${encodeURIComponent(userId)}`;

/** One card of a tab: a title, an optional action, its rows. */
export function PanelCard({
    title,
    action,
    slot,
    children,
}: {
    title: string;
    action?: ReactNode;
    slot: string;
    children: ReactNode;
}) {
    return (
        <section className="grid content-start gap-2 rounded-lg border p-4" data-slot={slot} aria-label={title}>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="font-medium">{title}</h4>
                {action}
            </div>
            {children}
        </section>
    );
}

/** A row of a card: what it is, its details in grey, and its controls on the right. */
function Row({ children, aside, slot }: { children: ReactNode; aside?: ReactNode; slot?: string }) {
    return (
        <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t py-2 first:border-t-0" data-slot={slot}>
            <span className="min-w-0 flex-1">{children}</span>
            {aside && <span className="flex shrink-0 items-center gap-1">{aside}</span>}
        </li>
    );
}

const Muted = ({ children }: { children: ReactNode }) => (
    <span className="text-xs text-muted-foreground">{children}</span>
);
const Empty = ({ children }: { children: ReactNode }) => <p className="text-muted-foreground">{children}</p>;

const LEVEL_KEYS = {
    editor: 'settings.person:access.levels.editor',
    member: 'settings.person:access.levels.member',
    everyone: 'settings.person:access.levels.everyone',
} as const;

/** A socio access grant's reach, as a key: `app:<id>` is an app, and so on; unknown ones as they are. */
const audienceKey = (audience: string) =>
    audience === 'gateway:model'
        ? 'settings.person:access.audiences.models'
        : audience === 'gateway:git'
          ? 'settings.person:access.audiences.git'
          : audience.startsWith('app:')
            ? 'settings.person:access.audiences.app'
            : audience.startsWith('plugin:')
              ? 'settings.person:access.audiences.plugin'
              : null;

/**
 * The Access tab (CB-360): the Spaces they read with their
 * level in each, and what acts for them (socio access, connected agents),
 * code access, Telegram and their groups (CB-376). Changes go through the existing routes: a
 * Space's people (admins edit every Space), the admin revoke of a socio's
 * access, and the admin disconnect of an agent.
 */
export function AccessTab({
    detail,
    spaces,
    locked,
    run,
}: {
    detail: PersonDetail;
    /** The workspace's Spaces, as this admin sees them: where "Add to a Space" may add them. */
    spaces: readonly Space[];
    locked: boolean;
    run: Run;
}) {
    const { t } = useTranslation(['settings.person']);
    const { shortDate } = usePeopleFormat();
    const { person, access } = detail;
    const first = firstName(person.name);
    const [adding, setAdding] = useState({ spaceId: '', role: 'member' as 'member' | 'editor' });
    const [removing, setRemoving] = useState<{ id: string; name: string }>();
    const [revoking, setRevoking] = useState<{ kind: 'socio' | 'agent'; id: string; name: string }>();
    if (!access) {
        return <Empty>{t('settings.person:access.unknown', { first })}</Empty>;
    }
    // A workspace admin edits every Space: their level there isn't a row to change.
    const adminEverywhere = isAdmin({ role: person.role });
    const off = person.status === 'deactivated';
    const editable = !adminEverywhere && !off && !locked && !!person.userId;
    const rowed = new Set(access.spaces.filter((space) => space.level !== 'everyone').map((space) => space.id));
    const addable = spaces.filter((space) => !rowed.has(space.id));
    const setLevel = (spaceId: string, role: 'member' | 'editor') =>
        run(() => api(spacePeople(spaceId, person.userId), 'PUT', { role }), t('settings.person:access.levelFailed'));
    return (
        <div className="grid gap-4 lg:grid-cols-2" data-slot="person-access">
            <PanelCard
                title={t('settings.person:access.spaces')}
                slot="person-spaces"
                action={
                    editable &&
                    addable.length > 0 && (
                        <form
                            className="flex flex-wrap items-center gap-1"
                            aria-label={t('settings.person:access.addForm')}
                            onSubmit={(e) => {
                                e.preventDefault();
                                const { spaceId, role } = adding;
                                if (spaceId) {
                                    void setLevel(spaceId, role).then(() => setAdding({ spaceId: '', role }));
                                }
                            }}
                        >
                            <select
                                data-slot="native-select"
                                aria-label={t('settings.person:access.addSelect')}
                                className={cn(nativeSelect, 'h-8 w-36')}
                                value={adding.spaceId}
                                onChange={(e) => setAdding({ ...adding, spaceId: e.target.value })}
                            >
                                <option value="">{t('settings.person:access.addPlaceholder')}</option>
                                {addable.map((space) => (
                                    <option key={space.id} value={space.id}>
                                        {space.name}
                                    </option>
                                ))}
                            </select>
                            <select
                                data-slot="native-select"
                                aria-label={t('settings.person:access.addRole')}
                                className={cn(nativeSelect, 'h-8 w-auto')}
                                value={adding.role}
                                onChange={(e) => setAdding({ ...adding, role: e.target.value as 'member' | 'editor' })}
                            >
                                <option value="member">{t(LEVEL_KEYS.member)}</option>
                                <option value="editor">{t(LEVEL_KEYS.editor)}</option>
                            </select>
                            <Button type="submit" size="sm" variant="outline" disabled={!adding.spaceId}>
                                {t('settings.person:access.add')}
                            </Button>
                        </form>
                    )
                }
            >
                {access.spaces.length ? (
                    <ul aria-label={t('settings.person:access.spaces')}>
                        {access.spaces.map((space) => (
                            <Row
                                key={space.id}
                                slot="person-space"
                                aside={
                                    editable && space.level !== 'everyone' ? (
                                        <>
                                            <select
                                                data-slot="native-select"
                                                aria-label={t('settings.person:access.roleIn', { space: space.name })}
                                                className={cn(nativeSelect, 'h-8 w-auto')}
                                                value={space.level}
                                                onChange={(e) =>
                                                    void setLevel(space.id, e.target.value as 'member' | 'editor')
                                                }
                                            >
                                                <option value="editor">{t(LEVEL_KEYS.editor)}</option>
                                                <option value="member">{t(LEVEL_KEYS.member)}</option>
                                            </select>
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                aria-label={t('settings.person:access.removeFrom', {
                                                    space: space.name,
                                                })}
                                                onClick={() => setRemoving(space)}
                                            >
                                                ×
                                            </Button>
                                        </>
                                    ) : (
                                        <Muted>{t(LEVEL_KEYS[space.level])}</Muted>
                                    )
                                }
                            >
                                {space.name}{' '}
                                <Muted>
                                    {space.membersOnly
                                        ? t('settings.person:access.private')
                                        : t('settings.person:access.everyone')}
                                </Muted>
                            </Row>
                        ))}
                    </ul>
                ) : (
                    <Empty>{t('settings.person:access.noSpaces')}</Empty>
                )}
                {adminEverywhere && <Muted>{t('settings.person:access.adminEverywhere', { first })}</Muted>}
            </PanelCard>
            <PanelCard title={t('settings.person:access.actors')} slot="person-actors">
                <ul aria-label={t('settings.person:access.actors')}>
                    {access.socioGrants.map((grant) => (
                        <Row
                            key={grant.id}
                            slot="person-socio-grant"
                            aside={
                                !locked && (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() =>
                                            setRevoking({
                                                kind: 'socio',
                                                id: grant.id,
                                                name: t('settings.person:access.grantName', {
                                                    socio: grant.socioName ?? t('settings.person:access.removedSocio'),
                                                }),
                                            })
                                        }
                                    >
                                        {t('settings.person:access.revoke')}
                                    </Button>
                                )
                            }
                        >
                            {t('settings.person:access.grant', {
                                socio: grant.socioName ?? t('settings.person:access.removedSocio'),
                                audiences:
                                    grant.audiences
                                        .map((audience) => {
                                            const key = audienceKey(audience);
                                            return key ? t(key) : audience;
                                        })
                                        .join(', ') || t('settings.person:access.grantAnything'),
                                first,
                            })}{' '}
                            <Muted>{t('settings.person:access.grantMeta', { date: shortDate(grant.expiresAt) })}</Muted>
                        </Row>
                    ))}
                    {access.connectedAgents.map((agent) => (
                        <Row
                            key={agent.grantId}
                            slot="person-agent"
                            aside={
                                !locked && (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() =>
                                            setRevoking({ kind: 'agent', id: agent.grantId, name: agent.label })
                                        }
                                    >
                                        {t('settings.person:access.disconnect')}
                                    </Button>
                                )
                            }
                        >
                            {agent.label}{' '}
                            <Muted>
                                {t('settings.person:access.agentKind', {
                                    context: agent.clientDomain ? 'domain' : undefined,
                                    domain: agent.clientDomain ?? '',
                                })}
                                {agent.scopes.length ? ` · ${agent.scopes.join(', ')}` : ''}
                            </Muted>
                        </Row>
                    ))}
                    <Row
                        slot="person-code-access"
                        aside={
                            <Badge variant={access.codeAccess ? 'default' : 'secondary'}>
                                {access.codeAccess ? t('settings.person:access.yes') : t('settings.person:access.no')}
                            </Badge>
                        }
                    >
                        {t('settings.person:access.codeAccess')}{' '}
                        <Muted>
                            {t('settings.person:access.codeAccessVia', {
                                context: adminEverywhere ? 'admin' : undefined,
                            })}
                            {' · '}
                            <Link to={GROUPS_PATH} className="underline underline-offset-2">
                                {t('settings.person:access.groupsLink')}
                            </Link>
                        </Muted>
                    </Row>
                    <Row
                        slot="person-telegram"
                        aside={
                            <Badge variant={access.telegram ? 'default' : 'secondary'}>
                                {access.telegram
                                    ? t('settings.person:access.telegramLinked')
                                    : t('settings.person:access.telegramNotLinked')}
                            </Badge>
                        }
                    >
                        {t('settings.person:access.telegram')}{' '}
                        {access.telegram && (
                            <Muted>
                                {access.telegram.username ? `@${access.telegram.username} ` : ''}
                                {t('settings.person:access.telegramSince', {
                                    date: shortDate(access.telegram.linkedAt),
                                })}
                            </Muted>
                        )}
                    </Row>
                </ul>
            </PanelCard>
            <PanelCard
                title={t('settings.person:access.groups')}
                slot="person-groups"
                action={
                    <Link to={GROUPS_PATH} className="text-xs underline underline-offset-2">
                        {t('settings.person:access.manageGroups')}
                    </Link>
                }
            >
                {detail.groups.length ? (
                    <ul aria-label={t('settings.person:access.groups')}>
                        {detail.groups.map((group) => (
                            <Row
                                key={group.id}
                                slot="person-group"
                                aside={
                                    !locked && (
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() =>
                                                void run(
                                                    () =>
                                                        api(
                                                            `/groups/${encodeURIComponent(group.id)}/members/${encodeURIComponent(person.id)}`,
                                                            'DELETE',
                                                        ),
                                                    t('settings.person:access.leaveFailed'),
                                                    t('settings.person:access.left', { first, group: group.name }),
                                                )
                                            }
                                        >
                                            {t('settings.person:access.remove')}
                                        </Button>
                                    )
                                }
                            >
                                {group.name}{' '}
                                <span className="inline-flex flex-wrap gap-1 align-middle">
                                    <PermissionBadges permissions={group.permissions} />
                                </span>
                            </Row>
                        ))}
                    </ul>
                ) : (
                    <Empty>{t('settings.person:access.noGroups')}</Empty>
                )}
            </PanelCard>
            {removing && (
                <ConfirmDelete
                    title={t('settings.person:access.removeTitle', { first, space: removing.name })}
                    action={t('settings.person:access.remove')}
                    slot="confirm-remove-space"
                    onClose={() => setRemoving(undefined)}
                    onConfirm={async () => {
                        const { id } = removing;
                        await run(
                            () => api(spacePeople(id, person.userId), 'DELETE'),
                            t('settings.person:access.removeFailed'),
                        );
                        setRemoving(undefined);
                    }}
                >
                    {t('settings.person:access.removeBody', { first })}
                </ConfirmDelete>
            )}
            {revoking && (
                <ConfirmDelete
                    title={
                        revoking.kind === 'socio'
                            ? t('settings.person:access.revokeTitle', { name: revoking.name })
                            : t('settings.person:access.disconnectTitle', { name: revoking.name })
                    }
                    action={
                        revoking.kind === 'socio'
                            ? t('settings.person:access.revoke')
                            : t('settings.person:access.disconnect')
                    }
                    slot="confirm-revoke-grant"
                    onClose={() => setRevoking(undefined)}
                    onConfirm={async () => {
                        const { kind, id } = revoking;
                        await run(
                            () =>
                                api(
                                    kind === 'socio'
                                        ? `/actors/admin/grants/${encodeURIComponent(id)}`
                                        : `/admin/agent-grants/${encodeURIComponent(id)}`,
                                    'DELETE',
                                ),
                            kind === 'socio'
                                ? t('settings.person:access.revokeFailed')
                                : t('settings.person:access.disconnectFailed'),
                        );
                        setRevoking(undefined);
                    }}
                >
                    {t('settings.person:access.revokeBody', { first })}
                </ConfirmDelete>
            )}
        </div>
    );
}

/**
 * The Sign-in & devices tab: each signed-in device, with a sign-out of
 * its own; passkeys, password, providers and the newest password link.
 */
export function SignInTab({
    detail,
    locked,
    run,
    onPasswordLink,
    onChanged,
}: {
    detail: PersonDetail;
    locked: boolean;
    run: Run;
    onPasswordLink: () => void;
    /** A device signed out from the card: the sessions above reload too. */
    onChanged?: () => void;
}) {
    const { t } = useTranslation(['settings.person']);
    const { deviceLabel, lastActive, shortDate, signInMethodLabel } = usePeopleFormat();
    const providerLabel = useProviderLabel();
    const { person, signIn } = detail;
    const off = person.status === 'deactivated';
    return (
        <div className="grid gap-4 lg:grid-cols-2" data-slot="person-sign-in">
            <PanelCard title={t('settings.person:signIn.sessions')} slot="person-sessions">
                {signIn.sessions.length ? (
                    <ul aria-label={t('settings.person:signIn.sessions')}>
                        {signIn.sessions.map((session) => {
                            const method = signInMethodLabel(session.signInMethod);
                            return (
                                <Row
                                    key={session.id}
                                    slot="person-session"
                                    aside={
                                        !locked && (
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                aria-label={t('settings.person:signIn.signOutDevice', {
                                                    device: deviceLabel(session.userAgent),
                                                })}
                                                onClick={() =>
                                                    void run(
                                                        () =>
                                                            api(
                                                                `/accounts/${encodeURIComponent(person.id)}/sessions/${encodeURIComponent(session.id)}`,
                                                                'DELETE',
                                                            ),
                                                        t('settings.person:signIn.signOutFailed'),
                                                        t('settings.person:signIn.signedOut'),
                                                    )
                                                }
                                            >
                                                {t('settings.person:signIn.signOut')}
                                            </Button>
                                        )
                                    }
                                >
                                    <span title={session.userAgent ?? undefined}>{deviceLabel(session.userAgent)}</span>{' '}
                                    <Muted>
                                        {[
                                            method && t('settings.person:signIn.by', { method }),
                                            t('settings.person:signIn.lastUsed', {
                                                ago: lastActive(Date.parse(session.renewedAt), undefined, true),
                                            }),
                                            session.ip,
                                            t('settings.person:signIn.since', { date: shortDate(session.createdAt) }),
                                        ]
                                            .filter(Boolean)
                                            .join(' · ')}
                                    </Muted>
                                </Row>
                            );
                        })}
                    </ul>
                ) : (
                    <Empty>{t('settings.person:signIn.nowhere', { context: off ? 'deactivated' : undefined })}</Empty>
                )}
            </PanelCard>
            <PanelCard title={t('settings.person:signIn.app')} slot="person-devices">
                <DevicesCard accountId={person.id} locked={locked} onChanged={onChanged} version={detail} />
            </PanelCard>
            <PanelCard title={t('settings.person:signIn.methods')} slot="person-methods">
                <ul aria-label={t('settings.person:signIn.methods')}>
                    <Row
                        slot="person-passkeys"
                        aside={<Muted>{signIn.passkeys.length || t('settings.person:signIn.none')}</Muted>}
                    >
                        {t('settings.person:signIn.passkeys')}
                        {signIn.passkeys.length > 0 && (
                            <span className="block">
                                {signIn.passkeys.map((passkey) => (
                                    <Muted key={passkey.id}>
                                        {passkey.name || t('settings.person:signIn.passkey')}
                                        {passkey.createdAt
                                            ? t('settings.person:signIn.passkeyAdded', {
                                                  date: shortDate(passkey.createdAt),
                                              })
                                            : ''}
                                        <br />
                                    </Muted>
                                ))}
                            </span>
                        )}
                    </Row>
                    <Row
                        slot="person-password"
                        aside={
                            <Muted>
                                {signIn.password ? t('settings.person:signIn.set') : t('settings.person:signIn.notSet')}
                            </Muted>
                        }
                    >
                        {t('settings.person:signIn.password')}
                    </Row>
                    <Row
                        slot="person-providers"
                        aside={
                            <Muted>
                                {signIn.providers.map(providerLabel).join(', ') || t('settings.person:signIn.none')}
                            </Muted>
                        }
                    >
                        {t('settings.person:signIn.providers')}
                    </Row>
                    <Row
                        slot="person-password-link"
                        aside={
                            !off &&
                            !locked && (
                                <Button variant="outline" size="sm" onClick={onPasswordLink}>
                                    {t('settings.person:signIn.newLink')}
                                </Button>
                            )
                        }
                    >
                        {t('settings.person:signIn.newestLink')}{' '}
                        <Muted>
                            {person.invite
                                ? person.invite.expired
                                    ? t('settings.person:dates.expired', { date: shortDate(person.invite.expiresAt) })
                                    : t('settings.person:dates.expires', { date: shortDate(person.invite.expiresAt) })
                                : t('settings.person:signIn.noLink')}
                        </Muted>
                    </Row>
                </ul>
            </PanelCard>
        </div>
    );
}

/** Where a key they made stands: live, expired or revoked. */
function useKeyStanding() {
    const { t } = useTranslation(['settings.person']);
    const { shortDate } = usePeopleFormat();
    return (key: { expiresAt: number; revokedAt: number | null }, now: number) => {
        if (key.revokedAt !== null) {
            return { live: false, label: t('settings.person:dates.revoked', { date: shortDate(key.revokedAt) }) };
        }
        return key.expiresAt > now
            ? { live: true, label: t('settings.person:dates.expires', { date: shortDate(key.expiresAt) }) }
            : { live: false, label: t('settings.person:dates.expired', { date: shortDate(key.expiresAt) }) };
    };
}

/** One kind's card on the Owns tab: its items (live first), with how many more there are. */
function OwnedCard({ kind, onTransfer }: { kind: OwnedKind; onTransfer?: (kind: AssetKind) => void }) {
    const { t } = useTranslation(['settings.person']);
    const { assetTitle, assetCount } = useAssetWords();
    const title = assetTitle(kind.kind);
    const more = kind.count - kind.items.length;
    return (
        <PanelCard
            title={title}
            slot="person-owned-kind"
            action={
                <span className="flex items-center gap-2">
                    <Muted>{assetCount(kind.kind, kind.count)}</Muted>
                    {onTransfer && (
                        <Button
                            variant="outline"
                            size="sm"
                            aria-label={t('settings.person:owns.transferKind', { kind: title })}
                            onClick={() => onTransfer(kind.kind)}
                        >
                            {t('settings.person:owns.transfer')}
                        </Button>
                    )}
                </span>
            }
        >
            <ul aria-label={title} data-kind={kind.kind}>
                {kind.items.map((item) => (
                    <Row
                        key={`${item.type}:${item.id}`}
                        slot="person-owned-item"
                        aside={
                            <Muted>
                                {item.deleted ? t('settings.person:owns.deletedKept', { type: item.type }) : item.type}
                            </Muted>
                        }
                    >
                        <span className={cn(item.deleted && 'text-muted-foreground')}>{item.name}</span>
                    </Row>
                ))}
            </ul>
            {more > 0 && <Muted>{t('settings.person:owns.more', { count: more })}</Muted>}
        </PanelCard>
    );
}

/**
 * The Owns tab (CB-360): every kind they own
 * (`GET /api/accounts/:id/assets`) with its items, each with its own
 * Transfer, and "Transfer everything"; then the service keys they made,
 * live and ended, each linking to its account on the Service accounts tab.
 * `version` changes after a transfer, to load it again.
 */
export function OwnsTab({
    detail,
    version = 0,
    onTransfer,
}: {
    detail: PersonDetail;
    version?: number;
    /** Opens the transfer dialog: all kinds, or one kind's alone. */
    onTransfer?: (only?: AssetKind[]) => void;
}) {
    const { t } = useTranslation(['settings.person']);
    const { lastActive } = usePeopleFormat();
    const { assetCount } = useAssetWords();
    const keyStanding = useKeyStanding();
    const { person, access } = detail;
    const first = firstName(person.name);
    const [assets, setAssets] = useState<PersonAssets>();
    const [error, setError] = useState<string>();
    useEffect(() => {
        if (!access) {
            return;
        }
        const controller = new AbortController();
        setError(undefined);
        api<PersonAssets>(`/accounts/${encodeURIComponent(person.id)}/assets`, 'GET', undefined, controller.signal)
            .then(setAssets)
            .catch((e: unknown) => {
                if (!controller.signal.aborted) {
                    setError(e instanceof Error ? e.message : t('settings.person:owns.loadFailed'));
                }
            });
        return () => controller.abort();
    }, [person.id, access, version, t]);
    if (!access) {
        return <Empty>{t('settings.person:owns.unknown', { first })}</Empty>;
    }
    const now = Date.now();
    const kinds = assets?.kinds.filter((kind) => kind.count > 0) ?? [];
    const transferable = !!onTransfer;
    return (
        <div className="grid gap-4" data-slot="person-owns">
            <div
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-4"
                data-slot="person-owns-summary"
            >
                <span className="min-w-0 flex-1">
                    {error ? (
                        <span className="text-destructive">{error}</span>
                    ) : !assets ? (
                        <Muted>{t('settings.person:owns.loading', { first })}</Muted>
                    ) : kinds.length ? (
                        <>
                            {t('settings.person:owns.owns', {
                                first,
                                list: kinds.map((kind) => assetCount(kind.kind, kind.count)).join(', '),
                            })}{' '}
                            <Muted>{t('settings.person:owns.companyOwns')}</Muted>
                        </>
                    ) : (
                        <Muted>{t('settings.person:owns.nothing', { first })}</Muted>
                    )}
                </span>
                {transferable && kinds.length > 0 && (
                    <Button size="sm" onClick={() => onTransfer()}>
                        {t('settings.person:owns.transferAll')}
                    </Button>
                )}
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
                {kinds.map((kind) => (
                    <OwnedCard
                        key={kind.kind}
                        kind={kind}
                        onTransfer={transferable ? (only) => onTransfer([only]) : undefined}
                    />
                ))}
                <PanelCard
                    title={t('settings.person:owns.keys', { first })}
                    slot="person-keys"
                    action={<Muted>{t('settings.person:owns.keysNote', { first })}</Muted>}
                >
                    {access.keysMade.length ? (
                        <ul aria-label={t('settings.person:owns.keysList')}>
                            {access.keysMade.map((key) => {
                                const standing = keyStanding(key, now);
                                return (
                                    <Row
                                        key={key.keyId}
                                        slot="person-key"
                                        aside={
                                            <Link
                                                to={serviceAccountPath(key.accountId)}
                                                className="text-xs underline underline-offset-2"
                                            >
                                                {key.account}
                                            </Link>
                                        }
                                    >
                                        <span className={cn(!standing.live && 'text-muted-foreground line-through')}>
                                            {key.name}
                                        </span>{' '}
                                        {/* oxlint-disable-next-line socio/no-literal-text -- the key's prefix, an identifier */}
                                        <code className="text-xs text-muted-foreground">cbk_{key.hint}…</code>{' '}
                                        <Muted>
                                            {standing.label}
                                            {standing.live &&
                                                ` · ${
                                                    key.lastUsedAt === null
                                                        ? t('settings.person:owns.neverUsed')
                                                        : t('settings.person:owns.used', {
                                                              ago: lastActive(key.lastUsedAt, undefined, true),
                                                          })
                                                }`}
                                        </Muted>
                                    </Row>
                                );
                            })}
                        </ul>
                    ) : (
                        <Empty>{t('settings.person:owns.noKeys', { first })}</Empty>
                    )}
                </PanelCard>
            </div>
        </div>
    );
}

const SOURCE_KEYS = {
    workspace: 'settings.person:activity.sources.workspace',
    access_policy: 'settings.person:activity.sources.access_policy',
    socio_access: 'settings.person:activity.sources.socio_access',
    room: 'settings.person:activity.sources.room',
} as const satisfies Record<PersonTrailSource, string>;

/**
 * The Activity tab: their audit trail, newest first, a page at a time
 * (`GET /api/accounts/:id/audit`), with "Load more" while there is more.
 */
export function ActivityTab({ accountId }: { accountId: string }) {
    const { t } = useTranslation(['settings.person']);
    const [lines, setLines] = useState<PersonTrailLine[]>();
    const [next, setNext] = useState<string | null>(null);
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState(false);
    const page = useCallback(
        async (before: string | null, signal?: AbortSignal) => {
            setBusy(true);
            try {
                const query = new URLSearchParams({ limit: '50', ...(before ? { before } : {}) });
                const trail = await api<PersonTrail>(
                    `/accounts/${encodeURIComponent(accountId)}/audit?${query}`,
                    'GET',
                    undefined,
                    signal,
                );
                setLines((current) => (before ? [...(current ?? []), ...trail.lines] : trail.lines));
                setNext(trail.next);
                setError(undefined);
            } catch (e) {
                if (!signal?.aborted) {
                    setError(e instanceof Error ? e.message : t('settings.person:activity.loadFailed'));
                }
            } finally {
                if (!signal?.aborted) {
                    setBusy(false);
                }
            }
        },
        [accountId, t],
    );
    useEffect(() => {
        const controller = new AbortController();
        setLines(undefined);
        void page(null, controller.signal);
        return () => controller.abort();
    }, [page]);
    return (
        <PanelCard title={t('settings.person:activity.title')} slot="person-activity">
            {lines === undefined ? (
                <Empty>{error ?? t('settings.person:activity.loading')}</Empty>
            ) : lines.length ? (
                <ul aria-label={t('settings.person:activity.title')}>
                    {lines.map((line) => (
                        <Row
                            key={line.id}
                            slot="person-trail-line"
                            aside={
                                <Muted>
                                    <time dateTime={new Date(line.at).toISOString()}>
                                        {t('settings.person:activity.at', { at: new Date(line.at) })}
                                    </time>
                                </Muted>
                            }
                        >
                            <span className="font-medium">{line.actorName}</span> {line.detail}{' '}
                            <Badge variant="outline" className="font-normal">
                                {line.source in SOURCE_KEYS ? t(SOURCE_KEYS[line.source]) : line.source}
                            </Badge>
                        </Row>
                    ))}
                </ul>
            ) : (
                <Empty>{t('settings.person:activity.empty')}</Empty>
            )}
            {lines !== undefined && error && <p className="text-destructive">{error}</p>}
            {lines !== undefined && next && (
                <Button variant="outline" size="sm" className="w-fit" disabled={busy} onClick={() => void page(next)}>
                    {t('settings.person:activity.more')}
                </Button>
            )}
        </PanelCard>
    );
}
