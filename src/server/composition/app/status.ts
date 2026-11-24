/**
 * The app's status (`AppStatus`): `setup`, `requireReady`,
 * `transcriptionSources`, `statusEpoch`, `adminSetup` and `health`, read
 * through the tag. It fills `ports.setup`. Placed in the graph (`composition/index.ts`)
 * after every service it reads (`liveLayers.counters`) and after the data keys'
 * step; it registers no listener, so the graph's order doesn't change. One per
 * runtime: `statusEpoch`'s count is its state.
 */
import { Context, Effect, Layer } from 'effect';

import { callsSetup } from '@socio/foundation/voice/speech-provider';
import {
    dictationSetup,
    transcriptionProvider,
    type TranscriptionSources,
} from '@socio/foundation/voice/transcription-provider';
import type { CopyAlertLevel } from '@socio/shared/continuous-copy';
import type { SetupStatus } from '@socio/shared/types';

import type { BackupService } from '../../backup/backup-service.js';
import type { InferenceService } from '../../inference/service.js';
import type { ModuleContext, ModuleHealth, ServerModule } from '../../modules/contract.js';
import type { AnalyticsClient } from '../../operations/analytics/client.js';
import { Dictation, type DictationShape } from '../../voice/contract.js';
import type { TranscriptionKeys } from '../../voice/transcription.js';
import { LegacyConfig, LegacyStore, ModuleHost } from '../base.js';
import { setupStatus, type PlatformConfig } from '../config.js';
import type { CoreStore } from '../core-store.js';
import { LegacyInference } from '../inference.js';
import { LegacyAnalytics } from '../operations.js';
import { Ports } from '../ports.js';
import { LegacyTranscriptionKeys } from '../voice.js';

import { DataKeyAdmin, type DataKeyAdminShape } from './data-keys.js';

/** What `/healthz` answers (`AppStatus.health`). */
export interface HealthStatus {
    ok: true;
    model: SetupStatus['model'];
    storage?: SetupStatus['storage'];
    analytics?: NonNullable<SetupStatus['analytics']>['state'];
    dataKey: 'key_missing' | 'not_set' | 'resealing' | 'ok';
    dataKeyId?: string;
    dataKeyPreviousId?: string;
    legacySealed: number;
    draining?: true;
    /** CB-340: how many registered datasets' files are missing; ids are in admins' setup. */
    datasetFiles?: { missing: number; warning?: string };
    /**
     * CB-315: the continuous copy's level (`off` without
     * LITESTREAM_REPLICA_DIR), with backups set up; its lag and log size
     * are in admins' setup and Operations → Health.
     */
    litestream?: 'off' | CopyAlertLevel;
}

/** The app's status: what `/setup`, `/healthz` and the shell's version read. */
export interface AppStatusShape {
    /**
     * Setup status, for a user when given: `model` and `inference` say whether
     * their chats have a model.
     */
    setup(userId?: string): Promise<SetupStatus>;
    /** Throws `Setup required: ...` while the environment's model settings are missing. */
    requireReady(): Promise<void>;
    /** What picks dictation's transcription server and key (CB-204). */
    transcriptionSources(): TranscriptionSources;
    /** Changes when the setup status may have. */
    statusEpoch(): number;
    /** What admins see on top of `setup()`: the data key, backups and missing dataset files. */
    adminSetup(): Promise<Pick<SetupStatus, 'dataKey' | 'backup' | 'datasetFiles'>>;
    /** `/healthz`. */
    health(): Promise<HealthStatus>;
}

/** The app's status, one per runtime (`composition/app/status.ts`). */
export class AppStatus extends Context.Service<AppStatus, AppStatusShape>()('socio/composition/app/AppStatus') {}

