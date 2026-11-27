import { Trash2, UserMinus, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const ROLE_KEYS = {
    editor: 'spaces.settings:roles.editor',
    member: 'spaces.settings:roles.member',
} as const satisfies Record<SpaceRole, string>;

const failure = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

/**
 * `/spaces/:id/settings` (CB-181): the Space's name, who sees it and its
 * people. Editors rename it (CB-366) and choose; readers see who is in it. Those who may delete it
 * (CB-277: a private one's editors, admins any) find that last.
 */
export function SpaceSettings({ space }: { space: Space }) {
    const { t } = useTranslation(['spaces.settings']);
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
            toast.error(failure(error, t('spaces.settings:people.load-failed')));
        }
    }, [base, t]);
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
            toast.error(failure(error, t('spaces.settings:people.save-failed')));
        }
    };

    const editor = view?.access === 'editor';
    const admin = isAdmin(shell.workspace.user);
    return (
        <section
            data-slot="space-settings"
            className="w-full pb-8"
            aria-label={t('spaces.settings:label', { space: space.name })}
        >
            <PageHeader module={MODULE_IDS.spaces} title={spaceTitle(space)}>
                {t('spaces.settings:description')}
            </PageHeader>
            <SpaceTabs space={space} />
            <div className="max-w-3xl px-4 pt-5 md:px-6">
                {!view ? (
                    <p className="text-xs text-muted-foreground">{t('spaces.settings:loading')}</p>
                ) : (
                    <>
                        {editor && <SpaceName space={space} onRenamed={() => shell.refresh()} />}
                        {editor ? (
                            <SpaceAudienceField
                                legend={t('spaces.settings:audience-legend')}
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
                                {t('spaces.settings:audience-note', {
                                    context: view.membersOnly ? 'private' : undefined,
                                })}
                            </p>
                        )}
                        <SpacePeople view={view} onChange={change} />
                        {canDeleteSpace({ private: view.membersOnly, access: view.access }, admin) && (
                            <section
                                aria-labelledby="space-delete"
                                data-slot="space-delete"
                                className="mt-8 grid gap-2 rounded-lg border border-destructive/40 p-4"
                            >
                                <SectionTitle id="space-delete">{t('spaces.settings:delete.title')}</SectionTitle>
                                <p className="text-xs leading-[1.7] text-muted-foreground">
                                    {t('spaces.settings:delete.body')}
                                </p>
                                <div>
                                    <Button
                                        type="button"
                                        variant="destructive"
                                        size="sm"
                                        onClick={() => setDeleting(true)}
                                    >
                                        <Trash2 className="size-4" aria-hidden />
                                        {t('spaces.settings:delete.action')}
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
                    title={t('spaces.settings:confirm.title', { context: confirming ? 'private' : undefined })}
                    action={t('spaces.settings:confirm.action', { context: confirming ? 'private' : undefined })}
                    onClose={() => setConfirming(undefined)}
                    onConfirm={async () => {
                        await change('/access', 'PUT', { membersOnly: confirming });
                        setConfirming(undefined);
                    }}
                >
                    {t('spaces.settings:confirm.body', { context: confirming ? 'private' : undefined })}
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
    const { t } = useTranslation(['spaces.settings']);
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
                    toast.success(t('spaces.settings:name.renamed'));
                } catch (error) {
                    toast.error(failure(error, t('spaces.settings:name.failed')));
                } finally {
                    setSaving(false);
                }
            }}
        >
            <SectionTitle id="space-name">{t('spaces.settings:name.title')}</SectionTitle>
            <p className="text-xs leading-[1.7] text-muted-foreground">{t('spaces.settings:name.hint')}</p>
            <div className="flex flex-wrap items-center gap-2">
                <Input
                    aria-label={t('spaces.settings:name.label')}
                    className="min-w-44 flex-1 sm:max-w-sm"
                    value={name}
                    maxLength={SPACE_NAME_MAX}
                    required
                    disabled={saving}
                    onChange={(event) => setName(event.target.value)}
                />
                <Button type="submit" size="sm" variant="outline" disabled={saving || !next || unchanged}>
                    {t('spaces.settings:name.rename')}
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
    const { t } = useTranslation(['spaces.settings']);
    const editor = view.access === 'editor';
    const [adding, setAdding] = useState('');
    const [role, setRole] = useState<SpaceRole>('member');
    return (
        <section aria-labelledby="space-people" data-slot="space-people">
            <SectionTitle id="space-people">{t('spaces.settings:people.title')}</SectionTitle>
            <p className="mb-3 text-xs leading-[1.7] text-muted-foreground">{t('spaces.settings:people.hint')}</p>
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
                                        <SelectTrigger
                                            size="sm"
                                            aria-label={t('spaces.settings:people.role-of', { name: person.name })}
                                            className="w-28"
                                        >
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {SPACE_ROLES.map((value) => (
                                                <SelectItem key={value} value={value}>
                                                    {t(ROLE_KEYS[value])}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                    <Button
                                        type="button"
                                        size="icon"
                                        variant="ghost"
                                        className="size-8 pointer-coarse:size-11"
                                        aria-label={t('spaces.settings:people.remove', { name: person.name })}
                                        title={t('spaces.settings:people.remove', { name: person.name })}
                                        onClick={() =>
                                            void onChange(`/people/${encodeURIComponent(person.userId)}`, 'DELETE')
                                        }
                                    >
                                        <UserMinus className="size-4" />
                                    </Button>
                                </>
                            ) : (
                                <Badge variant="secondary">{t(ROLE_KEYS[person.role])}</Badge>
                            )}
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="text-xs text-muted-foreground">{t('spaces.settings:people.none')}</p>
            )}
            {editor && view.candidates.length > 0 && (
                <form
                    className="mt-3 flex flex-wrap items-center gap-2"
                    aria-label={t('spaces.settings:people.add-form')}
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
                        <SelectTrigger
                            size="sm"
                            aria-label={t('spaces.settings:people.person-to-add')}
                            className="min-w-44 flex-1 sm:flex-none"
                        >
                            <SelectValue placeholder={t('spaces.settings:people.choose')} />
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
                        <SelectTrigger size="sm" aria-label={t('spaces.settings:people.role')} className="w-28">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {SPACE_ROLES.map((value) => (
                                <SelectItem key={value} value={value}>
                                    {t(ROLE_KEYS[value])}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Button size="sm" variant="outline" disabled={!adding}>
                        {t('spaces.settings:people.add')}
                    </Button>
                </form>
            )}
        </section>
    );
}
