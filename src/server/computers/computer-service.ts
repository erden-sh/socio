import { createHmac } from 'node:crypto';
import { posix } from 'node:path';

import { z } from 'zod';

import { DATA_TOKEN_PREFIX, redactSocioTokens } from '@socio/foundation/actors/redact';
import type { ComputerExecEnv, ComputerHooks } from '@socio/foundation/turns/turn';
import type { ComputerDiskStatus } from '@socio/shared/computers/computer-resources';
import {
    computerInputs,
    computerPermissionsSchema,
    type ComputerAction,
    type ComputerControl,
    type ComputerStatus,
} from '@socio/shared/computers/computer-types';
import { COMPUTER_RUN_DIR } from '@socio/shared/computers/paths';
import {
    DEPLOYMENT_STATS_TIMEOUT_MS,
    DiskUsageDeploymentMetrics,
    type DeploymentMetrics,
} from '@socio/shared/operations/deployment-metrics';

import type { SociosShape } from '../workspace/contract.js';

import { ComputerDiskUsage, DISK_USAGE_TIMEOUT_MS } from './computer-disk-usage.js';
import type {
    AppTarget,
    ComputerActionOptions,
    ComputerPrincipal,
    ComputerRecordsShape,
    ComputersConfigShape,
    ComputersShape,
    ComputerTelemetryReading,
} from './contract.js';

/**
 * What the service reads of the workspace: its socios, and their computers'
 * permissions and audit. A `WorkspaceStore` is one; the computers layer
 * makes one from the `Socios` and `ComputerRecords` tags.
 */
export type ComputerWorkspace = Pick<SociosShape, 'dot' | 'dots'> & { readonly computers: ComputerRecordsShape };

const resourceStatsSchema = z
    .object({
        botId: z.string(),
        container: z.string(),
        instance: z.string().min(1).max(256),
        running: z.boolean(),
        values: z
            .object({
                cpuPercent: z.number().finite().nonnegative().nullable(),
                memoryBytes: z.number().finite().nonnegative().nullable(),
                memoryLimitBytes: z.number().finite().nonnegative().nullable(),
                volumeBytes: z.number().finite().nonnegative().nullable(),
            })
            .strict(),
    })
    .strict();
const stateSchema = z.object({
    botId: z.string(),
    container: z.string(),
    status: z.string(),
    port: z.number().int().min(1024).max(65535).optional(),
    url: z.string().optional(),
    // Docker's health of the computer, from a supervisor that reports it:
    // "unhealthy" when its browser has been stuck for a minute (CB-125).
    health: z.string().optional(),
});
const controlSchema = z.object({
    holder: z.enum(['bot', 'human']),
    requested: z.boolean(),
    transitioning: z.boolean(),
    resumeSnapshotRequired: z.boolean(),
    request: z.object({ id: z.string(), status: z.string() }).optional(),
});
/**
 * Computer actions waiting on a computer, across every ComputerService (each
 * Dot turn has its own): an operator's force stop aborts them.
 */
const inFlight = new Set<AbortController>();
/** Computer actions in progress. */
export const computerActionsInFlight = () => inFlight.size;
/**
 * Aborts every computer action in progress; returns how many. Only the
 * requests end: the computer may finish a step it already began, and the
 * containers, managed by the supervisor, keep running.
 */
export function abortComputerActions() {
    const count = inFlight.size;
    for (const controller of inFlight) {
        controller.abort();
    }
    return count;
}
/**
 * A snapshot or screenshot takes about a second, and a few more when the
 * browser has to start, or restart after it died. Past this the browser is
 * not coming back, and waiting longer only spends the turn.
 */
export const BROWSER_READ_MS = 20_000;
/** How long the computer's /health may take after a browser call timed out. */
const HEALTH_MS = 5_000;
/** How long a Dot's browser calls fail at once after its browser was found stuck. */
export const STUCK_BROWSER_MS = 60_000;
export const BROWSER_STUCK =
    'The computer’s browser is stuck. Restart the computer (Stop computer, then Start computer, in this socio’s Computer panel) and try again.';
/**
 * Until when each Dot's browser calls fail at once, per workspace: every
 * Dot turn has its own ComputerService, and the next one must not spend
 * the full limit again on a browser that is known to be stuck. Keyed by the
 * workspace's computer records (one per workspace), the same object whether
 * a service was given the `WorkspaceStore` (a Dot turn's) or the `Socios`
 * and `ComputerRecords` tags (the platform's, `layer.ts`).
 */
const stuckBrowsers = new WeakMap<ComputerRecordsShape, Map<string, number>>();
/**
 * How many times each Dot's computer was stopped or started, per workspace,
 * so a browser call that began before one cannot trip the breaker after it.
 */
const computerRestarts = new WeakMap<ComputerRecordsShape, Map<string, number>>();
/**
 * A computer keeps the credential it was started with. One started under an
 * older key (a rotated `COMPUTER_TOKEN`) answers every call with HTTP 401
 * while it runs, and the supervisor gives it the current one only when it is
 * asked to ensure the computer, which replaces the container and keeps its
 * volumes. The app asks once per window, and gives up after a few tries, so
 * a 401 that a fresh credential doesn't cure never becomes a restart loop.
 */
