/**
 * Plugin snapshots, taken (CB-458): the host's side of the snapshot
 * protocol, driven over the ingress, into the store (`plugin-store.ts`).
 *
 * One snapshot: list the plugin's running tasks and pin every request to
 * one; `POST /__cb/backup` with a host-chosen id; poll
 * `GET /__cb/backup/{snapshotId}` until it is `ready` or `failed`; hand the
 * ready answer to the store, which checks it, fetches what it lacks and
 * seals it; then the level 1 drill on what was stored. The plugin's copy is
 * always dropped (`DELETE`), failed or not. A snapshot has
 * PLUGIN_SNAPSHOT_TIME_MS from its start, so a plugin that hangs fails
 * alone, and never throws: a failure is a result, with a reason that names
 * no path.
 *
 * What happened to each plugin is kept in `BACKUP_DIR/plugin-snapshots.json`
 * beside `backup-status.json`: its last good snapshot and its size, its
 * last failure, since when it fails or is disabled, its last check, what
 * admins last heard, and the requests it made in the last day. The status
 * on Service setup and the plugin's page is the manifest's (`pluginBackupStatuses`)
 * with this over it (`withSnapshots`). Notices (`observeSnapshotNotices`) are
 * pure, as `plugin-gaps.ts`'s are.
 */
import { readFileSync } from 'node:fs';

import { writePrivate } from '@socio/data/backup';
import type { PluginBackupStatus, PluginSnapshotReason } from '@socio/shared/plugins/plugin-backup';
import { PLUGIN_MANIFEST_MAX_BYTES, PluginSnapshotError } from '@socio/shared/plugins/plugin-snapshot';

import { httpSnapshotSource } from './plugin-source.js';
import {
    PLUGIN_END_TIME_MS,
    PLUGIN_SNAPSHOT_TIME_MS,
    newSnapshotId,
    type PluginSnapshotInstall,
    type PluginSnapshotSource,
    type PluginSnapshotStore,
} from './plugin-store.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** How often the host asks whether a snapshot is ready. */
export const PLUGIN_POLL_MS = 2_000;
/** A plugin's own requests (`socio.backup.request`): at most one an hour and four a day. */
export const PLUGIN_REQUESTS_PER_HOUR = 1;
export const PLUGIN_REQUESTS_PER_DAY = 4;
/** Notices about a plugin that stays failing or stale: at most once a day. */
export const PLUGIN_NOTICE_EVERY_MS = DAY;

/** One installed plugin that declares `service.backup`, as a snapshot records it. */
export interface PluginBackupTarget extends PluginSnapshotInstall {
    id: string;
    name: string;
    /** Enabled with replicas above 0: a disabled plugin isn't started for a backup. */
    running: boolean;
}

/** One host call to a plugin on `/__cb/`, pinned to `task`; its answer as `fetch` gives it. */
export type PluginHostRequest = (
    id: string,
    request: { method: 'GET' | 'POST' | 'DELETE'; target: string; task: string; body?: string; signal?: AbortSignal },
) => Promise<Response>;

/** What snapshots need of the plugins: the installs that declare backups, their tasks, and host calls. */
export interface PluginSnapshotHost {
    targets(): PluginBackupTarget[];
    tasks(id: string): Promise<string[]>;
    call: PluginHostRequest;
}

/** One plugin's snapshot, as it went. */
export type PluginAttempt =
    | {
          id: string;
          ok: true;
          snapshotId: string;
          bytes: number;
          fetched: { chunks: number; bytes: number };
          reused: number;
      }
    | { id: string; ok: false; error: string };

/** One plugin's record in `plugin-snapshots.json`. */
export interface PluginSnapshotRecord {
    lastAttemptAt?: number;
    lastSuccessAt?: number;
    lastSnapshotId?: string;
    sizeBytes?: number;
    lastErrorAt?: number;
    lastError?: string;
    /** The first failure in the current streak. */
    failingSince?: number;
    lastCheck?: { at: number; ok: boolean; error?: string };
    disabledSince?: number;
    /** What admins last heard of it, once delivered: failing or stale, and when. */
    noticed?: { state: 'failing' | 'stale'; at: number };
    /** Its own requests accepted in the last day. */
    requests?: number[];
}

export type PluginSnapshotFile = Record<string, PluginSnapshotRecord>;

const statePath = (directory: string) => `${directory}/plugin-snapshots.json`;

export function readPluginSnapshots(directory: string): PluginSnapshotFile {
    try {
        const parsed = JSON.parse(readFileSync(statePath(directory), 'utf8')) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as PluginSnapshotFile) : {};
    } catch {
        return {};
    }
}

