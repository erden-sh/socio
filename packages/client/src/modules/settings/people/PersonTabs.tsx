import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';

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
import {
    ASSET_INFO,
    assetCount,
    deviceLabel,
    firstName,
    lastActive,
    providerLabel,
    serviceAccountPath,
    shortDate,
    signInMethodLabel,
} from './people-format';

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

const LEVEL_LABELS = { editor: 'Editor', member: 'Member', everyone: 'Everyone' } as const;

/** A socio access grant's reach in words: `app:<id>` is an app, and so on. */
const audienceLabel = (audience: string) =>
    audience === 'gateway:model'
        ? 'models'
        : audience === 'gateway:git'
          ? 'git'
          : audience.startsWith('app:')
            ? 'an app'
            : audience.startsWith('plugin:')
              ? 'a plugin'
              : audience;

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
    const { person, access } = detail;
    const first = firstName(person.name);
    const [adding, setAdding] = useState({ spaceId: '', role: 'member' as 'member' | 'editor' });
    const [removing, setRemoving] = useState<{ id: string; name: string }>();
    const [revoking, setRevoking] = useState<{ kind: 'socio' | 'agent'; id: string; name: string }>();
    if (!access) {
        return <Empty>What {first} can reach isn’t known here: the account has no workspace user yet.</Empty>;
    }
    // A workspace admin edits every Space: their level there isn't a row to change.
    const adminEverywhere = isAdmin({ role: person.role });
    const off = person.status === 'deactivated';
    const editable = !adminEverywhere && !off && !locked && !!person.userId;
    const rowed = new Set(access.spaces.filter((space) => space.level !== 'everyone').map((space) => space.id));
    const addable = spaces.filter((space) => !rowed.has(space.id));
    const setLevel = (spaceId: string, role: 'member' | 'editor') =>
        run(() => api(spacePeople(spaceId, person.userId), 'PUT', { role }), 'Could not change their role there.');
    return (
        <div className="grid gap-4 lg:grid-cols-2" data-slot="person-access">
            <PanelCard
                title="Spaces"
                slot="person-spaces"
                action={
                    editable &&
                    addable.length > 0 && (
                        <form
                            className="flex flex-wrap items-center gap-1"
                            aria-label="Add to a Space"
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
                                aria-label="Space to add them to"
                                className={cn(nativeSelect, 'h-8 w-36')}
                                value={adding.spaceId}
                                onChange={(e) => setAdding({ ...adding, spaceId: e.target.value })}
                            >
                                <option value="">Add to a Space…</option>
                                {addable.map((space) => (
                                    <option key={space.id} value={space.id}>
                                        {space.name}
                                    </option>
                                ))}
                            </select>
                            <select
                                data-slot="native-select"
                                aria-label="Role in the Space"
                                className={cn(nativeSelect, 'h-8 w-auto')}
                                value={adding.role}
                                onChange={(e) => setAdding({ ...adding, role: e.target.value as 'member' | 'editor' })}
                            >
                                <option value="member">Member</option>
                                <option value="editor">Editor</option>
                            </select>
                            <Button type="submit" size="sm" variant="outline" disabled={!adding.spaceId}>
                                Add
                            </Button>
                        </form>
                    )
                }
            >
                {access.spaces.length ? (
                    <ul aria-label="Spaces">
                        {access.spaces.map((space) => (
                            <Row
                                key={space.id}
                                slot="person-space"
                                aside={
                                    editable && space.level !== 'everyone' ? (
                                        <>
                                            <select
                                                data-slot="native-select"
                                                aria-label={`Role in ${space.name}`}
                                                className={cn(nativeSelect, 'h-8 w-auto')}
                                                value={space.level}
                                                onChange={(e) =>
                                                    void setLevel(space.id, e.target.value as 'member' | 'editor')
                                                }
                                            >
                                                <option value="editor">Editor</option>
                                                <option value="member">Member</option>
                                            </select>
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                aria-label={`Remove from ${space.name}`}
                                                onClick={() => setRemoving(space)}
                                            >
                                                ×
                                            </Button>
                                        </>
                                    ) : (
                                        <Muted>{LEVEL_LABELS[space.level]}</Muted>
                                    )
                                }
                            >
                                {space.name} <Muted>{space.membersOnly ? 'private' : 'everyone'}</Muted>
                            </Row>
                        ))}
                    </ul>
                ) : (
                    <Empty>No Spaces.</Empty>
                )}
                {adminEverywhere && <Muted>As an admin, {first} edits every Space.</Muted>}
            </PanelCard>
            <PanelCard title="Socios, agents and code" slot="person-actors">
                <ul aria-label="Socios, agents and code">
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
                                                name: `${grant.socioName ?? 'A removed socio'}’s access`,
                                            })
                                        }
                                    >
                                        Revoke
                                    </Button>
                                )
                            }
                        >
                            {grant.socioName ?? 'A removed socio'} may use{' '}
                            {grant.audiences.map(audienceLabel).join(', ') || 'what it was granted'} for {first}{' '}
                            <Muted>socio access · until {shortDate(grant.expiresAt)}</Muted>
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
                                        Disconnect
                                    </Button>
                                )
                            }
                        >
                            {agent.label}{' '}
                            <Muted>
                                connected agent{agent.clientDomain ? ` (${agent.clientDomain})` : ''}
                                {agent.scopes.length ? ` · ${agent.scopes.join(', ')}` : ''}
                            </Muted>
                        </Row>
                    ))}
                    <Row
                        slot="person-code-access"
                        aside={
                            <Badge variant={access.codeAccess ? 'default' : 'secondary'}>
                                {access.codeAccess ? 'Yes' : 'No'}
                            </Badge>
                        }
                    >
                        Code access{' '}
                        <Muted>
                            {adminEverywhere ? 'as an admin' : 'from a group that gives “Run code”'}
                            {' · '}
                            <Link to={GROUPS_PATH} className="underline underline-offset-2">
                                Groups
                            </Link>
                        </Muted>
                    </Row>
                    <Row
                        slot="person-telegram"
                        aside={
                            <Badge variant={access.telegram ? 'default' : 'secondary'}>
                                {access.telegram ? 'Linked' : 'Not linked'}
                            </Badge>
                        }
                    >
                        Telegram{' '}
                        {access.telegram && (
                            <Muted>
                                {access.telegram.username ? `@${access.telegram.username} ` : ''}(linked{' '}
                                {shortDate(access.telegram.linkedAt)})
                            </Muted>
                        )}
                    </Row>
                </ul>
            </PanelCard>
            <PanelCard
                title="Groups"
                slot="person-groups"
                action={
                    <Link to={GROUPS_PATH} className="text-xs underline underline-offset-2">
                        Manage groups
                    </Link>
                }
            >
                {detail.groups.length ? (
                    <ul aria-label="Groups">
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
                                                    'Could not take them out of the group.',
                                                    `${first} is no longer in ${group.name}`,
                                                )
                                            }
                                        >
                                            Remove
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
                    <Empty>In no group.</Empty>
                )}
            </PanelCard>
            {removing && (
                <ConfirmDelete
                    title={`Remove ${first} from ${removing.name}?`}
                    action="Remove"
                    slot="confirm-remove-space"
                    onClose={() => setRemoving(undefined)}
                    onConfirm={async () => {
                        const { id } = removing;
                        await run(() => api(spacePeople(id, person.userId), 'DELETE'), 'Could not remove them.');
                        setRemoving(undefined);
                    }}
                >
                    If it is private, {first} stops seeing it at once. What they added there stays.
                </ConfirmDelete>
            )}
            {revoking && (
                <ConfirmDelete
                    title={revoking.kind === 'socio' ? `Revoke ${revoking.name}?` : `Disconnect ${revoking.name}?`}
                    action={revoking.kind === 'socio' ? 'Revoke' : 'Disconnect'}
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
                            kind === 'socio' ? 'Could not revoke the access.' : 'Could not disconnect the agent.',
                        );
                        setRevoking(undefined);
                    }}
                >
                    It stops working for {first} at once. {first} can grant it again.
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
    const { person, signIn } = detail;
    const off = person.status === 'deactivated';
    return (
        <div className="grid gap-4 lg:grid-cols-2" data-slot="person-sign-in">
            <PanelCard title="Devices signed in" slot="person-sessions">
                {signIn.sessions.length ? (
                    <ul aria-label="Devices signed in">
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
                                                aria-label={`Sign out ${deviceLabel(session.userAgent)}`}
                                                onClick={() =>
                                                    void run(
                                                        () =>
                                                            api(
                                                                `/accounts/${encodeURIComponent(person.id)}/sessions/${encodeURIComponent(session.id)}`,
                                                                'DELETE',
                                                            ),
                                                        'Could not sign the device out.',
                                                        'Signed out on that device',
                                                    )
                                                }
                                            >
                                                Sign out
                                            </Button>
                                        )
                                    }
                                >
                                    <span title={session.userAgent ?? undefined}>{deviceLabel(session.userAgent)}</span>{' '}
                                    <Muted>
                                        {[
                                            method && `by ${method}`,
                                            `last used ${lastActive(Date.parse(session.renewedAt)).toLocaleLowerCase('en-US')}`,
                                            session.ip,
                                            `since ${shortDate(session.createdAt)}`,
                                        ]
                                            .filter(Boolean)
                                            .join(' · ')}
                                    </Muted>
                                </Row>
                            );
                        })}
                    </ul>
                ) : (
                    <Empty>{off ? 'Deactivated: signed in nowhere.' : 'Not signed in anywhere now.'}</Empty>
                )}
            </PanelCard>
            <PanelCard title="The Socio app" slot="person-devices">
                <DevicesCard accountId={person.id} locked={locked} onChanged={onChanged} version={detail} />
            </PanelCard>
            <PanelCard title="How they sign in" slot="person-methods">
                <ul aria-label="How they sign in">
                    <Row slot="person-passkeys" aside={<Muted>{signIn.passkeys.length || 'None'}</Muted>}>
                        Passkeys
                        {signIn.passkeys.length > 0 && (
                            <span className="block">
                                {signIn.passkeys.map((passkey) => (
                                    <Muted key={passkey.id}>
                                        {passkey.name || 'Passkey'}
                                        {passkey.createdAt ? `, added ${shortDate(passkey.createdAt)}` : ''}
                                        <br />
                                    </Muted>
                                ))}
                            </span>
                        )}
                    </Row>
                    <Row slot="person-password" aside={<Muted>{signIn.password ? 'Set' : 'Not set'}</Muted>}>
                        Password
                    </Row>
                    <Row
                        slot="person-providers"
                        aside={<Muted>{signIn.providers.map(providerLabel).join(', ') || 'None'}</Muted>}
                    >
                        Sign-in providers
                    </Row>
                    <Row
                        slot="person-password-link"
                        aside={
                            !off &&
                            !locked && (
                                <Button variant="outline" size="sm" onClick={onPasswordLink}>
                                    New password link
                                </Button>
                            )
                        }
                    >
                        Newest password link{' '}
                        <Muted>
                            {person.invite
                                ? person.invite.expired
                                    ? `expired ${shortDate(person.invite.expiresAt)}`
                                    : `expires ${shortDate(person.invite.expiresAt)}`
                                : 'none made'}
                        </Muted>
                    </Row>
                </ul>
            </PanelCard>
        </div>
    );
}

