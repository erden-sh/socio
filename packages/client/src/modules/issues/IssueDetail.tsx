import { ChevronDown, Pencil, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import { ATTACHMENT_HINT } from '@socio/shared/issues/issue-attachment-files';
import { canDeleteAttachment, canEditText, canTriage } from '@socio/shared/issues/issue-board';
import {
    ISSUE_AREAS,
    ISSUE_KINDS,
    ISSUE_LABELS,
    ISSUE_PRIORITIES,
    ISSUE_STATUSES,
    issueKey,
    type IssueAssignees,
    type IssueAttachment,
    type IssueDetail,
    type IssueLabel,
    type IssueSummary,
} from '@socio/shared/issues/issue-types';
import { listFormat } from '@socio/shared/locale';
import type { User } from '@socio/shared/types';

import { api } from '../../lib/api';
import { useLiveTopic } from '../../lib/change-channel';
import { Slot } from '../context';

import { acceptFiles, pastedFiles, uploadAll, useUploadProblems } from './attachments';
import { useIssueTerms } from './issue-words';
import { AttachButton, AttachmentGrid } from './IssueAttachments';
import { BlockedBadge, DemandBadge, StatusRing, Tag } from './IssueBadges';
import { IssueComments, IssueHistory } from './IssueComments';
import { ComponentChip, ComponentPicker, useComponentOptions } from './IssueComponents';
import { ChoiceField, Field } from './IssueFields';
import { IssueLinks } from './IssueLinks';
import { IssueMarkdown } from './IssueMarkdown';
import { IssueTriage } from './IssueTriage';
import { VoteButton } from './IssueVotes';
import type { IssueChange } from './use-issues';

import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';

const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

/**
 * One issue, over the board (`/issues/CB-12`): the description, attachments,
 * comments and history, with editing per role. Admins change every field
 * (status, priority, kind, area, labels, components, assignee, resolution)
 * and delete;
 * members edit the title and description of their own issues in triage.
 */
export function IssueDetailDialog({
    number,
    initial,
    user,
    update,
    onChanged,
    onDeleted,
    onClose,
    reread,
}: {
    number: number | undefined;
    /** The issue from the page's loader, shown without asking again. */
    initial?: IssueDetail;
    user: User;
    /** Changes the issue (optimistic in the list); throws when refused. */
    update: (number: number, change: IssueChange) => Promise<IssueDetail>;
    /** A fresh detail, for the list. */
    onChanged: (detail: IssueDetail) => void;
    onDeleted: (number: number) => void;
    onClose: () => void;
    /** Reads the list again for a note; resolves with what the server lists. */
    reread?: () => Promise<readonly IssueSummary[] | undefined>;
}) {
    return (
        <Dialog
            open={number !== undefined}
            onOpenChange={(open) => {
                if (!open) {
                    onClose();
                }
            }}
        >
            {/*
        Phones: full screen. sm (tablets): a dialog with the fields below
        the content, one scroll. lg: the fields beside the content, each
        scrolling. 2xl (full HD and up): up to 90rem wide, the fields wider.
      */}
            <DialogContent
                data-slot="issue-detail"
                aria-describedby={undefined}
                className="flex h-svh max-h-svh max-w-full flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-auto sm:max-h-[min(90svh,56rem)] sm:max-w-[calc(100%-2rem)] sm:rounded-lg lg:max-w-[calc(100%-4rem)] 2xl:max-h-[min(90svh,64rem)] 2xl:max-w-[90rem]"
            >
                {number !== undefined && (
                    <IssueDetailBody
                        key={number}
                        number={number}
                        initial={initial?.issue.number === number ? initial : undefined}
                        user={user}
                        update={update}
                        onChanged={onChanged}
                        onDeleted={onDeleted}
                        onClose={onClose}
                        reread={reread}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

function IssueDetailBody({
    number,
    initial,
    user,
    update,
    onChanged,
    onDeleted,
    onClose,
    reread,
}: {
    number: number;
    initial?: IssueDetail;
    user: User;
    update: (number: number, change: IssueChange) => Promise<IssueDetail>;
    onChanged: (detail: IssueDetail) => void;
    onDeleted: (number: number) => void;
    onClose: () => void;
    reread?: () => Promise<readonly IssueSummary[] | undefined>;
}) {
    const { t } = useTranslation(['issues', 'issues.detail', 'issues.terms']);
    const terms = useIssueTerms();
    const uploadProblems = useUploadProblems();
    const [detail, setDetail] = useState<IssueDetail | undefined>(initial);
    const [missing, setMissing] = useState('');
    // Opened from the loader's copy: no second read on mount.
    const seeded = useRef(!!initial);
    const refresh = useCallback(async () => {
        try {
            const next = await api<IssueDetail>(`/issues/${number}`);
            setDetail(next);
            onChanged(next);
        } catch (error) {
            setMissing(message(error, t('issues.detail:load-failed')));
        }
    }, [number, onChanged, t]);
    useEffect(() => {
        if (seeded.current) {
            seeded.current = false;
            return;
        }
        void refresh();
    }, [refresh]);
    // Comments, attachments or fields changed in another tab. The list
    // re-reads first: an issue deleted there is no longer listed, and says
    // so without being asked for (no 404 in the console), as a chat does.
    useLiveTopic(`issue:${number}`, async () => {
        const listed = await reread?.();
        if (listed && !listed.some((issue) => issue.number === number)) {
            // An open issue deleted in another tab (or by another admin).
            setMissing(t('issues.detail:deleted'));
            return;
        }
        await refresh();
    });
    const change = async (patch: IssueChange) => {
        const before = detail;
        if (before) {
            setDetail({ ...before, issue: { ...before.issue, ...patch } });
        }
        try {
            setDetail(await update(number, patch));
            return true;
        } catch (error) {
            setDetail(before);
            toast.error(message(error, t('issues.detail:save-failed')));
            return false;
        }
    };
    const deleteAttachment = (file: IssueAttachment) =>
        void api(`/issue-attachments/${encodeURIComponent(file.id)}`, 'DELETE')
            .then(refresh)
            .catch((error: unknown) => toast.error(message(error, t('issues.detail:delete-file-failed'))));
    const [uploading, setUploading] = useState(false);
    const [tab, setTab] = useState('comments');
    const attach = async (picked: File[]) => {
        if (!detail) {
            return;
        }
        const { accepted, refused } = acceptFiles(picked, detail.attachments.length);
        for (const problem of refused) {
            toast.error(problem);
        }
        if (!accepted.length) {
            return;
        }
        setUploading(true);
        const failed = uploadProblems(await uploadAll(number, accepted));
        for (const problem of failed) {
            toast.error(problem);
        }
        setUploading(false);
        await refresh();
    };

    if (missing) {
        return (
            <div className="grid gap-4 p-6">
                <DialogTitle>{issueKey(number)}</DialogTitle>
                <p data-slot="issue-missing" className="text-sm text-muted-foreground">
                    {missing}
                </p>
                <DialogFooter>
                    <Button variant="outline" onClick={onClose}>
                        {t('issues.detail:back')}
                    </Button>
                </DialogFooter>
            </div>
        );
    }
    if (!detail) {
        return (
            <div className="grid gap-4 p-6" aria-busy="true">
                <DialogTitle className="sr-only">{t('issues.detail:loading', { key: issueKey(number) })}</DialogTitle>
                <Skeleton className="h-6 w-2/3" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-16 w-full" />
            </div>
        );
    }

    const { issue } = detail;
    const admin = canTriage(user);
    const editable = canEditText(issue, user);
    const issueFiles = detail.attachments.filter((file) => !file.commentId);
    return (
        <div
            className="flex min-h-0 flex-1 flex-col"
            onPaste={(event) => {
                // Pasted into a field: the field (or the comment box) handles it.
                const target = event.target as HTMLElement;
                if (target.closest('input, textarea')) {
                    return;
                }
                const pasted = pastedFiles(event.clipboardData);
                if (!pasted.length) {
                    return;
                }
                event.preventDefault();
                void attach(pasted);
            }}
        >
            <DialogHeader className="gap-1 border-b px-5 py-4 pr-12 text-left">
                {/* One mono line: key, status, votes. The other fields are in
            the side column (admins edit them, members read them). */}
                <div
                    data-slot="issue-detail-line"
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-muted-foreground tabular-nums"
                >
                    <span className="whitespace-nowrap">{issueKey(issue.number)}</span>
                    <span aria-hidden>·</span>
                    <span
                        data-slot="issue-detail-status"
                        className="flex items-center gap-1.5 whitespace-nowrap text-foreground"
                    >
                        <StatusRing status={issue.status} />
                        {terms.status(issue.status)}
                    </span>
                    <span aria-hidden>·</span>
                    <VoteButton issue={issue} onVoted={() => void refresh()} className="-ml-1.5 font-mono" />
                    <DemandBadge demand={issue.demand} />
                    <BlockedBadge blockers={issue.openBlockers} />
                </div>
                <IssueTitle title={issue.title} editable={editable} save={(title) => change({ title })} />
                <DialogDescription className="text-xs">
                    {t('issues.detail:filed', {
                        reporter: detail.users[issue.reporterId] ?? issue.reporterId,
                        agent: detail.filedByAgent?.label ?? '',
                        person: detail.filedBy ? (detail.users[detail.filedBy.userId] ?? detail.filedBy.userId) : '',
                        trigger: detail.filedBy ? t(`issues.detail:trigger.${detail.filedBy.trigger}`) : '',
                        at: new Date(issue.createdAt),
                        context: detail.filedByAgent
                            ? detail.filedBy
                                ? 'both'
                                : 'agent'
                            : detail.filedBy
                              ? 'dot'
                              : undefined,
                    })}
                    {issue.updatedAt !== issue.createdAt &&
                        t('issues.detail:updated', { at: new Date(issue.updatedAt) })}
                </DialogDescription>
            </DialogHeader>
            <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_18rem] lg:overflow-hidden 2xl:grid-cols-[minmax(0,1fr)_20rem]">
                <div className="grid min-w-0 content-start gap-6 p-5 lg:overflow-y-auto 2xl:p-6">
                    <Section title={t('issues.detail:section.description')}>
                        <IssueBody body={issue.body} editable={editable} save={(body) => change({ body })} />
                    </Section>
                    <Section
                        title={t('issues.detail:section.attachments')}
                        action={
                            <AttachButton
                                compact
                                label={t('issues.detail:attach')}
                                onFiles={(files) => void attach(files)}
                                disabled={uploading}
                            />
                        }
                    >
                        {issueFiles.length ? (
                            <AttachmentGrid
                                files={issueFiles}
                                canDelete={(file) => canDeleteAttachment(file, user)}
                                onDelete={deleteAttachment}
                            />
                        ) : (
                            <p className="text-xs text-muted-foreground">
                                {t('issues.detail:no-files', { hint: ATTACHMENT_HINT })}
                            </p>
                        )}
                    </Section>
                    <Tabs value={tab} onValueChange={setTab} className="gap-3">
                        <TabsList>
                            <TabsTrigger value="comments">
                                {t('issues.detail:tab.comments', { n: detail.comments.length })}
                            </TabsTrigger>
                            <TabsTrigger value="history">
                                {t('issues.detail:tab.history', { n: detail.events.length })}
                            </TabsTrigger>
                        </TabsList>
                        <TabsContent value="comments">
                            <IssueComments
                                detail={detail}
                                user={user}
                                refresh={refresh}
                                deleteAttachment={deleteAttachment}
                            />
                        </TabsContent>
                        <TabsContent value="history">
                            <IssueHistory events={detail.events} users={detail.users} components={detail.components} />
                        </TabsContent>
                    </Tabs>
                </div>
                <aside
                    aria-label={t('issues.detail:fields')}
                    className="grid min-w-0 content-start gap-4 border-t bg-muted/30 p-5 lg:overflow-y-auto lg:border-t-0 lg:border-l 2xl:p-6"
                >
                    <IssueTriage detail={detail} admin={admin} refresh={refresh} />
                    {admin ? <AdminFields detail={detail} change={change} /> : <ReadOnlyFields detail={detail} />}
                    <IssueLinks detail={detail} admin={admin} refresh={refresh} />
                    {detail.requesters && <DotRequesters detail={detail} />}
                    <div data-slot="issue-actions" className="grid gap-2 empty:hidden">
                        <Slot
                            name="issue.actions"
                            props={{
                                issue,
                                refresh: () => void refresh(),
                                blockedBy: detail.blockedBy ?? [],
                            }}
                        />
                    </div>
                    {admin && (
                        <DeleteIssue
                            number={number}
                            onDeleted={() => {
                                onDeleted(number);
                                onClose();
                            }}
                        />
                    )}
                </aside>
            </div>
        </div>
    );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
    return (
        <section className="grid gap-2">
            <div className="flex items-center justify-between gap-2">
                <h3 data-slot="issue-section-title" className="text-sm font-medium text-muted-foreground">
                    {title}
                </h3>
                {action}
            </div>
            {children}
        </section>
    );
}

function IssueTitle({
    title,
    editable,
    save,
}: {
    title: string;
    editable: boolean;
    save: (title: string) => Promise<boolean>;
}) {
    const { t } = useTranslation(['issues.detail']);
    const [draft, setDraft] = useState<string>();
    if (draft !== undefined) {
        return (
            <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(event) => {
                    event.preventDefault();
                    const next = draft.trim();
                    if (next === title) {
                        return setDraft(undefined);
                    }
                    void save(next).then((ok) => ok && setDraft(undefined));
                }}
            >
                <DialogTitle className="sr-only">{title}</DialogTitle>
                <Input
                    aria-label={t('issues.detail:title.label')}
                    value={draft}
                    maxLength={200}
                    autoFocus
                    className="min-w-0 flex-1"
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                            event.stopPropagation();
                            setDraft(undefined);
                        }
                    }}
                />
                <Button type="submit" size="sm" disabled={draft.trim().length < 3}>
                    {t('issues.detail:save')}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(undefined)}>
                    {t('issues.detail:cancel')}
                </Button>
            </form>
        );
    }
    return (
        <div className="flex items-start gap-2">
            <DialogTitle className="text-lg leading-snug">{title}</DialogTitle>
            {editable && (
                <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0"
                    aria-label={t('issues.detail:title.edit')}
                    onClick={() => setDraft(title)}
                >
                    <Pencil className="size-3.5" />
                </Button>
            )}
        </div>
    );
}

