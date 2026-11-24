import { useState } from 'react';
import { toast } from 'sonner';

import { canDeleteAttachment, canDeleteComment, canEditComment, eventText } from '@socio/shared/issues/issue-board';
import type { IssueAttachment, IssueComment, IssueDetail, IssueEvent } from '@socio/shared/issues/issue-types';
import type { User } from '@socio/shared/types';

import { api } from '../../lib/api';
import { LocalTime } from '../../lib/local-time';

import { acceptFiles, pastedFiles, uploadAll } from './attachments';
import { AttachButton, AttachmentGrid, PendingFiles } from './IssueAttachments';
import { componentEventText, type ComponentLabels } from './IssueComponents';
import { IssueMarkdown } from './IssueMarkdown';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

export const formatTime = (at: number) =>
    new Date(at).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
    });

/** A comment's element id, for links to it ("Read the answer"). */
export const issueCommentId = (id: string) => `issue-comment-${id}`;

const authorName = (comment: IssueComment, users: Record<string, string>) => {
    const name =
        (comment.authorId && users[comment.authorId]) ??
        (comment.authorKind === 'system' ? 'Socio' : comment.authorKind);
    // A Dot's comment (CB-84): "Dot for Person", as filings show it; a
    // connected agent's (CB-90): "‹label› for Person", the author.
    if (comment.agent) {
        return `${comment.agent.label} for ${name}`;
    }
    return comment.dot ? `${name} for ${users[comment.dot.userId] ?? comment.dot.userId}` : name;
};

const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

/**
 * An issue's comments: everyone adds them (with pasted or picked files);
 * authors edit their own; authors and admins delete them.
 */
export function IssueComments({
    detail,
    user,
    refresh,
    deleteAttachment,
}: {
    detail: IssueDetail;
    user: User;
    refresh: () => Promise<void>;
    deleteAttachment: (file: IssueAttachment) => void;
}) {
    const number = detail.issue.number;
    const [text, setText] = useState('');
    const [files, setFiles] = useState<File[]>([]);
    const [busy, setBusy] = useState(false);
    const addFiles = (picked: File[]) => {
        const { accepted, refused } = acceptFiles(picked, detail.attachments.length + files.length);
        if (accepted.length) {
            setFiles((current) => [...current, ...accepted]);
        }
        for (const problem of refused) {
            toast.error(problem);
        }
    };
    const post = async () => {
        if (!text.trim()) {
            return;
        }
        setBusy(true);
        try {
            const comment = await api<IssueComment>(`/issues/${number}/comments`, 'POST', { body: text.trim() });
            const failed = await uploadAll(number, files, comment.id);
            for (const problem of failed) {
                toast.error(problem);
            }
            setText('');
            setFiles([]);
            await refresh();
        } catch (error) {
            toast.error(message(error, 'Could not add the comment.'));
        } finally {
            setBusy(false);
        }
    };
    return (
        <div data-slot="issue-comments" className="grid gap-4">
            {detail.comments.length ? (
                <ol className="grid gap-3">
                    {detail.comments.map((comment) => (
                        <CommentItem
                            key={comment.id}
                            number={number}
                            comment={comment}
                            detail={detail}
                            user={user}
                            refresh={refresh}
                            deleteAttachment={deleteAttachment}
                        />
                    ))}
                </ol>
            ) : (
                <p data-slot="issue-no-comments" className="text-sm text-muted-foreground">
                    No comments yet.
                </p>
            )}
            <form
                data-slot="issue-comment-form"
                className="grid gap-2"
                onSubmit={(event) => {
                    event.preventDefault();
                    void post();
                }}
            >
                <Textarea
                    aria-label="Add a comment"
                    placeholder="Add a comment (markdown; paste a screenshot to attach it)"
                    value={text}
                    rows={3}
                    maxLength={10_000}
                    className="max-h-60"
                    onChange={(event) => setText(event.target.value)}
                    onPaste={(event) => {
                        const pasted = pastedFiles(event.clipboardData);
                        if (!pasted.length) {
                            return;
                        }
                        event.preventDefault();
                        event.stopPropagation();
                        addFiles(pasted);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                            event.preventDefault();
                            void post();
                        }
                    }}
                />
                <PendingFiles
                    files={files}
                    onRemove={(index) => setFiles((current) => current.filter((_, i) => i !== index))}
                />
                <div className="flex items-center justify-end gap-2">
                    <AttachButton compact label="Attach files to the comment" onFiles={addFiles} disabled={busy} />
                    <Button type="submit" size="sm" disabled={busy || !text.trim()}>
                        {busy ? 'Posting…' : 'Comment'}
                    </Button>
                </div>
            </form>
        </div>
    );
}