export function writePluginSnapshots(directory: string, file: PluginSnapshotFile) {
    writePrivate(statePath(directory), JSON.stringify(file));
}

/** A plugin's reason in words that name no path, cut short. */
export function snapshotFailure(error: unknown) {
    if (error instanceof PluginSnapshotError) {
        return clean(error.message);
    }
    const code = (error as NodeJS.ErrnoException)?.code;
    if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) {
        return `File system error (${code}).`;
    }
    const name = (error as { name?: string })?.name;
    if (name === 'TimeoutError') {
        return 'The snapshot ran out of time.';
    }
    if (name === 'AbortError') {
        return 'The snapshot was cancelled.';
    }
    return 'The plugin couldn’t be reached.';
}

const clean = (text: string) =>
    text
        // oxlint-disable-next-line no-control-regex -- control characters are what it strips
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/(\/[^\s'"]+)+/g, '…')
        .slice(0, 300);

/** A body, cut at `cap` bytes. */
async function readCapped(response: Response, cap: number, signal: AbortSignal) {
    const parts: Buffer[] = [];
    let size = 0;
    for await (const piece of (response.body as AsyncIterable<Uint8Array> | null) ?? []) {
        signal.throwIfAborted();
        size += piece.length;
        if (size > cap) {
            await response.body?.cancel().catch(() => undefined);
            throw new PluginSnapshotError(`The plugin's snapshot answer is over ${cap} bytes.`);
        }
        parts.push(Buffer.from(piece));
    }
    return Buffer.concat(parts);
}

/** Waits `ms`, or rejects at `signal`. */
function wait(ms: number, signal: AbortSignal) {
    return new Promise<void>((done, fail) => {
        if (signal.aborted) {
            fail(signal.reason);
            return;
        }
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', abort);
            done();
        }, ms);
        const abort = () => {
            clearTimeout(timer);
            fail(signal.reason);
        };
        signal.addEventListener('abort', abort, { once: true });
    });
}

export interface PluginSnapshotsDeps {
    store: PluginSnapshotStore;
    host: PluginSnapshotHost;
    /** The per-plugin size cap in force: an admin's over the environment's, 20 GiB by default. */
    maxBytes: () => number;
    now?: () => number;
    /** PLUGIN_SNAPSHOT_TIME_MS by default: begin, polls, fetches and the check. */
    timeMs?: number;
    /** PLUGIN_POLL_MS by default. */
    pollMs?: number;
    /** PLUGIN_END_TIME_MS by default: the `DELETE` of a snapshot the store never reached. */
    endMs?: number;
}

/** Takes one plugin's snapshot over the protocol. */
export class PluginSnapshots {
    private readonly now: () => number;
    constructor(private readonly deps: PluginSnapshotsDeps) {
        this.now = deps.now ?? Date.now;
    }

    /** One snapshot, start to end: never throws. */
    async take(
        target: PluginBackupTarget,
        reason: PluginSnapshotReason,
        options: { run?: string; note?: string; signal?: AbortSignal } = {},
    ): Promise<PluginAttempt> {
        const { id } = target;
        const deadline = AbortSignal.timeout(this.deps.timeMs ?? PLUGIN_SNAPSHOT_TIME_MS);
        const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
        const snapshotId = newSnapshotId(this.now());
        let source: PluginSnapshotSource | undefined;
        let began = false;
        try {
            const tasks = await this.deps.host.tasks(id);
            const task = tasks[0];
            if (task === undefined) {
                throw new PluginSnapshotError('The plugin isn’t running, so no snapshot could be taken.');
            }
            // Every request of this snapshot goes to the one task.
            const call = (request: {
                method: 'GET' | 'POST' | 'DELETE';
                target: string;
                body?: string;
                signal?: AbortSignal;
            }) => this.deps.host.call(id, { ...request, task });
            source = httpSnapshotSource(snapshotId, (request) => call(request));
            // From the moment the start is sent: an answer lost on the way may still have started a copy.
            began = true;
            const started = await call({
                method: 'POST',
                target: '/__cb/backup',
                body: JSON.stringify({ snapshotId, reason, quiesce: false }),
                signal,
            });
            await started.body?.cancel().catch(() => undefined);
            if (started.status !== 202) {
                throw new PluginSnapshotError(`The plugin answered ${started.status} to starting a snapshot.`);
            }
            const ready = await this.poll(call, snapshotId, signal);
            // From here the store ends the plugin's copy, failed or not.
            began = false;
            const taken = await this.deps.store.take({
                pluginId: id,
                snapshotId,
                reason,
                ...(options.run !== undefined ? { run: options.run } : {}),
                ...(options.note !== undefined ? { note: options.note } : {}),
                install: target,
                maxBytes: this.deps.maxBytes(),
                signal,
                source: {
                    // The ready answer the poll read, under the same cap.
                    manifest: async () => once(ready),
                    item: source.item,
                    end: source.end,
                },
            });
            return {
                id,
                ok: true,
                snapshotId,
                bytes: taken.snapshot.bytes,
                fetched: taken.fetched,
                reused: taken.reused,
            };
        } catch (error) {
            return { id, ok: false, error: signal.aborted ? snapshotFailure(signal.reason) : snapshotFailure(error) };
        } finally {
            // The store ends what it took; a begin that never reached it is ended here.
            if (began && source) {
                await source.end(AbortSignal.timeout(this.deps.endMs ?? PLUGIN_END_TIME_MS)).catch(() => undefined);
            }
        }
    }