function IssueBody({
    body,
    editable,
    save,
}: {
    body: string;
    editable: boolean;
    save: (body: string) => Promise<boolean>;
}) {
    const { t } = useTranslation(['issues.detail']);
    const [draft, setDraft] = useState<string>();
    if (draft !== undefined) {
        return (
            <form
                className="grid gap-2"
                onSubmit={(event) => {
                    event.preventDefault();
                    void save(draft).then((ok) => ok && setDraft(undefined));
                }}
            >
                <Textarea
                    aria-label={t('issues.detail:body.label')}
                    value={draft}
                    rows={8}
                    maxLength={20_000}
                    autoFocus
                    className="max-h-[50svh]"
                    onChange={(event) => setDraft(event.target.value)}
                />
                <div className="flex justify-end gap-2">
                    <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(undefined)}>
                        {t('issues.detail:cancel')}
                    </Button>
                    <Button type="submit" size="sm">
                        {t('issues.detail:body.save')}
                    </Button>
                </div>
            </form>
        );
    }
    return (
        <div className="grid gap-2">
            {body.trim() ? (
                <IssueMarkdown text={body} issueChips />
            ) : (
                <p className="text-sm text-muted-foreground">{t('issues.detail:body.empty')}</p>
            )}
            {editable && (
                <Button variant="outline" size="sm" className="w-fit" onClick={() => setDraft(body)}>
                    <Pencil />
                    {t('issues.detail:body.edit')}
                </Button>
            )}
        </div>
    );
}

