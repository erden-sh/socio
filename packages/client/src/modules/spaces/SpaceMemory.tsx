import { Archive, BookOpen, Check, History, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';

import { Trans, useTranslation } from '@socio/i18n/react';
import { dateTimeFormat } from '@socio/shared/locale';
import { MODULE_IDS } from '@socio/shared/modules';
import { SPACE_MEMORY_TEXT_MAX, type SpaceMemoryState, type SpaceMemoryView } from '@socio/shared/space-memory';
import type { Space } from '@socio/shared/types';

import { api } from '../../lib/api';
import { LocalTime } from '../../lib/local-time';
import { SectionTitle } from '../../shell/Home';
import { PageHeader } from '../../views/WorkspacePage';
import { MemoryDialog, memoryDialogStyles } from '../memories/MemoryDialogs';

import { SpaceTabs, spaceTitle } from './space-tabs';

import { ConfirmDelete } from '@/components/confirm-delete';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

const mediumDate = dateTimeFormat({ dateStyle: 'medium' });
const day = (value: number) => mediumDate.format(value);
const failure = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);
/** Who proposed a version, and where: "Mingo for Ada, in Planning". */
function Provenance({ version }: { version: SpaceMemoryView }) {
    const { t } = useTranslation(['spaces.memory']);
    const context = version.dotName ? 'socio' : undefined;
    const names = { socio: version.dotName ?? '', person: version.proposedByName };
    return (
        <>
            {version.chatTitle && version.threadId ? (
                <Trans
                    t={t}
                    i18nKey="spaces.memory:provenance.proposed-in"
                    context={context}
                    values={{ ...names, chat: version.chatTitle }}
                    components={{
                        chat: (
                            <Link
                                className="underline underline-offset-2 hover:text-foreground"
                                to={`/chats/${encodeURIComponent(version.threadId)}`}
                            />
                        ),
                    }}
                />
            ) : (
                t('spaces.memory:provenance.proposed', { context, ...names })
            )}
            {' · '}
            <LocalTime value={version.createdAt} format={day} />
        </>
    );
}

type Editing =
    | { kind: 'new' }
    | { kind: 'change'; entry: SpaceMemoryView }
    | { kind: 'approve'; proposal: SpaceMemoryView }
    | { kind: 'retire'; entry: SpaceMemoryView }
    | { kind: 'delete'; entry: SpaceMemoryView }
    | { kind: 'history'; entry: SpaceMemoryView };

/**
 * `/spaces/:id/memory` (CB-181): the Space's shared memory. Its entries in
 * use, the proposals waiting (all of them for its editors, a reader's own
 * otherwise) with approve and reject, retired entries (editors), each
 * entry's history. Its people, who read and approve it, and who sees
 * the Space are under Settings (`SpaceSettings`).
 */