    /** `GET /__cb/backup/{snapshotId}` until it is ready: its body, or why not. */
    private async poll(
        call: (request: { method: 'GET'; target: string; signal?: AbortSignal }) => Promise<Response>,
        snapshotId: string,
        signal: AbortSignal,
    ): Promise<Buffer> {
        for (;;) {
            const answer = await call({ method: 'GET', target: `/__cb/backup/${snapshotId}`, signal });
            if (answer.status !== 200) {
                await answer.body?.cancel().catch(() => undefined);
                throw new PluginSnapshotError(`The plugin answered ${answer.status} for its snapshot.`);
            }
            const body = await readCapped(answer, PLUGIN_MANIFEST_MAX_BYTES, signal);
            let state: unknown;
            let error: unknown;
            try {
                ({ state, error } = JSON.parse(body.toString('utf8')) as { state?: unknown; error?: unknown });
            } catch {
                throw new PluginSnapshotError("The plugin's snapshot answer couldn't be read.");
            }
            if (state === 'ready') {
                return body;
            }
            if (state === 'failed') {
                throw new PluginSnapshotError(
                    `The plugin couldn’t take its snapshot: ${typeof error === 'string' && error.trim() ? error.trim() : 'it gave no reason.'}`,
                );
            }
            if (state !== 'preparing') {
                throw new PluginSnapshotError('The plugin has no snapshot for this id.');
            }
            await wait(this.deps.pollMs ?? PLUGIN_POLL_MS, signal);
        }
    }
}

const once = (body: Buffer): AsyncIterable<Uint8Array> => ({
    async *[Symbol.asyncIterator]() {
        yield body;
    },
});

/** The record after one attempt at `now`. */
export function recordAttempt(
    record: PluginSnapshotRecord | undefined,
    attempt: PluginAttempt,
    now: number,
    check?: { ok: boolean; error?: string },
): PluginSnapshotRecord {
    const base: PluginSnapshotRecord = { ...record, lastAttemptAt: now };
    delete base.disabledSince;
    if (attempt.ok && check?.ok !== false) {
        const next: PluginSnapshotRecord = {
            ...base,
            lastSuccessAt: now,
            lastSnapshotId: attempt.snapshotId,
            sizeBytes: attempt.bytes,
            ...(check ? { lastCheck: { at: now, ok: true } } : {}),
        };
        delete next.lastError;
        delete next.lastErrorAt;
        delete next.failingSince;
        return next;
    }
    const error = attempt.ok ? `The snapshot failed its check: ${check?.error ?? 'unknown'}` : attempt.error;
    return {
        ...base,
        lastErrorAt: now,
        lastError: error,
        failingSince: record?.failingSince ?? now,
        ...(check ? { lastCheck: { at: now, ok: false, ...(check.error ? { error: check.error } : {}) } } : {}),
    };
}

/**
 * The manifest's status (`pluginBackupStatuses`) with what the snapshots
 * say over it: a plugin that declares `backup` and has a good snapshot is
 * no longer `not_backed_up`. Failing beats stale; disabled beats both.
 */
