import { X } from 'lucide-react';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import { issueNumber, issuePath } from '@socio/shared/issues/issue-board';
import {
    isBlockerSatisfied,
    issueKey,
    ISSUE_LINK_RELATIONS,
    type IssueDetail,
    type IssueLinkRef,
    type IssueLinkRelation,
    type IssueTitle,
} from '@socio/shared/issues/issue-types';

import { nativeSelect } from '../../components/form-fields';
import { api } from '../../lib/api';

import { IssueKey, StatusBadge } from './IssueBadges';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

/**
 * The groups, in the panel's order. Each relation's name, from the open
 * issue's side, is `links.relation.<relation>`; its group's title
 * `links.group.<relation>`.
 */
const GROUPS: ReadonlyArray<{
    relation: IssueLinkRelation;
    slot: string;
}> = [
    { relation: 'blocked_by', slot: 'issue-blockers' },
    { relation: 'blocks', slot: 'issue-blocks' },
    { relation: 'related', slot: 'issue-related' },
];

const relationSelect = cn(nativeSelect, 'h-8 md:text-xs');

/**
 * Linked issues in the side panel: what this one waits for (CB-29), what
 * waits for it, and what is related to it with no direction (CB-274).
 * Admins link an issue (choose it, then related, blocks or blocked by),
 * change a link's type and remove it; a pair has one link. Members relate
 * issues and remove related links; blocking links are triage fields, so
 * theirs to read only. A blocker that
 * is done or won't fix no longer holds anything, and shows dimmed.
 */