export const CREDENTIAL_REFRESH_WINDOW_MS = 15 * 60_000;
export const CREDENTIAL_REFRESH_MAX = 3;
/** How often a running computer's credential is checked in the background. */
export const CREDENTIAL_CHECK_MS = 30 * 60_000;
type CredentialRefresh = { at: number; tries: number; pending?: Promise<boolean>; checkedAt?: number };
const credentialRefreshes = new WeakMap<ComputerRecordsShape, Map<string, CredentialRefresh>>();
/** Computers an owner is stopping right now: a stop always wins over a credential restart. */
const computerStops = new WeakMap<ComputerRecordsShape, Set<string>>();
/** A computer refused the per-socio credential (HTTP 401). */
class ComputerUnauthorized extends Error {
    constructor() {
        super('Computer service returned HTTP 401.');
    }
}
/** The platform's folder in a computer's workspace, and its name before the rename. */
const PLATFORM_DIRS = ['.socio', '.company-brain'];
/**
 * The platform's secrets in a computer's workspace (CB-224): every `.env`
 * file under `.socio/` (a command's, a job run's or a mini app's token
 * file), or under `.company-brain/` as it was called before, and anything
 * under `.socio/run/`. A company socio's computer is shared by everyone
 * who uses it, so the file tools refuse these paths and listings leave
 * them out, for every person; only the platform writes them (`writeFile`,
 * an exec's env). The computer trims a path, so this does too.
 */
export function computerSecretPath(path: string) {
    const parts = posix
        .normalize(path.trim())
        .split('/')
        .filter((part) => part !== '' && part !== '.');
    return (
        PLATFORM_DIRS.includes(parts[0]) && (parts[1] === 'run' || (parts.length > 1 && parts.at(-1)!.endsWith('.env')))
    );
}
export const COMPUTER_SECRET_PATH =
    'Files under .socio/ that hold access tokens can’t be read, listed or changed with the file tools.';
/** Any data token, wherever it came from, is redacted from what a computer sends back. */
const DATA_TOKEN = new RegExp(`${DATA_TOKEN_PREFIX}[A-Za-z0-9_-]+`, 'g');
const healthSchema = z.object({
    browser: z.boolean().optional(),
    browserState: z.string().optional(),
});
export class ComputerService implements ComputersShape {
    private telemetryStates = new Map<string, boolean>();
    private diskUsage?: ComputerDiskUsage;
    private deploymentMetrics?: DeploymentMetrics | null;
    constructor(
        private workspace: ComputerWorkspace,
        private config: ComputersConfigShape,
        private paused: () => boolean,
        private transport: typeof fetch = fetch,
        private deadlineMs = 70000,
        // The data space's token for exec, and the end of a computer session.
        private hooks: ComputerHooks = {},
        private browserReadMs = BROWSER_READ_MS,
    ) {}
    private get stuck() {
        let stuck = stuckBrowsers.get(this.workspace.computers);
        if (!stuck) {
            stuckBrowsers.set(this.workspace.computers, (stuck = new Map()));
        }
        return stuck;
    }
    private restarts(id: string) {
        return computerRestarts.get(this.workspace.computers)?.get(id) ?? 0;
    }
    /** A stop or start clears a stuck browser, and outdates browser calls already under way. */
    private restarted(id: string) {
        this.stuck.delete(id);
        let restarts = computerRestarts.get(this.workspace.computers);
        if (!restarts) {
            computerRestarts.set(this.workspace.computers, (restarts = new Map()));
        }
        restarts.set(id, this.restarts(id) + 1);
    }
    private get refreshes() {
        let refreshes = credentialRefreshes.get(this.workspace.computers);
        if (!refreshes) {
            credentialRefreshes.set(this.workspace.computers, (refreshes = new Map()));
        }
        return refreshes;
    }
    /**
     * Ask the supervisor to ensure a computer that refused its credential:
     * one started under an older key is replaced with the current one (its
     * volumes stay). Once per window per computer, at most
     * CREDENTIAL_REFRESH_MAX times; concurrent callers share one attempt.
     * True when the supervisor answered, so the caller may retry once.
     */
    private get stopping() {
        let stopping = computerStops.get(this.workspace.computers);
        if (!stopping) {
            computerStops.set(this.workspace.computers, (stopping = new Set()));
        }
        return stopping;
    }
    /**
     * Whether a credential restart may still go ahead for a call made at
     * `generation`: never once the computer was stopped or started since,
     * or while an owner is stopping it.
     */
    private mayRefresh(id: string, generation: number) {
        return generation === this.restarts(id) && !this.stopping.has(id);
    }
    private refreshCredential(id: string, generation: number): Promise<boolean> {
        if (!this.mayRefresh(id, generation)) {
            return Promise.resolve(false);
        }
        const entry = this.refreshes.get(id) ?? { at: 0, tries: 0 };
        if (entry.pending) {
            return entry.pending;
        }
        if (entry.tries >= CREDENTIAL_REFRESH_MAX || Date.now() - entry.at < CREDENTIAL_REFRESH_WINDOW_MS) {
            return Promise.resolve(false);
        }
        entry.at = Date.now();
        entry.tries += 1;
        console.warn(
            `Computers: ${id}'s computer refused its credential (HTTP 401); asking the supervisor to restart it with the current one, volumes kept (attempt ${entry.tries} of ${CREDENTIAL_REFRESH_MAX}).`,
        );
        entry.pending = this.audited(id, 'refresh_credential', 'platform', async () => {
            // Only a computer that is still running and nobody stopped meanwhile.
            const current = await this.existing(id);
            if (current?.status !== 'running' || !this.mayRefresh(id, generation)) {
                return false;
            }
            const state = await this.supervisor(`/computers/${id}/ensure`, {});
            this.endpoint(id, state);
            // Its processes ended with the old container.
            this.telemetryStates.set(id, true);
            this.hooks.stopped?.(id);
            this.restarted(id);
            return true;
        })
            .catch((error: unknown) => {
                console.warn(
                    `Computers: restarting ${id}'s computer with the current credential failed (${error instanceof Error ? error.message : String(error)}).`,
                );
                return false;
            })
            .finally(() => {
                entry.pending = undefined;
                if (entry.tries >= CREDENTIAL_REFRESH_MAX) {
                    console.warn(
                        `Computers: ${id}'s computer still refuses its credential after ${entry.tries} restarts; not trying again until the app restarts.`,
                    );
                }
            });
        this.refreshes.set(id, entry);
        return entry.pending;
    }
    /**
     * The background check (CB-331): a running computer started under an
     * older key is found and restarted even when nobody uses it. A read of
     * its control state, at most every CREDENTIAL_CHECK_MS per computer.
     */
    private async checkCredentials(running: Array<{ id: string; url: string }>, signal?: AbortSignal) {
        for (const { id, url } of running) {
            const entry = this.refreshes.get(id) ?? { at: 0, tries: 0 };
            if (signal?.aborted || (entry.checkedAt && Date.now() - entry.checkedAt < CREDENTIAL_CHECK_MS)) {
                continue;
            }
            entry.checkedAt = Date.now();
            this.refreshes.set(id, entry);
            await this.json(`${url}/control`, this.token(id), undefined, signal, id, [], 15000).catch(() => undefined);
        }
    }
    get configured() {
        return !!(
            this.config.computerSupervisorUrl?.trim() &&
            this.config.computerSupervisorToken?.trim() &&
            this.config.computerToken?.trim()
        );
    }
    resourceState(id: string): boolean | null {
        return this.telemetryStates.get(id) ?? null;
    }