export function SpaceMemory({ space }: { space: Space }) {
    const { t } = useTranslation(['spaces.memory']);
    const [state, setState] = useState<SpaceMemoryState>();
    const [missing, setMissing] = useState(false);
    const [editing, setEditing] = useState<Editing>();
    const base = `/spaces/${encodeURIComponent(space.id)}`;
    const load = useCallback(async () => {
        try {
            setState(await api<SpaceMemoryState>(`${base}/memory`));
            setMissing(false);
        } catch (error) {
            if ((error as { status?: number }).status === 404) {
                setMissing(true);
            } else {
                toast.error(failure(error, t('spaces.memory:load-failed')));
            }
        }
    }, [base, t]);
    useEffect(() => {
        void load();
        // Proposals arrive from socios' chats: a poll finds them.
        const timer = setInterval(() => void load(), 15_000);
        return () => clearInterval(timer);
    }, [load]);

    /** Runs a change, then reloads; resolves to an error to show, if any. */
    const write = async (path: string, method: string, body: unknown = {}) => {
        try {
            await api(`${base}${path}`, method, body);
            await load();
            return undefined;
        } catch (error) {
            return failure(error, t('spaces.memory:save-failed'));
        }
    };
    const act = async (path: string, method: string, body?: unknown) => {
        const failed = await write(path, method, body);
        if (failed) {
            toast.error(failed);
        }
    };

    const editor = state?.access === 'editor';
    const entries = state?.entries ?? [];
    const proposals = state?.proposals ?? [];
    const textOf = (versionId: string | null) => entries.find((entry) => entry.id === versionId)?.text;

    return (
        <section
            data-slot="space-memory"
            className="w-full pb-8"
            aria-label={t('spaces.memory:label', { space: space.name })}
        >
            <PageHeader
                module={MODULE_IDS.spaces}
                title={spaceTitle(space)}
                actions={
                    state && (
                        <Button size="sm" onClick={() => setEditing({ kind: 'new' })}>
                            <Plus /> {editor ? t('spaces.memory:add') : t('spaces.memory:propose')}
                        </Button>
                    )
                }
            >
                {t('spaces.memory:description')}
            </PageHeader>
            <SpaceTabs space={space} />
            <div className="px-4 pt-5 md:px-6">
                {missing ? (
                    <p
                        data-slot="space-memory-missing"
                        className="rounded-xl border border-dashed p-4 text-xs text-muted-foreground"
                    >
                        {t('spaces.memory:missing')}
                    </p>
                ) : !state ? (
                    <p className="text-xs text-muted-foreground">{t('spaces.memory:loading')}</p>
                ) : (
                    <>
                        <p
                            data-slot="space-memory-audience"
                            className="mb-6 max-w-3xl text-xs leading-[1.7] text-muted-foreground"
                        >
                            {t('spaces.memory:audience.who', { context: space.private ? 'private' : undefined })}{' '}
                            {t('spaces.memory:audience.use')}{' '}
                            {t('spaces.memory:audience.waits', { context: editor ? 'editor' : undefined })}
                        </p>

                        {proposals.length > 0 && (
                            <section aria-labelledby="space-memory-proposals" className="mb-8">
                                <SectionTitle id="space-memory-proposals">
                                    {t('spaces.memory:proposals.title', { context: editor ? 'editor' : undefined })}
                                </SectionTitle>
                                <div
                                    data-slot="space-memory-proposals"
                                    className="grid grid-cols-2 gap-4 max-[920px]:grid-cols-1"
                                >
                                    {proposals.map((proposal) => (
                                        <Card
                                            role="article"
                                            key={proposal.id}
                                            data-proposal={proposal.id}
                                            className="gap-0 rounded-xl border-dashed p-5.5 shadow-none"
                                        >
                                            <Sparkles size={18} className="text-slate-400" />
                                            {proposal.supersedes && (
                                                <p className="mt-4 text-xs leading-[1.6] text-muted-foreground">
                                                    {t('spaces.memory:proposals.changes', {
                                                        context:
                                                            textOf(proposal.supersedes) === undefined
                                                                ? 'unknown'
                                                                : undefined,
                                                        text: textOf(proposal.supersedes) ?? '',
                                                    })}
                                                </p>
                                            )}
                                            <p className="mt-4 mb-2 text-[13px] leading-[1.7] whitespace-pre-wrap">
                                                {proposal.text}
                                            </p>
                                            <small className="mb-4.5 text-xs leading-[1.6] text-muted-foreground">
                                                <Provenance version={proposal} />
                                            </small>
                                            <div className="flex flex-wrap items-center gap-1.5">
                                                {editor && (
                                                    <>
                                                        <Button
                                                            size="sm"
                                                            className="text-xs"
                                                            onClick={() =>
                                                                void act(
                                                                    `/memory/proposals/${encodeURIComponent(proposal.id)}/approve`,
                                                                    'POST',
                                                                )
                                                            }
                                                        >
                                                            <Check className="size-3.5" />
                                                            {t('spaces.memory:proposals.approve')}
                                                        </Button>
                                                        <Button
                                                            variant="outline"
                                                            size="sm"
                                                            className="text-xs"
                                                            onClick={() => setEditing({ kind: 'approve', proposal })}
                                                        >
                                                            {t('spaces.memory:proposals.edit-approve')}
                                                        </Button>
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            className="text-xs text-muted-foreground"
                                                            onClick={() =>
                                                                void act(
                                                                    `/memory/proposals/${encodeURIComponent(proposal.id)}/reject`,
                                                                    'POST',
                                                                )
                                                            }
                                                        >
                                                            {t('spaces.memory:proposals.reject')}
                                                        </Button>
                                                    </>
                                                )}
                                                {!editor && (
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="text-xs text-muted-foreground"
                                                        onClick={() =>
                                                            void act(
                                                                `/memory/proposals/${encodeURIComponent(proposal.id)}/withdraw`,
                                                                'POST',
                                                            )
                                                        }
                                                    >
                                                        {t('spaces.memory:proposals.withdraw')}
                                                    </Button>
                                                )}
                                            </div>
                                        </Card>
                                    ))}
                                </div>
                            </section>
                        )}

                        <section aria-labelledby="space-memory-entries" className="mb-8">
                            <SectionTitle id="space-memory-entries">{t('spaces.memory:entries.title')}</SectionTitle>
                            {entries.length ? (
                                <div
                                    data-slot="space-memory-entries"
                                    className="grid grid-cols-2 gap-4 max-[920px]:grid-cols-1"
                                >
                                    {entries.map((entry) => (
                                        <Card
                                            role="article"
                                            key={entry.id}
                                            data-entry={entry.entryId}
                                            className="gap-0 rounded-xl p-5.5 shadow-none"
                                        >
                                            <div className="flex h-4.5 items-center justify-between gap-2">
                                                <BookOpen size={18} className="text-slate-400" />
                                                {(entry.version ?? 1) > 1 && (
                                                    <Badge variant="secondary" className="py-0 leading-5">
                                                        {t('spaces.memory:entries.version', {
                                                            version: entry.version ?? 1,
                                                        })}
                                                    </Badge>
                                                )}
                                            </div>
                                            <p className="mt-4 mb-2 text-[13px] leading-[1.7] whitespace-pre-wrap">
                                                {entry.text}
                                            </p>
                                            <small className="mb-1 text-xs leading-[1.6] text-muted-foreground">
                                                <Provenance version={entry} />
                                            </small>
                                            <div className="flex flex-wrap items-center gap-0.75">
                                                <small className="mr-auto text-xs text-muted-foreground">
                                                    {t('spaces.memory:entries.approved-by', {
                                                        context: entry.decidedByName ? undefined : 'unknown',
                                                        name: entry.decidedByName ?? '',
                                                    })}
                                                    {entry.decidedAt && (
                                                        <>
                                                            {' · '}
                                                            <LocalTime value={entry.decidedAt} format={day} />
                                                        </>
                                                    )}
                                                </small>
                                                <IconButton
                                                    label={t('spaces.memory:entries.history')}
                                                    onClick={() => setEditing({ kind: 'history', entry })}
                                                >
                                                    <History className="size-4" />
                                                </IconButton>
                                                <IconButton
                                                    label={t('spaces.memory:entries.edit', {
                                                        context: editor ? 'editor' : undefined,
                                                    })}
                                                    onClick={() => setEditing({ kind: 'change', entry })}
                                                >
                                                    <Pencil className="size-3.75" />
                                                </IconButton>
                                                {editor && (
                                                    <IconButton
                                                        label={t('spaces.memory:entries.retire')}
                                                        onClick={() => setEditing({ kind: 'retire', entry })}
                                                    >
                                                        <Archive className="size-3.75" />
                                                    </IconButton>
                                                )}
                                            </div>
                                        </Card>
                                    ))}
                                </div>
                            ) : (
                                <p
                                    data-slot="space-memory-empty"
                                    className="max-w-3xl text-xs leading-[1.8] text-muted-foreground"
                                >
                                    {t('spaces.memory:entries.empty')}
                                </p>
                            )}
                        </section>

                        {editor && state.retired.length > 0 && (
                            <section aria-labelledby="space-memory-retired" className="mb-8">
                                <SectionTitle id="space-memory-retired">
                                    {t('spaces.memory:retired.title')}
                                </SectionTitle>
                                <ul data-slot="space-memory-retired" className="grid gap-2 text-[13px]">
                                    {state.retired.map((entry) => (
                                        <li key={entry.id} className="flex items-start gap-2 rounded-lg border p-3">
                                            <span className="mr-auto min-w-0 whitespace-pre-wrap text-muted-foreground">
                                                {entry.text}
                                                <small className="block text-xs">
                                                    {t('spaces.memory:retired.by', {
                                                        context: entry.endedByName ? undefined : 'unknown',
                                                        name: entry.endedByName ?? '',
                                                    })}
                                                    {entry.endedAt && (
                                                        <>
                                                            {' · '}
                                                            <LocalTime value={entry.endedAt} format={day} />
                                                        </>
                                                    )}
                                                </small>
                                            </span>
                                            <IconButton
                                                label={t('spaces.memory:retired.delete')}
                                                onClick={() => setEditing({ kind: 'delete', entry })}
                                            >
                                                <Trash2 className="size-3.75" />
                                            </IconButton>
                                        </li>
                                    ))}
                                </ul>
                                <p className="mt-2 text-xs text-muted-foreground">
                                    {t('spaces.memory:retired.kept', { count: state.retentionDays })}
                                </p>
                            </section>
                        )}
                    </>
                )}
            </div>

            {(editing?.kind === 'new' || editing?.kind === 'change' || editing?.kind === 'approve') && (
                <EntryEditor
                    editing={editing}
                    editor={editor}
                    onClose={() => setEditing(undefined)}
                    onSave={(text) =>
                        editing.kind === 'new'
                            ? write('/memory', 'POST', { text })
                            : editing.kind === 'change'
                              ? write(`/memory/entries/${encodeURIComponent(editing.entry.entryId)}`, 'PUT', { text })
                              : write(`/memory/proposals/${encodeURIComponent(editing.proposal.id)}/approve`, 'POST', {
                                    text,
                                })
                    }
                />
            )}
            {editing?.kind === 'retire' && (
                <ConfirmDelete
                    title={t('spaces.memory:retire-confirm.title')}
                    slot="retire-space-memory"
                    action={t('spaces.memory:retire-confirm.action')}
                    onClose={() => setEditing(undefined)}
                    onConfirm={async () => {
                        await act(`/memory/entries/${encodeURIComponent(editing.entry.entryId)}/retire`, 'POST');
                        setEditing(undefined);
                    }}
                >
                    {t('spaces.memory:retire-confirm.body')}
                </ConfirmDelete>
            )}
            {editing?.kind === 'delete' && (
                <ConfirmDelete
                    title={t('spaces.memory:delete-confirm.title')}
                    slot="delete-space-memory"
                    onClose={() => setEditing(undefined)}
                    onConfirm={async () => {
                        await act(`/memory/entries/${encodeURIComponent(editing.entry.entryId)}`, 'DELETE');
                        setEditing(undefined);
                    }}
                >
                    {t('spaces.memory:delete-confirm.body')}
                </ConfirmDelete>
            )}
            {editing?.kind === 'history' && (
                <EntryHistory
                    path={`${base}/memory/entries/${encodeURIComponent(editing.entry.entryId)}/history`}
                    onClose={() => setEditing(undefined)}
                />
            )}
        </section>
    );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
    return (
        <Button
            variant="ghost"
            size="icon-sm"
            className="size-7.25 text-muted-foreground pointer-coarse:size-10"
            aria-label={label}
            title={label}
            onClick={onClick}
        >
            {children}
        </Button>
    );
}