/** Every field, editable: admins only. */
function AdminFields({ detail, change }: { detail: IssueDetail; change: (patch: IssueChange) => Promise<boolean> }) {
    const { t } = useTranslation(['issues.detail']);
    const terms = useIssueTerms();
    const { issue } = detail;
    const [people, setPeople] = useState<IssueAssignees>();
    const options = useComponentOptions();
    useEffect(() => {
        const controller = new AbortController();
        void api<IssueAssignees>('/issues/assignees', 'GET', undefined, controller.signal)
            .then(setPeople)
            .catch(() => undefined);
        return () => controller.abort();
    }, []);
    const names = new Map((people?.users ?? []).map((person) => [person.id, person.name]));
    // Deactivated people aren't offered, but an issue may still name one.
    if (issue.assigneeId && !names.has(issue.assigneeId)) {
        const name = detail.users[issue.assigneeId] ?? issue.assigneeId;
        const deactivated = people?.deactivated?.some((person) => person.id === issue.assigneeId);
        names.set(issue.assigneeId, deactivated ? t('issues.detail:field.deactivated', { name }) : name);
    }
    return (
        <>
            <ChoiceField
                label={t('issues.detail:field.status')}
                value={issue.status}
                options={ISSUE_STATUSES}
                labelOf={terms.status}
                onChange={(status) => status && void change({ status })}
            />
            <ChoiceField
                label={t('issues.detail:field.priority')}
                value={issue.priority}
                options={ISSUE_PRIORITIES}
                labelOf={terms.priority}
                onChange={(priority) => priority && void change({ priority })}
            />
            <ChoiceField
                label={t('issues.detail:field.kind')}
                value={issue.kind}
                options={ISSUE_KINDS}
                labelOf={terms.kind}
                onChange={(kind) => kind && void change({ kind })}
            />
            <ChoiceField
                label={t('issues.detail:field.area')}
                value={issue.area}
                options={ISSUE_AREAS}
                labelOf={terms.area}
                none={t('issues.detail:field.no-area')}
                onChange={(area) => void change({ area })}
            />
            <LabelsField labels={issue.labels} onChange={(labels) => void change({ labels })} />
            <ComponentPicker
                value={issue.components ?? []}
                options={options}
                labels={detail.components}
                onChange={(components) => void change({ components })}
            />
            <ChoiceField
                label={t('issues.detail:field.assignee')}
                value={issue.assigneeId}
                options={[...names.keys()]}
                labelOf={(id) => names.get(id) ?? id}
                none={t('issues.detail:field.unassigned')}
                onChange={(assigneeId) => void change({ assigneeId })}
            />
            <ResolutionField
                key={issue.resolution ?? ''}
                resolution={issue.resolution}
                save={(resolution) => change({ resolution })}
            />
        </>
    );
}

