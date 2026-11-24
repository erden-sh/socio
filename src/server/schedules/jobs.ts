import { createHash, randomUUID } from 'node:crypto';

import { deletedWith } from '@socio/data/soft-delete';
import { DATA_TOKEN_PREFIX } from '@socio/foundation/actors/redact';
import { DataError } from '@socio/foundation/dataspace/data-error';
import type { ComputerExecEnv } from '@socio/foundation/turns/turn';
import { APPROVAL_CAPABILITIES } from '@socio/shared/approvals';
import { jobEntryCommand } from '@socio/shared/job-entry';
import {
    JOB_ENTRIES,
    JOB_OUTPUT_NOT_KEPT,
    JOB_RUNS_PAGE,
    type JobCodeView,
    type JobDetail,
    type JobEntry,
    type JobFileView,
    type JobRunTrigger,
    type JobRunView,
    type JobRunsPage,
    type JobVersionView,
    type JobView,
} from '@socio/shared/schedule-types';
import type { Dot } from '@socio/shared/types';

import type { ApprovalOutcome, ApprovalsShape } from '../approvals/contract.js';
import type { ComputersShape } from '../computers/contract.js';
import type { WorkLease } from '../runtime/contract.js';
import type { AuditShape } from '../workspace/contract.js';

import {
    DEACTIVATED_JOB_RUN,
    DEFAULT_JOB_SETTINGS,
    type JobRun,
    type JobDataShape,
    type JobSettings,
    type JobsShape,
} from './contract.js';
import type { Job, JobRunPatch, JobVersion } from './domain/repositories.js';
import type { ScheduleData } from './services.js';
import { runScript } from './startup-wait.js';

/** A job problem the Dot or the user can act on (shown as is). */
export class JobError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 403 | 404 | 409 | 413 | 429 | 503 = 400,
    ) {
        super(message);
    }
}

export interface JobSaveInput {
    name: string;
    entry: JobEntry;
    files: Record<string, string>;
    timeoutSeconds: number;
    datasets?: string[];
    /** Runs in batches until the job says it is complete (CB-122). */
    untilDone?: boolean;
}
interface JobSavePayload extends JobSaveInput {
    jobId: string;
    /** Resolved dataset ids (`scratch` stays as is). */
    datasets: string[];
}

interface ExecResult {
    stdout?: unknown;
    stderr?: unknown;
    exitCode?: unknown;
}
/** `job_inspect`'s answer (CB-336). */
export type JobInspection =
    | {
          jobId: string;
          name: string;
          saved: true;
          version: number;
          untilDone: boolean;
          code: JobCodeView;
          lastRun: JobRunView | null;
          retryable: boolean;
          next: string;
      }
    | {
          jobId: string;
          name: string;
          /** Approved, but storing it failed before it was recorded. */
          saved: false;
          saveFailed: { approvalId: string; error: string | null; at: number | null };
          retryable: true;
          next: string;
      };

/** A storage failure, not a refusal: the object store or an unexpected error (CB-336). */
const storageFailure = (error: unknown) => !(error instanceof DataError) || error.status >= 500;

/** A run's error when its computer stopped under it. */
export const COMPUTER_STOPPED_JOB_RUN = 'The computer stopped during this run.';

interface Active {
    finalized?: boolean;
    cleanupDone?: boolean;
    notified?: boolean;
    lease: WorkLease;
    controller: AbortController;
    jobId: string;
    /** The job's owner: the run acts for them. */
    userId: string;
    done: Promise<void>;
    /** Set once the run's process was started in the computer. */
    dir?: string;
    /** A batch of a long run (CB-122): it resumes, so a drain doesn't wait for it. */
    longRunId?: string;
}

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const NAME = /^[^\p{Cc}]{1,80}$/u;
const SECRET_PATTERN = new RegExp(`${DATA_TOKEN_PREFIX}[A-Za-z0-9_-]+`, 'g');
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const message = (error: unknown) => (error instanceof Error ? error.message : 'The run failed.').slice(0, 500);
/** Shell-quotes a value we built ourselves (ids and checked paths). */
const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** A job's files: relative paths of safe segments, contents as text. */
export function checkJobFiles(
    files: Record<string, string>,
    entry: JobEntry,
    settings: Pick<JobSettings, 'maxFiles' | 'maxBytes'>,
) {
    const paths = Object.keys(files);
    if (!paths.length) {
        throw new JobError('Give the job’s files.');
    }
    if (paths.length > settings.maxFiles) {
        throw new JobError(`A job has at most ${settings.maxFiles} files.`);
    }
    let total = 0;
    for (const path of paths) {
        const segments = path.split('/');
        if (
            path.length > 200 ||
            segments.length > 5 ||
            segments.some((segment) => !SEGMENT.test(segment) || /^\.+$/.test(segment))
        ) {
            throw new JobError(
                `Invalid file path "${path.slice(0, 80)}": use relative paths of letters, digits, . _ and - (no spaces, .. or leading /).`,
            );
        }
        if (typeof files[path] !== 'string') {
            throw new JobError(`The contents of ${path} must be text.`);
        }
        if (files[path].length > 100_000) {
            throw new JobError(`${path} is too long: at most 100,000 characters.`);
        }
        total += Buffer.byteLength(files[path]);
    }
    if (total > settings.maxBytes) {
        throw new JobError(`A job’s files total at most ${Math.round(settings.maxBytes / 1024)} KB.`, 413);
    }
    if (!Object.hasOwn(files, entry)) {
        throw new JobError(`The files must include the entry, ${entry}.`);
    }
    return paths.sort();
}
/** The digest of a file set: order-independent, over paths and contents. */
export function jobDigest(files: Record<string, string>) {
    return sha256(
        Object.keys(files)
            .sort()
            .map((path) => `${path}\u0000${sha256(files[path])}`)
            .join('\n'),
    );
}
/** Where a version's files are in the owner's data space (the Dot's folder). */
export const jobFolder = (dotId: string, jobId: string, version: number) => `dots/${dotId}/jobs/${jobId}/v${version}/`;

/** Cuts a log to its last `max` bytes and takes secrets out. */
export function redactLog(text: string, secrets: readonly string[], max: number) {
    let out = text;
    for (const secret of secrets) {
        if (secret) {
            out = out.split(secret).join('[redacted]');
        }
    }
    out = out.replace(SECRET_PATTERN, '[redacted]');
    const bytes = Buffer.from(out);
    if (bytes.length <= max) {
        return out;
    }
    return `[…]${bytes.subarray(bytes.length - max).toString('utf8')}`;
}

export interface JobServiceOptions {
    data: JobDataShape;
    approvals: ApprovalsShape;
    /** The computers, as the platform's (agent) service. */
    computers: () => ComputersShape;
    workspace: {
        dot(id: string): Dot | undefined;
        /** Records a delete (CB-64); the platform's workspace has it. */
        audit?: AuditShape['audit'];
        /** A deactivated owner's runs stop. */
        isDeactivated?(userId: string): boolean;
    };
    /** The workspace's pause: runs stop, as turns do. */
    paused?: () => boolean;
    /** `DATA_API_URL`: without it, runs get no data token. */
    apiUrl?: string;
    settings?: Partial<JobSettings>;
    /** What an admin saved in Settings (CB-108), over `settings`, read on every use. */
    overrides?: () => Partial<JobSettings>;
    log?: (line: string) => void;
}

