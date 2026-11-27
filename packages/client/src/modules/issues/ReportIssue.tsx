import { Bug } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import { ATTACHMENT_HINT } from '@socio/shared/issues/issue-attachment-files';
import { issuePath } from '@socio/shared/issues/issue-board';
import {
    ISSUE_AREAS,
    ISSUE_KINDS,
    ISSUE_PRIORITIES,
    issueKey,
    type IssueArea,
    type IssueDetail,
    type IssueKind,
    type IssuePriority,
} from '@socio/shared/issues/issue-types';
import { MODULE_IDS } from '@socio/shared/modules';

import { onDemand, useOnDemand } from '../../i18n/on-demand';
import { api } from '../../lib/api';
import { HeaderMenuItem } from '../../shell/header-menu';
import type { SlotProps } from '../types';

import { acceptFiles, pastedFiles, uploadAll, useUploadProblems } from './attachments';
import { useIssueTerms } from './issue-words';
import { AttachButton, PendingFiles } from './IssueAttachments';
import { ComponentPicker, componentsOf, draftedComponents, useComponentOptions } from './IssueComponents';
import { ChoiceField, Field } from './IssueFields';
import { closeReport, notifyIssuesChanged, openReport, useReportRequest, type ReportDraft } from './report';

import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { DialogReturnFocus } from '@/components/ui/return-focus';
import { Textarea } from '@/components/ui/textarea';

/**
 * The issue area of the page: its module's, where one matches by name
 * (Scheduled & activity's tasks are Schedules'), else Homepage on Home
 * (`/`, which has no module of its own).
 */
export const areaOf = (moduleId: string | undefined, path?: string) =>
    moduleId === MODULE_IDS.activity
        ? 'schedules'
        : ISSUE_AREAS.includes(moduleId as IssueArea)
          ? (moduleId as IssueArea)
          : path === '/'
            ? 'homepage'
            : undefined;

/**
 * What "Report issue" starts with on a page: its area, and the plugin its
 * page is about (`componentsOf`).
 */
const pageDraft = (moduleId: string | undefined, pathname: string): ReportDraft => {
    const components = componentsOf(pathname);
    return { area: areaOf(moduleId, pathname), ...(components ? { components } : {}) };
};

/**
 * "Report issue" in the header of every page but Issues' own (which has
 * "New issue"), and the one report dialog: the title, a description, kind,
 * priority, area, components and attachments, filed into triage. The area
 * defaults to the page's module where one matches, the components to the
 * plugin whose page it is. Others open it with `openReport`. The button's
 * words (issues.slots) and the dialog's (issues.report, issues.form,
 * issues.terms) load on demand: each shows once its words are in.
 */
export function ReportIssue({ moduleId }: SlotProps['header.actions']) {
    const worded = useOnDemand(['issues.slots']);
    const { t } = useTranslation(['issues.slots']);
    const request = useReportRequest();
    const { pathname } = useLocation();
    // Kept past the request (which goes as the dialog closes), for the focus.
    const [back, setBack] = useState<HTMLElement | null>(null);
    useEffect(() => {
        if (request) {
            setBack(request.returnFocus ?? null);
        }
    }, [request]);
    return (
        <DialogReturnFocus value={back}>
            {moduleId !== MODULE_IDS.issues && worded && (
                <Button
                    variant="ghost"
                    size="icon"
                    // On phones it is in the account menu (ReportIssueItem).
                    className="max-md:hidden"
                    aria-label={t('issues.slots:report')}
                    title={t('issues.slots:report')}
                    onClick={() => openReport(pageDraft(moduleId, pathname))}
                >
                    <Bug className="size-4.5" />
                </Button>
            )}
            {request && <WordedReportDialog key={request.at} draft={request.draft} />}
        </DialogReturnFocus>
    );
}

/**
 * "Report issue" in the account menu, at every width (on phones the only
 * one: the header has no room). The dialog is the header's (ReportIssue).
 */
export function ReportIssueItem({ moduleId, close }: SlotProps['account.items']) {
    const worded = useOnDemand(['issues.slots']);
    const { t } = useTranslation(['issues.slots']);
    const { pathname } = useLocation();
    if (!worded) {
        return null;
    }
    return (
        <DropdownMenuItem
            onSelect={() => {
                close();
                openReport(pageDraft(moduleId, pathname));
            }}
        >
            <Bug />
            {t('issues.slots:report')}
        </DropdownMenuItem>
    );
}

