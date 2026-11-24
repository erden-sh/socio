import { History, Pencil, RotateCcw, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';

import {
    PERSONA_FIELDS,
    SOUL_FIELDS,
    SOUL_FIELD_MAX,
    SOUL_HINTS,
    SOUL_LABELS,
    soulFields,
    soulProblem,
    soulPrompt,
    textDiff,
    type SoulFields,
    type SoulVersion,
    type SoulView,
} from '@socio/shared/soul';

import { api, ApiError } from '../../lib/api';
import { LocalTime } from '../../lib/local-time';
import { SectionTitle } from '../../shell/Home';
import { useShell } from '../../shell/shell-context';
import { NotFound } from '../../views/NotFound';
import { WorkspacePage } from '../../views/WorkspacePage';
import { relative } from '../activity/TaskPresentation';

import { dotPath } from './nav';

import { ConfirmDelete } from '@/components/confirm-delete';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';

const failure = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);
const soulPath = (id: string) => `/dots/${encodeURIComponent(id)}/soul`;

/** How a version came to be, in a line. */
function origin(version: SoulVersion, name: (id: string) => string) {
    switch (version.source) {
        case 'migrated':
            return 'From its role instructions, at the upgrade to Soul';
        case 'created':
            return `Made by ${name(version.createdBy)}`;
        case 'restored':
            return `${name(version.createdBy)} restored version ${version.restoredFrom ?? '?'}`;
        default:
            return `Edited by ${name(version.createdBy)}`;
    }
}

/** A Soul's parts, the empty ones left out (instructions always shown). */
function SoulParts({ soul }: { soul: SoulFields }) {
    return (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-3 text-[13px] leading-[1.6] max-[700px]:grid-cols-1 max-[700px]:gap-y-1">
            {SOUL_FIELDS.filter((field) => field === 'instructions' || soul[field]).map((field) => (
                <div key={field} className="contents">
                    <dt className="text-muted-foreground">{SOUL_LABELS[field]}</dt>
                    <dd className="break-words whitespace-pre-wrap max-[700px]:mb-2">{soul[field]}</dd>
                </div>
            ))}
        </dl>
    );
}

/** What changed in each part from `before` to `after`. */
function SoulDiff({ before, after }: { before: SoulFields; after: SoulFields }) {
    const changed = SOUL_FIELDS.filter((field) => before[field] !== after[field]);
    if (!changed.length) {
        return <p className="text-xs text-muted-foreground">The same as the version before.</p>;
    }
    return (
        <dl data-slot="soul-diff" className="grid gap-3 text-[13px] leading-[1.6]">
            {changed.map((field) => (
                <div key={field}>
                    <dt className="mb-1 text-xs text-muted-foreground">{SOUL_LABELS[field]}</dt>
                    <dd className="rounded-md border bg-muted/40 p-2.5 break-words whitespace-pre-wrap">
                        {textDiff(before[field], after[field]).map((part, index) =>
                            part.kind === 'same' ? (
                                <span key={index}>{part.text}</span>
                            ) : part.kind === 'added' ? (
                                <ins
                                    key={index}
                                    className="bg-emerald-500/15 text-emerald-800 no-underline dark:text-emerald-300"
                                >
                                    {part.text}
                                </ins>
                            ) : (
                                <del key={index} className="bg-rose-500/15 text-rose-800 dark:text-rose-300">
                                    {part.text}
                                </del>
                            ),
                        )}
                    </dd>
                </div>
            ))}
        </dl>
    );
}