/**
 * Jobs (`LegacyJobs`): code a Dot wrote (Bun or bash) that runs in
 * its computer without the model, as the Dot for its owner. Saving a job
 * (each new version) goes through the `job.save` approval; running one
 * needs none, since its code was approved and a run can only do what the
 * Dot's computer and its own data token allow.
 *
 * A run: wake the Dot's computer through the supervisor (up to
 * `wakeTimeoutMs`; the wake counts toward the job's timeout), copy the
 * version's files (checked against their digest) into a fresh directory
 * under `.socio/jobs/<job>/<run>/`, issue a data token for that run
 * only (the job's datasets and the Dot's scratch, until the timeout plus a
 * margin), run `bun ./main.ts` or `bash main.sh` under `timeout`, then
 * keep the exit code and the end of stdout and stderr (secrets redacted)
 * and revoke the token. Runs up to `syncMaxSeconds` wait in one exec;
 * longer ones start detached and are polled; a computer that stops under
 * a run ends it then (interrupted), not at its deadline. Draining refuses
 * new runs; a force stop or the shutdown deadline stops the ones in
 * progress. A job saved with `untilDone` runs as batches of a long run
 * (long-runs.ts, CB-122), which the drain doesn't wait for.
 */
export class JobService implements JobsShape {
    private active = new Map<string, Active>();
    private queue: string[] = [];
    private draining = false;
    private stopped = false;
    private recoveryTimer?: ReturnType<typeof setTimeout>;
    private log: (line: string) => void;
    /** Whether runs get a data token: `DATA_API_URL` is set. */
    get dataApi(): boolean {
        return !!this.options.apiUrl;
    }
    /** The limits in force: an admin's, over the environment's, over the defaults. */
    get settings(): JobSettings {
        return {
            ...DEFAULT_JOB_SETTINGS,
            ...this.options.settings,
            ...this.options.overrides?.(),
        };
    }
    constructor(
        private schedules: ScheduleData,
        private options: JobServiceOptions,
    ) {
        this.log = options.log ?? (() => {});
        void this.recoverOrphans().catch((error: unknown) =>
            this.log(`Jobs: orphan recovery failed (${error instanceof Error ? error.name : 'unknown'}).`),
        );
        options.approvals.register<JobSavePayload>({
            capability: APPROVAL_CAPABILITIES.jobSave,
            label: 'Save a job',
            description:
                'A socio saves code (Bun or bash) as a job, or a new version of one: it runs in the socio’s computer, without the model, when you or a schedule start it.',
            execute: async (record) => {
                const saved = await this.store(record.userId, record.dotId, record.payload, { approvalId: record.id });
                return `Saved job “${saved.name}” version ${saved.version}.`;
            },
            auto: {
                maxRiskForAuto: 'low',
                riskNotes:
                    'Code that runs in the socio’s computer without the model, with a data token for the datasets it names.',
                rules: [
                    {
                        description: 'Jobs that use datasets beyond the socio’s scratch dataset go to you.',
                        check: ({ payload }) =>
                            payload.datasets.some((id) => id !== 'scratch') &&
                            'It uses datasets beyond the socio’s scratch dataset.',
                    },
                ],
            },
        });
    }

    // ---- definitions ---------------------------------------------------------

    private get jobsRepo() {
        return this.schedules.repos.jobs;
    }
    recoverOrphans(): Promise<void> {
        clearTimeout(this.recoveryTimer);
        if (this.stopped || !this.schedules.db.isOpen) {
            return Promise.resolve();
        }
        let protectedWork = false;
        return this.runsRepo
            .interruptOpen(
                Date.now(),
                'The server restarted during this run. Run the job again if needed.',
                (id, interrupt) => {
                    if (this.schedules.ownership.workAlive('job', id)) {
                        protectedWork = true;
                        return;
                    }
                    this.schedules.ownership.recoverOrphan('job', id, interrupt);
                    protectedWork ||= this.schedules.ownership.workAlive('job', id);
                },
            )
            .then(() => {
                if (protectedWork) {
                    this.retryRecovery();
                }
            });
    }

    private retryRecovery() {
        clearTimeout(this.recoveryTimer);
        if (this.stopped || !this.schedules.db.isOpen) {
            return;
        }
        this.recoveryTimer = setTimeout(
            () => {
                // A timer inherits the completed writer context that scheduled it.
                // Begin a fresh unit before a repository accesses its executor.
                void this.schedules.uow
                    .run(() => this.recoverOrphans(), {
                        label: 'retry orphan job ownership',
                    })
                    .catch(() => {
                        this.log('Jobs: orphan recovery failed; retrying without claiming live work.');
                        this.retryRecovery();
                    });
            },
            Math.min(1000, Math.floor(this.schedules.runtime.leaseMs / 3)),
        );
        this.recoveryTimer.unref();
    }