/** Proposes, adds, changes, or edits a proposal before approving it. */
function EntryEditor({
    editing,
    editor,
    onClose,
    onSave,
}: {
    editing: Extract<Editing, { kind: 'new' | 'change' | 'approve' }>;
    editor: boolean;
    onClose: () => void;
    onSave: (text: string) => Promise<string | undefined>;
}) {
    const { t } = useTranslation(['spaces.memory']);
    const [text, setText] = useState(
        editing.kind === 'change' ? editing.entry.text : editing.kind === 'approve' ? editing.proposal.text : '',
    );
    const { label, note, area } = memoryDialogStyles;
    const context = editor ? 'editor' : undefined;
    const title =
        editing.kind === 'approve'
            ? t('spaces.memory:editor.title-approve')
            : editing.kind === 'change'
              ? t('spaces.memory:editor.title-change', { context })
              : t('spaces.memory:editor.title-new', { context });
    return (
        <MemoryDialog title={title} slot="space-memory-editor" onClose={onClose} onSave={() => onSave(text.trim())}>
            <label className={label} htmlFor="space-memory-text">
                {t('spaces.memory:editor.label')}
            </label>
            <Textarea
                id="space-memory-text"
                className={area}
                rows={4}
                maxLength={SPACE_MEMORY_TEXT_MAX}
                required
                value={text}
                onChange={(event) => setText(event.target.value)}
            />
            <p className={cn(note, 'mt-2')}>
                {t('spaces.memory:editor.note', { context: editor || editing.kind === 'approve' ? 'now' : undefined })}{' '}
                {t('spaces.memory:editor.rule')}
            </p>
        </MemoryDialog>
    );
}

