import { constants } from 'node:fs';
import { open, opendir, stat, statfs, type FileHandle } from 'node:fs/promises';
import { freemem, loadavg, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { sqliteData } from '@socio/data/open';
import { COMPUTER_RESOURCE_METRICS, type ComputerResourceMetric } from '@socio/shared/computers/computer-resources';
import { RESOURCE_METRICS, type ResourceValues } from '@socio/shared/operations/operations-resources';

import { Computers } from '../computers/contract.js';
import { Data } from '../dataspace/contract.js';
import type { ModuleContext } from '../modules/contract.js';
import { WorkspaceSettings } from '../settings/contract.js';

import { OperationsConfig } from './contract.js';
import { sampleDeployment } from './deployment-samples.js';
import { SqliteResourceSource } from './infra/sqlite/resource-source.js';
import { SqliteResourceSamples, StaleResourceSample } from './infra/sqlite/samples.js';
import { resourcePolicyView } from './retention.js';

const DAY = 86_400_000;
/** Bounded daily scan: no symlink following and no partial size claimed as total. */
export async function directoryBytes(path: string, maximumEntries = 20000, maximumMs = 2000): Promise<number | null> {
    const end = Date.now() + maximumMs;
    let bytes = 0,
        entries = 0;
    // Linux descriptor-relative traversal keeps every child anchored to its open
    // parent. O_NOFOLLOW rejects roots or children replaced with symlinks.
    if (process.platform !== 'linux') {
        return null;
    }
    const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    const walk = async (directory: FileHandle, depth: number) => {
        if (depth > 64 || Date.now() > end) {
            throw new Error('Directory scan limit');
        }
        for await (const entry of await opendir(`/proc/self/fd/${directory.fd}`)) {
            if (++entries > maximumEntries || Date.now() > end) {
                throw new Error('Directory scan limit');
            }
            if (!entry.isDirectory() && !entry.isFile()) {
                continue;
            }
            let child: FileHandle;
            try {
                child = await open(
                    join(`/proc/self/fd/${directory.fd}`, entry.name),
                    flags | (entry.isDirectory() ? constants.O_DIRECTORY : 0),
                );
            } catch (error) {
                if (['ELOOP', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) {
                    continue;
                }
                throw error;
            }
            try {
                const info = await child.stat();
                if (info.isDirectory()) {
                    await walk(child, depth + 1);
                } else if (info.isFile()) {
                    bytes += info.size;
                }
            } finally {
                await child.close();
            }
        }
    };
    let root: FileHandle | undefined;
    try {
        root = await open(resolve(path), flags | constants.O_DIRECTORY);
        await walk(root, 0);
        return bytes;
    } catch {
        return null;
    } finally {
        await root?.close();
    }
}

/**
 * One instance per runtime (its context's services), never a
 * process-global collector shared by tests. It reads the data folder
 * (`Data`'s `dir`) and the computers' readings and the deployment's
 * metrics (`Computers`) from the app's services at each sample.
 */
export class ResourceSampler {
    private previous?: { at: number; cpu: NodeJS.CpuUsage };
    private collection?: Promise<void>;
    private controller = new AbortController();
    constructor(private context: ModuleContext) {}
    start() {
        if (this.controller.signal.aborted) {
            this.controller = new AbortController();
        }
        return this.collect();
    }
    async stop() {
        this.controller.abort();
        await this.collection?.catch(() => {});
    }
    collect(now = Date.now()): Promise<void> {
        if (this.controller.signal.aborted) {
            return Promise.resolve();
        }
        if (!this.collection) {
            this.collection = this.sample(now).finally(() => {
                this.collection = undefined;
            });
        }
        return this.collection;
    }
    private async sample(now: number) {
        try {
            const { db, services } = this.context;
            const policy = resourcePolicyView(
                services.get(WorkspaceSettings).settings().operations,
                services.get(OperationsConfig).operations?.resources,
            ).policy;
            const samples = new SqliteResourceSamples(sqliteData(db));
            const latest = await samples.latest();
            if (latest && now - latest.at < policy.sampleEverySeconds * 1000) {
                return;
            }
            const values = Object.fromEntries(
                Object.keys(RESOURCE_METRICS).map((key) => [key, null]),
            ) as ResourceValues;
            values.rssBytes = process.memoryUsage().rss;
            const cpu = process.cpuUsage();
            if (this.previous && now > this.previous.at) {
                values.cpuPercent = Math.max(
                    0,
                    ((cpu.user + cpu.system - this.previous.cpu.user - this.previous.cpu.system) /
                        ((now - this.previous.at) * 1000)) *
                        100,
                );
            }
            this.previous = { at: now, cpu };
            [values.load1, values.load5, values.load15] = loadavg();
            values.freeMemoryBytes = freemem();
            values.totalMemoryBytes = totalmem();
            const source = new SqliteResourceSource(db);
            const database = source.database();
            values.databasePages = database.pages;
            values.databaseFreePages = database.freePages;
            try {
                const volume = await statfs(database.path ? dirname(database.path) : services.get(Data).dir);
                values.volumeBytes = volume.blocks * volume.bsize;
                values.volumeFreeBytes = volume.bavail * volume.bsize;
            } catch {
                /* Missing filesystem measurements remain visible as gaps. */
            }
            if (database.path) {
                try {
                    values.walBytes = (await stat(database.path + '-wal')).size;
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                        values.walBytes = 0;
                    }
                }
            }
            if (!(await samples.dailyCollectedSince(Math.floor(now / DAY) * DAY))) {
                Object.assign(values, source.daily());
                values.userdataBytes = await directoryBytes(services.get(Data).dir);
            }
            await samples.record({ at: now, values }, policy.sampleDays, () => !this.controller.signal.aborted);
            // The whole deployment's services (CB-321): a missing or failing
            // port is a gap and a status, never a failed sample.
            await sampleDeployment({
                owner: services,
                metrics: services.get(Computers).deployment,
                data: sqliteData(db),
                at: now,
                keepDays: policy.sampleDays,
                signal: this.controller.signal,
            }).catch((error) => {
                if (error instanceof StaleResourceSample || this.controller.signal.aborted) {
                    return false;
                }
                throw error;
            });
            const computers = await services
                .get(Computers)
                .resourceReadings(this.controller.signal)
                .catch(() => []);
            for (const reading of computers) {
                try {
                    await new SqliteResourceSamples<ComputerResourceMetric>(
                        sqliteData(db),
                        reading.dotId,
                        COMPUTER_RESOURCE_METRICS,
                    ).record({ at: now, values: reading.stats.values }, policy.sampleDays, reading.current);
                } catch (error) {
                    if (!(error instanceof StaleResourceSample)) {
                        throw error;
                    }
                }
            }
        } catch (error) {
            if (!this.controller.signal.aborted) {
                throw error;
            }
        }
    }
}

/** Each runtime's sampler, by its context's services (one per platform). */
const samplers = new WeakMap<object, ResourceSampler>();
export function resourceSampler(context: ModuleContext) {
    let sampler = samplers.get(context.services);
    if (!sampler) {
        samplers.set(context.services, (sampler = new ResourceSampler(context)));
    }
    return sampler;
}
