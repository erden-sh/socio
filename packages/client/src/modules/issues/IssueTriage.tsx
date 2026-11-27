import { useState } from 'react';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import type { IssueDetail } from '@socio/shared/issues/issue-types';

import { api } from '../../lib/api';

import { useIssueTerms } from './issue-words';
import { PriorityPill, Tag } from './IssueBadges';
import { ComponentChip, useComponentText } from './IssueComponents';

import { Button } from '@/components/ui/button';

const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

/**
 * Automatic triage (CB-30): the proposal the workspace's model made for a
 * new issue, as the comment on it says. Nothing changed by itself; an admin
 * applies it (kind, area, priority, labels and components in one action) or
 * ignores it. Everyone sees what was proposed and what was decided; the
 * suggested components are only those the reader may see (CB-442).
 */
export function IssueTriage({
    detail,
    admin,
    refresh,
}: {
    detail: IssueDetail;
    admin: boolean;
    refresh: () => Promise<void>;
}) {
    const { t } = useTranslation(['issues.detail']);
    const terms = useIssueTerms();
    const componentText = useComponentText();
    const proposal = detail.triage;
    const [busy, setBusy] = useState(false);
    if (!proposal) {
        return null;
    }
    const decide = async (action: 'apply' | 'ignore') => {
        setBusy(true);
        try {
            await api(`/issues/${detail.issue.number}/triage/${action}`, 'POST');
            toast.success(action === 'apply' ? t('issues.detail:triage.applied') : t('issues.detail:triage.ignored'));
            await refresh();
        } catch (error) {
            toast.error(message(error, t('issues.detail:triage.failed')));
            await refresh();
        } finally {
            setBusy(false);
        }
    };
    const decided =
        proposal.decidedAt !== null && proposal.decidedBy
            ? t('issues.detail:triage.decided', {
                  name: detail.users[proposal.decidedBy] ?? proposal.decidedBy,
                  at: new Date(proposal.decidedAt),
                  context: proposal.state === 'applied' ? undefined : 'ignored',
              })
            : undefined;
    return (
        <section
            data-slot="issue-triage"
            data-state={proposal.state}
            aria-labelledby="issue-triage-title"
            className="grid gap-2 rounded-lg border bg-card p-3 text-sm text-card-foreground"
        >
            <h3 id="issue-triage-title" className="text-sm font-medium text-muted-foreground">
                {t('issues.detail:triage.title')}
            </h3>
            <div className="flex flex-wrap items-center gap-1">
                <Tag title={t('issues.detail:triage.kind')}>{terms.kind(proposal.kind)}</Tag>
                {proposal.area && <Tag title={t('issues.detail:triage.area')}>{terms.area(proposal.area)}</Tag>}
                <PriorityPill
                    priority={proposal.priority}
                    title={t('issues.detail:triage.priority', { priority: terms.priority(proposal.priority) })}
                />
                {proposal.labels.map((label) => (
                    <Tag key={label} title={t('issues.detail:triage.label')}>
                        {terms.label(label)}
                    </Tag>
                ))}
                {(proposal.components ?? []).map((ref) => (
                    <ComponentChip
                        key={ref}
                        componentRef={ref}
                        labels={detail.components}
                        title={t('issues.detail:triage.component', { name: componentText(ref, detail.components) })}
                    />
                ))}
            </div>
            <p className="text-xs [overflow-wrap:anywhere] text-muted-foreground">{proposal.reason}</p>
            {decided ? (
                <p data-slot="issue-triage-decision" className="text-xs">
                    {decided}
                </p>
            ) : admin ? (
                <div className="flex gap-2">
                    <Button size="sm" disabled={busy} onClick={() => void decide('apply')}>
                        {t('issues.detail:triage.apply')}
                    </Button>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void decide('ignore')}>
                        {t('issues.detail:triage.ignore')}
                    </Button>
                </div>
            ) : (
                <p className="text-xs text-muted-foreground">{t('issues.detail:triage.waiting')}</p>
            )}
        </section>
    );
}
