import type { Result } from '@socio/shared/types';

import type { PlatformTurnOptions, TurnOutcome } from '../turns/contract.js';

import type { Claim } from './contract.js';
import type { LongRunService } from './long-runs.js';
import type { SchedulesWorkspace } from './slices.js';

/** What a scheduled task's run uses: long runs, the task's conversation, and a turn in it. */
export interface ScheduledTaskSources {
    readonly longRuns: Pick<LongRunService, 'startJob'>;
    readonly workspace: Pick<SchedulesWorkspace, 'taskThread' | 'requireOwnedThread'>;
    turnOutcome(
        threadId: string,
        prompt: string,
        signal: AbortSignal,
        options?: PlatformTurnOptions,
    ): Promise<TurnOutcome>;
}

/**
 * Runs a scheduled task as its owner. A turn runs in its conversation (the
 * one it was scheduled from, or a Dot-proposed schedule's own), on the
 * owner's inference for scheduled work; a job schedule starts a run of its
 * job, which goes on by itself (the job's run records how it ended). The
 * task is refused if its owner is no longer a user or no longer owns the
 * thread or job.
 */
export function scheduledTaskExecutor(platform: ScheduledTaskSources, isUser: (userId: string) => boolean) {
    return async (
        claim: Claim,
        _memories: unknown,
        signal: AbortSignal,
        progress: (text: string) => void,
    ): Promise<Result> => {
        const owner = claim.userId;
        if (claim.kind === 'job') {
            if (!owner || !isUser(owner)) {
                throw new Error('This schedule’s owner no longer has access.');
            }
            if (!claim.jobId) {
                throw new Error('This schedule has no job.');
            }
            const { run, longRun, already } = await platform.longRuns.startJob(owner, claim.jobId, {
                trigger: 'schedule',
                scheduleId: claim.id,
                ...(claim.dotId ? { dotId: claim.dotId } : {}),
            });
            // A job that runs until done (CB-122): its long run goes on in
            // batches, and one still open is left to finish.
            if (longRun) {
                progress(
                    already
                        ? `The job is still running until done (${longRun.items.done} of ${longRun.items.total} items done).`
                        : 'Started the job; it runs until done.',
                );
                return {
                    text: already
                        ? `The job’s run from before is still going (${longRun.items.done} of ${longRun.items.total} items done), so no new one started.`
                        : 'Started the job; it runs in batches until done, under Schedules & jobs.',
                    sources: [],
                    sample: false,
                };
            }
            progress(`Started job run ${run!.id}.`);
            return {
                text: `Started a run of the job (run ${run!.id}); its logs are under Schedules & jobs.`,
                sources: [],
                sample: false,
            };
        }
        const threadId = await platform.workspace.taskThread(claim.id);
        if (!threadId) {
            throw new Error('This legacy task has no conversation. Create a new scheduled task from a conversation.');
        }
        if (!owner || !isUser(owner)) {
            throw new Error('This task’s owner no longer has access.');
        }
        try {
            platform.workspace.requireOwnedThread(owner, threadId);
        } catch {
            throw new Error('This task’s owner no longer has access to its conversation.');
        }
        progress('Running this task in its conversation.');
        // The turn's tools learn which task this is (a goal's, or a schedule).
        const { text } = await platform.turnOutcome(threadId, claim.prompt, signal, {
            source: 'scheduled',
            cause: { kind: 'schedule', id: claim.id },
            // Its queue time is how late it ran (CB-185).
            ...(claim.dueAt ? { receivedAt: claim.dueAt } : {}),
        });
        return { text, sources: [], sample: false };
    };
}