/** The editor: every part, with its limit, and what the socio will read. */
function SoulEditor({
    dotName,
    soul,
    onSave,
    onCancel,
}: {
    dotName: string;
    soul: SoulVersion;
    onSave: (fields: SoulFields) => Promise<string | undefined>;
    onCancel: () => void;
}) {
    const [fields, setFields] = useState<SoulFields>(() => soulFields(soul));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [preview, setPreview] = useState(false);
    const trimmed = soulFields(fields);
    const problem = soulProblem(trimmed);
    return (
        <form
            data-slot="soul-editor"
            className="grid gap-4"
            onSubmit={async (event) => {
                event.preventDefault();
                if (problem) {
                    return setError(problem);
                }
                setBusy(true);
                setError((await onSave(trimmed)) ?? '');
                setBusy(false);
            }}
        >
            {SOUL_FIELDS.map((field) => (
                <div key={field} className="grid gap-1.5">
                    <label htmlFor={`soul-${field}`} className="text-sm font-medium">
                        {SOUL_LABELS[field]}
                        {field !== 'instructions' && (
                            <span className="font-normal text-muted-foreground"> (optional)</span>
                        )}
                    </label>
                    <p id={`soul-${field}-hint`} className="text-xs text-muted-foreground">
                        {SOUL_HINTS[field]}
                    </p>
                    <Textarea
                        id={`soul-${field}`}
                        aria-describedby={`soul-${field}-hint`}
                        rows={field === 'instructions' ? 6 : 3}
                        maxLength={SOUL_FIELD_MAX[field]}
                        required={field === 'instructions'}
                        value={fields[field]}
                        onChange={(event) =>
                            setFields((current) => ({
                                ...current,
                                [field]: event.target.value,
                            }))
                        }
                        className="leading-[1.6]"
                    />
                    <p className="text-right text-[11px] text-muted-foreground tabular-nums">
                        {fields[field].length} / {SOUL_FIELD_MAX[field]}
                    </p>
                </div>
            ))}
            <div>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-expanded={preview}
                    aria-controls="soul-preview"
                    onClick={() => setPreview((open) => !open)}
                >
                    {preview ? 'Hide preview' : `Preview what ${dotName} reads`}
                </Button>
                {preview && (
                    <pre
                        id="soul-preview"
                        data-slot="soul-preview"
                        className="mt-2 max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 font-sans text-[13px] leading-[1.6] break-words whitespace-pre-wrap"
                    >
                        {`Role instructions: ${soulPrompt(trimmed)}`}
                    </pre>
                )}
            </div>
            {error && (
                <p role="alert" className="text-sm text-destructive">
                    {error}
                </p>
            )}
            <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={busy || !!problem}>
                    Save as a new version
                </Button>
                <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
                    Cancel
                </Button>
            </div>
        </form>
    );
}

/**
 * `/dots/:dotId/soul` (CB-179): a socio's Soul. The version in use, its
 * editor for those who may change it (the owner of a personal socio, an
 * admin for a company socio), and every version before, with who made it
 * and when, what changed, and Restore (a new version, history kept).
 */
