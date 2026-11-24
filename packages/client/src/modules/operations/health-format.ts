import { formatNumber, numberFormat } from '@socio/shared/locale';
import type {
    GoalState,
    HealthCoverageId,
    HealthReasoningKind,
    ScheduleState,
} from '@socio/shared/operations/operations-health';

const oneDecimal = numberFormat({ maximumFractionDigits: 1 });
const percent = numberFormat({ style: 'percent', maximumFractionDigits: 0 });
const usd = numberFormat({ style: 'currency', currency: 'USD' });

/** A duration: "420 ms", "3.2 s", "4.5 min", "2.1 h"; "–" with none. */
export function formatMs(ms: number | null | undefined) {
    if (ms === null || ms === undefined) {
        return '–';
    }
    if (ms < 1000) {
        return `${formatNumber(Math.round(ms))} ms`;
    }
    if (ms < 60_000) {
        return `${oneDecimal.format(ms / 1000)} s`;
    }
    if (ms < 3_600_000) {
        return `${oneDecimal.format(ms / 60_000)} min`;
    }
    return `${oneDecimal.format(ms / 3_600_000)} h`;
}

/** How long ago: "35 s ago", "4 min ago", "2 h ago", "3 days ago". */
export function formatAgo(at: number, now: number) {
    const ms = Math.max(0, now - at);
    if (ms < 60_000) {
        return `${Math.round(ms / 1000)} s ago`;
    }
    if (ms < 3_600_000) {
        return `${Math.round(ms / 60_000)} min ago`;
    }
    if (ms < 86_400_000) {
        return `${Math.round(ms / 3_600_000)} h ago`;
    }
    const days = Math.round(ms / 86_400_000);
    return `${days} day${days === 1 ? '' : 's'} ago`;
}

export const formatShare = (covered: number, total: number) => (total ? percent.format(covered / total) : '–');

export const formatUsd = (value: number) => usd.format(value);

export const REASONING_LABELS: Record<HealthReasoningKind, string> = {
    summary: 'Summary',
    raw: 'Raw',
    hidden: 'Hidden',
    none: 'None',
    mixed: 'Mixed',
    unknown: 'Unknown',
};

export const SCHEDULE_STATE_LABELS: Record<ScheduleState, string> = {
    failing: 'Failing',
    paused: 'Paused',
    overdue: 'Overdue',
    ok: 'On time',
    stopped: 'Stopped',
};

export const GOAL_STATE_LABELS: Record<GoalState, string> = {
    stalled: 'Stalled',
    active: 'Active',
    done: 'Done',
    cancelled: 'Canceled',
};

/** What each coverage row counts, and why some data lacks it. */
export const COVERAGE_LABELS: Record<HealthCoverageId, { label: string; gap: string }> = {
    trace: {
        label: 'Turns with a trace',
        gap: 'Older turns kept no timings or tokens.',
    },
    firstOutput: {
        label: 'Model rounds timed to first output',
        gap: 'Some models and older rounds weren’t timed.',
    },
    reasoningKind: {
        label: 'Traced turns that say their reasoning kind',
        gap: 'Older turns show as Unknown.',
    },
    reasoningTokens: {
        label: 'Traced turns with reasoning tokens reported',
        gap: 'Some models count reasoning in their output tokens.',
    },
    receivedAt: {
        label: 'Turns with a queue time',
        gap: 'Older turns didn’t record when their message came in.',
    },
    trigger: {
        label: 'Turns that say who started them',
        gap: 'Older turns are credited to the chat’s owner.',
    },
    dueAt: {
        label: 'Scheduled runs with a due time',
        gap: 'Older runs didn’t record when they came due, so lateness skips them.',
    },
};

/** The analytics store's sources, as people know them: every ETL step's. */
export const SOURCE_LABELS: Record<string, string> = {
    agent_runs: 'Turns, messages and tool calls',
    dimensions: 'People, socios, Spaces and chats',
    job_runs: 'Job runs',
    runs: 'Scheduled runs',
    schedules: 'Schedules, goals and long runs',
    retention: 'Retention',
    // Reliability (CB-189).
    taxonomy: 'Failure categories',
    // Failure labels (CB-198).
    labels: 'Failure labels',
    session_labels: 'Session intent and themes',
    issues: 'The Improvements board',
    // Activity and Value (CB-190).
    approval_audit: 'Approvals',
    space_writes: 'Pages made in Spaces',
    message_reactions: 'Reactions',
    memories: 'Memories',
    // Knowledge and Capabilities (CB-191).
    pages: 'Space pages',
    page_revisions: 'Page edits',
    data_audit: 'Dataset access',
    data_dataset_days: 'Dataset sizes',
    storage: 'Storage',
    dot_requests: 'Capability requests',
    // Grounding (CB-194).
    run_refs: 'What turns read',
    issue_runs: 'Items filed from turns',
    // Cost (CB-195, CB-196).
    cost: 'Turn cost and cost pools',
    // Rooms (CB-218).
    work_cycles: 'Work cycles',
};