function LabelsField({
    labels,
    onChange,
}: {
    labels: readonly IssueLabel[];
    onChange: (labels: IssueLabel[]) => void;
}) {
    const { t } = useTranslation(['issues.detail']);
    const terms = useIssueTerms();
    const shown = labels.map(terms.label);
    return (
        <Field label={t('issues.detail:field.labels')}>
            {(id) => (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            variant="outline"
                            size="sm"
                            aria-labelledby={id}
                            aria-description={
                                shown.length
                                    ? listFormat({ type: 'unit', style: 'short' }).format(shown)
                                    : t('issues.detail:field.no-labels')
                            }
                            className="h-auto min-h-8 w-full justify-between py-1 font-normal"
                        >
                            <span className="flex flex-wrap gap-1">
                                {labels.length ? (
                                    labels.map((label) => <Tag key={label}>{terms.label(label)}</Tag>)
                                ) : (
                                    <span className="text-muted-foreground">{t('issues.detail:field.no-labels')}</span>
                                )}
                            </span>
                            <ChevronDown className="opacity-50" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-56">
                        {ISSUE_LABELS.map((label) => (
                            <DropdownMenuCheckboxItem
                                key={label}
                                checked={labels.includes(label)}
                                onSelect={(event) => event.preventDefault()}
                                onCheckedChange={(checked) =>
                                    onChange(checked ? [...labels, label] : labels.filter((value) => value !== label))
                                }
                            >
                                {terms.label(label)}
                            </DropdownMenuCheckboxItem>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>
            )}
        </Field>
    );
}

function ResolutionField({
    resolution,
    save,
}: {
    resolution: string | null;
    save: (resolution: string | null) => Promise<boolean>;
}) {
    const { t } = useTranslation(['issues.detail']);
    const [draft, setDraft] = useState(resolution ?? '');
    const commit = () => {
        const next = draft.trim() || null;
        if (next !== resolution) {
            void save(next);
        }
    };
    return (
        <Field label={t('issues.detail:field.resolution')}>
            {(id) => (
                <Input
                    aria-labelledby={id}
                    placeholder={t('issues.detail:field.resolution-example')}
                    value={draft}
                    maxLength={500}
                    className="h-8"
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={commit}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                            event.preventDefault();
                            commit();
                        }
                    }}
                />
            )}
        </Field>
    );
}