export function SoulPage() {
    const { dotId = '' } = useParams();
    const shell = useShell();
    const [view, setView] = useState<SoulView | null>();
    const [editing, setEditing] = useState(false);
    const [open, setOpen] = useState<number>();
    const [restoring, setRestoring] = useState<SoulVersion>();
    const load = useCallback(
        () =>
            api<SoulView>(soulPath(dotId))
                .then(setView)
                .catch((error: unknown) => {
                    if (error instanceof ApiError && error.status === 404) {
                        setView(null);
                    } else {
                        toast.error(failure(error, 'Could not load the Soul.'));
                    }
                }),
        [dotId],
    );
    // The shell's poll sees a new version made elsewhere: show it.
    const shellVersion = shell.workspace.dots.find((dot) => dot.id === dotId)?.soul?.version;
    useEffect(() => {
        void load();
    }, [load, shellVersion]);

    if (view === null) {
        return <NotFound what="Socio" />;
    }
    const current = view?.versions[0];
    const name = (id: string) => view?.users[id] ?? 'Someone';
    const dotName = view?.dot.name ?? 'This socio';
    const write = async (path: string, body: unknown) => {
        try {
            await api(path, path.endsWith('/restore') ? 'POST' : 'PUT', body);
            await Promise.all([load(), shell.refresh()]);
            return undefined;
        } catch (error) {
            // Someone else's version came first: show it.
            if (error instanceof ApiError && error.status === 409) {
                void load();
            }
            return failure(error, 'Could not save the Soul.');
        }
    };
    const editors = view?.dot.ownerId ? 'its owner edits it' : 'admins edit it';

    return (
        <WorkspacePage
            slot="soul-page"
            icon={Sparkles}
            tone="violet"
            measure="reading"
            title={`${dotName}’s Soul`}
            description={`Who ${dotName} is: its role, voice, values and working style. It is part of every chat with ${dotName}, and changes only when ${editors}. It shapes tone and role, never Socio’s rules, tool permissions or approvals.`}
            actions={
                view &&
                (shell.workspace.dots.some((dot) => dot.id === view.dot.id) ? (
                    <Button variant="outline" size="sm" asChild>
                        <Link to={dotPath(view.dot)}>Back to {dotName}</Link>
                    </Button>
                ) : shell.admin ? (
                    <Button variant="outline" size="sm" asChild>
                        <Link to={`/admin/dots/${encodeURIComponent(view.dot.id)}`}>Back to {dotName}</Link>
                    </Button>
                ) : undefined)
            }
        >
            {!view || !current ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
                <>
                    <section aria-labelledby="soul-current" className="mb-8">
                        <SectionTitle id="soul-current">In use</SectionTitle>
                        <Card data-slot="soul-current" className="gap-4 rounded-xl p-5.5 shadow-none">
                            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                <Badge variant="secondary">Version {current.version}</Badge>
                                <span>
                                    {origin(current, name)} · <LocalTime value={current.createdAt} format={relative} />
                                </span>
                                {view.canEdit && !editing && (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className="ml-auto"
                                        onClick={() => setEditing(true)}
                                    >
                                        <Pencil />
                                        Edit
                                    </Button>
                                )}
                            </div>
                            {editing ? (
                                <SoulEditor
                                    dotName={dotName}
                                    soul={current}
                                    onCancel={() => setEditing(false)}
                                    onSave={async (fields) => {
                                        const failed = await write(soulPath(dotId), {
                                            ...fields,
                                            baseVersion: current.version,
                                        });
                                        if (!failed) {
                                            setEditing(false);
                                            toast(`${dotName}’s Soul saved`);
                                        }
                                        return failed;
                                    }}
                                />
                            ) : (
                                <>
                                    <SoulParts soul={current} />
                                    {!PERSONA_FIELDS.some((field) => current[field]) && (
                                        <p className="text-xs text-muted-foreground">
                                            No voice, values or working style yet
                                            {view.canEdit ? ': Edit adds them.' : '.'}
                                        </p>
                                    )}
                                </>
                            )}
                            {!view.canEdit && (
                                <p data-slot="soul-read-only" className="text-xs text-muted-foreground">
                                    {view.dot.archived
                                        ? 'This socio is archived: its Soul can’t change until it’s unarchived.'
                                        : view.dot.ownerId
                                          ? 'Only its owner can change this Soul.'
                                          : 'Only an admin can change this Soul.'}
                                </p>
                            )}
                        </Card>
                    </section>

                    <section aria-labelledby="soul-history">
                        <SectionTitle id="soul-history">History</SectionTitle>
                        <ol data-slot="soul-history" className="grid gap-0.5 rounded-xl border bg-card p-1.5 shadow-xs">
                            {view.versions.map((version, index) => {
                                const before = view.versions[index + 1];
                                const expanded = open === version.version;
                                return (
                                    <li key={version.version} data-slot="soul-version" className="rounded-lg px-3 py-2">
                                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                                            <History className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                                            <span className="font-medium">Version {version.version}</span>
                                            {index === 0 && (
                                                <Badge variant="secondary" className="py-0">
                                                    In use
                                                </Badge>
                                            )}
                                            <span className="min-w-0 flex-1 basis-48 text-xs text-muted-foreground">
                                                {origin(version, name)} ·{' '}
                                                <LocalTime value={version.createdAt} format={relative} />
                                            </span>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                aria-expanded={expanded}
                                                aria-controls={`soul-version-${version.version}`}
                                                onClick={() => setOpen(expanded ? undefined : version.version)}
                                            >
                                                {expanded ? 'Hide' : before ? 'Changes' : 'Show'}
                                            </Button>
                                            {view.canEdit && index > 0 && (
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    onClick={() => setRestoring(version)}
                                                >
                                                    <RotateCcw />
                                                    Restore
                                                </Button>
                                            )}
                                        </div>
                                        {expanded && (
                                            <div id={`soul-version-${version.version}`} className="mt-3 mb-1 pl-7">
                                                {before ? (
                                                    <SoulDiff before={before} after={version} />
                                                ) : (
                                                    <SoulParts soul={version} />
                                                )}
                                            </div>
                                        )}
                                    </li>
                                );
                            })}
                        </ol>
                    </section>
                    {restoring && (
                        <ConfirmDelete
                            title={`Restore version ${restoring.version}?`}
                            slot="confirm-restore-soul"
                            action="Restore"
                            variant="default"
                            onClose={() => setRestoring(undefined)}
                            onConfirm={async () => {
                                const failed = await write(`${soulPath(dotId)}/restore`, {
                                    version: restoring.version,
                                    baseVersion: current.version,
                                });
                                if (failed) {
                                    toast.error(failed);
                                } else {
                                    toast(`Version ${restoring.version} is back in use`);
                                    setEditing(false);
                                }
                                setRestoring(undefined);
                            }}
                        >
                            {dotName} uses it from its next turn, as version {current.version + 1}. Every version stays
                            in the history.
                        </ConfirmDelete>
                    )}
                </>
            )}
        </WorkspacePage>
    );
}