/** What the app's status reads. */
export interface StatusSources {
    readonly config: PlatformConfig;
    readonly store: Pick<CoreStore, 'slices'>;
    readonly inference: Pick<InferenceService, 'registered' | 'availability'>;
    readonly transcriptionKeys: Pick<TranscriptionKeys, 'read'>;
    readonly analytics?: Pick<AnalyticsClient, 'mode' | 'health'>;
    readonly modules: readonly ServerModule[];
    readonly context: ModuleContext;
    readonly dataKeys: Pick<DataKeyAdminShape, 'status' | 'resealing' | 'lastReseal'>;
    /** Dictation's streams, read at the moment of use. */
    dictation(): DictationShape;
    /** Scheduled backups, read at the moment of use (their late-bound port). */
    backups(): BackupService | undefined;
    /** Whether the server drains (its late-bound port), read at the moment of use. */
    draining(): boolean;
}

/** The app's status over its sources (`AppStatus`). */
export class Status implements AppStatusShape {
    private epoch = { epoch: 0, fingerprint: '' };
    constructor(private readonly sources: StatusSources) {}

    /**
     * `/healthz`. Stays 200 while draining: it is a liveness check, and a
     * failing one could get the task replaced while it drains.
     */
    async health(): Promise<HealthStatus> {
        const setup = await this.setup();
        const key = await this.sources.dataKeys.status();
        const files = this.moduleHealth().datasetFiles;
        const backups = this.sources.backups();
        const copy = backups?.status().continuous;
        return {
            ok: true,
            model: setup.model,
            ...(setup.storage ? { storage: setup.storage } : {}),
            ...(setup.analytics ? { analytics: setup.analytics.state } : {}),
            // CB-62: key_missing when some are under a key this server doesn't
            // have (a data key removed, too), else not_set, or resealing while
            // older seals remain.
            dataKey: key.unknown
                ? 'key_missing'
                : !key.configured
                  ? 'not_set'
                  : key.legacy + key.previous
                    ? 'resealing'
                    : 'ok',
            // CB-322: the keys' fingerprints (never the keys), to check an
            // escrowed copy against, and what's still under SESSION_SECRET's key.
            ...(key.keyId ? { dataKeyId: key.keyId } : {}),
            ...(key.previousKeyId ? { dataKeyPreviousId: key.previousKeyId } : {}),
            legacySealed: key.legacy,
            ...(this.sources.draining() ? { draining: true as const } : {}),
            // CB-340: unauthenticated, so the count and warning only; the ids are in adminSetup.
            ...(files
                ? { datasetFiles: { missing: files.missing, ...(files.warning ? { warning: files.warning } : {}) } }
                : {}),
            // CB-315: unauthenticated, so the level only; no paths, sizes or times.
            ...(backups ? { litestream: copy ? (copy.level ?? 'ok') : 'off' } : {}),
        };
    }

    /**
     * `statusEpoch`: a number that changes when the part of `setup` that isn't
     * in any table changes, for the shell's version. That part is what the
     * modules report (the Telegram channel's status, whether S3 answered) and
     * the backups' status (a run in progress, the last result, which the backup
     * CLI may write too). Each read compares a fingerprint of them, so no
     * source has to remember to bump it. Config is read at boot and is in the
     * boot id instead.
     */
    statusEpoch(): number {
        const { analytics, context, dataKeys, modules } = this.sources;
        // The continuous copy's times change with every write: only whether
        // it is behind counts, here and off-site.
        const backup = this.sources.backups()?.status();
        const shipped = backup?.continuous?.offsite;
        const fingerprint = JSON.stringify([
            modules.map((module) => module.setup?.(context) ?? null),
            // Its state, not its progress: a rebuild's every percent isn't news.
            analytics && [analytics.mode, analytics.health().state],
            // An admin's re-seal running, then done (CB-322).
            [dataKeys.resealing, dataKeys.lastReseal?.finishedAt ?? 0],
            backup
                ? {
                      ...backup,
                      continuous: backup.continuous && [backup.continuous.behind, backup.continuous.level],
                      continuousOffsite: shipped && [shipped.intervalSeconds, shipped.behind, shipped.lastError],
                  }
                : null,
        ]);
        if (fingerprint !== this.epoch.fingerprint) {
            this.epoch = { epoch: this.epoch.epoch + 1, fingerprint };
        }
        return this.epoch.epoch;
    }