    /**
     * The computers' disk usage (CB-197), from the read-only disk usage proxy
     * rather than the supervisor: it is measured every 15 minutes in the
     * background and resource readings take its last result.
     */
    get disk(): ComputerDiskUsage {
        if (!this.diskUsage) {
            const base = this.config.computerDiskUsageUrl?.trim().replace(/\/$/, '');
            const token = this.config.computerSupervisorToken?.trim();
            this.diskUsage = new ComputerDiskUsage(
                base && token
                    ? (path, signal) =>
                          this.json(base + path, token, undefined, signal, undefined, [], DISK_USAGE_TIMEOUT_MS)
                    : null,
                this.config.computerNamespace ?? 'company-brain',
            );
        }
        return this.diskUsage;
    }
    diskStatus(): ComputerDiskStatus {
        return this.disk.status();
    }

    /**
     * The deployment's resource use (CB-321), through the same read-only
     * disk usage proxy and token: null when it isn't set up
     * (COMPUTER_DISK_USAGE_URL), so the dashboard says so.
     */
    get deployment(): DeploymentMetrics | null {
        if (this.deploymentMetrics === undefined) {
            const base = this.config.computerDiskUsageUrl?.trim().replace(/\/$/, '');
            const token = this.config.computerSupervisorToken?.trim();
            this.deploymentMetrics =
                base && token
                    ? new DiskUsageDeploymentMetrics((path, signal) =>
                          this.json(base + path, token, undefined, signal, undefined, [], DEPLOYMENT_STATS_TIMEOUT_MS),
                      )
                    : null;
        }
        return this.deploymentMetrics;
    }

