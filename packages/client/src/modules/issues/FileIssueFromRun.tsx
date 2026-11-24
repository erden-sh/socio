import { Bug } from 'lucide-react';

import type { AgentRunSummary } from '@socio/shared/types';

import type { SlotProps } from '../types';

import { openReport, type ReportDraft } from './report';

import { Button } from '@/components/ui/button';

/**
 * The report form's draft for a failed run: its error, and where it ran.
 * The filed item is linked to the run (CB-194), so Operations can say how
 * long failures take to be reported.
 */
export function runIssueDraft(run: AgentRunSummary): ReportDraft {
    const what = run.title ?? 'a conversation';
    const started = new Date(run.startedAt).toISOString();
    const lines = [
        `A turn failed in ${run.readable ? `[${what}](/chats/${encodeURIComponent(run.threadId)})` : what}${run.dotName ? ` with ${run.dotName}` : ''}.`,
        '',
        `- Run: \`${run.runId}\``,
        `- Started: ${started}`,
        `- Source: ${run.source}`,
        '',
        ...(run.error ? [`**Error:** ${run.error}`, ''] : []),
        ...(run.errorDetail ? ['```', run.errorDetail, '```', ''] : []),
    ];
    const error = (run.error ?? 'failed').replace(/\s+/g, ' ').trim();
    return {
        title: `Run failed: ${error}`.slice(0, 200),
        body: lines.join('\n').trim(),
        kind: 'bug',
        priority: 'medium',
        area: 'runs',
        runId: run.runId,
    };
}

/** "File issue" under a failed run in Runs (the `run.actions` slot). */
export function FileIssueFromRun({ run }: SlotProps['run.actions']) {
    if (run.status !== 'failed') {
        return null;
    }
    return (
        <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            aria-label={`File an issue about the failed run ${run.title ?? run.runId}`}
            onClick={() => openReport(runIssueDraft(run))}
        >
            <Bug className="size-3.5" />
            File issue
        </Button>
    );
}