/**
 * A Dot request's askers: each Dot and the user it asked for, by name (the
 * tracker is team-shared, so everyone sees them, as they see authors).
 */
function DotRequesters({ detail }: { detail: IssueDetail }) {
    const { t } = useTranslation(['issues.detail']);
    const requesters = detail.requesters ?? [];
    return (
        <section data-slot="issue-requesters" className="grid gap-1.5 text-sm">
            <h3 className="text-xs font-medium text-muted-foreground">
                {t('issues.detail:requesters.title', { n: requesters.length })}
            </h3>
            {requesters.length ? (
                <ul className="grid gap-1">
                    {requesters.map((row) => (
                        <li key={`${row.dotId}:${row.userId}`} className="[overflow-wrap:anywhere]">
                            <span className="font-medium">
                                {detail.users[`dot:${row.dotId}`] ?? t('issues.detail:requesters.deleted-socio')}
                            </span>{' '}
                            <span className="text-muted-foreground">
                                {t('issues.detail:requesters.for', {
                                    person: detail.users[row.userId] ?? row.userId,
                                    at: new Date(row.createdAt),
                                })}
                            </span>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="text-xs text-muted-foreground">{t('issues.detail:requesters.none')}</p>
            )}
        </section>
    );
}

/** What members see in the side panel. */
function ReadOnlyFields({ detail }: { detail: IssueDetail }) {
    const { t } = useTranslation(['issues.detail']);
    const terms = useIssueTerms();
    const { issue } = detail;
    const none = t('issues.detail:none');
    const rows: [string, ReactNode][] = [
        [t('issues.detail:field.status'), terms.status(issue.status)],
        [t('issues.detail:field.priority'), terms.priority(issue.priority)],
        [t('issues.detail:field.kind'), terms.kind(issue.kind)],
        [t('issues.detail:field.area'), issue.area ? terms.area(issue.area) : none],
        [
            t('issues.detail:field.labels'),
            issue.labels.length
                ? listFormat({ type: 'unit', style: 'short' }).format(issue.labels.map(terms.label))
                : none,
        ],
        [
            t('issues.detail:field.components'),
            issue.components?.length ? (
                <span key="components" className="flex flex-wrap gap-1">
                    {issue.components.map((ref) => (
                        <ComponentChip key={ref} componentRef={ref} labels={detail.components} />
                    ))}
                </span>
            ) : (
                none
            ),
        ],
        [
            t('issues.detail:field.assignee'),
            issue.assigneeId
                ? (detail.users[issue.assigneeId] ?? issue.assigneeId)
                : t('issues.detail:field.unassigned'),
        ],
        ...(issue.resolution
            ? ([[t('issues.detail:field.resolution'), issue.resolution]] as [string, ReactNode][])
            : []),
    ];
    return (
        <dl data-slot="issue-fields" className="grid gap-3 text-sm">
            {rows.map(([label, value]) => (
                <div key={label} className="grid gap-0.5">
                    <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
                    <dd className="[overflow-wrap:anywhere]">{value}</dd>
                </div>
            ))}
        </dl>
    );
}

function DeleteIssue({ number, onDeleted }: { number: number; onDeleted: () => void }) {
    const { t } = useTranslation(['issues.detail']);
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const key = issueKey(number);
    if (!confirming) {
        return (
            <Button
                variant="ghost"
                size="sm"
                className="w-fit text-destructive hover:text-destructive"
                onClick={() => setConfirming(true)}
            >
                <Trash2 />
                {t('issues.detail:delete.button')}
            </Button>
        );
    }
    return (
        <div
            role="group"
            aria-label={t('issues.detail:delete.group', { key })}
            className="grid gap-2 rounded-md border border-destructive/40 p-3"
        >
            <p data-slot="issue-delete-warning" className="text-xs">
                {t('issues.detail:delete.warning', { key })}
            </p>
            <div className="flex gap-2">
                <Button
                    variant="destructive"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                        setBusy(true);
                        void api(`/issues/${number}`, 'DELETE')
                            .then(() => {
                                toast.success(t('issues.detail:delete.done', { key }));
                                onDeleted();
                            })
                            .catch((error: unknown) => {
                                setBusy(false);
                                toast.error(message(error, t('issues.detail:delete.failed')));
                            });
                    }}
                >
                    {t('issues.detail:delete.confirm', { key })}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                    {t('issues.detail:keep')}
                </Button>
            </div>
        </div>
    );
}
