import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    compareVersions,
    FINISHED_PHASES,
    UPDATE_TAG,
    versionOfTag,
    type UpdatePhase,
    type UpdaterApplyRequest,
    type UpdaterJob,
    type UpdaterStatus,
} from '@socio/shared/updates/updates';

import type { UpdaterConfig } from './config.js';
import { PlanError } from './plan.js';
import { PlatformError, type UpdaterPlatform } from './platform.js';
import { createPlatform } from './platforms.js';

/** A job as the updater keeps it: with what it needs to resume or roll back. */
interface StoredJob extends UpdaterJob {
    /** The platform's own state for this deploy (`PreparedDeploy.state`). */
    deployment: unknown;
}

/** Fields an updater before CB-323 kept on the job: the Portainer deployment's. */
const LEGACY_DEPLOYMENT = ['stackId', 'previous', 'next'] as const;

/** A job from before the platform port: its Portainer state moves under `deployment`. */
function upgradeJob(job: UpdaterJob | null): StoredJob | null {
    if (!job || 'deployment' in job) {
        return job as StoredJob | null;
    }
    const legacy: Record<string, unknown> = { ...job };
    const deployment = Object.fromEntries(LEGACY_DEPLOYMENT.map((key) => [key, legacy[key]]));
    for (const key of LEGACY_DEPLOYMENT) {
        delete legacy[key];
    }
    return { ...(legacy as unknown as UpdaterJob), deployment };
}

interface StateFile {
    job: StoredJob | null;
    history: UpdaterJob[];
}

const HISTORY = 10;

/** Refused before anything changed: `status` is the HTTP answer's. */
export class ApplyRefused extends Error {
    constructor(
        message: string,
        readonly status: 400 | 409 | 422 | 502,
    ) {
        super(message);
        this.name = 'ApplyRefused';
    }
}

export interface UpdaterOptions {
    config: UpdaterConfig;
    /** The platform it deploys to; by default the one `config.platform` names. */
    platform?: UpdaterPlatform;
    /** For the app's /healthz (tests: a loopback fake). */
    transport?: typeof fetch;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    log?: (line: string) => void;
}

const BACKUP_DATABASE = /^company-brain-\d{8}-\d{6}\.sqlite$/;
const BACKUP_USERDATA = /^userdata-\d{8}-\d{6}$/;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

/** Checks the app's request; refuses anything it doesn't expect. */
export function checkRequest(raw: unknown, now: number, maxAgeMs: number): UpdaterApplyRequest {
    const bad = (message: string): never => {
        throw new ApplyRefused(message, 400);
    };
    if (!raw || typeof raw !== 'object') {
        bad('Send the update as JSON.');
    }
    const body = raw as Record<string, unknown>;
    const allowed = ['target', 'from', 'requestedBy', 'backup'];
    if (Object.keys(body).some((key) => !allowed.includes(key))) {
        bad('Unknown fields in the request.');
    }
    const { target, from, requestedBy, backup } = body;
    if (typeof target !== 'string' || !UPDATE_TAG.test(target)) {
        bad('target must be a release tag such as v0.22.0.');
    }
    if (typeof from !== 'string' || !VERSION.test(from)) {
        bad('from must be the running version, such as 0.21.0.');
    }
    if (typeof requestedBy !== 'string' || !requestedBy || requestedBy.length > 200 || /[\r\n]/.test(requestedBy)) {
        bad('requestedBy must name who asked.');
    }
    if (compareVersions(versionOfTag(target as string)!, from as string) <= 0) {
        throw new ApplyRefused(
            `${target as string} is not newer than ${from as string}: the updater never downgrades (that needs a restore).`,
            422,
        );
    }
    // The mandatory pre-update backup: named, and fresh.
    const record = backup && typeof backup === 'object' ? (backup as Record<string, unknown>) : undefined;
    if (
        !record ||
        typeof record.database !== 'string' ||
        !BACKUP_DATABASE.test(record.database) ||
        typeof record.userdata !== 'string' ||
        !BACKUP_USERDATA.test(record.userdata) ||
        typeof record.offsite !== 'boolean' ||
        typeof record.at !== 'number'
    ) {
        throw new ApplyRefused(
            'An update needs the pre-update backup the app took: its database and userdata names and time.',
            422,
        );
    }
    if (record.at > now + 5 * 60_000 || now - record.at > maxAgeMs) {
        throw new ApplyRefused('The pre-update backup is too old: the app takes a new one for each update.', 422);
    }
    return {
        target: target as string,
        from: from as string,
        requestedBy: requestedBy as string,
        backup: {
            database: record.database,
            userdata: record.userdata,
            offsite: record.offsite,
            at: record.at,
        },
    };
}