export function IssueLinks({
    detail,
    admin,
    refresh,
}: {
    detail: IssueDetail;
    admin: boolean;
    refresh: () => Promise<void>;
}) {
    const { t } = useTranslation(['issues.detail']);
    const { issue } = detail;
    const links: Record<IssueLinkRelation, IssueLinkRef[]> = {
        blocked_by: detail.blockedBy ?? [],
        blocks: detail.blocks ?? [],
        related: detail.related ?? [],
    };
    const listId = useId();
    const [draft, setDraft] = useState('');
    const [relation, setRelation] = useState<IssueLinkRelation>('related');
    const [titles, setTitles] = useState<IssueTitle[]>();
    const [busy, setBusy] = useState(false);
    const total = GROUPS.reduce((sum, group) => sum + links[group.relation].length, 0);
    // What this person may choose: members relate issues only.
    const relations = admin ? ISSUE_LINK_RELATIONS : (['related'] as const);
    const linked = new Set(GROUPS.flatMap((group) => links[group.relation].map((ref) => ref.number)));
    // Offered while typing: the open issues, from the palette's light list.
    const loadTitles = () => {
        if (titles) {
            return;
        }
        setTitles([]);
        void api<IssueTitle[]>('/issues/titles?open=true')
            .then(setTitles)
            .catch(() => setTitles(undefined));
    };
    const run = async (work: () => Promise<unknown>, fallback: string) => {
        setBusy(true);
        try {
            await work();
            await refresh();
            return true;
        } catch (error) {
            toast.error(message(error, fallback));
            return false;
        } finally {
            setBusy(false);
        }
    };
    const put = (other: number, next: IssueLinkRelation) =>
        api(`/issues/${issue.number}/links/${other}`, 'PUT', { relation: next });
    const add = async () => {
        const other = issueNumber(draft.trim());
        if (!other) {
            return toast.error(t('issues.detail:links.enter-key', { example: issueKey(12) }));
        }
        if (await run(() => put(other, relation), t('issues.detail:links.link-failed'))) {
            setDraft('');
        }
    };
    const change = (ref: IssueLinkRef, next: IssueLinkRelation) =>
        void run(() => put(ref.number, next), t('issues.detail:links.change-failed'));
    const remove = (ref: IssueLinkRef) =>
        void run(
            () => api(`/issues/${issue.number}/links/${ref.number}`, 'DELETE'),
            t('issues.detail:links.remove-failed'),
        );
    return (
        <section data-slot="issue-links" className="grid gap-3 text-sm">
            {GROUPS.map(({ relation: group, slot }) =>
                links[group].length ? (
                    <div key={group} className="grid gap-1.5">
                        <h3 className="text-xs font-medium text-muted-foreground">
                            {t(`issues.detail:links.group.${group}`)}
                        </h3>
                        <ul data-slot={slot} className="grid gap-1.5">
                            {links[group].map((ref) => (
                                <LinkRow
                                    key={ref.number}
                                    link={ref}
                                    action={
                                        admin && (
                                            <select
                                                data-slot="native-select"
                                                aria-label={t('issues.detail:links.type-of', {
                                                    key: issueKey(ref.number),
                                                })}
                                                className={cn(relationSelect, 'h-7 w-fit')}
                                                value={group}
                                                disabled={busy}
                                                onChange={(event) =>
                                                    change(ref, event.target.value as IssueLinkRelation)
                                                }
                                            >
                                                {ISSUE_LINK_RELATIONS.map((option) => (
                                                    <option key={option} value={option}>
                                                        {t(`issues.detail:links.relation.${option}`)}
                                                    </option>
                                                ))}
                                            </select>
                                        )
                                    }
                                    remove={
                                        (admin || group === 'related') && (
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="size-6 shrink-0 text-muted-foreground"
                                                aria-label={t('issues.detail:links.remove', {
                                                    key: issueKey(ref.number),
                                                })}
                                                disabled={busy}
                                                onClick={() => remove(ref)}
                                            >
                                                <X className="size-3.5" />
                                            </Button>
                                        )
                                    }
                                />
                            ))}
                        </ul>
                    </div>
                ) : null,
            )}
            <div className="grid gap-1.5">
                <h3 className="text-xs font-medium text-muted-foreground">{t('issues.detail:links.title')}</h3>
                {!total && <p className="text-xs text-muted-foreground">{t('issues.detail:links.empty')}</p>}
                <form
                    data-slot="issue-link-form"
                    className="flex flex-wrap items-center gap-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void add();
                    }}
                >
                    <select
                        data-slot="native-select"
                        aria-label={t('issues.detail:links.type')}
                        className={cn(relationSelect, 'w-fit shrink-0')}
                        value={relation}
                        onChange={(event) => setRelation(event.target.value as IssueLinkRelation)}
                    >
                        {relations.map((option) => (
                            <option key={option} value={option}>
                                {t(`issues.detail:links.relation.${option}`)}
                            </option>
                        ))}
                    </select>
                    <Input
                        aria-label={t('issues.detail:links.issue')}
                        placeholder={issueKey(12)}
                        list={listId}
                        value={draft}
                        maxLength={16}
                        className="h-8 min-w-[6rem] flex-1"
                        onFocus={loadTitles}
                        onChange={(event) => setDraft(event.target.value)}
                    />
                    <datalist id={listId}>
                        {(titles ?? [])
                            .filter((item) => item.number !== issue.number && !linked.has(item.number))
                            .map((item) => (
                                <option key={item.number} value={issueKey(item.number)}>
                                    {item.title}
                                </option>
                            ))}
                    </datalist>
                    <Button type="submit" variant="outline" size="sm" disabled={busy || !draft.trim()}>
                        {t('issues.detail:links.add')}
                    </Button>
                </form>
            </div>
            {(admin || links.blocked_by.length > 0) && (
                <p className="text-xs text-muted-foreground">{t('issues.detail:links.hint')}</p>
            )}
        </section>
    );
}

/** One linked issue: its key and status, the title under them (dimmed once closed). */
function LinkRow({
    link,
    action,
    remove,
}: {
    link: IssueLinkRef;
    /** Under the title: the link's type, for admins. */
    action?: React.ReactNode;
    remove?: React.ReactNode;
}) {
    return (
        <li
            data-slot="issue-link-row"
            data-open={!isBlockerSatisfied(link.status)}
            className={cn(
                'flex items-start gap-2 rounded-md border bg-background px-2 py-1.5',
                isBlockerSatisfied(link.status) && 'opacity-70',
            )}
        >
            <div className="grid min-w-0 flex-1 gap-0.5">
                <span className="flex flex-wrap items-center gap-1.5">
                    <IssueKey number={link.number} />
                    <StatusBadge status={link.status} />
                </span>
                <Link
                    to={issuePath(link.number)}
                    state={{ fromIssues: true }}
                    className="text-xs leading-snug [overflow-wrap:anywhere] hover:underline focus-visible:underline focus-visible:outline-none"
                >
                    {link.title}
                </Link>
                {action}
            </div>
            {remove}
        </li>
    );
}
