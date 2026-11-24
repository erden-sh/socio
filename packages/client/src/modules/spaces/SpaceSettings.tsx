import { Trash2, UserMinus, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { MODULE_IDS } from '@socio/shared/modules';
import { isAdmin } from '@socio/shared/roles';
import { SPACE_ROLES, type SpacePeopleView, type SpaceRole } from '@socio/shared/space-memory';
import { SPACE_NAME_ERROR, SPACE_NAME_MAX } from '@socio/shared/spaces/create-input';
import type { Space } from '@socio/shared/types';

import { api } from '../../lib/api';
import { SectionTitle } from '../../shell/Home';
import { useShell } from '../../shell/shell-context';
import { PageHeader } from '../../views/WorkspacePage';

import { canDeleteSpace, DeleteSpaceDialog } from './DeleteSpaceDialog';
import { SpaceTabs, spaceTitle } from './space-tabs';
import { SpaceAudienceField } from './SpaceAudienceField';

import { ConfirmDelete } from '@/components/confirm-delete';
import { PRIVATE_SPACE_COVERS } from '@/components/private-space';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const ROLE_LABELS: Record<SpaceRole, string> = {
    editor: 'Editor',
    member: 'Member',
};

const failure = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

/**
 * `/spaces/:id/settings` (CB-181): the Space's name, who sees it and its
 * people. Editors rename it (CB-366) and choose; readers see who is in it. Those who may delete it
 * (CB-277: a private one's editors, admins any) find that last.
 */
export function SpaceSettings({ space }: { space: Space }) {
    const shell = useShell();
    const navigate = useNavigate();
    const [view, setView] = useState<SpacePeopleView>();
    const [confirming, setConfirming] = useState<boolean>();
    const [deleting, setDeleting] = useState(false);
    const base = `/spaces/${encodeURIComponent(space.id)}`;
    const load = useCallback(async () => {
        try {
            setView(await api<SpacePeopleView>(`${base}/people`));
        } catch (error) {
            toast.error(failure(error, 'Could not load the Space’s people.'));
        }
    }, [base]);
    useEffect(() => {
        void load();
    }, [load]);

    /** A change; the shell refreshes too (the sidebar's lock, the list). */
    const change = async (path: string, method: string, body?: unknown) => {
        try {
            const next = await api<SpacePeopleView | { ok: true }>(`${base}${path}`, method, body);
            await shell.refresh();
            // They left a private Space: it is gone for them.
            if (!('people' in next)) {
                navigate('/spaces', { replace: true });
            } else {
                setView(next);
            }
        } catch (error) {
            toast.error(failure(error, 'Could not save. Try again.'));
        }
    };

    const editor = view?.access === 'editor';
    const admin = isAdmin(shell.workspace.user);
    return (
        <section data-slot="space-settings" className="w-full pb-8" aria-label={`${space.name} settings`}>
            <PageHeader module={MODULE_IDS.spaces} title={spaceTitle(space)}>
                Who sees this Space, and its people.
            </PageHeader>
            <SpaceTabs space={space} />
            <div className="max-w-3xl px-4 pt-5 md:px-6">
                {!view ? (
                    <p className="text-xs text-muted-foreground">Loading…</p>
                ) : (
                    <>
                        {editor && <SpaceName space={space} onRenamed={() => shell.refresh()} />}
                        {editor ? (
                            <SpaceAudienceField
                                legend="Who can see this Space"
                                admin={admin}
                                value={view.membersOnly}
                                onChange={(next) => {
                                    if (next !== view.membersOnly) {
                                        setConfirming(next);
                                    }
                                }}
                            />
                        ) : (
                            <p
                                data-slot="space-audience-note"
                                className="mb-6 text-xs leading-[1.7] text-muted-foreground"
                            >
                                {view.membersOnly
                                    ? `Private: only its people and workspace admins see it, ${PRIVATE_SPACE_COVERS}.`
                                    : 'Everyone in the workspace sees this Space and everything in it.'}{' '}
                                Its editors choose.
                            </p>
                        )}
                        <SpacePeople view={view} onChange={change} />
                        {canDeleteSpace({ private: view.membersOnly, access: view.access }, admin) && (
                            <section
                                aria-labelledby="space-delete"
                                data-slot="space-delete"
                                className="mt-8 grid gap-2 rounded-lg border border-destructive/40 p-4"
                            >
                                <SectionTitle id="space-delete">Delete this Space</SectionTitle>
                                <p className="text-xs leading-[1.7] text-muted-foreground">
                                    It goes for everyone at once, with its pages, chats, memory, app shares and socios’
                                    access. A workspace admin can restore it.
                                </p>
                                <div>
                                    <Button
                                        type="button"
                                        variant="destructive"
                                        size="sm"
                                        onClick={() => setDeleting(true)}
                                    >
                                        <Trash2 className="size-4" aria-hidden />
                                        Delete this Space
                                    </Button>
                                </div>
                            </section>
                        )}
                    </>
                )}
            </div>
            <DeleteSpaceDialog
                space={space}
                open={deleting}
                onOpenChange={setDeleting}
                onDeleted={async () => {
                    await shell.refresh();
                    navigate('/spaces', { replace: true });
                }}
            />
            {confirming !== undefined && (
                <ConfirmDelete
                    slot="space-audience-confirm"
                    variant="default"
                    title={confirming ? 'Make this Space private?' : 'Open this Space to the whole workspace?'}
                    action={confirming ? 'Make private' : 'Open to everyone'}
                    onClose={() => setConfirming(undefined)}
                    onConfirm={async () => {
                        await change('/access', 'PUT', { membersOnly: confirming });
                        setConfirming(undefined);
                    }}
                >
                    {confirming
                        ? `From now on only its people and workspace admins see it, ${PRIVATE_SPACE_COVERS}. Everyone else stops seeing it at once, and socios use it only in chats where everyone may.`
                        : 'Everyone in the workspace will see it and everything in it.'}
                </ConfirmDelete>
            )}
        </section>
    );
}

/**
 * Renaming the Space (CB-366, its editors): only the name changes. Its
 * pages, chats and links, which name its id, stay as they are.
 */
function SpaceName({ space, onRenamed }: { space: Space; onRenamed: () => Promise<unknown> }) {
    const [name, setName] = useState(space.name);
    const [saving, setSaving] = useState(false);
    // Another tab, or a socio, renamed it: show the name in force.
    useEffect(() => setName(space.name), [space.name]);
    const next = name.trim();
    const unchanged = next === space.name;
    return (
        <form
            aria-labelledby="space-name"
            data-slot="space-name"
            className="mb-6 grid gap-2"
            onSubmit={async (event) => {
                event.preventDefault();
                if (!next) {
                    toast.error(SPACE_NAME_ERROR);
                    return;
                }
                if (unchanged) {
                    return;
                }
                setSaving(true);
                try {
                    await api<Space>(`/spaces/${encodeURIComponent(space.id)}`, 'PATCH', { name: next });
                    await onRenamed();
                    toast.success('Space renamed.');
                } catch (error) {
                    toast.error(failure(error, 'Could not rename the Space. Try again.'));
                } finally {
                    setSaving(false);
                }
            }}
        >
            <SectionTitle id="space-name">Name</SectionTitle>
            <p className="text-xs leading-[1.7] text-muted-foreground">
                Renaming keeps its pages, chats and links as they are.
            </p>
            <div className="flex flex-wrap items-center gap-2">
                <Input
                    aria-label="Space name"
                    className="min-w-44 flex-1 sm:max-w-sm"
                    value={name}
                    maxLength={SPACE_NAME_MAX}
                    required
                    disabled={saving}
                    onChange={(event) => setName(event.target.value)}
                />
                <Button type="submit" size="sm" variant="outline" disabled={saving || !next || unchanged}>
                    Rename
                </Button>
            </div>
        </form>
    );
}

/** The Space's people and their roles. Editors add, change and remove. */
function SpacePeople({
    view,
    onChange,
}: {
    view: SpacePeopleView;
    onChange: (path: string, method: string, body?: unknown) => Promise<void>;
}) {
    const editor = view.access === 'editor';
    const [adding, setAdding] = useState('');
    const [role, setRole] = useState<SpaceRole>('member');
    return (
        <section aria-labelledby="space-people" data-slot="space-people">
            <SectionTitle id="space-people">People</SectionTitle>
            <p className="mb-3 text-xs leading-[1.7] text-muted-foreground">
                Editors manage its people and who sees it, and approve its memory; members read it and propose.
                Workspace admins are editors of every Space.
            </p>
            {view.people.length ? (
                <ul className="grid gap-2">
                    {view.people.map((person) => (
                        <li
                            key={person.userId}
                            className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-[13px]"
                        >
                            <Users className="size-4 text-slate-400" aria-hidden />
                            <span className="mr-auto min-w-0 break-words">{person.name}</span>
                            {editor ? (
                                <>
                                    <Select
                                        value={person.role}
                                        onValueChange={(value) =>
                                            void onChange(`/people/${encodeURIComponent(person.userId)}`, 'PUT', {
                                                role: value,
                                            })
                                        }
                                    >
                                        <SelectTrigger size="sm" aria-label={`${person.name}’s role`} className="w-28">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {SPACE_ROLES.map((value) => (
                                                <SelectItem key={value} value={value}>
                                                    {ROLE_LABELS[value]}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                    <Button
                                        type="button"
                                        size="icon"
                                        variant="ghost"
                                        className="size-8 pointer-coarse:size-11"
                                        aria-label={`Remove ${person.name}`}
                                        title={`Remove ${person.name}`}
                                        onClick={() =>
                                            void onChange(`/people/${encodeURIComponent(person.userId)}`, 'DELETE')
                                        }
                                    >
                                        <UserMinus className="size-4" />
                                    </Button>
                                </>
                            ) : (
                                <Badge variant="secondary">{ROLE_LABELS[person.role]}</Badge>
                            )}
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="text-xs text-muted-foreground">No one added yet: workspace admins manage it.</p>
            )}
            {editor && view.candidates.length > 0 && (
                <form
                    className="mt-3 flex flex-wrap items-center gap-2"
                    aria-label="Add a person"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (!adding) {
                            return;
                        }
                        void onChange(`/people/${encodeURIComponent(adding)}`, 'PUT', {
                            role,
                        }).then(() => setAdding(''));
                    }}
                >
                    <Select value={adding} onValueChange={setAdding}>
                        <SelectTrigger size="sm" aria-label="Person to add" className="min-w-44 flex-1 sm:flex-none">
                            <SelectValue placeholder="Choose a person" />
                        </SelectTrigger>
                        <SelectContent>
                            {view.candidates.map((candidate) => (
                                <SelectItem key={candidate.id} value={candidate.id}>
                                    {candidate.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Select value={role} onValueChange={(value) => setRole(value as SpaceRole)}>
                        <SelectTrigger size="sm" aria-label="Role" className="w-28">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {SPACE_ROLES.map((value) => (
                                <SelectItem key={value} value={value}>
                                    {ROLE_LABELS[value]}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Button size="sm" variant="outline" disabled={!adding}>
                        Add
                    </Button>
                </form>
            )}
        </section>
    );
}