    async adminSetup(): Promise<Pick<SetupStatus, 'dataKey' | 'backup' | 'datasetFiles'>> {
        const backups = this.sources.backups();
        const files = this.moduleHealth().datasetFiles;
        return {
            dataKey: await this.sources.dataKeys.status(),
            ...(backups ? { backup: backups.status() } : {}),
            ...(files ? { datasetFiles: files } : {}),
        };
    }

    /** What the modules report to operators (`ServerModule.health`), merged. */
    private moduleHealth(): ModuleHealth {
        const { context, modules } = this.sources;
        return Object.assign({}, ...modules.map((module) => module.health?.(context)));
    }

    /**
     * What picks dictation's transcription server and key: the environment's
     * and the key an admin set (CB-204), opened, for `transcriptionProvider`.
     */
    transcriptionSources(): TranscriptionSources {
        const { config } = this.sources;
        return {
            transcription: config.transcription,
            voiceKey: config.voiceKey,
            savedKey: this.sources.transcriptionKeys.read(),
        };
    }

    /**
     * Setup status, for a user when given: `model` and `inference` say whether
     * their chats have a model. `missing` names the environment's model
     * settings only until a backend exists or a bring-your-own kind is allowed
     * (the database is the source of truth after that).
     */
    async setup(userId?: string): Promise<SetupStatus> {
        const { analytics, config, context, inference: registry, modules, store } = this.sources;
        const base = setupStatus(config);
        const registered = await registry.registered();
        const inference = await registry.availability(userId);
        const missing = registered ? [] : base.missing;
        return Object.assign(
            {
                ...base,
                model: registered ? inference.available : base.model,
                ...callsSetup({
                    cloud: !!(config.voiceKey && config.voiceModel && !missing.length),
                    model: !missing.length,
                    env: config.voiceCalls,
                    settings: store.slices.settings.settings(),
                    transcription: transcriptionProvider(this.transcriptionSources(), store.slices.settings.settings()),
                }),
                ...dictationSetup(
                    transcriptionProvider(this.transcriptionSources(), store.slices.settings.settings()),
                    this.sources.dictation(),
                ),
                missing,
                inference,
                ...(analytics ? { analytics: analytics.health() } : {}),
            },
            ...modules.map((module) => module.setup?.(context)),
        );
    }

    async requireReady() {
        const missing = (await this.setup()).missing;
        if (missing.length) {
            throw new Error(`Setup required: ${missing.join(', ')}. Configure the model in the server environment.`);
        }
    }
}

/**
 * `AppStatus` over the services built before it, the modules, the data
 * keys and the late ports; it fills `ports.setup`.
 */
const AppStatusLive = Layer.effect(
    AppStatus,
    Effect.gen(function* () {
        const ports = yield* Ports;
        // Dictation's relays, built once by their leaf step (`app/dictation.ts`).
        const dictation = yield* Dictation;
        const { modules, context } = (yield* ModuleHost).use((modules, context) => ({ modules, context }));
        const status = new Status({
            config: yield* LegacyConfig,
            store: yield* LegacyStore,
            inference: yield* LegacyInference,
            transcriptionKeys: yield* LegacyTranscriptionKeys,
            analytics: yield* LegacyAnalytics,
            modules,
            context,
            dataKeys: yield* DataKeyAdmin,
            dictation: () => dictation,
            backups: () => ports.backups.peek(),
            draining: () => ports.draining.get(),
        });
        ports.setup.fill({ setup: (userId) => status.setup(userId) });
        return AppStatus.of(status);
    }),
);

/** The step, as `composition/index.ts` places it. */
export const appStatusLayers = { step: AppStatusLive };