/**
 * The updater (CB-259): one update at a time, through its platform port
 * (CB-323, `platform.ts`; Portainer's stack API by default). The platform
 * plans the deploy without changing anything, deploys the release tag,
 * waits until the new version is healthy, and on failure puts the previous
 * deployment back and waits for the previous version.
 *
 * The job is kept on disk after every step, so a restart of the updater
 * resumes it: an update cut off before the platform took it fails with
 * nothing changed; after, it checks the new version's health again (and
 * rolls back when it fails) rather than repeating the update blindly.
 */
export class Updater {
    private state: StateFile;
    private running?: Promise<void>;
    private readonly path: string;
    private readonly platform: UpdaterPlatform;

    constructor(private options: UpdaterOptions) {
        this.path = join(options.config.stateDir, 'updater-state.json');
        this.state = this.read();
        this.platform =
            options.platform ??
            createPlatform(options.config, {
                transport: options.transport,
                now: options.now,
                sleep: options.sleep,
            });
    }

    /** What it updates, and through which platform: for the startup line. */
    get target() {
        return `${this.platform.describe} (UPDATER_PLATFORM=${this.platform.name})`;
    }

    private now() {
        return this.options.now?.() ?? Date.now();
    }

    private log(line: string) {
        (this.options.log ?? console.log)(`Updater: ${line}`);
    }

    private read(): StateFile {
        try {
            const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as StateFile;
            return {
                job: upgradeJob(parsed.job ?? null),
                history: Array.isArray(parsed.history) ? parsed.history : [],
            };
        } catch {
            return { job: null, history: [] };
        }
    }

    /** Atomically, private to the updater (it holds the stack's env). */
    private write() {
        mkdirSync(this.options.config.stateDir, { recursive: true, mode: 0o700 });
        const temporary = `${this.path}.${process.pid}.tmp`;
        writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
        renameSync(temporary, this.path);
    }

    private step(job: StoredJob, line: string, phase?: UpdatePhase) {
        const at = this.now();
        if (phase) {
            job.phase = phase;
        }
        job.updatedAt = at;
        job.steps.push({ at, line });
        if (job.phase && FINISHED_PHASES.includes(job.phase)) {
            job.finishedAt = at;
        }
        this.write();
        this.log(`${job.target}: ${line}`);
    }

    /** A job as reported: nothing of the platform's state (no stack file, no env values). */
    private static public(job: StoredJob | UpdaterJob): UpdaterJob {
        const stored = { ...job } as Partial<StoredJob> & Record<string, unknown>;
        delete stored.deployment;
        for (const key of LEGACY_DEPLOYMENT) {
            delete stored[key];
        }
        const rest = stored as UpdaterJob;
        return { ...rest, steps: rest.steps.map((step) => ({ ...step })) };
    }

    status(): UpdaterStatus {
        return {
            stack: this.options.config.stack,
            tagKeys: [...this.options.config.tagKeys],
            job: this.state.job ? Updater.public(this.state.job) : null,
            history: this.state.history.map((job) => Updater.public(job)),
        };
    }

    /** Whether an update is going on. */
    busy() {
        return !!this.state.job && !FINISHED_PHASES.includes(this.state.job.phase);
    }

