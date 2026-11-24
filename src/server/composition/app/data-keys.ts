/**
 * The data keys (`DataKeyAdmin`): their status, the re-seal (one run at a
 * time), `resealNow` and `verifyRecoveryKey`, read through the tag. Placed in
 * the graph (`composition/index.ts`) after every service it reads
 * (`liveLayers.counters`); it registers no listener, so the graph's order
 * doesn't change. One per runtime: the re-seal's single run and the last admin
 * run are its state.
 */
import { Context, Effect, Layer } from 'effect';

import { nextTurn } from '@socio/data/events';
import { dataKeyIds } from '@socio/foundation/keys/data-keys';
import { dataKeyId, SEAL_PURPOSES, type SealPurpose, type SealState } from '@socio/foundation/keys/secret-box';
import type { DataKeyResealStatus, DataKeyStatus, RecoveryKeyCheck } from '@socio/shared/types';

import type { BackupService } from '../../backup/backup-service.js';
import type { DataSpace } from '../../dataspace/space.js';
import type { GitHubAppSettings } from '../../github/settings.js';
import type { InferenceService } from '../../inference/service.js';
import type { McpConnections } from '../../mcp/connections.js';
import type { NotificationService } from '../../notifications/service.js';
import type { UpdateService } from '../../updates/service.js';
import type { TranscriptionKeys } from '../../voice/transcription.js';
import type { WorkspaceSecrets } from '../../workspace-secrets/service.js';
import { LegacyConfig, LegacyModuleContext, LegacyWorkspace } from '../base.js';
import type { PlatformConfig } from '../config.js';
import { LegacyData } from '../dataspace.js';
import { LegacyGitHub } from '../github.js';
import { LegacyInference } from '../inference.js';
import { LegacyMcpConnections } from '../mcp.js';
import { LegacyNotifications } from '../notifications.js';
import { Ports } from '../ports.js';
import { LegacyUpdates } from '../updates.js';
import { LegacyTranscriptionKeys } from '../voice.js';
import type { AppWorkspace } from '../workspace-parts.js';
import { LegacyWorkspaceSecrets } from '../workspace-secrets.js';

/** What a re-seal run did, all stores together (CB-322). Counts only. */
export interface ResealOutcome {
    resealed: number;
    unreadable: number;
    left: number;
}

/** The data keys' admin: their status, the re-seal and the recovery key check. */
export interface DataKeyAdminShape {
    /** The data key, and what files and stored credentials are left to re-seal (CB-62). */
    status(): Promise<DataKeyStatus>;
    /** The re-seal: one run at a time; asked while one runs, it's that one (the same promise). */
    reseal(): Promise<ResealOutcome | undefined>;
    /** An admin's re-seal, now (CB-322). */
    resealNow(actor: string): Promise<void>;
    /** The restore drill's check of a recovery key (CB-322). */
    verifyRecoveryKey(key: Buffer, actor: string): Promise<RecoveryKeyCheck>;
    /** Whether a re-seal runs now. */
    readonly resealing: boolean;
    /** The last re-seal an admin asked for, since start (CB-322). */
    readonly lastReseal: NonNullable<DataKeyResealStatus['last']> | undefined;
}

/** The data keys' admin, one per runtime (`composition/app/data-keys.ts`). */
export class DataKeyAdmin extends Context.Service<DataKeyAdmin, DataKeyAdminShape>()(
    'socio/composition/app/DataKeyAdmin',
) {}

/** What the data keys' admin reads: the stores that seal, the backups' port, the audit and the log. */
export interface DataKeySources {
    readonly config: Pick<PlatformConfig, 'dataKeys'>;
    readonly workspace: Pick<AppWorkspace, 'audit'>;
    readonly inference: Pick<InferenceService, 'store'>;
    readonly data: Pick<DataSpace, 'sealStates' | 'resealDue' | 'resealFiles' | 'sealedObject'>;
    readonly notifications: Pick<NotificationService, 'push'>;
    readonly github: Pick<GitHubAppSettings, 'sealStates' | 'reseal'>;
    readonly transcriptionKeys: Pick<TranscriptionKeys, 'sealStates' | 'reseal'>;
    readonly updates: Pick<UpdateService, 'sealStates' | 'reseal'>;
    readonly mcpConnections: Pick<McpConnections, 'sealStates' | 'reseal'>;
    readonly workspaceSecrets: Pick<WorkspaceSecrets, 'sealStates' | 'reseal'>;
    /** Scheduled backups, read at the moment of use (their late-bound port). */
    backups(): BackupService | undefined;
    log(line: string): void;
}

/** Two stores' seal counts as one purpose's. */
const addStates = (a: Record<SealState, number>, b: Record<SealState, number>): Record<SealState, number> => ({
    current: a.current + b.current,
    previous: a.previous + b.previous,
    legacy: a.legacy + b.legacy,
    unknown: a.unknown + b.unknown,
});

/** The data keys' admin over its sources (`DataKeyAdmin`). */
export class DataKeys implements DataKeyAdminShape {
    /** The re-seal running now: the hourly one and an admin's are the same run. */
    private running?: Promise<ResealOutcome | undefined>;
    private last?: NonNullable<DataKeyResealStatus['last']>;
    constructor(private readonly sources: DataKeySources) {}