/**
 * "Report issue" in the phone header's ⋯ menu, on every page but Issues'
 * own, as in the header. The dialog is the header's (ReportIssue).
 */
export function ReportIssueMenuItem({ moduleId }: SlotProps['header.menu']) {
    const worded = useOnDemand(['issues.slots']);
    const { t } = useTranslation(['issues.slots']);
    const { pathname } = useLocation();
    if (moduleId === MODULE_IDS.issues || !worded) {
        return null;
    }
    return (
        <HeaderMenuItem open={(from) => openReport(pageDraft(moduleId, pathname), { returnFocus: from })}>
            <Bug />
            {t('issues.slots:report')}
        </HeaderMenuItem>
    );
}

function ReportDialog({ draft }: { draft: ReportDraft }) {
    const { t } = useTranslation(['issues.report']);
    const terms = useIssueTerms();
    const uploadProblems = useUploadProblems();
    const navigate = useNavigate();
    const [title, setTitle] = useState(draft.title ?? '');
    const [body, setBody] = useState(draft.body ?? '');
    const [kind, setKind] = useState<IssueKind>(draft.kind ?? 'bug');
    const [priority, setPriority] = useState<IssuePriority>(draft.priority ?? 'medium');
    const [area, setArea] = useState<IssueArea | null>(draft.area ?? null);
    // Components (CB-442): a drafted ref counts only once it is among the
    // reader's options, so a prefill never names what they can't see.
    const options = useComponentOptions();
    const [picked, setPicked] = useState<string[]>();
    const initialComponents = draftedComponents(draft.components, options);
    const components = picked ?? initialComponents;
    const [files, setFiles] = useState<File[]>([]);
    const [busy, setBusy] = useState(false);
    const [discardOpen, setDiscardOpen] = useState(false);
    const dialog = useRef<HTMLDivElement>(null);
    const editingFocus = useRef<HTMLElement | null>(null);
    const dirty =
        title !== (draft.title ?? '') ||
        body !== (draft.body ?? '') ||
        kind !== (draft.kind ?? 'bug') ||
        priority !== (draft.priority ?? 'medium') ||
        area !== (draft.area ?? null) ||
        components.length !== initialComponents.length ||
        components.some((ref) => !initialComponents.includes(ref)) ||
        files.length > 0;
    const dismiss = () => {
        if (busy) {
            return;
        }
        if (!dirty) {
            closeReport();
            return;
        }
        setDiscardOpen(true);
    };
    const addFiles = (picked: File[]) => {
        const { accepted, refused } = acceptFiles(picked, files.length);
        if (accepted.length) {
            setFiles((current) => [...current, ...accepted]);
        }
        for (const problem of refused) {
            toast.error(problem);
        }
    };
    const submit = async () => {
        if (busy) {
            return;
        }
        setBusy(true);
        try {
            const { issue } = await api<IssueDetail>('/issues', 'POST', {
                title: title.trim(),
                body: body.trim(),
                kind,
                priority,
                ...(area ? { area } : {}),
                ...(components.length ? { components } : {}),
                ...(draft.runId ? { runId: draft.runId } : {}),
            });
            const key = issueKey(issue.number);
            const failed = uploadProblems(await uploadAll(issue.number, files));
            closeReport();
            notifyIssuesChanged();
            const open = {
                label: t('issues.report:open'),
                onClick: () => void navigate(issuePath(issue.number)),
            };
            if (failed.length) {
                toast.warning(t('issues.report:filed-partly', { key }), {
                    description: failed.join('\n'),
                    action: open,
                });
            } else {
                toast.success(t('issues.report:filed', { key }), {
                    description: issue.title,
                    action: open,
                });
            }
        } catch (e) {
            toast.error(e instanceof Error ? e.message : t('issues.report:failed'));
        } finally {
            setBusy(false);
        }
    };
    const form = (
        <form
            data-slot="report-issue-form"
            className="grid gap-4"
            onFocusCapture={(event) => {
                // The field to return to after "Keep editing". A click on Cancel focuses Cancel first, so the
                // dismissal buttons don't count.
                if (event.target instanceof HTMLElement && !event.target.closest('[data-slot="dialog-close"]')) {
                    editingFocus.current = event.target;
                }
            }}
            onSubmit={(e) => {
                e.preventDefault();
                void submit();
            }}
            onPaste={(e) => {
                const pasted = pastedFiles(e.clipboardData);
                if (!pasted.length) {
                    return;
                }
                e.preventDefault();
                addFiles(pasted);
            }}
        >
            <DialogHeader>
                <DialogTitle>{t('issues.report:title')}</DialogTitle>
                <DialogDescription>
                    {t('issues.report:description', { context: draft.runId ? 'run' : undefined })}
                </DialogDescription>
            </DialogHeader>
            <Field label={t('issues.report:field.title')}>
                {(id) => (
                    <Input
                        aria-labelledby={id}
                        placeholder={t('issues.report:field.title-placeholder')}
                        value={title}
                        maxLength={200}
                        required
                        autoFocus
                        onChange={(e) => setTitle(e.target.value)}
                    />
                )}
            </Field>
            <Field label={t('issues.report:field.description')}>
                {(id) => (
                    <Textarea
                        aria-labelledby={id}
                        placeholder={t('issues.report:field.description-placeholder')}
                        value={body}
                        rows={5}
                        maxLength={20_000}
                        className="max-h-72"
                        onChange={(e) => setBody(e.target.value)}
                    />
                )}
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <ChoiceField
                    label={t('issues.report:field.kind')}
                    value={kind}
                    options={ISSUE_KINDS}
                    labelOf={terms.kind}
                    onChange={(value) => value && setKind(value)}
                />
                <ChoiceField
                    label={t('issues.report:field.priority')}
                    value={priority}
                    options={ISSUE_PRIORITIES}
                    labelOf={terms.priority}
                    onChange={(value) => value && setPriority(value)}
                />
                <ChoiceField
                    label={t('issues.report:field.area')}
                    value={area}
                    options={ISSUE_AREAS}
                    labelOf={terms.area}
                    none={t('issues.report:field.no-area')}
                    onChange={setArea}
                />
            </div>
            <ComponentPicker value={components} onChange={setPicked} options={options} />
            <div className="grid gap-2">
                <div className="flex flex-wrap items-center gap-2">
                    <AttachButton onFiles={addFiles} disabled={busy} />
                    <span className="text-xs text-muted-foreground">{ATTACHMENT_HINT}</span>
                </div>
                <PendingFiles
                    files={files}
                    onRemove={(index) => setFiles((current) => current.filter((_, i) => i !== index))}
                />
            </div>
            <DialogFooter>
                <DialogClose asChild>
                    <Button type="button" variant="outline" disabled={busy}>
                        {t('issues.report:cancel')}
                    </Button>
                </DialogClose>
                <Button type="submit" disabled={busy || title.trim().length < 3}>
                    {busy ? t('issues.report:filing') : t('issues.report:file')}
                </Button>
            </DialogFooter>
        </form>
    );
    return (
        <Dialog open onOpenChange={(open) => !open && dismiss()}>
            <DialogContent
                ref={dialog}
                showCloseButton={!busy}
                className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-xl"
            >
                {form}
            </DialogContent>
            <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
                <AlertDialogContent
                    onCloseAutoFocus={(event) => {
                        // Only the report itself returns focus to the page.
                        event.preventDefault();
                        const focused = editingFocus.current;
                        (focused?.isConnected ? focused : dialog.current)?.focus();
                    }}
                >
                    <AlertDialogHeader>
                        <AlertDialogTitle>{t('issues.report:discard.title')}</AlertDialogTitle>
                        <AlertDialogDescription>{t('issues.report:discard.body')}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>{t('issues.report:discard.keep')}</AlertDialogCancel>
                        <Button type="button" variant="destructive" onClick={closeReport}>
                            {t('issues.report:discard.confirm')}
                        </Button>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </Dialog>
    );
}

/** The dialog, once its words are in (on demand: a click opens it). */
const WordedReportDialog = onDemand(['issues.report', 'issues.form', 'issues.terms'], ReportDialog);