    /**
     * Plans and starts an update; resolves once it is underway (202). Refuses
     * (`ApplyRefused`) before changing anything when another one runs, the
     * stack can't be read, a tag key is missing or an image isn't there.
     */
    async apply(raw: unknown): Promise<UpdaterJob> {
        const { config } = this.options;
        const request = checkRequest(raw, this.now(), config.backupMaxAgeMs);
        if (this.busy() || this.running) {
            throw new ApplyRefused('An update is already going on.', 409);
        }
        let prepared;
        try {
            prepared = await this.platform.prepare(request.target);
        } catch (error) {
            if (error instanceof PlanError) {
                throw new ApplyRefused(error.message, 409);
            }
            if (error instanceof PlatformError) {
                throw new ApplyRefused(error.message, 502);
            }
            throw error;
        }
        if (this.busy() || this.running) {
            throw new ApplyRefused('An update is already going on.', 409);
        }
        const at = this.now();
        if (this.state.job) {
            this.state.history = [Updater.public(this.state.job), ...this.state.history].slice(0, HISTORY);
        }
        const job: StoredJob = {
            id: randomUUID(),
            target: request.target,
            from: request.from,
            requestedBy: request.requestedBy,
            phase: 'applying',
            startedAt: at,
            updatedAt: at,
            backup: request.backup,
            steps: [],
            deployment: prepared.state,
        };
        this.state.job = job;
        this.step(
            job,
            `Backup ${request.backup.database} and ${request.backup.userdata}${request.backup.offsite ? ', copied off-site,' : ''} taken; ${prepared.summary}`,
        );
        this.running = this.run(job, 'update').finally(() => {
            this.running = undefined;
        });
        return Updater.public(job);
    }

    /**
     * After a restart: an update cut off goes on from where it can (see
     * `run`'s `resume`); a rollback is done again.
     */
    recover() {
        const job = this.state.job;
        if (!job || FINISHED_PHASES.includes(job.phase) || this.running) {
            return;
        }
        if (job.phase === 'checking') {
            this.step(job, 'Interrupted before any change.', 'failed');
            return;
        }
        const from = job.phase === 'rolling_back' ? 'rollback' : job.phase === 'applying' ? 'resume' : 'verify';
        this.step(job, 'The updater restarted: carrying on.');
        this.running = this.run(job, from).finally(() => {
            this.running = undefined;
        });
    }

    /** Resolves when no update is going on (tests, shutdown). */
    async idle() {
        while (this.running) {
            await this.running;
        }
    }

    private async run(job: StoredJob, from: 'update' | 'resume' | 'verify' | 'rollback') {
        const { config } = this.options;
        const { platform } = this;
        let failure: string | undefined;
        if (from === 'resume') {
            // Cut off around the stack update: did it happen?
            try {
                if (!(await platform.deployed(job.deployment))) {
                    job.error = 'Interrupted before the stack update.';
                    this.step(job, 'Interrupted before the stack update; nothing changed.', 'failed');
                    return;
                }
            } catch {
                // Can't tell: check the new version's health, and roll back if it isn't.
            }
            from = 'verify';
        }
        if (from !== 'rollback') {
            try {
                if (from === 'update') {
                    await platform.deploy(job.deployment);
                    this.step(job, 'Stack updated; waiting for the new version.', 'verifying');
                } else {
                    job.phase = 'verifying';
                }
                const health = await platform.waitHealthy(versionOfTag(job.target)!);
                if (health.ok) {
                    this.step(
                        job,
                        `${job.target} is healthy (${config.health.stableChecks} checks in a row).`,
                        'succeeded',
                    );
                    return;
                }
                failure = health.reason;
            } catch (error) {
                failure = error instanceof Error ? error.message : 'The update failed.';
            }
            job.error = failure;
            this.step(job, `${failure} Rolling back.`, 'rolling_back');
        }
        try {
            await platform.rollBack(job.deployment);
            this.step(job, 'Previous stack file and env sent back; waiting for the previous version.');
            const health = await platform.waitHealthy(job.from);
            if (health.ok) {
                this.step(job, `${job.from} is healthy again.`, 'rolled_back');
                return;
            }
            job.error = `${job.error ?? 'The update failed.'} The rollback did not come back healthy either: ${health.reason}`;
        } catch (error) {
            job.error = `${job.error ?? 'The update failed.'} The rollback failed: ${error instanceof Error ? error.message : 'unknown error'}`;
        }
        this.step(
            job,
            `Rollback failed. If the new version migrated the database, the previous image refuses it: restore the pre-update backup (${job.backup.database}, ${job.backup.userdata}) as docs/operate/upgrades describes.`,
            'rollback_failed',
        );
    }
}