    /** Platform-only reads: no ensure, shell, credential minting or control takeover. */
    async resourceReadings(signal?: AbortSignal): Promise<ComputerTelemetryReading[]> {
        const callerSignal = signal;
        signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
        if (!this.configured) {
            return [];
        }
        const generations = new Map(computerRestarts.get(this.workspace.computers));
        const base = this.config.computerSupervisorUrl!.replace(/\/$/, '');
        const token = this.config.computerSupervisorToken!.trim();
        let listing: { computers: z.infer<typeof stateSchema>[] };
        try {
            listing = z
                .object({ computers: z.array(stateSchema) })
                .parse(await this.json(base + '/computers', token, undefined, signal, undefined, [], 3000));
        } catch {
            // An unavailable supervisor cannot confirm that a previous running state
            // is still current. Preserve any control decision made during this read.
            for (const dot of this.workspace.dots()) {
                if ((generations.get(dot.id) ?? 0) === this.restarts(dot.id)) {
                    this.telemetryStates.delete(dot.id);
                }
            }
            return [];
        }
        const states = new Map(listing.computers.map((state) => [state.botId, state]));
        const running: Array<{ id: string; generation: number; url: string }> = [];
        for (const dot of this.workspace.dots()) {
            const generation = generations.get(dot.id) ?? 0;
            if (generation !== this.restarts(dot.id)) {
                continue;
            }
            const state = states.get(dot.id);
            if (!state || state.status !== 'running') {
                this.telemetryStates.set(dot.id, false);
                this.hooks.stopped?.(dot.id);
                continue;
            }
            const url = this.endpoint(dot.id, state);
            this.telemetryStates.set(dot.id, true);
            running.push({ id: dot.id, generation, url });
        }
        if (running.length) {
            this.disk.refresh(callerSignal);
            // Not awaited: a restart outlasts this reading's deadline.
            void this.checkCredentials(running).catch(() => undefined);
        }
        const result: ComputerTelemetryReading[] = [];
        // Bounded parallelism: a failed computer cannot create unbounded requests.
        for (let index = 0; index < running.length; index += 4) {
            await Promise.all(
                running.slice(index, index + 4).map(async ({ id, generation }) => {
                    try {
                        const stats = resourceStatsSchema.parse(
                            await this.json(
                                base + '/computers/' + id + '/stats',
                                token,
                                undefined,
                                signal,
                                undefined,
                                [],
                                15000,
                            ),
                        );
                        const namespace = this.config.computerNamespace ?? 'company-brain';
                        if (stats.botId !== id || stats.container !== `${namespace}-computer-${id}`) {
                            return;
                        }
                        const current = () =>
                            generation === this.restarts(id) &&
                            this.telemetryStates.get(id) === true &&
                            !callerSignal?.aborted;
                        if (!stats.running) {
                            if (current()) {
                                this.telemetryStates.set(id, false);
                                this.hooks.stopped?.(id);
                            }
                            return;
                        }
                        // The supervisor no longer sizes volumes; an older one may still.
                        const disk = this.disk.reading(id);
                        const values = {
                            ...stats.values,
                            volumeBytes: stats.values.volumeBytes ?? disk.volumeBytes,
                            containerBytes: disk.containerBytes,
                        };
                        if (current()) {
                            result.push({ dotId: id, stats: { ...stats, values }, current });
                        }
                    } catch {
                        /* A missing/old supervisor metric remains a visible collection gap. */
                    }
                }),
            );
            if (signal?.aborted) {
                break;
            }
        }
        return result;
    }
    private token(id: string) {
        return createHmac('sha256', this.config.computerToken!.trim())
            .update(`company-brain-computer:${id}`)
            .digest('hex');
    }
    private requireDot(id: string) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) || !this.workspace.dot(id)) {
            throw new Error('Socio not found.');
        }
    }
    private async allowed(id: string, kind: 'browser' | 'files' | 'shell' | undefined, actor: 'agent' | 'owner') {
        this.requireDot(id);
        // Archived: its computer is looked at (status), never used, by any path
        // (routes, jobs, apps, the Dot's own tools).
        if (this.workspace.dot(id)?.archivedAt) {
            throw new Error('This socio is archived.');
        }
        if (!this.configured) {
            throw new Error('Computer service is not configured.');
        }
        const policy = await this.workspace.computers.permissions(id);
        if (!policy.enabled || (kind && !policy[kind])) {
            throw new Error('Computer permission is disabled.');
        }
        if (actor === 'agent' && this.paused()) {
            throw new Error('Agents are paused.');
        }
    }
    private async json(
        url: string,
        token: string,
        body: unknown | undefined,
        signal?: AbortSignal,
        dotId?: string,
        secrets: readonly string[] = [],
        deadlineMs = this.deadlineMs,
    ): Promise<unknown> {
        // The computer's lifecycle as this call found it: a stop or start since wins.
        const generation = dotId ? this.restarts(dotId) : 0;
        try {
            return await this.request(url, token, body, signal, dotId, secrets, deadlineMs);
        } catch (error) {
            // Only a computer's own refusal of this socio's credential, never the supervisor's.
            if (
                !(error instanceof ComputerUnauthorized) ||
                !dotId ||
                !this.config.computerToken?.trim() ||
                token !== this.token(dotId) ||
                !(await this.refreshCredential(dotId, generation))
            ) {
                throw error;
            }
        }
        return this.request(url, token, body, signal, dotId, secrets, deadlineMs);
    }
    private async request(
        url: string,
        token: string,
        body: unknown | undefined,
        signal?: AbortSignal,
        dotId?: string,
        secrets: readonly string[] = [],
        deadlineMs = this.deadlineMs,
    ): Promise<unknown> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), deadlineMs);
        const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        try {
            const response = await this.transport(url, {
                method: body === undefined ? 'GET' : 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                    ...(dotId ? { 'x-openbot-bot-id': dotId } : {}),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                redirect: 'error',
                signal: combined,
            });
            if (response.status === 409) {
                throw await conflict(response);
            }
            if (response.status === 401) {
                throw new ComputerUnauthorized();
            }
            if (!response.ok) {
                throw new Error(`Computer service returned HTTP ${response.status}.`);
            }
            if (!response.body) {
                throw new Error('Computer service returned an empty response.');
            }
            const reader = response.body.getReader();
            let size = 0;
            const chunks: Uint8Array[] = [];
            for (;;) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                size += value.length;
                if (size > 4_000_000) {
                    await reader.cancel();
                    throw new Error('Computer response exceeded its size limit.');
                }
                chunks.push(value);
            }
            // Infrastructure secrets must never leave the gateway even if an upstream response reflects one.
            let text = Buffer.concat(chunks).toString('utf8');
            for (const secret of [
                token,
                this.config.computerToken?.trim(),
                this.config.computerSupervisorToken?.trim(),
                ...secrets,
                // Other commands' live tokens on this computer, as of now (CB-224).
                ...((dotId && this.hooks.secrets?.(dotId)) || []),
            ]) {
                if (secret) {
                    text = text.split(secret).join('[redacted]');
                }
            }
            // And anything shaped like a Socio credential, live or not, which no
            // runtime can list by value (CB-232).
            return JSON.parse(redactSocioTokens(text.replace(DATA_TOKEN, '[redacted]')));
        } catch (error) {
            if (combined.aborted) {
                throw new (signal?.aborted ? Error : ComputerTimeout)('Computer request was canceled or timed out.', {
                    cause: error,
                });
            }
            if (error instanceof Error && /^Computer (service returned|response exceeded)/.test(error.message)) {
                throw error;
            }
            throw new Error('Computer service is unavailable or returned an invalid response.', { cause: error });
        } finally {
            clearTimeout(timeout);
        }
    }
    private supervisor(path: string, body?: unknown, signal?: AbortSignal) {
        return this.json(
            `${this.config.computerSupervisorUrl!.replace(/\/$/, '')}${path}`,
            this.config.computerSupervisorToken!.trim(),
            body,
            signal,
        );
    }
    private endpoint(id: string, raw: unknown) {
        const state = stateSchema.parse(raw);
        const ns = this.config.computerNamespace ?? 'company-brain';
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(ns)) {
            throw new Error('Invalid computer namespace.');
        }
        const expected = `${ns}-computer-${id}`;
        if (state.botId !== id || state.container !== expected) {
            throw new Error('Computer identity mismatch.');
        }
        const url = new URL(state.url ?? (state.port ? `http://127.0.0.1:${state.port}` : `http://${expected}:4100`));
        const network = url.hostname === expected.toLowerCase() && url.port === '4100';
        const local =
            url.hostname === '127.0.0.1' &&
            !!state.port &&
            url.port === String(state.port) &&
            new URL(this.config.computerSupervisorUrl!).hostname === '127.0.0.1';
        if (
            url.protocol !== 'http:' ||
            url.username ||
            url.password ||
            url.pathname !== '/' ||
            url.search ||
            url.hash ||
            (!network && !local)
        ) {
            throw new Error('Computer endpoint is not bound to this socio.');
        }
        return url.origin;
    }
    private async existing(id: string, signal?: AbortSignal) {
        const generation = this.restarts(id);
        const listing = z
            .object({ computers: z.array(stateSchema) })
            .parse(await this.supervisor('/computers', undefined, signal));
        const state = listing.computers.find((c) => c.botId === id);
        // Only an authoritative stopped observation ends leases. A listing
        // begun before/during a start cannot revoke that start's fresh leases.
        if ((!state || state.status !== 'running') && generation === this.restarts(id)) {
            this.hooks.stopped?.(id);
        }
        return state;
    }
    private async running(id: string, signal?: AbortSignal) {
        return (await this.runningState(id, signal)).url;
    }
    private async runningState(id: string, signal?: AbortSignal) {
        const state = await this.existing(id, signal);
        if (!state || state.status !== 'running') {
            throw new Error('Start this socio’s computer first.');
        }
        return { url: this.endpoint(id, state), health: state.health };
    }
    /**
     * A browser call ran out of time: ask the computer whether its browser is
     * stuck (a close or launch that never finished, or no answer at all). A
     * computer from before browserState was reported says only `browser:
     * false`, which after a timeout means the same. When it is stuck, this
     * Dot's browser calls fail at once for a while, unless the computer was
     * stopped or started since the call began (`restarts`).
     */
    private async stuckOrTimeout(id: string, url: string, timeout: Error, signal: AbortSignal, restarts: number) {
        const health = await this.json(
            `${url}/health`,
            this.token(id),
            undefined,
            signal,
            id,
            [],
            Math.min(HEALTH_MS, this.deadlineMs),
        )
            .then((raw) => healthSchema.safeParse(raw))
            .catch(() => undefined);
        if (signal.aborted || this.restarts(id) !== restarts) {
            return timeout;
        }
        if (
            health?.success &&
            health.data.browserState !== 'stuck' &&
            (health.data.browserState !== undefined || health.data.browser !== false)
        ) {
            return timeout;
        }
        this.stuck.set(id, Date.now() + STUCK_BROWSER_MS);
        return new Error(BROWSER_STUCK, { cause: timeout });
    }
    async status(id: string): Promise<ComputerStatus> {
        this.requireDot(id);
        const base = {
            configured: this.configured,
            permissions: await this.workspace.computers.permissions(id),
            audit: await this.workspace.computers.audit(id),
        };
        if (!this.configured) {
            return { ...base, state: 'not_configured' };
        }
        try {
            const state = await this.existing(id);
            if (!state || state.status !== 'running') {
                return { ...base, state: 'stopped' };
            }
            const url = this.endpoint(id, state);
            const control = controlSchema.parse(
                await this.json(`${url}/control`, this.token(id), undefined, undefined, id),
            );
            return { ...base, state: 'running', control };
        } catch {
            return {
                ...base,
                state: 'unavailable',
                error: 'Computer service is unavailable. Check the supervisor configuration and connection.',
            };
        }
    }
    private async audited<T>(
        id: string,
        action: string,
        actor: 'owner' | 'agent' | 'platform',
        fn: () => Promise<T>,
        userId?: string,
    ): Promise<T> {
        this.requireDot(id);
        const receipt = this.workspace.computers.begin(id, action, actor, userId);
        try {
            const result = await fn();
            this.workspace.computers.finish(receipt, 'succeeded');
            return result;
        } catch (error) {
            this.workspace.computers.finish(receipt, 'failed');
            throw error;
        }
    }
    /**
     * Where a mini app on this Dot's computer listens: the computer's
     * own host on the computers network with the app's port. Containers on
     * that network reach each other on any port; a computer on this machine
     * (a published API port on 127.0.0.1) publishes no others. Not an action
     * on the computer: nothing is audited and the agents' pause doesn't apply.
     */
    async appTarget(id: string, port: number, signal?: AbortSignal): Promise<AppTarget> {
        this.requireDot(id);
        if (!this.configured) {
            return { state: 'not_configured' };
        }
        if (!(await this.workspace.computers.permissions(id)).enabled) {
            return { state: 'disabled' };
        }
        try {
            const state = await this.existing(id, signal);
            if (!state || state.status !== 'running') {
                return { state: 'stopped' };
            }
            const origin = new URL(this.endpoint(id, state));
            if (origin.hostname === '127.0.0.1') {
                return { state: 'unreachable' };
            }
            return { state: 'running', host: origin.hostname, port };
        } catch {
            return { state: 'unavailable' };
        }
    }
    /**
     * The platform's own command on a computer (CB-224): token files it
     * deletes. Audited as `platform`, with no person.
     */
    private platformExec(
        id: string,
        url: string,
        command: string,
        signal?: AbortSignal,
        secrets: readonly string[] = [],
        principal?: ComputerPrincipal,
    ) {
        return this.audited(id, 'exec', 'platform', () =>
            this.json(
                `${url}/exec`,
                this.token(id),
                { command, timeoutMs: 5_000, principal },
                signal,
                id,
                secrets,
                Math.min(10_000, this.deadlineMs),
            ),
        );
    }
    /**
     * The platform writes a file in the computer's workspace (a mini app's
     * token file). The computer must be running and enabled; `secrets`
     * are redacted from the response.
     */
    async writeFile(
        id: string,
        path: string,
        contents: string,
        principal: ComputerPrincipal,
        secrets: readonly string[] = [],
    ) {
        this.requireDot(id);
        if (!this.configured) {
            throw new Error('Computer service is not configured.');
        }
        if (!(await this.workspace.computers.permissions(id)).enabled) {
            throw new Error('Computer permission is disabled.');
        }
        const url = await this.running(id);
        await this.requireIsolation(id, url);
        await this.json(`${url}/files/write`, this.token(id), { path, contents, principal }, undefined, id, secrets);
    }
    private async requireIsolation(id: string, url: string, signal?: AbortSignal) {
        const health = await this.json(`${url}/health`, this.token(id), undefined, signal, id, [], HEALTH_MS);
        if (
            !health ||
            typeof health !== 'object' ||
            (health as { isolationVersion?: unknown }).isolationVersion !== 1
        ) {
            throw new Error(
                'This computer needs the isolated runtime image. Restart it after upgrading the computer supervisor.',
            );
        }
    }
    async permissions(id: string, input: unknown, userId?: string) {
        const patch = computerPermissionsSchema.partial().parse(input);
        await this.audited(id, 'permissions', 'owner', async () => this.workspace.computers.patch(id, patch), userId);
        return this.status(id);
    }
    async start(id: string, userId?: string) {
        await this.audited(
            id,
            'start',
            'owner',
            async () => {
                await this.allowed(id, undefined, 'owner');
                this.restarted(id);
                this.endpoint(id, await this.supervisor(`/computers/${id}/ensure`, {}));
                this.restarted(id);
                this.telemetryStates.set(id, true);
            },
            userId,
        );
        return this.status(id);
    }
    /**
     * Starts the Dot's computer for work it does on its own (a job run): the
     * supervisor's ensure, then waits until the computer reports running,
     * up to `waitMs`. Needs shell permission and agents not paused. Returns
     * how long the wake took.
     */
    async ensureRunning(
        id: string,
        options: { userId?: string; signal?: AbortSignal; waitMs: number },
    ): Promise<number> {
        const started = Date.now();
        await this.audited(
            id,
            'start',
            'agent',
            async () => {
                await this.allowed(id, 'shell', 'agent');
                const current = await this.existing(id, options.signal);
                if (current?.status === 'running') {
                    this.endpoint(id, current);
                    return;
                }
                const deadline = started + options.waitMs;
                // Started from stopped, so whatever was stuck went with it.
                this.restarted(id);
                let state = await this.supervisor(`/computers/${id}/ensure`, {}, options.signal).catch(
                    (error: unknown) => {
                        if (options.signal?.aborted) {
                            throw error;
                        }
                        return undefined;
                    },
                );
                for (;;) {
                    const parsed = stateSchema.safeParse(state);
                    if (parsed.success && parsed.data.status === 'running') {
                        this.endpoint(id, parsed.data);
                        this.restarted(id);
                        this.telemetryStates.set(id, true);
                        return;
                    }
                    if (Date.now() >= deadline) {
                        throw new Error(`The computer did not start within ${Math.round(options.waitMs / 1000)} s.`);
                    }
                    await new Promise((resolve) => setTimeout(resolve, Math.min(2000, deadline - Date.now())));
                    options.signal?.throwIfAborted();
                    await this.allowed(id, 'shell', 'agent');
                    state = await this.existing(id, options.signal);
                }
            },
            options.userId,
        );
        return Date.now() - started;
    }
    async stop(id: string, userId?: string) {
        await this.audited(
            id,
            'stop',
            'owner',
            async () => {
                if (!this.configured) {
                    throw new Error('Computer service is not configured.');
                }
                this.stopping.add(id);
                try {
                    await this.supervisor(`/computers/${id}/stop`, {});
                    this.telemetryStates.set(id, false);
                    this.hooks.stopped?.(id);
                    // A restart is what clears a stuck browser.
                    this.restarted(id);
                } finally {
                    this.stopping.delete(id);
                }
            },
            userId,
        );
        return this.status(id);
    }
    async control(id: string, verb: 'take' | 'release', userId?: string) {
        await this.audited(
            id,
            verb,
            'owner',
            async () => {
                if (!this.configured) {
                    throw new Error('Computer service is not configured.');
                }
                if (verb === 'take') {
                    await this.allowed(id, 'browser', 'owner');
                }
                const url = await this.running(id);
                if (verb === 'take') {
                    await this.allowed(id, 'browser', 'owner');
                }
                let control: ComputerControl = controlSchema.parse(
                    await this.json(`${url}/control`, this.token(id), undefined, undefined, id),
                );
                if (verb === 'take' && !control.request) {
                    control = controlSchema.parse(
                        await this.json(
                            `${url}/control/request`,
                            this.token(id),
                            { reason: 'Owner requested control.' },
                            undefined,
                            id,
                        ),
                    );
                }
                if (verb === 'take' && control.request && !['waiting', 'taken'].includes(control.request.status)) {
                    control = controlSchema.parse(
                        await this.json(
                            `${url}/control/request`,
                            this.token(id),
                            { reason: 'Owner requested control.' },
                            undefined,
                            id,
                        ),
                    );
                }
                if (!control.request) {
                    throw new Error('There is no active control request.');
                }
                await this.json(
                    `${url}/control/${verb}`,
                    this.token(id),
                    { requestId: control.request.id },
                    undefined,
                    id,
                );
            },
            userId,
        );
        return this.status(id);
    }
    async action(
        id: string,
        action: ComputerAction,
        input: unknown,
        actor: 'owner' | 'agent' = 'owner',
        signal?: AbortSignal,
        userId?: string,
        options: ComputerActionOptions = {},
    ): Promise<unknown> {
        if (!Object.hasOwn(computerInputs, action)) {
            throw new Error('Unknown computer action.');
        }
        const parsed = computerInputs[action].parse(input);
        return this.audited(
            id,
            action,
            actor,
            async () => {
                if (actor === 'agent' && action.startsWith('human_')) {
                    throw new Error('Human controls are owner-only.');
                }
                if (action.startsWith('files_') && computerSecretPath((parsed as { path: string }).path)) {
                    throw new Error(COMPUTER_SECRET_PATH);
                }
                const kind = action === 'exec' ? 'shell' : action.startsWith('files_') ? 'files' : 'browser';
                await this.allowed(id, kind, actor);
                const principal = options.principal ?? (userId ? { kind: 'person' as const, id: userId } : undefined);
                if (kind !== 'browser' && !principal) {
                    throw new Error('A signed-in execution principal is required.');
                }
                const cancellation = new AbortController();
                inFlight.add(cancellation);
                const activeSignal = signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal;
                const watcher = setInterval(() => {
                    this.allowed(id, kind, actor).catch(() => cancellation.abort());
                }, 50);
                let url: string | undefined;
                const restarts = this.restarts(id);
                // Exec: the data space's token reaches the command through a file
                // the platform writes first and the command's prefix sources and
                // deletes; it is redacted from whatever comes back, and it ends
                // when the command returns (`release`).
                let env: ComputerExecEnv | undefined;
                let pending = false;
                try {
                    const state = await this.runningState(id, activeSignal);
                    url = state.url;
                    if (kind !== 'browser') {
                        await this.requireIsolation(id, url, activeSignal);
                    }
                    await this.allowed(id, kind, actor);
                    activeSignal.throwIfAborted();
                    if (kind === 'browser') {
                        // Known stuck: fail at once rather than wait out the limit again.
                        const until = this.stuck.get(id) ?? 0;
                        if (state.health === 'unhealthy' || until > Date.now()) {
                            throw new Error(BROWSER_STUCK);
                        }
                    }
                    const path =
                        action === 'screenshot' && options.jpegQuality
                            ? `screenshot?type=jpeg&quality=${Math.round(options.jpegQuality)}`
                            : action.replace(/^files_/, 'files/').replace(/^human_/, 'human/');
                    env =
                        action === 'exec'
                            ? options.env === null
                                ? undefined
                                : (options.env ??
                                  this.hooks.execEnv?.(
                                      id,
                                      userId,
                                      (parsed as { timeoutMs: number }).timeoutMs + 30_000,
                                  ))
                            : undefined;
                    // Redacted from everything that comes back: the data token, a
                    // job's own secrets, and mini apps' tokens on this computer.
                    const secrets = [
                        ...(env?.secrets ?? []),
                        ...(options.secrets ?? []),
                        ...(this.hooks.secrets?.(id) ?? []),
                    ];
                    let body: unknown = ['read', 'screenshot'].includes(action) ? undefined : parsed;
                    if (env) {
                        pending = true;
                        await this.json(
                            `${url}/files/write`,
                            this.token(id),
                            { ...env.file, principal },
                            activeSignal,
                            id,
                            secrets,
                        );
                        body = {
                            ...(parsed as { command: string }),
                            command: `${env.prefix}${(parsed as { command: string }).command}`,
                        };
                    }
                    if (kind !== 'browser') {
                        body = { ...(body as Record<string, unknown>), principal };
                    }
                    // Snapshots and screenshots get the shorter browser limit.
                    const readMs = Math.min(this.deadlineMs, this.browserReadMs);
                    const call = () =>
                        this.json(
                            `${url}/${path}`,
                            this.token(id),
                            body,
                            activeSignal,
                            id,
                            secrets,
                            ['snapshot', 'screenshot'].includes(action) ? readMs : this.deadlineMs,
                        );
                    let result: unknown;
                    try {
                        result = await call();
                        // The command ran, and its prefix deleted the file first.
                        pending = false;
                    } catch (error) {
                        // A person's own browser action after a restart or a handback:
                        // the computer wants a fresh snapshot first, so take one and
                        // retry once. Agents get the message and snapshot themselves.
                        if (
                            !(error instanceof ComputerConflict) ||
                            error.kind !== 'snapshot' ||
                            actor !== 'owner' ||
                            kind !== 'browser' ||
                            action === 'snapshot'
                        ) {
                            throw error;
                        }
                        await this.json(`${url}/snapshot`, this.token(id), {}, activeSignal, id, [], readMs);
                        result = await call();
                    }
                    if (kind === 'browser') {
                        this.stuck.delete(id);
                    }
                    await this.allowed(id, kind, actor);
                    if (action === 'exec' && result && typeof result === 'object') {
                        const copy = { ...result } as Record<string, unknown>;
                        delete copy.command;
                        return copy;
                    }
                    if (
                        action === 'files_list' &&
                        result &&
                        typeof result === 'object' &&
                        Array.isArray((result as { entries?: unknown }).entries)
                    ) {
                        return {
                            ...result,
                            entries: (result as { entries: unknown[] }).entries.filter(
                                (entry) =>
                                    !computerSecretPath(String((entry as { path?: unknown } | null)?.path ?? '')),
                            ),
                        };
                    }
                    return result;
                } catch (error) {
                    if (kind === 'browser' && url && error instanceof ComputerTimeout) {
                        throw await this.stuckOrTimeout(id, url, error, activeSignal, restarts);
                    }
                    throw error;
                } finally {
                    clearInterval(watcher);
                    inFlight.delete(cancellation);
                    env?.release?.();
                    // The command may never have started: delete its token file.
                    if (env && pending && url) {
                        await this.platformExec(
                            id,
                            url,
                            `[ ! -L .socio ] && [ ! -L ${COMPUTER_RUN_DIR} ] && rm -f ${env.file.path}; true`,
                            undefined,
                            env.secrets,
                            principal,
                        ).catch(() => undefined);
                    }
                }
            },
            userId,
        );
    }
}