/** Where a key they made stands: live, expired or revoked. */
function keyStanding(key: { expiresAt: number; revokedAt: number | null }, now: number) {
    if (key.revokedAt !== null) {
        return { live: false, label: `revoked ${shortDate(key.revokedAt)}` };
    }
    return key.expiresAt > now
        ? { live: true, label: `expires ${shortDate(key.expiresAt)}` }
        : { live: false, label: `expired ${shortDate(key.expiresAt)}` };
}

/** One kind's card on the Owns tab: its items (live first), with how many more there are. */
function OwnedCard({ kind, onTransfer }: { kind: OwnedKind; onTransfer?: (kind: AssetKind) => void }) {
    const info = ASSET_INFO[kind.kind];
    const more = kind.count - kind.items.length;
    return (
        <PanelCard
            title={info.title}
            slot="person-owned-kind"
            action={
                <span className="flex items-center gap-2">
                    <Muted>{assetCount(kind.kind, kind.count)}</Muted>
                    {onTransfer && (
                        <Button
                            variant="outline"
                            size="sm"
                            aria-label={`Transfer ${info.title}`}
                            onClick={() => onTransfer(kind.kind)}
                        >
                            Transfer…
                        </Button>
                    )}
                </span>
            }
        >
            <ul aria-label={info.title} data-kind={kind.kind}>
                {kind.items.map((item) => (
                    <Row
                        key={`${item.type}:${item.id}`}
                        slot="person-owned-item"
                        aside={<Muted>{item.deleted ? `${item.type} · deleted, kept` : item.type}</Muted>}
                    >
                        <span className={cn(item.deleted && 'text-muted-foreground')}>{item.name}</span>
                    </Row>
                ))}
            </ul>
            {more > 0 && <Muted>and {more} more</Muted>}
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
                    setError(e instanceof Error ? e.message : 'Could not load what they own.');
                }
            });
        return () => controller.abort();
    }, [person.id, access, version]);
    if (!access) {
        return <Empty>What {first} owns isn’t known here: the account has no workspace user yet.</Empty>;
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
                        <Muted>Loading what {first} owns…</Muted>
                    ) : kinds.length ? (
                        <>
                            {first} owns {kinds.map((kind) => assetCount(kind.kind, kind.count)).join(', ')}.{' '}
                            <Muted>The company owns it: hand it to another active person at any time.</Muted>
                        </>
                    ) : (
                        <Muted>{first} owns nothing that can be transferred.</Muted>
                    )}
                </span>
                {transferable && kinds.length > 0 && (
                    <Button size="sm" onClick={() => onTransfer()}>
                        Transfer everything…
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
                    title={`Service keys ${first} made`}
                    slot="person-keys"
                    action={<Muted>revoked if {first} is deactivated</Muted>}
                >
                    {access.keysMade.length ? (
                        <ul aria-label="Service keys">
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
                                        <code className="text-xs text-muted-foreground">cbk_{key.hint}…</code>{' '}
                                        <Muted>
                                            {standing.label}
                                            {standing.live &&
                                                ` · ${key.lastUsedAt === null ? 'never used' : `used ${lastActive(key.lastUsedAt).toLocaleLowerCase('en-US')}`}`}
                                        </Muted>
                                    </Row>
                                );
                            })}
                        </ul>
                    ) : (
                        <Empty>{first} made no service keys.</Empty>
                    )}
                </PanelCard>
            </div>
        </div>
    );
}

