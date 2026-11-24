import { useState } from 'react';
import { toast } from 'sonner';

import { areaLabel, KIND_LABEL, PRIORITY_LABEL } from '@socio/shared/issues/issue-board';
import type { IssueDetail } from '@socio/shared/issues/issue-types';

import { api } from '../../lib/api';

import { PriorityPill, Tag } from './IssueBadges';
import { formatTime } from './IssueComments';
import { ComponentChip, componentText } from './IssueComponents';

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
    const proposal = detail.triage;
    const [busy, setBusy] = useState(false);
    if (!proposal) {
        return null;
    }
    const decide = async (action: 'apply' | 'ignore') => {
        setBusy(true);
        try {
            await api(`/issues/${detail.issue.number}/triage/${action}`, 'POST');
            toast.success(action === 'apply' ? 'Triage proposal applied' : 'Proposal ignored');
            await refresh();
        } catch (error) {
            toast.error(message(error, 'Could not save the decision.'));
            await refresh();
        } finally {
            setBusy(false);
        }
    };
    const decided =
        proposal.decidedAt !== null && proposal.decidedBy
            ? `${proposal.state === 'applied' ? 'Applied' : 'Ignored'} by ${detail.users[proposal.decidedBy] ?? proposal.decidedBy} · ${formatTime(proposal.decidedAt)}`
            : undefined;
    return (
        <section
            data-slot="issue-triage"
            data-state={proposal.state}
            aria-labelledby="issue-triage-title"
            className="grid gap-2 rounded-lg border bg-card p-3 text-sm text-card-foreground"
        >
            <h3 id="issue-triage-title" className="text-sm font-medium text-muted-foreground">
                Triage proposal
            </h3>
            <div className="flex flex-wrap items-center gap-1">
                <Tag title="Proposed kind">{KIND_LABEL[proposal.kind]}</Tag>
                {proposal.area && <Tag title="Proposed area">{areaLabel(proposal.area)}</Tag>}
                <PriorityPill
                    priority={proposal.priority}
                    title={`Proposed priority: ${PRIORITY_LABEL[proposal.priority]}`}
                />
                {proposal.labels.map((label) => (
                    <Tag key={label} title="Proposed label">
                        {label}
                    </Tag>
                ))}
                {(proposal.components ?? []).map((ref) => (
                    <ComponentChip
                        key={ref}
                        componentRef={ref}
                        labels={detail.components}
                        title={`Proposed component: ${componentText(ref, detail.components)}`}
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
                        Apply
                    </Button>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void decide('ignore')}>
                        Ignore
                    </Button>
                </div>
            ) : (
                <p className="text-xs text-muted-foreground">
                    An admin can apply or ignore it. Nothing has changed yet.
                </p>
            )}
        </section>
    );
}