    get resealing() {
        return !!this.running;
    }
    get lastReseal() {
        return this.last;
    }

    async status(): Promise<DataKeyStatus> {
        const { config, data, github, mcpConnections, workspaceSecrets } = this.sources;
        const configured = !!config.dataKeys?.current;
        const purposes: Record<SealPurpose, Record<SealState, number>> = {
            'inference-credentials': await this.sources.inference.store.sealStates(),
            'data-files': data.sealStates(),
            // The continuous copy's files off-site: never legacy (CB-322).
            backups: this.sources.backups()?.sealStates() ?? { current: 0, previous: 0, legacy: 0, unknown: 0 },
            'push-keys': await this.sources.notifications.push.sealStates(),
            'dispatch-credentials': await github.sealStates(),
            // The transcription key and the release feed's token.
            'settings-secrets': addStates(
                this.sources.transcriptionKeys.sealStates(),
                this.sources.updates.sealStates(),
            ),
            'mcp-credentials': mcpConnections.sealStates(),
            'workspace-secrets': workspaceSecrets.sealStates(),
            // CB-326 step 6: coding session gateway exchange bodies. The
            // object-store writer (step 6's next slice) reports seal states;
            // nothing is sealed until it lands.
            'gateway-log': { current: 0, previous: 0, legacy: 0, unknown: 0 },
        };
        // Backups go again under the current key with their next send, so
        // the re-seal's own counts leave them out.
        const sum = (state: SealState, skip?: SealPurpose) =>
            SEAL_PURPOSES.reduce((total, purpose) => total + (purpose === skip ? 0 : purposes[purpose][state]), 0);
        // Without a data key, the legacy key is the current one: everything
        // sealed is legacy-sealed (CB-322).
        const legacyState: SealState = configured ? 'legacy' : 'current';
        const legacyByPurpose = Object.fromEntries(
            SEAL_PURPOSES.filter((purpose) => purposes[purpose][legacyState]).map((purpose) => [
                purpose,
                purposes[purpose][legacyState],
            ]),
        );
        const ids = dataKeyIds(config.dataKeys);
        return {
            configured,
            // Every purpose, with a data key or without (CB-322): SESSION_SECRET
            // stays in the recovery kit until this is zero.
            legacy: sum(legacyState),
            previous: sum('previous', 'backups'),
            unknown: sum('unknown', 'backups'),
            ...(ids.current ? { keyId: ids.current } : {}),
            ...(ids.previous ? { previousKeyId: ids.previous } : {}),
            ...(Object.keys(legacyByPurpose).length ? { legacyByPurpose } : {}),
            ...(this.running || this.last
                ? {
                      reseal: {
                          running: !!this.running,
                          ...(this.last ? { last: this.last } : {}),
                      },
                  }
                : {}),
        };
    }

    /**
     * Seals stored credentials and files again under DATA_ENCRYPTION_KEY
     * (CB-62): at start and hourly, in the background, until nothing older
     * is left, and when an admin asks (`resealNow`). One run at a time: asked
     * while one runs, it's that one. Store by store, each yielding to the
     * event loop as it goes (CB-318). Logs counts only. Without a data key
     * it only says so when something is sealed under one (the key was
     * removed).
     */
    reseal(): Promise<ResealOutcome | undefined> {
        if (!this.running) {
            this.running = this.resealOnce().finally(() => {
                this.running = undefined;
            });
        }
        return this.running;
    }
    private async resealOnce(): Promise<ResealOutcome | undefined> {
        const { config, data, log } = this.sources;
        if (!config.dataKeys?.current) {
            const { unknown } = await this.status();
            if (unknown) {
                log(
                    `Data key: ${unknown} item(s) are sealed under a data key, but DATA_ENCRYPTION_KEY is not set; they can't be read until it is set again.`,
                );
            }
            return undefined;
        }
        const credentials = { resealed: 0, unreadable: 0 };
        const stores: Array<{ reseal(): Promise<{ resealed: number; unreadable: number }> }> = [
            this.sources.inference.store,
            this.sources.notifications.push,
            this.sources.github,
            this.sources.transcriptionKeys,
            this.sources.mcpConnections,
            this.sources.updates,
            this.sources.workspaceSecrets,
        ];
        for (const store of stores) {
            const result = await store.reseal();
            credentials.resealed += result.resealed;
            credentials.unreadable += result.unreadable;
            await nextTurn();
        }
        const files = data.resealDue() ? await data.resealFiles() : undefined;
        const parts = [
            credentials.resealed && `re-sealed ${credentials.resealed} stored credential(s)`,
            files?.resealed && `re-sealed ${files.resealed} file(s)`,
            files?.fixed && `recorded ${files.fixed} file(s) already re-sealed`,
            credentials.unreadable + (files?.unreadable ?? 0) &&
                `${credentials.unreadable + (files?.unreadable ?? 0)} item(s) under a key this server doesn't have`,
            files?.missing && `${files.missing} file(s) missing`,
            files?.mismatched && `${files.mismatched} write(s) to retry`,
            files?.skipped && `${files.skipped} file(s) in storage not configured here`,
            files?.unavailable && 'stopped: file storage is unreachable',
        ].filter(Boolean);
        if (parts.length) {
            log(`Data key: ${parts.join('; ')}.`);
        }
        return {
            resealed: credentials.resealed + (files?.resealed ?? 0) + (files?.fixed ?? 0),
            unreadable: credentials.unreadable + (files?.unreadable ?? 0),
            left: (files?.mismatched ?? 0) + (files?.skipped ?? 0) + (files?.unavailable ? 1 : 0),
        };
    }

