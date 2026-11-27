import { useState } from 'react';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import { canDeleteAttachment, canDeleteComment, canEditComment } from '@socio/shared/issues/issue-board';
import type {
    IssueArea,
    IssueAttachment,
    IssueComment,
    IssueDetail,
    IssueEvent,
    IssueKind,
    IssuePriority,
    IssueStatus,
} from '@socio/shared/issues/issue-types';
import { dateTimeFormat } from '@socio/shared/locale';
import type { User } from '@socio/shared/types';

import { api } from '../../lib/api';
import { LocalTime } from '../../lib/local-time';

import { acceptFiles, pastedFiles, uploadAll, useUploadProblems } from './attachments';
import { useIssueTerms } from './issue-words';
import { AttachButton, AttachmentGrid, PendingFiles } from './IssueAttachments';
import { useComponentEventText, type ComponentLabels } from './IssueComponents';
import { IssueMarkdown } from './IssueMarkdown';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

/** A comment's or event's time, in the app's language (and the reader's zone). */
export const formatTime = (at: number) => dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' }).format(at);

/** A comment's element id, for links to it ("Read the answer"). */
export const issueCommentId = (id: string) => `issue-comment-${id}`;

/** A comment's author, in words. */
function useAuthorName() {
    const { t } = useTranslation(['common', 'issues.detail']);
    return (comment: IssueComment, users: Record<string, string>) => {
        const name =
            (comment.authorId && users[comment.authorId]) ??
            (comment.authorKind === 'system' ? t('common:product') : comment.authorKind);
        // A Dot's comment (CB-84): "Dot for Person", as filings show it; a
        // connected agent's (CB-90): "‹label› for Person", the author.
        if (comment.agent) {
            return t('issues.detail:comments.for', { name: comment.agent.label, person: name });
        }
        return comment.dot
            ? t('issues.detail:comments.for', { name, person: users[comment.dot.userId] ?? comment.dot.userId })
            : name;
    };
}

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
    const { t } = useTranslation(['issues.detail']);
    const uploadProblems = useUploadProblems();
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
            const failed = uploadProblems(await uploadAll(number, files, comment.id));
            for (const problem of failed) {
                toast.error(problem);
            }
            setText('');
            setFiles([]);
            await refresh();
        } catch (error) {
            toast.error(message(error, t('issues.detail:comments.add-failed')));
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
                    {t('issues.detail:comments.empty')}
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
                    aria-label={t('issues.detail:comments.add')}
                    placeholder={t('issues.detail:comments.placeholder')}
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
                    <AttachButton
                        compact
                        label={t('issues.detail:comments.attach')}
                        onFiles={addFiles}
                        disabled={busy}
                    />
                    <Button type="submit" size="sm" disabled={busy || !text.trim()}>
                        {busy ? t('issues.detail:comments.posting') : t('issues.detail:comments.post')}
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
    const { t } = useTranslation(['issues.detail']);
    const authorName = useAuthorName();
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
            t('issues.detail:comments.save-failed'),
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
                {comment.editedAt && <span>{t('issues.detail:comments.edited')}</span>}
                <span className="ml-auto flex items-center gap-1">
                    {canEditComment(comment, user) && editing === undefined && (
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-xs"
                            onClick={() => setEditing(comment.body)}
                        >
                            {t('issues.detail:comments.edit')}
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
                                            t('issues.detail:comments.delete-failed'),
                                        )
                                    }
                                >
                                    {t('issues.detail:comments.delete-confirm')}
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 px-2 text-xs"
                                    onClick={() => setConfirming(false)}
                                >
                                    {t('issues.detail:keep')}
                                </Button>
                            </>
                        ) : (
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2 text-xs"
                                onClick={() => setConfirming(true)}
                            >
                                {t('issues.detail:comments.delete')}
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
                        aria-label={t('issues.detail:comments.edit-label')}
                        value={editing}
                        rows={3}
                        maxLength={10_000}
                        autoFocus
                        onChange={(event) => setEditing(event.target.value)}
                    />
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(undefined)}>
                            {t('issues.detail:cancel')}
                        </Button>
                        <Button type="submit" size="sm" disabled={busy || !editing.trim()}>
                            {t('issues.detail:save')}
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
    const { t } = useTranslation(['common', 'issues.detail']);
    const eventText = useEventText();
    const componentEventText = useComponentEventText();
    if (!events.length) {
        return <p className="text-sm text-muted-foreground">{t('issues.detail:history.empty')}</p>;
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
                        {event.dot
                            ? t('issues.detail:history.for', {
                                  name: users[`dot:${event.dot.dotId}`] ?? t('common:product'),
                                  person: users[event.dot.userId] ?? event.dot.userId,
                              })
                            : event.agent
                              ? t('issues.detail:history.for', {
                                    name: event.agent.label,
                                    person: event.actorId
                                        ? (users[event.actorId] ?? event.actorId)
                                        : t('common:product'),
                                })
                              : event.actorId
                                ? (users[event.actorId] ?? event.actorId)
                                : t('common:product')}
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

/**
 * A history row in words: "changed status from Triage to Open" (the
 * shared `eventText`, in the reader's language; components events are
 * `useComponentEventText`'s).
 */
function useEventText() {
    const { t } = useTranslation(['issues.detail']);
    const terms = useIssueTerms();
    return (event: IssueEvent, users: Record<string, string> = {}): string => {
        const from = event.fromValue;
        const to = event.toValue;
        const value = (raw: string | null) => {
            if (raw === null || raw === '') {
                return t('issues.detail:history.none');
            }
            switch (event.kind) {
                case 'status':
                    return terms.status(raw as IssueStatus);
                case 'assignee':
                    return users[raw] ?? raw;
                case 'priority':
                    return terms.priority(raw as IssuePriority);
                case 'kind':
                    return terms.kind(raw as IssueKind);
                case 'area':
                    return terms.area(raw as IssueArea);
                default:
                    return raw;
            }
        };
        const change = { from: value(from), to: value(to) };
        switch (event.kind) {
            case 'created':
            case 'imported':
            case 'body':
            case 'comment_added':
            case 'comment_edited':
            case 'comment_deleted':
            case 'deleted':
                return t(`issues.detail:history.${event.kind}`);
            case 'title':
                return t('issues.detail:history.title', { title: to ?? '' });
            case 'assignee':
                return to
                    ? t('issues.detail:history.assigned', { person: value(to) })
                    : t('issues.detail:history.unassigned');
            case 'attachment_added':
                return t('issues.detail:history.attachment_added', { name: to ?? t('issues.detail:history.a-file') });
            case 'attachment_deleted':
                return t('issues.detail:history.attachment_deleted', {
                    name: from ?? t('issues.detail:history.a-file'),
                });
            case 'labels':
            case 'status':
            case 'priority':
            case 'kind':
            case 'area':
                return t(`issues.detail:history.${event.kind}`, change);
            case 'resolution':
                return to
                    ? t('issues.detail:history.resolution', { resolution: to })
                    : t('issues.detail:history.resolution-cleared');
            case 'blocked_by':
            case 'blocks':
            case 'related':
                return to
                    ? t(`issues.detail:history.${event.kind}`, { key: to })
                    : t(`issues.detail:history.${event.kind}-lifted`, { key: from ?? '' });
            case 'triage':
                return to === 'proposed'
                    ? t('issues.detail:history.triage-proposed')
                    : to === 'applied'
                      ? t('issues.detail:history.triage-applied')
                      : t('issues.detail:history.triage-ignored');
            default:
                return t('issues.detail:history.changed', { field: event.kind, ...change });
        }
    };
}