function CommentItem({
    number,
    comment,
    detail,
    user,
    refresh,
    deleteAttachment,
}: {
    number: number;
    comment: IssueComment;
    detail: IssueDetail;
    user: User;
    refresh: () => Promise<void>;
    deleteAttachment: (file: IssueAttachment) => void;
}) {
    const [editing, setEditing] = useState<string>();
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const files = detail.attachments.filter((file) => file.commentId === comment.id);
    const act = async (call: () => Promise<unknown>, fallback: string) => {
        setBusy(true);
        try {
            await call();
            await refresh();
            return true;
        } catch (error) {
            toast.error(message(error, fallback));
            return false;
        } finally {
            setBusy(false);
        }
    };
    const save = async () => {
        if (!editing?.trim()) {
            return;
        }
        const ok = await act(
            () =>
                api(`/issues/${number}/comments/${comment.id}`, 'PATCH', {
                    body: editing.trim(),
                }),
            'Could not save the comment.',
        );
        if (ok) {
            setEditing(undefined);
        }
    };
    return (
        <li
            id={issueCommentId(comment.id)}
            tabIndex={-1}
            data-slot="issue-comment"
            data-comment={comment.id}
            className="rounded-lg border bg-card p-3 text-card-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
            <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{authorName(comment, detail.users)}</span>
                <LocalTime value={comment.createdAt} format={formatTime} />
                {comment.editedAt && <span>(edited)</span>}
                <span className="ml-auto flex items-center gap-1">
                    {canEditComment(comment, user) && editing === undefined && (
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-xs"
                            onClick={() => setEditing(comment.body)}
                        >
                            Edit
                        </Button>
                    )}
                    {canDeleteComment(comment, user) &&
                        (confirming ? (
                            <>
                                <Button
                                    variant="destructive"
                                    size="sm"
                                    className="h-6 px-2 text-xs"
                                    disabled={busy}
                                    onClick={() =>
                                        void act(
                                            () => api(`/issues/${number}/comments/${comment.id}`, 'DELETE'),
                                            'Could not delete the comment.',
                                        )
                                    }
                                >
                                    Delete comment
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 px-2 text-xs"
                                    onClick={() => setConfirming(false)}
                                >
                                    Keep
                                </Button>
                            </>
                        ) : (
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2 text-xs"
                                onClick={() => setConfirming(true)}
                            >
                                Delete
                            </Button>
                        ))}
                </span>
            </div>
            {editing !== undefined ? (
                <form
                    className="grid gap-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void save();
                    }}
                >
                    <Textarea
                        aria-label="Edit comment"
                        value={editing}
                        rows={3}
                        maxLength={10_000}
                        autoFocus
                        onChange={(event) => setEditing(event.target.value)}
                    />
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(undefined)}>
                            Cancel
                        </Button>
                        <Button type="submit" size="sm" disabled={busy || !editing.trim()}>
                            Save
                        </Button>
                    </div>
                </form>
            ) : (
                <IssueMarkdown text={comment.body} issueChips />
            )}
            <AttachmentGrid
                className="mt-2"
                files={files}
                canDelete={(file) => canDeleteAttachment(file, user)}
                onDelete={deleteAttachment}
            />
        </li>
    );
}

/** The issue's history, oldest first. */
export function IssueHistory({
    events,
    users,
    components,
}: {
    events: readonly IssueEvent[];
    users: Record<string, string>;
    /** Names for the refs in components events (the detail's label map, CB-442). */
    components?: ComponentLabels;
}) {
    if (!events.length) {
        return <p className="text-sm text-muted-foreground">No history yet.</p>;
    }
    return (
        <ol data-slot="issue-history" className="grid gap-2 border-l pl-4">
            {events.map((event) => (
                <li
                    key={event.id}
                    data-slot="issue-event"
                    className="relative text-sm before:absolute before:top-1.5 before:-left-[1.3rem] before:size-2 before:rounded-full before:bg-border"
                >
                    <span className="font-medium">
                        {event.dot ? (
                            `${users[`dot:${event.dot.dotId}`] ?? 'Socio'} for ${users[event.dot.userId] ?? event.dot.userId}`
                        ) : (
                            <>
                                {event.agent && `${event.agent.label} for `}
                                {event.actorId ? (users[event.actorId] ?? event.actorId) : 'Socio'}
                            </>
                        )}
                    </span>{' '}
                    <span className="text-muted-foreground [overflow-wrap:anywhere]">
                        {event.kind === 'components' ? componentEventText(event, components) : eventText(event, users)}
                    </span>
                    <LocalTime
                        value={event.createdAt}
                        format={formatTime}
                        className="block text-xs text-muted-foreground"
                    />
                </li>
            ))}
        </ol>
    );
}
