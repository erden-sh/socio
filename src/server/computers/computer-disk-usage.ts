import { z } from 'zod';

import type { ComputerDiskStatus } from '@socio/shared/computers/computer-resources';

import type { ComputerDiskReading, ComputerDiskShape } from './contract.js';

/**
 * How often the computers' disk usage is measured (CB-197). Docker's df
 * walks every volume on the host and has taken over 45 s on a busy host, so it
 * runs in the background at this pace, never inside a resource sample.
 */
export const DISK_USAGE_EVERY_MS = 15 * 60_000;
/** How long one measurement may take before it counts as unavailable. */
export const DISK_USAGE_TIMEOUT_MS = 10 * 60_000;
/** A measurement older than this is no longer shown as current. */
export const DISK_USAGE_FRESH_MS = 3 * DISK_USAGE_EVERY_MS;

const BOT_LABEL = 'openbot.bot-id';
const VOLUME_KINDS = ['workspace', 'profile', 'private'] as const;
const owned = (namespace: string, labels: Record<string, string>) =>
    labels['openbot.supervisor'] === 'true' && (labels['openbot.namespace'] ?? 'openbot') === namespace;
/** A coding sandbox's workspace volume (CB-239, coding-sandbox.mjs). */
const VOLUME_KEY = /^[a-f0-9]{64}$/;
const codingOwned = (namespace: string, labels: Record<string, string>) =>
    labels['socio.coding.supervisor'] === 'true' && labels['socio.coding.namespace'] === namespace;
const labels = z.record(z.string(), z.string());
const volumesSchema = z.object({
    Volumes: z.array(
        z.object({
            Name: z.string(),
            Labels: labels,
            UsageData: z.object({ Size: z.number().finite() }),
        }),
    ),
});
const containersSchema = z.array(
    z.object({
        Names: z.array(z.string()),
        Labels: labels,
        SizeRw: z.number().finite(),
    }),
);

const NONE: ComputerDiskReading = { volumeBytes: null, containerBytes: null };

export type DiskUsageRead = (path: string, signal: AbortSignal) => Promise<unknown>;

/**
 * The computers' disk usage from the read-only disk usage proxy
 * (deployment/computers/disk-usage-proxy.mjs). One measurement for every
 * computer at a time, at most every 15 minutes; readers only ever see the
 * last result, so a slow or missing proxy never delays a resource sample.
 */
export class ComputerDiskUsage implements ComputerDiskShape {
    private readings = new Map<string, ComputerDiskReading>();
    /** Coding workspace volumes' sizes, by volume key (CB-239). */
    private workspaces = new Map<string, number>();
    private measuredAt: number | null = null;
    private attemptedAt: number | null = null;
    private failed = false;
    /** The measurement in progress, if any (tests await it). */
    pending?: Promise<void>;
    constructor(
        private read: DiskUsageRead | null,
        private namespace: string,
        private now: () => number = Date.now,
    ) {}

    status(): ComputerDiskStatus {
        const fresh = this.fresh();
        return {
            state: !this.read ? 'off' : this.failed && !fresh ? 'unavailable' : fresh ? 'ok' : 'pending',
            measuredAt: this.measuredAt,
            everyMinutes: DISK_USAGE_EVERY_MS / 60_000,
        };
    }

    /** The last measurement for one socio's computer, or nulls when there is none or it is stale. */
    reading(dotId: string): ComputerDiskReading {
        return this.fresh() ? (this.readings.get(dotId) ?? NONE) : NONE;
    }

    /**
     * The last measured size of a coding sandbox's workspace volume (CB-239,
     * the Computer panel's sandbox list), or null when there is none
     * or it is stale.
     */
    workspace(volumeKey: string): number | null {
        return this.fresh() ? (this.workspaces.get(volumeKey) ?? null) : null;
    }

    /** Starts a measurement when one is due. Never waits for it. */
    refresh(signal?: AbortSignal) {
        if (!this.read || this.pending || signal?.aborted) {
            return;
        }
        const now = this.now();
        if (this.attemptedAt !== null && now - this.attemptedAt < DISK_USAGE_EVERY_MS) {
            return;
        }
        this.attemptedAt = now;
        const bounded = signal
            ? AbortSignal.any([signal, AbortSignal.timeout(DISK_USAGE_TIMEOUT_MS)])
            : AbortSignal.timeout(DISK_USAGE_TIMEOUT_MS);
        this.pending = this.measure(this.read, bounded)
            .then(
                ({ readings, workspaces }) => {
                    this.readings = readings;
                    this.workspaces = workspaces;
                    this.measuredAt = this.now();
                    this.failed = false;
                },
                () => {
                    // The last good measurement stays shown until it is stale.
                    this.failed = true;
                },
            )
            .finally(() => {
                this.pending = undefined;
            });
    }

    private fresh() {
        return this.measuredAt !== null && this.now() - this.measuredAt < DISK_USAGE_FRESH_MS;
    }

    private async measure(read: DiskUsageRead, signal: AbortSignal) {
        const [df, containers] = await Promise.all([
            read('/v1.44/system/df?type=volume', signal),
            read('/v1.44/containers/json?all=true&size=true', signal),
        ]);
        const ns = this.namespace;
        // The proxy filters too; the app checks names and labels again.
        const sizes = new Map<string, number>();
        const workspaces = new Map<string, number>();
        for (const volume of volumesSchema.parse(df).Volumes) {
            const key = volume.Labels['socio.coding.volume'];
            if (
                key &&
                VOLUME_KEY.test(key) &&
                codingOwned(ns, volume.Labels) &&
                volume.Name === `${ns}-code-work-${key}`
            ) {
                if (volume.UsageData.Size >= 0) {
                    workspaces.set(key, volume.UsageData.Size);
                }
                continue;
            }
            const bot = volume.Labels[BOT_LABEL];
            if (
                !bot ||
                !owned(ns, volume.Labels) ||
                !VOLUME_KINDS.some((kind) => volume.Name === `${ns}-${kind}-${bot}`)
            ) {
                continue;
            }
            sizes.set(volume.Name, volume.UsageData.Size);
        }
        const layers = new Map<string, number>();
        for (const container of containersSchema.parse(containers)) {
            const bot = container.Labels[BOT_LABEL];
            if (
                bot &&
                owned(ns, container.Labels) &&
                container.Names.includes(`/${ns}-computer-${bot}`) &&
                container.SizeRw >= 0
            ) {
                layers.set(bot, container.SizeRw);
            }
        }
        const bots = new Set([
            ...layers.keys(),
            ...[...sizes.keys()].flatMap((name) => {
                const kind = VOLUME_KINDS.find((kind) => name.startsWith(`${ns}-${kind}-`));
                return kind ? [name.slice(`${ns}-${kind}-`.length)] : [];
            }),
        ]);
        const readings = new Map<string, ComputerDiskReading>();
        for (const bot of bots) {
            // All three volumes with a known size, or none: never a partial total.
            const volumes = VOLUME_KINDS.map((kind) => sizes.get(`${ns}-${kind}-${bot}`));
            readings.set(bot, {
                volumeBytes: volumes.every((size) => size !== undefined && size >= 0)
                    ? volumes.reduce((sum: number, size) => sum + size!, 0)
                    : null,
                containerBytes: layers.get(bot) ?? null,
            });
        }
        return { readings, workspaces };
    }
}