    /**
     * "Re-seal under the data key" (CB-322): an admin's run of the re-seal
     * now, in the background, rather than at the next hourly one. Refused
     * without a data key (new seals would still be legacy). Idempotent and
     * resumable: each value moves on its own, so a run cut short leaves the
     * rest for the next. Audited when asked and when done, counts only.
     * Resolves when it's done (the route doesn't wait).
     */
    resealNow(actor: string): Promise<void> {
        const { config, workspace } = this.sources;
        const keyId = dataKeyIds(config.dataKeys).current;
        if (!keyId) {
            throw new Error(
                'Set DATA_ENCRYPTION_KEY first: without a data key, values would be sealed under the key from SESSION_SECRET again.',
            );
        }
        const startedAt = Date.now();
        workspace.audit({
            actor,
            action: 'reseal',
            targetKind: 'data_key',
            targetId: keyId,
            detail: 'started',
        });
        return this.reseal()
            .then(
                (outcome) => ({ resealed: 0, unreadable: 0, left: 0, ...outcome }),
                () => ({
                    resealed: 0,
                    unreadable: 0,
                    left: 0,
                    error: 'The re-seal failed; it runs again within the hour.',
                }),
            )
            .then(async (outcome: NonNullable<DataKeyResealStatus['last']> | ResealOutcome) => {
                this.last = { startedAt, finishedAt: Date.now(), ...outcome };
                const { legacy } = await this.status();
                workspace.audit({
                    actor,
                    action: 'reseal',
                    targetKind: 'data_key',
                    targetId: keyId,
                    detail: `done: ${outcome.resealed} re-sealed, ${outcome.unreadable} unreadable, ${outcome.left} left; ${legacy} legacy-sealed remain${this.last.error ? `; ${this.last.error}` : ''}`,
                });
            })
            .catch(() => undefined);
    }

    /**
     * "Verify a recovery key" (CB-322): the restore drill opens a sample of
     * the latest restore's seals with a key from escrow, in the background.
     * The key is wiped when the check ends; only its id and the counts are
     * kept, audited and logged.
     */
    verifyRecoveryKey(key: Buffer, actor: string): Promise<RecoveryKeyCheck> {
        const { config, data, workspace } = this.sources;
        const backups = this.sources.backups();
        if (!backups?.drill) {
            key.fill(0);
            throw new Error('The continuous copy isn’t set up here.');
        }
        const keyId = dataKeyId(key);
        const check = backups.drill.verifyKey(key, dataKeyIds(config.dataKeys), {
            files: (row) => data.sealedObject(row),
            backups: (count) => backups.sampleOffsite(count),
        });
        workspace.audit({
            actor,
            action: 'verify',
            targetKind: 'data_key',
            targetId: keyId,
            detail: 'recovery key check started',
        });
        void check.then(
            (result) =>
                workspace.audit({
                    actor,
                    action: 'verify',
                    targetKind: 'data_key',
                    targetId: keyId,
                    detail: result.error
                        ? `could not check: ${result.error}`
                        : `${result.ok ? 'passed' : 'failed'} (${result.matches}): ${result.purposes
                              .map((p) => `${p.purpose} ${p.opened}/${p.sampled}`)
                              .join(', ')}`,
                }),
            () => undefined,
        );
        return check;
    }
}

/** `DataKeyAdmin` over the services built before it, the backups' port and the modules' log. */
const DataKeyAdminLive = Layer.effect(
    DataKeyAdmin,
    Effect.gen(function* () {
        const ports = yield* Ports;
        const context = yield* LegacyModuleContext;
        return DataKeyAdmin.of(
            new DataKeys({
                config: yield* LegacyConfig,
                workspace: yield* LegacyWorkspace,
                inference: yield* LegacyInference,
                data: yield* LegacyData,
                notifications: yield* LegacyNotifications,
                github: yield* LegacyGitHub,
                transcriptionKeys: yield* LegacyTranscriptionKeys,
                updates: yield* LegacyUpdates,
                mcpConnections: yield* LegacyMcpConnections,
                workspaceSecrets: yield* LegacyWorkspaceSecrets,
                backups: () => ports.backups.peek(),
                // The modules' log, read at each line, as the module host gives it.
                log: (line) => context.log(line),
            }),
        );
    }),
);

/** The step, as `composition/index.ts` places it. */
export const appDataKeysLayers = { step: DataKeyAdminLive };