    /** Startup batch recovery must not refund a live runtime's item claims. */
    withOrphanedRun(id: string, work: () => Promise<void>) {
        return this.schedules.uow.run(
            async () => {
                if (this.schedules.ownership.workOwnerAlive('job', id)) {
                    return false;
                }
                await work();
                return true;
            },
            { label: 'recover orphan batch state' },
        );
    }
    private get runsRepo() {
        return this.schedules.repos.jobRuns;
    }
    /** A live job; a deleted one is missing (CB-64). */
    private jobRow(id: string) {
        return this.jobsRepo.get(id);
    }
    /** A job row, deleted or not, with its stamp (admin, tests). */
    withDeleted(id: string) {
        return this.jobsRepo.withDeleted(id);
    }
    /** The user's job, or (with `dotId`) that Dot's job for the user. */
    async owned(userId: string, jobId: string, dotId?: string) {
        const row = await this.jobRow(jobId);
        if (!row || row.userId !== userId || (dotId && row.dotId !== dotId)) {
            throw new JobError('Job not found.', 404);
        }
        return row;
    }
    /** Checks a save and resolves its datasets; throws a JobError otherwise. */
    private async prepare(userId: string, dotId: string, input: JobSaveInput): Promise<JobSavePayload> {
        const name = input.name.trim();
        if (!NAME.test(name)) {
            throw new JobError('Name the job (1–80 characters).');
        }
        if (!JOB_ENTRIES.includes(input.entry)) {
            throw new JobError('The entry is main.ts (Bun) or main.sh (bash).');
        }
        if (
            !Number.isInteger(input.timeoutSeconds) ||
            input.timeoutSeconds < 5 ||
            input.timeoutSeconds > this.settings.maxTimeoutSeconds
        ) {
            throw new JobError(
                `The timeout is 5 to ${this.settings.maxTimeoutSeconds} seconds; it includes starting the computer.`,
            );
        }
        checkJobFiles(input.files, input.entry, this.settings);
        const existing = await this.jobsRepo.named(userId, dotId, name);
        if (!existing && (await this.jobsRepo.list(userId)).length >= this.settings.maxJobsPerUser) {
            throw new JobError(
                `The user has ${this.settings.maxJobsPerUser} jobs, the most allowed. Update an existing one instead.`,
                429,
            );
        }
        const visible = this.options.data.visible({ kind: 'dot', userId, dotId }, false);
        const datasets = [
            ...new Set(
                (input.datasets ?? []).map((ref) => {
                    const wanted = ref.trim();
                    if (wanted.toLowerCase() === 'scratch') {
                        return 'scratch';
                    }
                    const match =
                        visible.find((item) => item.row.id === wanted) ??
                        visible.find((item) => item.row.name.toLowerCase() === wanted.toLowerCase());
                    if (!match) {
                        throw new JobError(
                            `No dataset "${wanted.slice(0, 80)}" is available to this socio. data_list shows yours; the user grants others.`,
                            404,
                        );
                    }
                    return match.scratch ? 'scratch' : match.row.id;
                }),
            ),
        ];
        return {
            ...input,
            name,
            datasets,
            jobId: existing?.id ?? randomUUID(),
        };
    }
    /**
     * `job_save`: asks the user to approve the code (unless bypass), then
     * stores it as the job's next version. Same name, same job.
     */
    async propose(
        userId: string,
        dotId: string,
        input: JobSaveInput,
        threadId?: string,
    ): Promise<{ jobId: string; outcome: ApprovalOutcome }> {
        const payload = await this.prepare(userId, dotId, input);
        const existing = await this.jobRow(payload.jobId);
        const entry = payload.files[payload.entry];
        const preview = entry
            .split('\n')
            .map((line) => line.trimEnd())
            .filter(Boolean)
            .slice(0, 6)
            .map((line) => `│ ${line.slice(0, 120)}`);
        const outcome = await this.options.approvals.request({
            userId,
            dotId,
            capability: APPROVAL_CAPABILITIES.jobSave,
            summary: existing
                ? `Update job “${payload.name}” to version ${existing.version + 1}`
                : `Save job “${payload.name}”`,
            details: [
                payload.untilDone
                    ? `Runs ${jobEntryCommand(payload.entry)} in this socio’s computer, without the model, in batches of at most ${payload.timeoutSeconds} s until it says it is done, resuming from its checkpoint after a stop.`
                    : `Runs ${jobEntryCommand(payload.entry)} in this socio’s computer, at most ${payload.timeoutSeconds} s, without the model.`,
                `Files: ${Object.keys(payload.files)
                    .sort()
                    .map((path) => `${path} (${Buffer.byteLength(payload.files[path])} B)`)
                    .join(', ')}`.slice(0, 300),
                `Data: the socio’s scratch dataset${payload.datasets.filter((id) => id !== 'scratch').length ? ` and ${payload.datasets.filter((id) => id !== 'scratch').length} granted dataset(s)` : ''}, through a token for each run.`,
                ...preview,
            ],
            payload,
            threadId,
        });
        return { jobId: payload.jobId, outcome };
    }
    /** Writes an approved version's files and records it (approval handler). */
    private async store(userId: string, dotId: string, raw: JobSavePayload, meta: { approvalId?: string }) {
        if (!this.options.workspace.dot(dotId)) {
            throw new JobError('The socio no longer exists.', 404);
        }
        // Checked again: a grant may be gone since the request.
        const payload = {
            ...(await this.prepare(userId, dotId, raw)),
            jobId: raw.jobId,
        };
        // Deleted while the update waited (CB-64): its id is kept, so it can't
        // be saved again; the Dot saves a new job under the same name.
        if ((await this.withDeleted(payload.jobId))?.deletedAt) {
            throw new JobError('This job was deleted. Save it again to make a new job.', 404);
        }
        const current = await this.jobRow(payload.jobId);
        if (current && (current.userId !== userId || current.dotId !== dotId)) {
            throw new JobError('Job not found.', 404);
        }
        const version = (current?.version ?? 0) + 1;
        const folder = jobFolder(dotId, payload.jobId, version);
        const actor = { kind: 'dot' as const, userId, dotId };
        const files: JobFileView[] = Object.keys(payload.files)
            .sort()
            .map((path) => ({ path, size: Buffer.byteLength(payload.files[path]) }));
        // CB-336: storage failing as the code is written (an object store
        // outage) still records the approved version, so the job doesn't
        // vanish: its code shows as missing and `job_retry` stores it again
        // from the approval. A refusal (the space full, a rate limit) records
        // nothing, as before: the current version stays the one that runs.
        let unstored: unknown;
        for (const file of files) {
            try {
                await this.options.data.putFile(
                    actor,
                    `${folder}${file.path}`,
                    Buffer.from(payload.files[file.path]),
                    'text/plain',
                );
            } catch (error) {
                if (!storageFailure(error)) {
                    throw error;
                }
                unstored = error;
                break;
            }
        }
        const now = Date.now();
        await this.jobsRepo.save(
            { id: payload.jobId, userId, dotId, name: payload.name },
            {
                jobId: payload.jobId,
                version,
                entry: payload.entry,
                files,
                digest: jobDigest(payload.files),
                timeoutSeconds: payload.timeoutSeconds,
                datasets: payload.datasets,
                approvalId: meta.approvalId ?? null,
                createdAt: now,
                untilDone: !!payload.untilDone,
            },
            !current,
            now,
        );
        if (unstored) {
            this.log(
                `Jobs: saved job=${payload.jobId} version=${version} dot=${dotId} without its code (storage failed)`,
            );
            throw new JobError(
                `Saved job “${payload.name}” (${payload.jobId}) version ${version}, but its code couldn’t be stored: ${message(unstored)} job_inspect shows it; job_retry stores the approved code again and runs it.`,
                503,
            );
        }
        this.log(`Jobs: saved job=${payload.jobId} version=${version} dot=${dotId}`);
        return { id: payload.jobId, name: payload.name, version };
    }
    private versionView(row: JobVersion): JobVersionView {
        return {
            version: row.version,
            entry: row.entry,
            files: row.files,
            timeoutSeconds: row.timeoutSeconds,
            datasets: row.datasets,
            untilDone: row.untilDone,
            createdAt: row.createdAt,
        };
    }
    private async view(row: Job): Promise<JobView> {
        const version = (await this.jobsRepo.version(row.id, row.version))!;
        const last = await this.runsRepo.latest(row.id);
        const parsed = this.versionView(version);
        return {
            id: row.id,
            name: row.name,
            dotId: row.dotId,
            dotName: this.options.workspace.dot(row.dotId)?.name ?? null,
            entry: parsed.entry,
            version: row.version,
            timeoutSeconds: parsed.timeoutSeconds,
            datasets: parsed.datasets,
            files: parsed.files,
            untilDone: parsed.untilDone,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            lastRun: last ? this.runView(last) : null,
        };
    }
    /** The user's jobs (with `dotId`, that Dot's), newest first. */
    async list(userId: string, dotId?: string): Promise<JobView[]> {
        const views: JobView[] = [];
        for (const row of await this.jobsRepo.list(userId, dotId)) {
            views.push(await this.view(row));
        }
        return views;
    }
    async job(userId: string, jobId: string, dotId?: string): Promise<JobView> {
        return this.view(await this.owned(userId, jobId, dotId));
    }
    async detail(userId: string, jobId: string): Promise<JobDetail> {
        const row = await this.owned(userId, jobId);
        const version = (await this.jobsRepo.version(row.id, row.version))!;
        const missing = this.missingFiles(row, version);
        return {
            job: await this.view(row),
            code: { state: missing.length ? 'missing' : 'stored', missing, error: null },
            versions: (await this.jobsRepo.versions(jobId)).map((version) => this.versionView(version)),
            ...(await this.page(jobId, JOB_RUNS_PAGE)),
        };
    }
    /**
     * A job's runs older than `before` (a run of the job), newest first: the
     * detail's "Load more". Every run is kept, so this pages through
     * `job_runs_job` instead of reading them all.
     */
    async runs(userId: string, jobId: string, before: string, limit = JOB_RUNS_PAGE): Promise<JobRunsPage> {
        await this.owned(userId, jobId);
        const cursor = await this.runRow(before);
        if (!cursor || cursor.jobId !== jobId) {
            throw new JobError('Run not found.', 404);
        }
        const { runs, moreRuns } = await this.page(jobId, limit, before);
        return { runs, more: moreRuns };
    }
    private async page(jobId: string, limit: number, before?: string) {
        const { runs, more } = await this.runsRepo.page(jobId, limit, before);
        return { runs: runs.map((row) => this.runView(row)), moreRuns: more };
    }
    /** A version's code, from the data space (the app's code view). */
    async code(userId: string, jobId: string, version?: number) {
        const row = await this.owned(userId, jobId);
        const files = await this.readFiles(row, version ?? row.version);
        return { version: version ?? row.version, files };
    }
    /**
     * Deletes a job (the user, in the app), unless it is running. CB-64: the
     * job is hidden and kept with its versions and runs, and its code files
     * are deleted with it (`deletedWith job:<id>`), so kept too; its name is
     * free for a new job. The caller stops its schedules.
     */
    async remove(userId: string, jobId: string, now = Date.now()) {
        const row = await this.owned(userId, jobId);
        if ([...this.active.values()].some((run) => run.jobId === jobId)) {
            throw new JobError('Wait for the job’s run to finish first.', 409);
        }
        await this.jobsRepo.remove(jobId, userId, now);
        for (const file of this.options.data.listFiles({ kind: 'user', userId }, `dots/${row.dotId}/jobs/${jobId}/`)) {
            try {
                await this.options.data.deleteFile(userId, file.path, {
                    with: deletedWith('job', jobId),
                });
            } catch {
                // Deleted from the Media page already.
            }
        }
        this.options.workspace.audit?.({
            actor: userId,
            action: 'delete',
            targetKind: 'job',
            targetId: jobId,
            detail: row.name,
        });
    }
    /** Reads a version's files back and checks them against its digest. */
    private async readFiles(row: Job, version: number) {
        const stored = await this.jobsRepo.version(row.id, version);
        if (!stored) {
            throw new JobError('That version doesn’t exist.', 404);
        }
        const folder = jobFolder(row.dotId, row.id, version);
        const files: Record<string, string> = {};
        for (const file of stored.files) {
            let data: Uint8Array;
            try {
                ({ data } = await this.options.data.getFile(
                    { kind: 'user', userId: row.userId },
                    `${folder}${file.path}`,
                ));
            } catch (error) {
                const gone = error instanceof DataError && error.status === 404;
                throw new JobError(
                    gone
                        ? `This job’s code (version ${version}, ${file.path}) is missing from storage. job_retry stores the approved code again.`
                        : `This job’s code (version ${version}) couldn’t be read from storage: ${message(error)} Try again; job_inspect shows its state.`,
                    gone ? 404 : 503,
                );
            }
            files[file.path] = Buffer.from(data).toString('utf8');
        }
        if (jobDigest(files) !== stored.digest) {
            throw new JobError(
                'This job’s files were changed outside job_save. job_retry stores the approved code again; job_save saves new code.',
                409,
            );
        }
        return files;
    }
    /** A version's files with no record in the data space (no read). */
    private missingFiles(row: Job, version: JobVersion) {
        const folder = jobFolder(row.dotId, row.id, version.version);
        const listed = new Set(
            this.options.data.listFiles({ kind: 'user', userId: row.userId }, folder).map((file) => file.path),
        );
        return version.files.map((file) => file.path).filter((path) => !listed.has(`${folder}${path}`));
    }
    /** Whether the current version's code is there and reads back as approved (CB-336). */
    private async codeState(row: Job, version: JobVersion): Promise<JobCodeView> {
        const missing = this.missingFiles(row, version);
        if (missing.length) {
            return { state: 'missing', missing, error: null };
        }
        try {
            await this.readFiles(row, version.version);
            return { state: 'stored', missing, error: null };
        } catch (error) {
            const status = error instanceof JobError ? error.status : 503;
            return {
                state: status === 409 ? 'changed' : status === 404 ? 'missing' : 'unreadable',
                missing,
                error: message(error),
            };
        }
    }
    /** The latest save of `jobId` this Dot's person approved whose storing failed before it was recorded. */
    private async failedSave(userId: string, jobId: string, dotId: string) {
        const failed = await this.options.approvals.failedPayloads<JobSavePayload>(
            userId,
            dotId,
            APPROVAL_CAPABILITIES.jobSave,
        );
        return failed.find((item) => item.payload?.jobId === jobId);
    }
    /**
     * `job_inspect` (CB-336): a job's saved state without running it: its
     * version, whether its code is stored and reads back as approved, its
     * last run and, for a save that was approved but never recorded (its
     * code store failed), that save and why. Reads the code from storage.
     */
    async inspect(userId: string, jobId: string, dotId?: string): Promise<JobInspection> {
        const row = await this.jobRow(jobId);
        if (!row) {
            const failed =
                dotId && !(await this.withDeleted(jobId)) ? await this.failedSave(userId, jobId, dotId) : undefined;
            if (!failed) {
                throw new JobError('Job not found.', 404);
            }
            return {
                jobId,
                name: failed.payload.name,
                saved: false,
                saveFailed: { approvalId: failed.id, error: failed.outcome, at: failed.decidedAt },
                retryable: true,
                next: 'The user approved this job, but saving it failed. job_retry saves the approved code and runs it.',
            };
        }
        await this.owned(userId, jobId, dotId);
        const version = (await this.jobsRepo.version(row.id, row.version))!;
        const code = await this.codeState(row, version);
        const last = await this.runsRepo.latest(row.id);
        const lastRun = last ? this.runView(last) : null;
        const failedRun = !!lastRun && ['failed', 'timed_out', 'interrupted'].includes(lastRun.status);
        return {
            jobId,
            name: row.name,
            saved: true,
            version: row.version,
            untilDone: version.untilDone,
            code,
            lastRun,
            retryable: code.state !== 'stored' || failedRun || !lastRun,
            next:
                code.state === 'stored'
                    ? failedRun
                        ? 'Its code is stored. job_retry (or job_run) runs it again.'
                        : 'Its code is stored; job_run runs it.'
                    : code.state === 'unreadable'
                      ? 'Storage didn’t return its code; try job_retry again later.'
                      : 'job_retry stores the approved code again and runs it.',
        };
    }
    /**
     * `job_retry`'s repair (CB-336), before it starts a run: a save that was
     * approved but never recorded is saved again from its approval; a
     * version whose code is missing or changed gets the approved code back.
     * Only what the person approved is written (checked against the
     * version's digest), so a retry never runs unapproved code: new code
     * goes through job_save. Returns what it repaired.
     */
    async repair(userId: string, jobId: string, dotId?: string): Promise<{ repaired: 'saved' | 'code' | null }> {
        const row = await this.jobRow(jobId);
        if (!row) {
            const failed =
                dotId && !(await this.withDeleted(jobId)) ? await this.failedSave(userId, jobId, dotId) : undefined;
            if (!failed) {
                throw new JobError('Job not found.', 404);
            }
            const named = await this.jobsRepo.named(userId, dotId!, failed.payload.name.trim());
            if (named && named.id !== jobId) {
                throw new JobError(
                    `Another job named “${named.name}” was saved since. Save this code again with job_save.`,
                    409,
                );
            }
            await this.store(userId, dotId!, failed.payload, { approvalId: failed.id });
            return { repaired: 'saved' };
        }
        await this.owned(userId, jobId, dotId);
        const version = (await this.jobsRepo.version(row.id, row.version))!;
        const code = await this.codeState(row, version);
        if (code.state === 'stored') {
            return { repaired: null };
        }
        const approved = version.approvalId
            ? await this.options.approvals.approvedPayload<JobSavePayload>(
                  version.approvalId,
                  row.userId,
                  APPROVAL_CAPABILITIES.jobSave,
              )
            : undefined;
        if (
            !approved ||
            approved.dotId !== row.dotId ||
            approved.payload?.jobId !== row.id ||
            approved.payload.entry !== version.entry ||
            jobDigest(approved.payload.files) !== version.digest
        ) {
            throw new JobError(
                'The approved code of this version isn’t on record. Save the job again with job_save; the user approves it.',
                409,
            );
        }
        const actor = { kind: 'dot' as const, userId: row.userId, dotId: row.dotId };
        const folder = jobFolder(row.dotId, row.id, version.version);
        for (const file of version.files) {
            await this.options.data.putFile(
                actor,
                `${folder}${file.path}`,
                Buffer.from(approved.payload.files[file.path]),
                'text/plain',
            );
        }
        await this.readFiles(row, version.version);
        this.log(`Jobs: restored the code of job=${row.id} version=${version.version}`);
        return { repaired: 'code' };
    }

