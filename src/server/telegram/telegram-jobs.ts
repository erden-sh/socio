import type { LongRunView } from '@socio/shared/schedule-types';

import type { JobsShape, LongRunRow, LongRunsShape } from '../schedules/contract.js';

import type { ChannelShape, LinksShape } from './contract.js';

/**
 * Durable jobs in Telegram (CB-145, CB-122): `/jobs` lists how the
 * person's jobs that run until done are doing, and a job started from a
 * direct message keeps one progress message there, edited as its batches
 * end. Its end is reported there by the socio's own turn
 * (`LongRunReports`), as before; the progress message then says how it
 * ended.
 */

const STATUS: Record<LongRunView['status'], string> = {
    running: 'running',
    waiting: 'waiting for its next batch',
    done: 'done',
    failed: 'failed',
    cancelled: 'stopped',
};

/** "Import CRM: running · 40 of 120 done · 2 failed", as the app's job line. */
export function longRunLine(name: string, run: LongRunView) {
    const { done, total, failed } = run.items;
    const items = total ? `${done} of ${total} done${failed ? ` · ${failed} failed` : ''}` : 'no items yet';
    return `${name}: ${STATUS[run.status]} · ${items}`;
}

/** The most jobs `/jobs` lists. */
const JOBS_SHOWN = 10;
const open = (run: LongRunView) => run.status === 'running' || run.status === 'waiting';

/**
 * What `/jobs` answers: the person's jobs that run until done, open ones
 * first, each with where its latest long run stands.
 */
export async function jobsReply(
    services: {
        jobs?: Pick<JobsShape, 'list'>;
        longRuns?: Pick<LongRunsShape, 'latestFor'>;
        appOrigin?: string;
    },
    userId: string,
) {
    const { jobs, longRuns } = services;
    if (!jobs || !longRuns) {
        return 'Jobs are not available here.';
    }
    const owned = (await jobs.list(userId)).filter((job) => job.untilDone);
    const runs = await longRuns.latestFor(owned.map((job) => job.id));
    const listed = owned
        .flatMap((job) => {
            const run = runs.get(job.id);
            return run ? [{ name: job.name, run }] : [];
        })
        .sort((a, b) => Number(open(b.run)) - Number(open(a.run)) || b.run.updatedAt - a.run.updatedAt);
    const where = services.appOrigin
        ? `${services.appOrigin.replace(/\/$/, '')}/schedules?tab=jobs`
        : 'Schedules → Jobs in Socio';
    if (!listed.length) {
        return `None of your jobs has run until done yet. They are in ${where}.`;
    }
    return [
        'Your jobs:',
        ...listed.slice(0, JOBS_SHOWN).map(({ name, run }) => {
            const line = `- ${longRunLine(name, run)}`;
            return open(run) || !run.outcome ? line : `${line}\n  ${run.outcome.replace(/\s+/g, ' ').slice(0, 200)}`;
        }),
        ...(listed.length > JOBS_SHOWN ? [`And ${listed.length - JOBS_SHOWN} more.`] : []),
        '',
        `Details: ${where}`,
    ].join('\n');
}

/** Edits of one progress message, at most one per this many ms. */
export const PROGRESS_EDIT_MS = 15_000;

/**
 * Keeps one progress message per long run started from a direct message,
 * while the person's account still reaches it: sent at its first batch's
 * end, edited at later ones (throttled) and at its end. Kept in memory: a
 * restart sends a new one. Best effort; a failure never touches the job.
 */
/** The channel as the progress messages use it: `TelegramChannel`, when configured. */
export type ProgressChannel = Pick<ChannelShape, 'status' | 'reaches' | 'sendDirect'> & {
    editDirect(chatId: string, messageId: number, text: string): Promise<unknown>;
};

/** What the progress messages read: the channel, the links, the jobs and their long runs. */
export interface JobProgressServices {
    readonly telegram?: ProgressChannel;
    readonly workspace: { readonly telegram: Pick<LinksShape, 'threadInfo'> };
    readonly jobs: Pick<JobsShape, 'job'>;
    readonly longRuns: Pick<LongRunsShape, 'onProgress' | 'onFinished'>;
}

export class TelegramJobProgress {
    private messages = new Map<string, { chatId: string; id: number; at: number }>();
    private unsubscribe: Array<() => void> = [];
    constructor(
        private platform: JobProgressServices,
        private now = () => Date.now(),
    ) {}
    start() {
        this.stop();
        this.unsubscribe.push(
            this.platform.longRuns.onProgress((row, view) => void this.show(row, view, false)),
            this.platform.longRuns.onFinished((row, view) => void this.show(row, view, true)),
        );
    }
    stop() {
        for (const off of this.unsubscribe.splice(0)) {
            off();
        }
        this.messages.clear();
    }
    /** Settles once the message for this state is sent or edited (tests). */
    async show(row: LongRunRow, view: LongRunView, ended: boolean) {
        try {
            await this.update(row, view, ended);
        } catch {
            // Progress is best effort: the job and its report go on.
        } finally {
            if (ended) {
                this.messages.delete(row.id);
            }
        }
    }
    private async update(row: LongRunRow, view: LongRunView, ended: boolean) {
        const channel = this.platform.telegram;
        if (!row.threadId || !channel || channel.status !== 'online') {
            return;
        }
        const shown = this.messages.get(row.id);
        // Its end edits only a message it has: the report turn says the rest.
        if (ended && !shown) {
            return;
        }
        const now = this.now();
        if (!ended && shown && now - shown.at < PROGRESS_EDIT_MS) {
            return;
        }
        const { workspace, jobs } = this.platform;
        const conversation = await workspace.telegram.threadInfo(row.threadId);
        if (conversation?.kind !== 'dm') {
            return;
        }
        if (!(await channel.reaches(conversation, row.userId))) {
            return;
        }
        const name = await jobs
            .job(row.userId, row.jobId)
            .then((job) => job.name)
            .catch(() => 'Your job');
        const text = `${ended ? 'Job ended' : 'Job in progress'}: ${longRunLine(`“${name}”`, view)}`;
        if (shown) {
            shown.at = now;
            await channel.editDirect(shown.chatId, shown.id, text);
            return;
        }
        const id = await channel.sendDirect(conversation.chatId, text, undefined, {
            silent: true,
        });
        this.messages.set(row.id, { chatId: conversation.chatId, id, at: now });
    }
}