/** An entry's versions, newest first, with who proposed and approved each. */
function EntryHistory({ path, onClose }: { path: string; onClose: () => void }) {
    const { t } = useTranslation(['spaces.memory']);
    const [versions, setVersions] = useState<SpaceMemoryView[]>();
    const [error, setError] = useState('');
    useEffect(() => {
        api<SpaceMemoryView[]>(path).then(setVersions, (failed: unknown) =>
            setError(failure(failed, t('spaces.memory:history.load-failed'))),
        );
    }, [path, t]);
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent
                data-slot="space-memory-history"
                className="max-h-[calc(100dvh-48px)] overflow-y-auto sm:max-w-130"
            >
                <DialogTitle>{t('spaces.memory:history.title')}</DialogTitle>
                <DialogDescription>{t('spaces.memory:history.description')}</DialogDescription>
                {error && (
                    <p role="alert" className="text-xs text-destructive">
                        {error}
                    </p>
                )}
                <ol className="grid gap-3">
                    {(versions ?? []).map((version) => (
                        <li key={version.id} className="rounded-lg border p-3 text-[13px]">
                            <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                <Badge variant="secondary" className="py-0 leading-5">
                                    {version.version
                                        ? t('spaces.memory:history.version', { version: version.version })
                                        : t('spaces.memory:history.proposal')}
                                </Badge>
                                <span>{t(STATUS_KEYS[version.status])}</span>
                            </div>
                            <p className="whitespace-pre-wrap">{version.text}</p>
                            <small className="mt-1 block text-xs text-muted-foreground">
                                <Provenance version={version} />
                                {version.decidedByName && version.decidedAt && (
                                    <>
                                        {' · '}
                                        {t('spaces.memory:history.decided', {
                                            context: version.status === 'rejected' ? 'rejected' : undefined,
                                            name: version.decidedByName,
                                        })}
                                    </>
                                )}
                            </small>
                        </li>
                    ))}
                </ol>
            </DialogContent>
        </Dialog>
    );
}

const STATUS_KEYS = {
    proposed: 'spaces.memory:status.proposed',
    active: 'spaces.memory:status.active',
    superseded: 'spaces.memory:status.superseded',
    rejected: 'spaces.memory:status.rejected',
    withdrawn: 'spaces.memory:status.withdrawn',
    retired: 'spaces.memory:status.retired',
} as const satisfies Record<SpaceMemoryView['status'], string>;