    // ---- runs ----------------------------------------------------------------

    private runRow(id: string) {
        return this.runsRepo.get(id);
    }
    private runView(row: JobRun, logs = false): JobRunView {
        return {
            id: row.id,
            jobId: row.jobId,
            version: row.version,
            trigger: row.trigger,
            scheduleId: row.scheduleId,
            status: row.status,
            queuedAt: row.queuedAt,
            startedAt: row.startedAt,
            wakeMs: row.wakeMs,
            finishedAt: row.finishedAt,
            exitCode: row.exitCode,
            error: row.error,
            longRunId: row.longRunId ?? null,
            ...(row.outputTrimmedAt
                ? { outputNotKept: JOB_OUTPUT_NOT_KEPT }
                : logs
                  ? { stdout: row.stdout ?? '', stderr: row.stderr ?? '' }
                  : {}),
        };
    }
    /** One run with its logs, for its user (and with `dotId`, that Dot). */
    async run(userId: string, runId: string, dotId?: string): Promise<JobRunView> {
        const row = await this.runRow(runId);
        if (!row || row.userId !== userId || (dotId && row.dotId !== dotId) || !(await this.jobRow(row.jobId))) {
            throw new JobError('Run not found.', 404);
        }
        return this.runView(row, true);
    }
    /** The latest run a schedule started, for its last-run line. */
    async lastScheduledRun(scheduleId: string): Promise<JobRunView | null> {
        const row = await this.runsRepo.latestOfSchedule(scheduleId);
        return row ? this.runView(row) : null;
    }
    /**
     * A page of the runs a schedule started, newest first, older than the
     * run `before` (one of them) when given; undefined for any other run.
     */
    async scheduleRuns(userId: string, scheduleId: string, limit: number, before?: string) {
        const cursor = before ? await this.runRow(before) : undefined;
        if (before && (cursor?.scheduleId !== scheduleId || cursor.userId !== userId)) {
            return undefined;
        }
        const { runs, more } = await this.runsRepo.ofSchedule(scheduleId, userId, limit, cursor?.id);
        return { runs: runs.map((row) => this.runView(row)), more };
    }
    /** A Dot's runs queued by `before`, newest first (its admin activity). */
    dotRuns(dotId: string, before: number, limit: number) {
        return this.runsRepo.ofDot(dotId, before, limit);
    }
    /** When a Dot's newest run was queued (its admin row). */
    lastDotRunAt(dotId: string) {
        return this.runsRepo.lastOfDot(dotId);
    }
    /** A run's row changed: awaited, behind any open unit of work (CB-110). */
    private update(id: string, patch: JobRunPatch): Promise<void> {
        const active = this.active.get(id);
        const lease = active?.lease;
        // A forced teardown may close the connection before an aborted exec settles.
        // Its durable row is recovered by the next runtime, never written unfenced.
        if (!lease || !this.schedules.db.isOpen) {
            return Promise.resolve();
        }
        return this.schedules.uow.run(
            async () => {
                // Already inside the shared writer transaction: another process cannot
                // take the lease between this check and the awaited repository write.
                if (!this.schedules.ownership.owns(lease)) {
                    this.retryRecovery();
                    return;
                }
                await this.runsRepo.update(id, patch);
                if (patch.finishedAt !== undefined) {
                    this.schedules.ownership.release(lease);
                    this.schedules.uow.afterCommit(() => {
                        active!.finalized = true;
                        this.notifyEnded(id, active!);
                    });
                }
            },
            { label: 'fenced job run update' },
        );
    }
    /** Job runs in progress or waiting for a slot (force stop counts them). */
    get running() {
        // Queued runs are in `active` too, waiting for a slot.
        return this.active.size;
    }
    /**
     * The runs a deploy's drain waits for: not a long run's batches
     * (CB-122), which the stop interrupts and the next process resumes from
     * their checkpoint.
     */
    get holdingDrain() {
        return [...this.active.values()].filter((run) => !run.longRunId).length;
    }
    /** Whether new runs are refused (a shutdown is under way). */
    get isDraining() {
        return this.draining;
    }
    private ends = new Set<(run: JobRunView) => void>();
    /** Calls `listener` with each run once it has ended, however it ended. */
    onRunEnded(listener: (run: JobRunView) => void) {
        this.ends.add(listener);
        return () => this.ends.delete(listener);
    }
    /** Notify only this owner's committed completion, after its cleanup has ended. */
    private notifyEnded(id: string, active: Active) {
        if (!active.finalized || !active.cleanupDone || active.notified || !this.schedules.db.isOpen) {
            return;
        }
        active.notified = true;
        void this.ended(id).catch((error: unknown) =>
            this.log(`Jobs: a run's end could not be read (${error instanceof Error ? error.name : 'unknown'}).`),
        );
    }
    private async ended(id: string) {
        const row = await this.runRow(id);
        if (!row) {
            return;
        }
        const view = this.runView(row);
        for (const listener of this.ends) {
            try {
                if (!this.schedules.ownership.workOwnerAlive('job', id)) {
                    return;
                }
                listener(view);
            } catch (error) {
                this.log(
                    `Jobs: a run's end handler failed (${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}).`,
                );
            }
        }
    }
    /** A run's redacted output, for the long run to tell why a batch failed. */
    async runLogs(id: string): Promise<{ stdout: string; stderr: string }> {
        const row = await this.runRow(id);
        return { stdout: row?.stdout ?? '', stderr: row?.stderr ?? '' };
    }
    /** A run as stored (a long run's batch, CB-122). */
    async runRecord(id: string): Promise<JobRunView | undefined> {
        const row = await this.runRow(id);
        return row && this.runView(row);
    }
    /**
     * Stops one run, queued or running, with `reason` as its error. A run
     * another live runtime owns (CB-108) gets the stop through the database
     * and applies it within a second.
     */
    stopRun(id: string, reason: string) {
        if (this.active.has(id)) {
            this.cancel(id, reason);
        } else if (this.schedules.db.isOpen) {
            void this.schedules.ownership
                .signal('job', id, 'stop', reason)
                .catch(() => this.log('Jobs: a stop for a run elsewhere was not recorded.'));
        }
    }
    /** Everyone's runs by status, and saved jobs (the operators' counts). */
    async counts() {
        return {
            jobs: await this.jobsRepo.count(),
            // Kept by triggers (schedules migration 4): every run is kept.
            jobRuns: await this.runsRepo.counts(),
            runningJobs: this.running,
        };
    }
    /** Shutdown (SIGTERM): new runs are refused; the ones running finish. */
    drain() {
        this.draining = true;
    }
    /**
     * Starts a run of the job's current version, as its Dot for its owner.
     * A job runs once at a time: a second start returns the run in progress.
     */
    /** Throws the JobError a start would; returns the job otherwise. */
    async startable(userId: string, jobId: string, dotId?: string) {
        if (this.draining) {
            throw new JobError('Socio is updating. Try again in a minute.', 503);
        }
        const job = await this.owned(userId, jobId, dotId);
        if (!this.options.workspace.dot(job.dotId)) {
            throw new JobError('The job’s socio no longer exists.', 404);
        }
        if (this.options.workspace.dot(job.dotId)?.archivedAt) {
            throw new JobError('The job’s socio is archived.', 409);
        }
        if (!this.options.computers().configured) {
            throw new JobError('No computer service is configured.', 503);
        }
        return job;
    }
    async start(
        userId: string,
        jobId: string,
        origin: {
            trigger: JobRunTrigger;
            dotId?: string;
            scheduleId?: string;
            /** A batch of this long run (CB-122). */
            longRunId?: string;
        },
    ): Promise<JobRunView> {
        const job = await this.startable(userId, jobId, origin.dotId);
        // The open-run check, the insert and the trim are one unit of work, and
        // the run is registered in it, so a second start sees it (CB-110).
        const started = await this.schedules.uow.run<{ already: JobRunView } | { id: string }>(
            async () => {
                const current = await this.runsRepo.open(jobId);
                if (current && this.schedules.ownership.workAlive('job', current.id)) {
                    return { already: this.runView(current) };
                }
                const id = randomUUID();
                const lease = this.schedules.ownership.claim('job', id, `job:${jobId}`, (claimed) => claimed);
                await this.runsRepo.insert({
                    id,
                    jobId,
                    version: job.version,
                    userId,
                    dotId: job.dotId,
                    trigger: origin.trigger,
                    scheduleId: origin.scheduleId ?? null,
                    queuedAt: Date.now(),
                    longRunId: origin.longRunId ?? null,
                });
                await this.trimOutput(jobId);
                const controller = new AbortController();
                let resolve!: () => void;
                const done = new Promise<void>((r) => (resolve = r));
                this.active.set(id, {
                    lease,
                    controller,
                    jobId,
                    userId,
                    done,
                    ...(origin.longRunId ? { longRunId: origin.longRunId } : {}),
                });
                this.queue.push(id);
                this.done.set(id, resolve);
                return { id };
            },
            { label: 'start job run' },
        );
        if ('already' in started) {
            return started.already;
        }
        this.pump();
        return this.runView((await this.runRow(started.id))!);
    }
    private done = new Map<string, () => void>();
    /** Starts queued runs while there are free slots; a raised limit calls it. */
    pump() {
        const busy = this.active.size - this.queue.length;
        let slots = this.settings.concurrency - busy;
        while (slots-- > 0 && this.queue.length) {
            const id = this.queue.shift()!;
            const active = this.active.get(id)!;
            void this.execute(id).finally(() => {
                active.cleanupDone = true;
                this.active.delete(id);
                this.done.get(id)?.();
                this.done.delete(id);
                this.notifyEnded(id, active);
                this.pump();
            });
        }
    }
    /** Waits up to `ms` for a run to finish; returns it as it is then. */
    async wait(runId: string, ms: number): Promise<JobRunView> {
        const active = this.active.get(runId);
        if (active) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([active.done, new Promise((resolve) => (timer = setTimeout(resolve, ms)))]);
            clearTimeout(timer);
        }
        return this.runView((await this.runRow(runId))!, true);
    }
    /**
     * Every run is kept; past the newest `keepRuns` of the job, finished runs
     * lose their stdout and stderr (the bulk) and keep the rest: when, version,
     * trigger, status, exit code and error. A run still going there is trimmed
     * by a later start, once it has finished.
     */
    private trimOutput(jobId: string) {
        return this.runsRepo.trimOutput(jobId, this.settings.keepRuns, Date.now());
    }
    /**
     * Stops one run with `reason` as its error: a queued one is interrupted
     * here, a started one is aborted and its process stopped (`execute`).
     */
    private cancel(id: string, reason: string) {
        const queued = this.queue.indexOf(id);
        if (queued === -1) {
            this.active.get(id)?.controller.abort(new Error(reason));
            return;
        }
        this.queue.splice(queued, 1);
        const active = this.active.get(id)!;
        const stored = this.update(id, {
            status: 'interrupted',
            finishedAt: Date.now(),
            error: reason,
        });
        this.active.get(id)?.controller.abort(new Error(reason));
        this.active.delete(id);
        this.done.get(id)?.();
        this.done.delete(id);
        active.cleanupDone = true;
        this.notifyEnded(id, active);
        void stored.catch((error: unknown) =>
            this.log(`Jobs: a cancelled run wasn't saved (${error instanceof Error ? error.name : 'unknown'}).`),
        );
    }
    /** Stops every run (a force stop, the shutdown deadline); returns how many. */
    forceStop(reason: string) {
        const count = this.running;
        // Queued runs are in `active` too.
        for (const id of [...this.active.keys()]) {
            this.cancel(id, reason);
        }
        return count;
    }
    /**
     * Stops a person's runs, queued or running (they were deactivated,
     * accounts.ts), with `reason` as each run's error; returns how many.
     */
    /** How many runs `stopOwnedBy` would stop now (a deactivation preview). */
    runningCountOf(userId: string) {
        return [...this.active.values()].filter((run) => run.userId === userId).length;
    }
    stopOwnedBy(userId: string, reason: string) {
        const ids = [...this.active].filter(([, run]) => run.userId === userId).map(([id]) => id);
        for (const id of ids) {
            this.cancel(id, reason);
        }
        return ids.length;
    }
    /** The server's stop (`LeaderWork.stop`): stops what still runs and waits a little for it to be recorded. */
    async stop(reason = 'The server stopped during this run.') {
        clearTimeout(this.recoveryTimer);
        this.stopped = true;
        this.draining = true;
        if (!this.active.size) {
            await this.schedules.runtime.detach(this.schedules.db);
            return;
        }
        const pending = [...this.active.values()].map((run) => run.done);
        this.forceStop(reason);
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([Promise.all(pending), new Promise((resolve) => (timer = setTimeout(resolve, 5000)))]);
        clearTimeout(timer);
        if (this.schedules.db.isOpen) {
            await this.schedules.uow.run(
                async () => {
                    for (const active of this.active.values()) {
                        this.schedules.ownership.release(active.lease);
                    }
                },
                { label: 'release stopped job ownership' },
            );
        }
        await this.schedules.runtime.detach(this.schedules.db);
    }

    /** One run, start to end; never throws (the row says what happened). */
    private async execute(id: string) {
        const row = (await this.runRow(id))!;
        const active = this.active.get(id)!;
        const signal = active.controller.signal;
        const job = await this.jobRow(row.jobId);
        const computers = this.options.computers();
        const session = `job:${id}`;
        const secrets: string[] = [];
        const startedAt = Date.now();
        const dir = `.socio/jobs/${row.jobId}/${id}`;
        let launched = false;
        let watcher: ReturnType<typeof setInterval> | undefined;
        const finish = (patch: JobRunPatch) => this.update(id, { finishedAt: Date.now(), ...patch });
        try {
            if (!job) {
                throw new JobError('The job was deleted.', 404);
            }
            const version = (await this.jobsRepo.version(job.id, row.version))!;
            const deadline = startedAt + version.timeoutSeconds * 1000;
            await this.update(id, { status: 'starting', startedAt });
            // Paused, the Dot gone or its owner deactivated (also by the auth
            // CLI, from another process): the run stops.
            watcher = setInterval(() => {
                if (!this.schedules.ownership.owns(active.lease)) {
                    active.controller.abort(new Error('Run ownership was lost.'));
                } else if (!this.options.workspace.dot(row.dotId)) {
                    active.controller.abort(new Error('The socio was deleted.'));
                } else if (this.options.paused?.()) {
                    active.controller.abort(new Error('Agents were paused.'));
                } else if (this.options.workspace.isDeactivated?.(row.userId)) {
                    active.controller.abort(new Error(DEACTIVATED_JOB_RUN));
                }
                // A stop that reached another runtime (CB-108: a long run's
                // pause or cancel served by the other task of a deploy).
                else if (this.schedules.ownership.hasSignal('job', id, 'stop')) {
                    void this.schedules.ownership
                        .takeSignal('job', id, 'stop')
                        .then((reason) => {
                            if (reason !== undefined) {
                                this.cancel(id, reason || 'Stopped.');
                            }
                        })
                        .catch(() => undefined);
                }
            }, 1000);
            const exec = async (
                command: string,
                timeoutMs = 30_000,
                env: ComputerExecEnv | null = null,
                actor: 'agent' | 'owner' = 'agent',
                runSignal: AbortSignal = signal,
            ) =>
                ((await computers.action(
                    row.dotId,
                    'exec',
                    { command, timeoutMs: Math.max(1000, Math.min(60_000, timeoutMs)) },
                    actor,
                    runSignal,
                    row.userId,
                    { env, secrets, principal: { kind: 'job', id: row.jobId } },
                )) ?? {}) as ExecResult;
            const files = await this.readFiles(job, row.version);
            // 1. The computer: running, or woken (this counts toward the timeout).
            const wakeMs = await computers.ensureRunning(row.dotId, {
                userId: row.userId,
                signal,
                waitMs: Math.max(1000, Math.min(this.settings.wakeTimeoutMs, deadline - Date.now())),
            });
            await this.update(id, { wakeMs });
            // A long run's earlier batch may still run in the computer after a
            // server restart (its token died with the server): it is stopped, so
            // only this batch works on the job's items (CB-122).
            if (row.longRunId) {
                await exec(
                    `for d in .socio/jobs/${q(row.jobId)}/*/; do [ "$d" = ${q(`${dir}/`)} ] && continue; [ -f "$d/exit.code" ] && continue; P=$(cat "$d/job.pid" 2>/dev/null) && { kill -TERM -- -$P 2>/dev/null || kill -TERM $P 2>/dev/null; }; done; true`,
                ).catch((error: unknown) => {
                    if (signal.aborted) {
                        throw error;
                    }
                });
            }
            // 2. A fresh directory with the version's files.
            const folders = new Set([dir]);
            for (const path of Object.keys(files)) {
                if (path.includes('/')) {
                    folders.add(`${dir}/${path.slice(0, path.lastIndexOf('/'))}`);
                }
            }
            await exec(`mkdir -p ${[...folders].map(q).join(' ')}`);
            for (const [path, contents] of Object.entries(files)) {
                signal.throwIfAborted();
                await computers.action(
                    row.dotId,
                    'files_write',
                    { path: `${dir}/${path}`, contents },
                    'agent',
                    signal,
                    row.userId,
                    { secrets, principal: { kind: 'job', id: row.jobId } },
                );
            }
            const seconds = Math.floor((deadline - Date.now()) / 1000);
            if (seconds < 1) {
                await finish({
                    status: 'timed_out',
                    error: `The job’s ${version.timeoutSeconds} s ran out before it started (waking the computer took ${Math.round(wakeMs / 1000)} s).`,
                });
                return;
            }
            const command = jobEntryCommand(version.entry);
            await computers.action(
                row.dotId,
                'files_write',
                {
                    path: `${dir}/run.sh`,
                    // CB-161: waits for the app first, within a part of the timeout.
                    contents: runScript({
                        command,
                        seconds,
                        waitSeconds: Math.min(this.settings.startupWindowMs / 1000, seconds / 2),
                    }),
                },
                'agent',
                signal,
                row.userId,
                { secrets, principal: { kind: 'job', id: row.jobId } },
            );
            // 3. The run's own data token, in the environment only: the file the
            // prefix sources is deleted before the job starts.
            let env: ComputerExecEnv | null = null;
            const apiUrl = this.options.apiUrl;
            if (apiUrl) {
                const datasets = version.datasets;
                const token = this.options.data.tokens.issue(
                    {
                        userId: row.userId,
                        dotId: row.dotId,
                        purpose: 'job',
                        // Jobs run on the same shared computer as interactive commands.
                        ...(this.options.workspace.dot(row.dotId)?.ownerId === null ? { reach: 'socio' as const } : {}),
                        session,
                        datasetIds: [...new Set([...datasets, 'scratch'])],
                    },
                    seconds * 1000 + 120_000,
                );
                secrets.push(token);
                const file = `${dir}/job.env`;
                env = {
                    file: {
                        path: file,
                        contents: `CB_DATA_URL='${apiUrl.replace(/'/g, '')}/api/data'\nCB_DATA_TOKEN='${token}'\nCB_JOB_ID='${row.jobId}'\nCB_JOB_RUN_ID='${id}'\nCB_JOB_VERSION='${row.version}'\n${row.longRunId ? `CB_JOB_API='${apiUrl.replace(/'/g, '')}/api/data/job'\nCB_JOB_LONG_RUN_ID='${row.longRunId}'\n` : ''}`,
                    },
                    prefix: `set -a; [ -r ${q(file)} ] && . ./${file}; set +a; rm -f ${q(file)}\n`,
                    secrets: [token],
                };
            }
            // 4. Run it.
            await this.update(id, { status: 'running' });
            launched = true;
            active.dir = dir;
            const exitFile = q(`${dir}/exit.code`);
            if (seconds <= this.settings.syncMaxSeconds) {
                await exec(`bash ${q(`${dir}/run.sh`)}`, (seconds + 10) * 1000, env).catch((error: unknown) => {
                    if (signal.aborted) {
                        throw error;
                    }
                    // The exec call may give up first; the run's files say how it ended.
                });
            } else {
                await exec(
                    `if command -v setsid >/dev/null 2>&1; then setsid bash ${q(`${dir}/run.sh`)} < /dev/null > /dev/null 2>&1 & else nohup bash ${q(`${dir}/run.sh`)} < /dev/null > /dev/null 2>&1 & fi; echo started`,
                    15_000,
                    env,
                );
            }
            // Long runs (and a short one the exec call gave up on) are polled.
            for (let first = true; ; first = false) {
                if (!first) {
                    await new Promise((resolve) => setTimeout(resolve, this.settings.pollMs));
                }
                signal.throwIfAborted();
                const poll = await exec(`cat ${exitFile} 2>/dev/null || echo running`, 15_000).catch(
                    async (error: unknown) => {
                        if (signal.aborted) {
                            throw error;
                        }
                        // A computer that stopped (idle, recycled, an owner's stop) ends
                        // the run now instead of at its deadline.
                        const state = await computers.status(row.dotId).catch(() => undefined);
                        if (state?.state === 'stopped') {
                            active.controller.abort(new Error(COMPUTER_STOPPED_JOB_RUN));
                            signal.throwIfAborted();
                        }
                        return { stdout: 'running' };
                    },
                );
                if (String(poll.stdout ?? '').trim() !== 'running') {
                    break;
                }
                if (Date.now() > deadline + this.settings.graceMs) {
                    break;
                }
            }
            // 5. What happened.
            const status = await exec(`cat ${exitFile} 2>/dev/null || echo none`);
            const logs = await exec(
                `tail -c ${this.settings.logMaxBytes} ${q(`${dir}/out.log`)} 2>/dev/null; tail -c ${this.settings.logMaxBytes} ${q(`${dir}/err.log`)} 1>&2 2>/dev/null; true`,
            );
            const raw = String(status.stdout ?? '').trim();
            const exitCode = /^\d+$/.test(raw) ? Number(raw) : null;
            const stdout = redactLog(String(logs.stdout ?? ''), secrets, this.settings.logMaxBytes);
            const stderr = redactLog(String(logs.stderr ?? ''), secrets, this.settings.logMaxBytes);
            // No exit code past the deadline: `timeout` didn't end it; we do.
            if (exitCode === null) {
                await this.kill(computers, row, dir);
            }
            const timedOut =
                exitCode === 124 ||
                (exitCode === 137 && Date.now() >= deadline - 1000) ||
                (exitCode === null && Date.now() >= deadline);
            await finish({
                status: timedOut ? 'timed_out' : exitCode === 0 ? 'succeeded' : 'failed',
                exitCode,
                stdout,
                stderr,
                error: timedOut
                    ? `Stopped at the job’s ${version.timeoutSeconds} s timeout.`
                    : exitCode === null
                      ? 'The job ended without an exit code.'
                      : exitCode === 0
                        ? null
                        : `Exited with code ${exitCode}.`,
            });
        } catch (error) {
            if (signal.aborted) {
                const reason = message(signal.reason ?? error);
                if (launched) {
                    await this.kill(computers, row, dir);
                }
                await finish({ status: 'interrupted', error: reason });
            } else {
                await finish({
                    status: 'failed',
                    error: redactLog(message(error), secrets, 500),
                });
            }
        } finally {
            clearInterval(watcher);
            // The token ends with the run, whatever happened.
            this.options.data.tokens.revokeSession(session);
            const final = await this.runRow(id);
            this.log(
                `Jobs: run=${id} job=${row.jobId} status=${final?.status ?? 'unknown'} ms=${Date.now() - startedAt}${final?.exitCode !== null && final?.exitCode !== undefined ? ` exit=${final.exitCode}` : ''}`,
            );
            if (launched)
            // Keeps the last three run directories of the job; best effort.
            {
                await computers
                    .action(
                        row.dotId,
                        'exec',
                        {
                            command: `rm -f ${q(`${dir}/job.env`)}; ls -1dt .socio/jobs/${row.jobId}/*/ 2>/dev/null | tail -n +4 | xargs -r rm -rf; true`,
                            timeoutMs: 10_000,
                        },
                        'owner',
                        AbortSignal.timeout(12_000),
                        row.userId,
                        { env: null, secrets, principal: { kind: 'job', id: row.jobId } },
                    )
                    .catch(() => undefined);
            }
        }
    }
    /** Stops a run's process group in the computer; best effort. */
    private async kill(computers: ComputersShape, row: JobRun, dir: string) {
        await computers
            .action(
                row.dotId,
                'exec',
                {
                    command: `P=$(cat ${q(`${dir}/job.pid`)} 2>/dev/null) && { kill -TERM -- -$P 2>/dev/null || kill -TERM $P 2>/dev/null; sleep 2; kill -KILL -- -$P 2>/dev/null; }; true`,
                    timeoutMs: 10_000,
                },
                'owner',
                AbortSignal.timeout(12_000),
                row.userId,
                { env: null, principal: { kind: 'job', id: row.jobId } },
            )
            .catch(() => undefined);
    }
}
