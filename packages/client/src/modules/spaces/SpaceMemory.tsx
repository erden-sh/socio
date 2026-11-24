import { Archive, BookOpen, Check, History, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';

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

const day = (value: number) => new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' });
const failure = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);
/** Who proposed a version, and where: "Mingo for Ada, in Planning". */
function Provenance({ version }: { version: SpaceMemoryView }) {
    return (
        <>
            {version.dotName
                ? `Proposed by ${version.dotName} for ${version.proposedByName}`
                : `Proposed by ${version.proposedByName}`}
            {version.chatTitle && version.threadId && (
                <>
                    {' in '}
                    <Link
                        className="underline underline-offset-2 hover:text-foreground"
                        to={`/chats/${encodeURIComponent(version.threadId)}`}
                    >
                        {version.chatTitle}
                    </Link>
                </>
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
                toast.error(failure(error, 'Could not load the Space’s memory.'));
            }
        }
    }, [base]);
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
            return failure(error, 'Could not save. Try again.');
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
        <section data-slot="space-memory" className="w-full pb-8" aria-label={`${space.name} memory`}>
            <PageHeader
                module={MODULE_IDS.spaces}
                title={spaceTitle(space)}
                actions={
                    state && (
                        <Button size="sm" onClick={() => setEditing({ kind: 'new' })}>
                            <Plus /> {editor ? 'Add entry' : 'Propose entry'}
                        </Button>
                    )
                }
            >
                Shared memory: what this Space’s socios know for everyone who can read it. Approved by its editors.
            </PageHeader>
            <SpaceTabs space={space} />
            <div className="px-4 pt-5 md:px-6">
                {missing ? (
                    <p
                        data-slot="space-memory-missing"
                        className="rounded-xl border border-dashed p-4 text-xs text-muted-foreground"
                    >
                        Space not found.
                    </p>
                ) : !state ? (
                    <p className="text-xs text-muted-foreground">Loading memory…</p>
                ) : (
                    <>
                        <p
                            data-slot="space-memory-audience"
                            className="mb-6 max-w-3xl text-xs leading-[1.7] text-muted-foreground"
                        >
                            {space.private
                                ? 'This Space is private: only its people and workspace admins read its memory.'
                                : 'Everyone in the workspace reads this Space’s memory.'}{' '}
                            Socios with this Space use matching entries in chats, and in a chat with other people only
                            when every one of them can read it.
                            {editor
                                ? ' Socios’ proposals wait for you or another editor.'
                                : ' What you propose waits for its editors.'}
                        </p>

                        {proposals.length > 0 && (
                            <section aria-labelledby="space-memory-proposals" className="mb-8">
                                <SectionTitle id="space-memory-proposals">
                                    {editor ? 'Waiting for approval' : 'Your proposals'}
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
                                                    Changes: “{textOf(proposal.supersedes) ?? 'an earlier entry'}”
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
                                                            Approve
                                                        </Button>
                                                        <Button
                                                            variant="outline"
                                                            size="sm"
                                                            className="text-xs"
                                                            onClick={() => setEditing({ kind: 'approve', proposal })}
                                                        >
                                                            Edit and approve
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
                                                            Reject
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
                                                        Withdraw
                                                    </Button>
                                                )}
                                            </div>
                                        </Card>
                                    ))}
                                </div>
                            </section>
                        )}

                        <section aria-labelledby="space-memory-entries" className="mb-8">
                            <SectionTitle id="space-memory-entries">In use</SectionTitle>
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
                                                        Version {entry.version}
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
                                                    {'Approved by '}
                                                    {entry.decidedByName ?? 'an editor'}
                                                    {entry.decidedAt && (
                                                        <>
                                                            {' · '}
                                                            <LocalTime value={entry.decidedAt} format={day} />
                                                        </>
                                                    )}
                                                </small>
                                                <IconButton
                                                    label="Entry history"
                                                    onClick={() => setEditing({ kind: 'history', entry })}
                                                >
                                                    <History className="size-4" />
                                                </IconButton>
                                                <IconButton
                                                    label={editor ? 'Edit entry' : 'Suggest a change'}
                                                    onClick={() => setEditing({ kind: 'change', entry })}
                                                >
                                                    <Pencil className="size-3.75" />
                                                </IconButton>
                                                {editor && (
                                                    <IconButton
                                                        label="Retire entry"
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
                                    Nothing yet. Propose a lasting team fact, convention or decision, like “Invoices go
                                    out on the 1st”, or ask a socio with this Space to propose one.
                                </p>
                            )}
                        </section>

                        {editor && state.retired.length > 0 && (
                            <section aria-labelledby="space-memory-retired" className="mb-8">
                                <SectionTitle id="space-memory-retired">Retired</SectionTitle>
                                <ul data-slot="space-memory-retired" className="grid gap-2 text-[13px]">
                                    {state.retired.map((entry) => (
                                        <li key={entry.id} className="flex items-start gap-2 rounded-lg border p-3">
                                            <span className="mr-auto min-w-0 whitespace-pre-wrap text-muted-foreground">
                                                {entry.text}
                                                <small className="block text-xs">
                                                    {'Retired by '}
                                                    {entry.endedByName ?? 'an editor'}
                                                    {entry.endedAt && (
                                                        <>
                                                            {' · '}
                                                            <LocalTime value={entry.endedAt} format={day} />
                                                        </>
                                                    )}
                                                </small>
                                            </span>
                                            <IconButton
                                                label="Delete retired entry"
                                                onClick={() => setEditing({ kind: 'delete', entry })}
                                            >
                                                <Trash2 className="size-3.75" />
                                            </IconButton>
                                        </li>
                                    ))}
                                </ul>
                                <p className="mt-2 text-xs text-muted-foreground">
                                    Kept {state.retentionDays} days after they are retired, with earlier versions and
                                    proposals turned down.
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
                    title="Retire this entry?"
                    slot="retire-space-memory"
                    action="Retire"
                    onClose={() => setEditing(undefined)}
                    onConfirm={async () => {
                        await act(`/memory/entries/${encodeURIComponent(editing.entry.entryId)}/retire`, 'POST');
                        setEditing(undefined);
                    }}
                >
                    Socios stop using it in every chat at once. Proposals waiting to change it are turned down. It stays
                    under Retired until it is deleted.
                </ConfirmDelete>
            )}
            {editing?.kind === 'delete' && (
                <ConfirmDelete
                    title="Delete this entry for good?"
                    slot="delete-space-memory"
                    onClose={() => setEditing(undefined)}
                    onConfirm={async () => {
                        await act(`/memory/entries/${encodeURIComponent(editing.entry.entryId)}`, 'DELETE');
                        setEditing(undefined);
                    }}
                >
                    Every version of it goes. Backups keep it until they age out.
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
    const [text, setText] = useState(
        editing.kind === 'change' ? editing.entry.text : editing.kind === 'approve' ? editing.proposal.text : '',
    );
    const { label, note, area } = memoryDialogStyles;
    const title =
        editing.kind === 'approve'
            ? 'Approve in your words.'
            : editing.kind === 'change'
              ? editor
                  ? 'Keep it accurate.'
                  : 'Suggest a change.'
              : editor
                ? 'Something the team knows.'
                : 'Propose shared knowledge.';
    return (
        <MemoryDialog title={title} slot="space-memory-editor" onClose={onClose} onSave={() => onSave(text.trim())}>
            <label className={label} htmlFor="space-memory-text">
                Entry
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
                {editor || editing.kind === 'approve'
                    ? 'It is in use as soon as you save: socios with this Space use it with everyone who can read it. The version before is kept in its history.'
                    : 'It waits for one of the Space’s editors, and is used only once they approve it.'}{' '}
                One lasting fact, convention or decision; nothing private about a person, and no secrets.
            </p>
        </MemoryDialog>
    );
}

/** An entry's versions, newest first, with who proposed and approved each. */
function EntryHistory({ path, onClose }: { path: string; onClose: () => void }) {
    const [versions, setVersions] = useState<SpaceMemoryView[]>();
    const [error, setError] = useState('');
    useEffect(() => {
        api<SpaceMemoryView[]>(path).then(setVersions, (failed: unknown) =>
            setError(failure(failed, 'Could not load its history.')),
        );
    }, [path]);
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent
                data-slot="space-memory-history"
                className="max-h-[calc(100dvh-48px)] overflow-y-auto sm:max-w-130"
            >
                <DialogTitle>Entry history</DialogTitle>
                <DialogDescription>Every version, newest first, with who proposed and approved it.</DialogDescription>
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
                                    {version.version ? `Version ${version.version}` : 'Proposal'}
                                </Badge>
                                <span>{STATUS_LABELS[version.status]}</span>
                            </div>
                            <p className="whitespace-pre-wrap">{version.text}</p>
                            <small className="mt-1 block text-xs text-muted-foreground">
                                <Provenance version={version} />
                                {version.decidedByName && version.decidedAt && (
                                    <>
                                        {version.status === 'rejected' ? ' · rejected by ' : ' · approved by '}
                                        {version.decidedByName}
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

const STATUS_LABELS: Record<SpaceMemoryView['status'], string> = {
    proposed: 'Waiting for approval',
    active: 'In use',
    superseded: 'Replaced',
    rejected: 'Rejected',
    withdrawn: 'Withdrawn',
    retired: 'Retired',
};
