import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import { areaLabel, issuePath, KIND_LABEL, PRIORITY_LABEL } from '@socio/shared/issues/issue-board';
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
import { pageExcerpt, type Page } from '@socio/shared/pages/page-library';
import type { WorkspaceState } from '@socio/shared/types';

import { onDemand } from '../../i18n/on-demand';
import { api, ApiError } from '../../lib/api';
import { Field, ChoiceField } from '../issues/IssueFields';
import { spacePath } from '../pages/page-navigation';

import { Button } from '@/components/ui/button';
import {
    Dialog as DialogRoot,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/**
 * The repeat intervals the "Create a schedule" dialog offers (WorkspaceDialog
 * `schedule`): reused here so the two stay in sync. The server takes seconds
 * (`/api/tasks`, `intervalSeconds`, minimum 60).
 */
const INTERVALS = [
    { value: 3600, label: 'spaces.promote:intervals.hour' },
    { value: 86400, label: 'spaces.promote:intervals.day' },
    { value: 604800, label: 'spaces.promote:intervals.week' },
] as const;

/** The three kinds of follow-up a Space finding can become (CB-281). */
export type FollowUpDestination = 'issue' | 'schedule' | 'goal';

/** The submit button's words for each destination. */
const SUBMIT_KEYS = {
    issue: 'spaces.promote:submit.issue',
    schedule: 'spaces.promote:submit.schedule',
    goal: 'spaces.promote:submit.goal',
} as const satisfies Record<FollowUpDestination, string>;

/**
 * The citation line that ties a follow-up to its source page, matching the
 * chat's existing page-context convention (`From [Title](/spaces/…/pages/…)`).
 * Prepended to the body so the destination carries the source link without a
 * new server field.
 */
export function pageCitation(page: Pick<Page, 'id' | 'spaceId' | 'title'>) {
    const url = spacePath(page.spaceId, page.id);
    const label = page.title.trim() || 'Untitled page';
    return `From [${label}](${url})`;
}

/**
 * "Create follow-up" from a Space page (CB-281): a review dialog that turns a
 * finding into a goal, a recurring schedule, or a board issue. The title and
 * body are prefilled from the page (with a citation to it), the user edits
 * and picks a destination, and only then is anything created — through the
 * existing create-issue, create-schedule and goal-set paths, not a new one.
 *
 * Destinations are gated by what the page can reach:
 * - Issue: any signed-in person (the board's own filing rules apply server-side).
 * - Schedule: needs inference set up and a specialist for the Space (a schedule
 *   runs in a conversation of its own, bound to a thread the person owns).
 * - Goal: needs a specialist for the Space — there is no web "create a goal"
 *   endpoint, so the goal destination asks that specialist to set the goal,
 *   reusing the existing chat → `goal_set` → approval path.
 *
 * Its words load on demand (spaces.promote).
 */
function PromoteFinding({
    page,
    workspace,
    onClose,
    onAskGoal,
}: {
    page: Page;
    workspace: WorkspaceState;
    onClose: () => void;
    /**
     * For the goal destination: open the page's conversation seeded with the
     * goal request, so the specialist proposes a goal the person then approves.
     * PageDocument wires this to its PageConversation.
     */
    onAskGoal: (prompt: string, dotId: string) => void;
}) {
    const { t } = useTranslation(['spaces.promote']);
    const navigate = useNavigate();
    const citation = pageCitation(page);
    const excerpt = pageExcerpt(page.content);
    const bodyDefault = `${citation}:\n\n${excerpt}`.trim();

    const [title, setTitle] = useState(page.title.trim() || t('spaces.promote:untitled'));
    const [body, setBody] = useState(bodyDefault);
    const [destination, setDestination] = useState<FollowUpDestination>('issue');
    const [intervalSeconds, setIntervalSeconds] = useState(86400);
    const [kind, setKind] = useState<IssueKind>('improvement');
    const [priority, setPriority] = useState<IssuePriority>('medium');
    const [area, setArea] = useState<IssueArea | null>('spaces');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    // Who can reach what. The page conversation endpoint and /tasks need a
    // specialist that can read this Space; goals need one too (the specialist
    // runs goal_set). Schedules also need inference configured.
    const spaceDot = workspace.dots.find((dot) => !dot.archivedAt && dot.spaceIds.includes(page.spaceId));
    const researchReady = workspace.setup.missing.length === 0;
    const canSchedule = !!spaceDot && researchReady;
    const canGoal = !!spaceDot;

    // Only offer destinations the person can act on. Issue is always offered;
    // schedule and goal are dropped silently when no specialist can reach the
    // page (the page chat says the same: "Add a specialist to work with this
    // Space").
    const destinations: {
        value: FollowUpDestination;
        label: string;
        hint: string;
    }[] = [
        {
            value: 'issue',
            label: t('spaces.promote:destinations.issue'),
            hint: t('spaces.promote:destinations.issue-hint'),
        },
    ];
    if (canSchedule) {
        destinations.push({
            value: 'schedule',
            label: t('spaces.promote:destinations.schedule'),
            hint: t('spaces.promote:destinations.schedule-hint'),
        });
    }
    if (canGoal) {
        destinations.push({
            value: 'goal',
            label: t('spaces.promote:destinations.goal'),
            hint: t('spaces.promote:destinations.goal-hint'),
        });
    }

    // If the only reachable destination is the issue, don't show the picker.
    const onlyIssue = destinations.length === 1;
    const effective = onlyIssue ? 'issue' : destination;

    const submit = async () => {
        setBusy(true);
        setError('');
        try {
            if (effective === 'issue') {
                const { issue } = await api<IssueDetail>('/issues', 'POST', {
                    title: title.trim(),
                    body: body.trim(),
                    kind,
                    priority,
                    ...(area ? { area } : {}),
                });
                const key = issueKey(issue.number);
                toast.success(t('spaces.promote:toasts.filed', { key }), {
                    description: issue.title,
                    action: {
                        label: t('spaces.promote:toasts.open'),
                        onClick: () => void navigate(issuePath(issue.number)),
                    },
                });
                onClose();
                return;
            }
            if (effective === 'schedule') {
                if (!spaceDot) {
                    throw new Error(t('spaces.promote:errors.no-specialist'));
                }
                // A schedule runs in a conversation the person owns: ensure the page's
                // conversation exists, then bind the task to it (the same /tasks
                // contract the "Create a schedule" dialog uses).
                const thread = await api<{ id: string }>(
                    `/spaces/${page.spaceId}/pages/${page.id}/conversation`,
                    'POST',
                    { dotId: spaceDot.id },
                );
                const task = await api<{ id: string }>('/tasks', 'POST', {
                    prompt: body.trim(),
                    threadId: thread.id,
                    intervalSeconds,
                });
                toast.success(t('spaces.promote:toasts.scheduled'), {
                    description: t('spaces.promote:toasts.scheduled-detail'),
                    action: {
                        label: t('spaces.promote:toasts.open'),
                        onClick: () => void navigate(`/schedules/${encodeURIComponent(task.id)}`),
                    },
                });
                onClose();
                return;
            }
            // goal: ask the specialist to set it, reusing the existing goal_set
            // path (the person approves the request it produces).
            if (!spaceDot) {
                throw new Error(t('spaces.promote:errors.no-specialist'));
            }
            onAskGoal(body.trim(), spaceDot.id);
            toast.message(t('spaces.promote:toasts.asked'), {
                description: t('spaces.promote:toasts.asked-detail', { socio: spaceDot.name }),
            });
            onClose();
            return;
        } catch (e) {
            setError(
                e instanceof ApiError ? e.message : e instanceof Error ? e.message : t('spaces.promote:errors.failed'),
            );
        } finally {
            setBusy(false);
        }
    };

    return (
        <DialogRoot open onOpenChange={(open) => !open && onClose()}>
            <DialogContent
                showCloseButton={false}
                aria-describedby={undefined}
                className="block max-h-[calc(100dvh-48px)] overflow-y-auto rounded-[13px] bg-card px-[23px] py-7.5 text-sm shadow-2xl sm:rounded-[17px] sm:max-w-[30rem]"
            >
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2 text-[22px] leading-tight font-[550] tracking-[-0.03em]">
                        <Sparkles className="size-5 text-muted-foreground" />
                        {t('spaces.promote:title')}
                    </DialogTitle>
                    <DialogDescription>{t('spaces.promote:description')}</DialogDescription>
                </DialogHeader>
                <form
                    data-slot="promote-finding-form"
                    className="mt-4 grid gap-4"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void submit();
                    }}
                >
                    <Field label={t('spaces.promote:fields.title')}>
                        {(id) => (
                            <Input
                                aria-labelledby={id}
                                value={title}
                                maxLength={200}
                                required
                                autoFocus
                                onChange={(e) => setTitle(e.target.value)}
                            />
                        )}
                    </Field>
                    <Field label={t('spaces.promote:fields.body')}>
                        {(id) => (
                            <Textarea
                                aria-labelledby={id}
                                value={body}
                                rows={6}
                                maxLength={20_000}
                                className="max-h-72"
                                onChange={(e) => setBody(e.target.value)}
                            />
                        )}
                    </Field>
                    {!onlyIssue && (
                        <Field label={t('spaces.promote:fields.destination')}>
                            {(id) => (
                                <div role="radiogroup" aria-labelledby={id} className="grid gap-2">
                                    {destinations.map((d) => {
                                        const checked = effective === d.value;
                                        return (
                                            <label
                                                key={d.value}
                                                className={cn(
                                                    'flex cursor-pointer items-start gap-3 rounded-[9px] border p-3 text-xs transition-colors',
                                                    checked ? 'border-primary bg-accent' : 'hover:bg-accent/50',
                                                )}
                                            >
                                                <input
                                                    type="radio"
                                                    name="follow-up-destination"
                                                    value={d.value}
                                                    checked={checked}
                                                    onChange={() => setDestination(d.value)}
                                                    className="sr-only"
                                                />
                                                <span
                                                    aria-hidden
                                                    className={cn(
                                                        'mt-0.5 size-4 shrink-0 rounded-full border',
                                                        checked
                                                            ? 'border-primary bg-primary'
                                                            : 'border-muted-foreground/40',
                                                    )}
                                                />
                                                <span className="grid gap-0.5">
                                                    <span className="font-medium text-foreground">{d.label}</span>
                                                    <span className="text-muted-foreground">{d.hint}</span>
                                                </span>
                                            </label>
                                        );
                                    })}
                                </div>
                            )}
                        </Field>
                    )}
                    {effective === 'issue' && (
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                            <ChoiceField
                                label={t('spaces.promote:fields.kind')}
                                value={kind}
                                options={ISSUE_KINDS}
                                labelOf={(value) => KIND_LABEL[value]}
                                onChange={(value) => value && setKind(value)}
                            />
                            <ChoiceField
                                label={t('spaces.promote:fields.priority')}
                                value={priority}
                                options={ISSUE_PRIORITIES}
                                labelOf={(value) => PRIORITY_LABEL[value]}
                                onChange={(value) => value && setPriority(value)}
                            />
                            <ChoiceField
                                label={t('spaces.promote:fields.area')}
                                value={area}
                                options={ISSUE_AREAS}
                                labelOf={areaLabel}
                                none={t('spaces.promote:fields.no-area')}
                                onChange={setArea}
                            />
                        </div>
                    )}
                    {effective === 'schedule' && (
                        <Field label={t('spaces.promote:fields.repeat')}>
                            {(id) => (
                                <select
                                    aria-labelledby={id}
                                    data-slot="native-select"
                                    className="h-10 rounded-[9px] border border-input bg-background px-3 text-xs md:text-xs dark:bg-input/30"
                                    value={intervalSeconds}
                                    onChange={(e) => setIntervalSeconds(Number(e.target.value))}
                                >
                                    {INTERVALS.map((opt) => (
                                        <option key={opt.value} value={opt.value}>
                                            {t(opt.label)}
                                        </option>
                                    ))}
                                </select>
                            )}
                        </Field>
                    )}
                    {effective === 'goal' && (
                        <p className="text-[11px] leading-[1.7] text-muted-foreground">
                            {t('spaces.promote:goal-note', { socio: spaceDot?.name ?? '' })}
                        </p>
                    )}
                    {error && (
                        <p
                            className="rounded-lg bg-destructive/10 p-3 text-[11px] leading-[1.8] text-destructive"
                            role="alert"
                        >
                            {error}
                        </p>
                    )}
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
                            {t('spaces.promote:cancel')}
                        </Button>
                        <Button type="submit" disabled={busy || title.trim().length < 3}>
                            {busy ? t('spaces.promote:creating') : t(SUBMIT_KEYS[effective])}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </DialogRoot>
    );
}

/** The follow-up dialog (`PromoteFinding`), once its words are in. */
export const PromoteFindingDialog = onDemand(['spaces.promote'], PromoteFinding);