const SOURCE_LABELS: Record<PersonTrailSource, string> = {
    workspace: 'Workspace',
    access_policy: 'Access',
    socio_access: 'Socio access',
    room: 'Room',
};

const timeFormat = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
});

/**
 * The Activity tab: their audit trail, newest first, a page at a time
 * (`GET /api/accounts/:id/audit`), with "Load more" while there is more.
 */
export function ActivityTab({ accountId }: { accountId: string }) {
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
                    setError(e instanceof Error ? e.message : 'Could not load the activity.');
                }
            } finally {
                if (!signal?.aborted) {
                    setBusy(false);
                }
            }
        },
        [accountId],
    );
    useEffect(() => {
        const controller = new AbortController();
        setLines(undefined);
        void page(null, controller.signal);
        return () => controller.abort();
    }, [page]);
    return (
        <PanelCard title="Activity" slot="person-activity">
            {lines === undefined ? (
                <Empty>{error ?? 'Loading…'}</Empty>
            ) : lines.length ? (
                <ul aria-label="Activity">
                    {lines.map((line) => (
                        <Row
                            key={line.id}
                            slot="person-trail-line"
                            aside={
                                <Muted>
                                    <time dateTime={new Date(line.at).toISOString()}>{timeFormat.format(line.at)}</time>
                                </Muted>
                            }
                        >
                            <span className="font-medium">{line.actorName}</span> {line.detail}{' '}
                            <Badge variant="outline" className="font-normal">
                                {SOURCE_LABELS[line.source] ?? line.source}
                            </Badge>
                        </Row>
                    ))}
                </ul>
            ) : (
                <Empty>Nothing recorded yet.</Empty>
            )}
            {lines !== undefined && error && <p className="text-destructive">{error}</p>}
            {lines !== undefined && next && (
                <Button variant="outline" size="sm" className="w-fit" disabled={busy} onClick={() => void page(next)}>
                    Load more
                </Button>
            )}
        </PanelCard>
    );
}