export function withSnapshots(
    statuses: readonly PluginBackupStatus[],
    file: PluginSnapshotFile,
    context: { now: number; intervalHours: number; disabled: ReadonlySet<string>; running: ReadonlySet<string> },
): PluginBackupStatus[] {
    return statuses.map((status) => {
        if (!status.declared) {
            return status;
        }
        const record = file[status.id];
        const out: PluginBackupStatus = { ...status };
        if (record?.lastSuccessAt !== undefined) {
            out.lastSuccessAt = record.lastSuccessAt;
        }
        if (record?.sizeBytes !== undefined) {
            out.sizeBytes = record.sizeBytes;
        }
        if (record?.lastError !== undefined) {
            out.lastError = record.lastError;
            out.lastErrorAt = record.lastErrorAt ?? record.lastAttemptAt ?? context.now;
        }
        if (record?.lastCheck) {
            out.lastCheck = record.lastCheck;
        }
        if (context.running.has(status.id)) {
            out.running = true;
        }
        const staleAfter = context.intervalHours > 0 ? 2 * context.intervalHours * HOUR : undefined;
        if (context.disabled.has(status.id)) {
            out.state = 'disabled';
            if (record?.disabledSince !== undefined) {
                out.since = record.disabledSince;
            }
        } else if (record?.lastError !== undefined) {
            out.state = 'failing';
            out.since = record.failingSince ?? out.lastErrorAt;
        } else if (record?.lastSuccessAt === undefined) {
            out.state = 'not_backed_up';
        } else if (staleAfter !== undefined && context.now - record.lastSuccessAt > staleAfter) {
            out.state = 'stale';
        } else {
            out.state = 'ok';
        }
        return out;
    });
}

/** A notice about a plugin's snapshots: failing, out of date, or recovered. */
export interface PluginSnapshotNotice {
    id: string;
    kind: 'failing' | 'stale' | 'recovered';
    title: string;
    message: string;
    path: string;
}

/**
 * The notices one check owes: on the first failure, when the last good
 * snapshot is older than twice the interval, and on recovery; while a
 * plugin stays failing or stale, a reminder at most once a day.
 * The caller records each with `snapshotNoticed` once it was delivered.
 */
export function observeSnapshotNotices(
    statuses: readonly PluginBackupStatus[],
    file: PluginSnapshotFile,
    now: number,
): PluginSnapshotNotice[] {
    const notices: PluginSnapshotNotice[] = [];
    for (const status of statuses) {
        if (!status.declared) {
            continue;
        }
        const noticed = file[status.id]?.noticed;
        const path = `/settings/plugins/${encodeURIComponent(status.id)}`;
        if (status.state === 'failing' || status.state === 'stale') {
            if (noticed?.state === status.state && now - noticed.at < PLUGIN_NOTICE_EVERY_MS) {
                continue;
            }
            const last = status.lastSuccessAt
                ? `Its last good backup is from ${new Date(status.lastSuccessAt).toISOString().slice(0, 16).replace('T', ' ')} UTC.`
                : 'It has no good backup yet.';
            notices.push(
                status.state === 'failing'
                    ? {
                          id: status.id,
                          kind: 'failing',
                          title: `Plugin backup failed: ${status.name}`,
                          message: `The workspace couldn’t back up ${status.name}: ${status.lastError ?? 'unknown reason'} ${last} The workspace’s own backup is not affected, and it tries again with the next backup.`,
                          path,
                      }
                    : {
                          id: status.id,
                          kind: 'stale',
                          title: `Plugin backup out of date: ${status.name}`,
                          message: `${status.name} hasn’t been backed up for more than two backup intervals. ${last}`,
                          path,
                      },
            );
        } else if (status.state === 'ok' && noticed) {
            notices.push({
                id: status.id,
                kind: 'recovered',
                title: `Plugin backup working again: ${status.name}`,
                message: `${status.name} was backed up again.`,
                path,
            });
        }
    }
    return notices;
}

/** The file once `notice` was delivered at `now`. */
export function snapshotNoticed(
    file: PluginSnapshotFile,
    notice: PluginSnapshotNotice,
    now: number,
): PluginSnapshotFile {
    const record = { ...file[notice.id] };
    if (notice.kind === 'recovered') {
        delete record.noticed;
    } else {
        record.noticed = { state: notice.kind, at: now };
    }
    return { ...file, [notice.id]: record };
}

/** A plugin's own request: accepted, or how long until one would be. */
export function requestAllowed(
    record: PluginSnapshotRecord | undefined,
    now: number,
): { ok: true; requests: number[] } | { ok: false; retryAfterSeconds: number } {
    const recent = (record?.requests ?? []).filter((at) => typeof at === 'number' && now - at < DAY).sort();
    const lastHour = recent.filter((at) => now - at < HOUR);
    if (lastHour.length >= PLUGIN_REQUESTS_PER_HOUR) {
        return { ok: false, retryAfterSeconds: Math.ceil((lastHour[0]! + HOUR - now) / 1000) };
    }
    if (recent.length >= PLUGIN_REQUESTS_PER_DAY) {
        return {
            ok: false,
            retryAfterSeconds: Math.ceil((recent[recent.length - PLUGIN_REQUESTS_PER_DAY]! + DAY - now) / 1000),
        };
    }
    return { ok: true, requests: [...recent, now] };
}