/** The computer did not answer within its limit (not a cancellation). */
export class ComputerTimeout extends Error {}

/**
 * A 409 from the computer: a person has control (takeover), or the browser
 * needs a fresh snapshot (after a restart, a handback or a page change), or
 * another conflict the computer names. The message keeps the
 * "Computer service returned" prefix that `json` passes on as is.
 */
export class ComputerConflict extends Error {
    constructor(
        readonly kind: 'control' | 'snapshot' | 'other',
        message: string,
    ) {
        super(message);
    }
}

async function conflict(response: Response) {
    const body = (await response.json().catch(() => ({}))) as {
        humanHasControl?: boolean;
        stale?: boolean;
        snapshotRequired?: boolean;
    };
    if (body.humanHasControl) {
        return new ComputerConflict(
            'control',
            'Computer service returned HTTP 409: a person has control of this computer. Wait for them to hand it back; do not bypass takeover.',
        );
    }
    if (body.stale || body.snapshotRequired) {
        return new ComputerConflict(
            'snapshot',
            'Computer service returned HTTP 409: the page changed or the computer restarted. Take a new computer_snapshot, then retry with its refs.',
        );
    }
    return new ComputerConflict(
        'other',
        'Computer service returned HTTP 409: the computer refused this action in its current state. Take a computer_snapshot and try again.',
    );
}
